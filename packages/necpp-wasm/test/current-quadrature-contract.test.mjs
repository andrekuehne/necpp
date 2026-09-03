import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { NecGeometryError, NecStateError, createNecModel } from "../.test-build/src/index.js";
import { createNecWorkerModel } from "../.test-build/src/worker.js";
import {
  currentQuadratureFieldGrid,
  currentQuadratureFixtures,
  applyCurrentQuadratureFixture,
  unitCurrentVector,
} from "./fixtures/current-quadrature.mjs";
import {
  viewEmbeddedField,
  viewPreparedQuadrature,
} from "./fixtures/current-quadrature-packed.mjs";

const generatedLoader = new URL(
  "../.test-build/src/nec2pp.generated.js",
  import.meta.url,
);
const wasmUrl = new URL("../.test-build/src/nec2pp.wasm", import.meta.url);
const hasWasm = existsSync(generatedLoader) && existsSync(wasmUrl);
const skip = !hasWasm && "WASM artifacts have not been built";
const hasWp4Abi = hasWasm
  && readFileSync(generatedLoader, "utf8").includes(
    "_necpp_wasm_v1_get_current_distribution",
  );
const skipWp4 = skip
  || (!hasWp4Abi && "WASM artifacts have not been rebuilt with WP4 ABI exports");

const unitCurrentTolerance = 1e-7;
const samePathTolerance = 1e-12;

function relativeError(left, right) {
  assert.equal(left.length, right.length);
  let numerator = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const delta = left[index] - right[index];
    numerator += delta * delta;
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  return Math.sqrt(numerator)
    / Math.max(1, Math.sqrt(leftNorm), Math.sqrt(rightNorm));
}

function complexRelativeError(left, right) {
  return relativeError(
    Float64Array.from([...left.real, ...left.imag]),
    Float64Array.from([...right.real, ...right.imag]),
  );
}

function inputPowerW(solution, index) {
  const voltage = {
    re: solution.voltages.real[index],
    im: solution.voltages.imag[index],
  };
  const current = {
    re: solution.currents.real[index],
    im: solution.currents.imag[index],
  };
  return 0.5 * (voltage.re * current.re + voltage.im * current.im);
}

async function withModel(factory, fixture, body) {
  const model = await factory();
  try {
    await applyCurrentQuadratureFixture(model, fixture);
    await body(model);
  } finally {
    await Promise.resolve(model.dispose());
  }
}

test("WP0 current-quadrature fixtures lock public Z, polarity, and unit current",
  { skip }, async (t) => {
    for (const fixture of Object.values(currentQuadratureFixtures)) {
      await t.test(fixture.id, async () => {
        await withModel(createNecModel, fixture, async (model) => {
          const matrices = model.computeImpedanceMatrix();
          assert.equal(matrices.impedance.rows, fixture.ports.length);
          assert.equal(matrices.impedance.columns, fixture.ports.length);
          assert.equal(matrices.impedance.order, "row-major");
          for (const value of matrices.impedance.real) {
            assert.equal(Number.isFinite(value), true);
          }

          const ones = {
            real: Float64Array.from(fixture.ports, () => 1),
            imag: new Float64Array(fixture.ports.length),
          };
          const voltage = model.solveVoltages(ones);
          assert.equal(voltage.currents.real[0] > 0, true);
          assert.ok(Math.abs(voltage.powersW[0] - inputPowerW(voltage, 0))
            < samePathTolerance);

          const unit = model.solveCurrents(
            unitCurrentVector(fixture.ports.length),
          );
          assert.ok(complexRelativeError(
            unit.currents,
            unitCurrentVector(fixture.ports.length),
          ) < unitCurrentTolerance);

          const embedded = model.computeEmbeddedFarFields(
            currentQuadratureFieldGrid,
            { kind: "unit-current", valueA: 1 },
          );
          assert.equal(embedded.ports.length, fixture.ports.length);
          assert.equal(
            embedded.samplesPerPort,
            currentQuadratureFieldGrid.theta.count
              * currentQuadratureFieldGrid.phi.count,
          );
          assert.equal(embedded.normalization.kind, "unit-current");
          assert.equal(model.state, "solved");
          assert.equal(unit.solveGeneration > 0, true);
        });
      });
    }
  });

