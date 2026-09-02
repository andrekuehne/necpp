import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import { NecGeometryError, createNecModel } from "../.test-build/src/index.js";
import { createNecWorkerModel } from "../.test-build/src/worker.js";
import {
  currentQuadratureFieldGrid,
  currentQuadratureFixtures,
  applyCurrentQuadratureFixture,
  unitCurrentVector,
} from "./fixtures/current-quadrature.mjs";

const generatedLoader = new URL(
  "../.test-build/src/nec2pp.generated.js",
  import.meta.url,
);
const wasmUrl = new URL("../.test-build/src/nec2pp.wasm", import.meta.url);
const hasWasm = existsSync(generatedLoader) && existsSync(wasmUrl);
const skip = !hasWasm && "WASM artifacts have not been built";

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