test("WP0 insulated and connected turnstiles are distinct public networks",
  { skip }, async () => {
    let insulatedZ;
    let connectedZ;
    await withModel(
      createNecModel,
      currentQuadratureFixtures["turnstile-insulated"],
      async (model) => {
        insulatedZ = model.computeImpedanceMatrix().impedance;
      },
    );
    await withModel(
      createNecModel,
      currentQuadratureFixtures["turnstile-connected"],
      async (model) => {
        connectedZ = model.computeImpedanceMatrix().impedance;
      },
    );
    assert.equal(insulatedZ.rows, 2);
    assert.equal(connectedZ.rows, 2);
    assert.ok(complexRelativeError(insulatedZ, connectedZ) > 1e-3);
  });

test("WP0 through-crossing coplanar dipoles are geometry errors",
  { skip }, async () => {
    const model = await createNecModel();
    try {
      model.addWire({
        tag: 1,
        segments: 11,
        start: [-0.25, 0, 0],
        end: [0.25, 0, 0],
        radiusM: 0.001,
      });
      model.addWire({
        tag: 2,
        segments: 11,
        start: [0, -0.25, 0],
        end: [0, 0.25, 0],
        radiusM: 0.001,
      });
      assert.throws(
        () => model.completeGeometry(),
        (error) => error instanceof NecGeometryError && error.code === "NEC_GEOMETRY",
      );
    } finally {
      model.dispose();
    }
  });

test("WP0 dipole direct and worker Z agree within native-to-WASM tolerance",
  { skip }, async () => {
    let directZ;
    await withModel(
      createNecModel,
      currentQuadratureFixtures.dipole,
      async (model) => {
        directZ = model.computeImpedanceMatrix().impedance;
      },
    );
    await withModel(
      createNecWorkerModel,
      currentQuadratureFixtures.dipole,
      async (model) => {
        const workerZ = await model.computeImpedanceMatrix();
        assert.equal(workerZ.impedance.rows, 1);
        assert.ok(
          complexRelativeError(directZ, workerZ.impedance) < samePathTolerance,
        );
      },
    );
  });

const fourNodeQuadrature = Object.freeze({
  nodes: Float64Array.of(-1, -1 / 3, 1 / 3, 1),
  images: "physical-only",
  modes: "unit-current",
});

function packedMagic(buffer) {
  const bytes = new Uint8Array(buffer);
  return String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
}

test("WP4 dipole current, quadrature, and characterization are public",
  { skip: skipWp4 }, async () => {
    await withModel(createNecModel, currentQuadratureFixtures.dipole, async (model) => {
      const currents = model.getCurrentDistribution({ kind: "unit-current" });
      assert.equal(currents.schemaVersion, 1);
      assert.equal(currents.modeKind, "unit-current");
      assert.equal(currents.modeCount, 1);
      assert.equal(currents.segments.length, 11);
      assert.equal(currents.segments[5]?.tag, 1);
      assert.equal(currents.segments[5]?.segment, 6);
      assert.equal(currents.startEnds[0]?.kind, "free");
      assert.equal(currents.endEnds[currents.endEnds.length - 1]?.kind, "free");
      assert.equal(currents.aReal.length, 11);
      assert.equal(Number.isFinite(currents.aReal[5]), true);

      assert.throws(
        () => model.getCurrentDistribution({ kind: "latest-solution" }),
        (error) => error instanceof NecStateError && error.code === "NEC_STATE",
      );

      const prepared = model.prepareCurrentQuadrature(fourNodeQuadrature);
      assert.equal(prepared.schemaVersion, 1);
      assert.equal(prepared.byteLength, 4072);
      assert.equal(packedMagic(prepared.buffer), "NECQ");

      const characterization = model.characterizeIsolatedElement({
        quadrature: fourNodeQuadrature,
        field: currentQuadratureFieldGrid,
      });
      assert.equal(characterization.impedance.rows, 1);
      assert.equal(packedMagic(characterization.quadrature.buffer), "NECQ");
      assert.equal(packedMagic(characterization.embeddedField.buffer), "NECF");
      assert.equal(characterization.quadrature.byteLength, prepared.byteLength);
    });
  });

test("WP4 insulated turnstile characterization has two unit-current modes",
  { skip: skipWp4 }, async () => {
    await withModel(
      createNecModel,
      currentQuadratureFixtures["turnstile-insulated"],
      async (model) => {
        const characterization = model.characterizeIsolatedElement({
          quadrature: fourNodeQuadrature,
          field: currentQuadratureFieldGrid,
        });
        assert.equal(characterization.impedance.rows, 2);
        assert.equal(packedMagic(characterization.quadrature.buffer), "NECQ");
        const header = new DataView(characterization.quadrature.buffer);
        assert.equal(header.getUint32(20, true), 2);
        assert.equal(packedMagic(characterization.embeddedField.buffer), "NECF");
        const fieldHeader = new DataView(characterization.embeddedField.buffer);
        assert.equal(fieldHeader.getUint32(8, true), 2);
      },
    );
  });

test("WP4 direct and worker packed NECQ/NECF agree",
  { skip: skipWp4 }, async () => {
    let direct;
    await withModel(
      createNecModel,
      currentQuadratureFixtures.dipole,
      async (model) => {
        direct = model.characterizeIsolatedElement({
          quadrature: fourNodeQuadrature,
          field: currentQuadratureFieldGrid,
        });
      },
    );
    await withModel(
      createNecWorkerModel,
      currentQuadratureFixtures.dipole,
      async (model) => {
        const worker = await model.characterizeIsolatedElement({
          quadrature: fourNodeQuadrature,
          field: currentQuadratureFieldGrid,
        });
        assert.equal(worker.quadrature.byteLength, direct.quadrature.byteLength);
        assert.deepEqual(
          new Uint8Array(worker.quadrature.buffer),
          new Uint8Array(direct.quadrature.buffer),
        );
        assert.equal(
          worker.embeddedField.byteLength,
          direct.embeddedField.byteLength,
        );
        assert.deepEqual(
          new Uint8Array(worker.embeddedField.buffer),
          new Uint8Array(direct.embeddedField.buffer),
        );
        assert.ok(
          complexRelativeError(direct.impedance, worker.impedance) < samePathTolerance,
        );
      },
    );
  });

const necSpeedOfLightMPerS = 1 / Math.sqrt(
  8.854e-12 * 4 * Math.PI * 1e-7,
);

async function scaledDipoleCharacterization(factory, frequencyMHz) {
  const wavelengthM = necSpeedOfLightMPerS / (frequencyMHz * 1e6);
  const model = await factory();
  try {
    await Promise.resolve(model.addWire({
      tag: 1,
      segments: 11,
      start: [0, 0, -0.25 * wavelengthM],
      end: [0, 0, 0.25 * wavelengthM],
      radiusM: 0.001 * wavelengthM,
    }));
    await Promise.resolve(model.completeGeometry());
    await Promise.resolve(model.definePorts([{ tag: 1, segment: 6 }]));
    await Promise.resolve(model.prepare({ frequencyMHz }));
    return await Promise.resolve(model.characterizeIsolatedElement({
      quadrature: {
        nodes: Float64Array.of(-0.5, 0, 0.5),
        weights: Float64Array.of(0.4, 1.2, 0.4),
        images: "physical-only",
        modes: "unit-current",
      },
      field: {
        radiusM: 10 * wavelengthM,
        theta: { startDeg: 30, count: 3, stepDeg: 30 },
        phi: { startDeg: 0, count: 2, stepDeg: 90 },
      },
    }));
  } finally {
    await Promise.resolve(model.dispose());
  }
}

test("frequency-scaled NECQ and NECF are invariant through direct and worker APIs",
  { skip: skipWp4 }, async () => {
    let reference;
    for (const frequencyMHz of [30, 300, 1000, 10000]) {
      const direct = await scaledDipoleCharacterization(createNecModel, frequencyMHz);
      const worker = await scaledDipoleCharacterization(createNecWorkerModel, frequencyMHz);
      assert.deepEqual(
        new Uint8Array(worker.quadrature.buffer),
        new Uint8Array(direct.quadrature.buffer),
      );
      assert.deepEqual(
        new Uint8Array(worker.embeddedField.buffer),
        new Uint8Array(direct.embeddedField.buffer),
      );

      const necq = viewPreparedQuadrature(direct.quadrature.buffer);
      const necf = viewEmbeddedField(direct.embeddedField.buffer);
      const feed = necq.currentIndex(0, 0, 5, 1);
      assert.ok(Math.abs(necq.iReal[feed] - 1) < unitCurrentTolerance);
      assert.ok(Math.abs(necq.iImag[feed]) < unitCurrentTolerance);
      const feedGeometry = necq.geometryIndex(0, 5, 1);
      assert.ok(Math.abs(necq.z[feedGeometry] / necq.wavelengthM) < 1e-12);
      assert.ok(Math.abs(necq.lengthM[feedGeometry] / necq.wavelengthM - 0.5 / 11) < 1e-12);
      assert.ok(Math.abs(necq.dsWeight[feedGeometry] / necq.wavelengthM
        - 0.5 * (0.5 / 11) * 1.2) < 1e-12);

      const normalized = {
        impedance: Float64Array.of(
          direct.impedance.real[0], direct.impedance.imag[0],
        ),
        currents: Float64Array.from([...necq.iReal, ...necq.iImag]),
        fields: Float64Array.from([
          ...necf.eThetaReal, ...necf.eThetaImag,
          ...necf.ePhiReal, ...necf.ePhiImag,
        ], (value) => value * necq.wavelengthM),
      };
      if (reference === undefined) {
        reference = normalized;
      } else {
        assert.ok(relativeError(normalized.impedance, reference.impedance) < 1e-10);
        assert.ok(relativeError(normalized.currents, reference.currents) < 1e-10);
        assert.ok(relativeError(normalized.fields, reference.fields) < 1e-7);
      }
    }
  });

async function scaledTurnstileCurrents(factory, frequencyMHz) {
  const wavelengthM = necSpeedOfLightMPerS / (frequencyMHz * 1e6);
  const model = await factory();
  try {
    for (const wire of [
      {
        tag: 1,
        start: [-0.25 * wavelengthM, 0, 0.001 * wavelengthM],
        end: [0.25 * wavelengthM, 0, 0.001 * wavelengthM],
      },
      {
        tag: 2,
        start: [0, -0.25 * wavelengthM, -0.001 * wavelengthM],
        end: [0, 0.25 * wavelengthM, -0.001 * wavelengthM],
      },
    ]) {
      await Promise.resolve(model.addWire({
        ...wire,
        segments: 11,
        radiusM: 0.001 * wavelengthM,
      }));
    }
    await Promise.resolve(model.completeGeometry());
    await Promise.resolve(model.definePorts([
      { tag: 1, segment: 6 }, { tag: 2, segment: 6 },
    ]));
    await Promise.resolve(model.prepare({ frequencyMHz }));
    return await Promise.resolve(
      model.getCurrentDistribution({ kind: "unit-current" }),
    );
  } finally {
    await Promise.resolve(model.dispose());
  }
}

test("frequency-scaled multiport currents are normalized through direct and worker APIs",
  { skip: skipWp4 }, async () => {
    for (const frequencyMHz of [30, 300, 1000, 10000]) {
      const direct = await scaledTurnstileCurrents(createNecModel, frequencyMHz);
      const worker = await scaledTurnstileCurrents(createNecWorkerModel, frequencyMHz);
      assert.ok(relativeError(direct.aReal, worker.aReal) < samePathTolerance);
      assert.ok(relativeError(direct.aImag, worker.aImag) < samePathTolerance);
      assert.ok(relativeError(direct.cReal, worker.cReal) < samePathTolerance);
      assert.ok(relativeError(direct.cImag, worker.cImag) < samePathTolerance);
      for (let mode = 0; mode < 2; mode += 1) {
        for (let port = 0; port < 2; port += 1) {
          const plane = mode * 22 + port * 11 + 5;
          const expected = mode === port ? 1 : 0;
          assert.ok(Math.abs(direct.aReal[plane] + direct.cReal[plane] - expected)
            < unitCurrentTolerance);
          assert.ok(Math.abs(direct.aImag[plane] + direct.cImag[plane])
            < unitCurrentTolerance);
        }
      }
    }
  });

test("WP4 direct and worker current planes agree",
  { skip: skipWp4 }, async () => {
    let direct;
    await withModel(
      createNecModel,
      currentQuadratureFixtures.dipole,
      async (model) => {
        direct = model.getCurrentDistribution({ kind: "unit-current" });
      },
    );
    await withModel(
      createNecWorkerModel,
      currentQuadratureFixtures.dipole,
      async (model) => {
        const worker = await model.getCurrentDistribution({ kind: "unit-current" });
        assert.deepEqual(worker.segments, direct.segments);
        assert.deepEqual(worker.startEnds, direct.startEnds);
        assert.deepEqual(worker.endEnds, direct.endEnds);
        assert.equal(worker.modeCount, direct.modeCount);
        assert.ok(relativeError(direct.aReal, worker.aReal) < samePathTolerance);
        assert.ok(relativeError(direct.aImag, worker.aImag) < samePathTolerance);
        assert.ok(relativeError(direct.cReal, worker.cReal) < samePathTolerance);
      },
    );
  });
