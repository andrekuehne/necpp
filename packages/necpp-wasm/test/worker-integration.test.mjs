import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import { createNecModel, NecGeometryError } from "../.test-build/src/index.js";
import { createNecWorkerModel } from "../.test-build/src/worker.js";
import { createReferenceArrayFixture } from "./fixtures/reference-array.mjs";

const generatedLoader = new URL(
  "../.test-build/src/nec2pp.generated.js",
  import.meta.url,
);
const wasmUrl = new URL("../.test-build/src/nec2pp.wasm", import.meta.url);
const hasWasm = existsSync(generatedLoader) && existsSync(wasmUrl);

const dipole = {
  tag: 1,
  segments: 11,
  start: [0, 0, -0.25],
  end: [0, 0, 0.25],
  radiusM: 0.001,
};

const farFieldRequest = {
  radiusM: 1,
  theta: { startDeg: 0, count: 5, stepDeg: 45 },
  phi: { startDeg: 0, count: 3, stepDeg: 90 },
};

function relativeError(left, right) {
  let numerator = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const delta = left[index] - right[index];
    numerator += delta * delta;
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  return Math.sqrt(numerator) / Math.max(1, Math.sqrt(leftNorm), Math.sqrt(rightNorm));
}

async function buildDipole(model) {
  await Promise.resolve(model.addWire(dipole));
  await Promise.resolve(model.completeGeometry());
  await Promise.resolve(model.definePorts([{ tag: 1, segment: 6, name: "feed" }]));
  await Promise.resolve(model.prepare({ frequencyMHz: 300 }));
}

async function buildR1Reflection(model, fixture) {
  const reflection = fixture.reflection;
  assert.ok(reflection);
  for (const wire of reflection.fundamentalWires) {
    await Promise.resolve(model.addWire(wire));
  }
  const completion = await Promise.resolve(model.completeGeometry({
    groundConnection: fixture.groundConnection,
    symmetry: reflection.symmetry,
  }));
  const ports = Array.from(
    { length: fixture.ports.length },
    (_, index) => ({ tag: index + 1, segment: fixture.feedSegment }),
  );
  await Promise.resolve(model.definePorts(ports));
  await Promise.resolve(model.setGround(fixture.ground));
  await Promise.resolve(model.prepare({ frequencyMHz: fixture.frequencyMHz }));
  return completion;
}

function gatherMatrix(matrix, scatterCallerToGenerated) {
  const order = scatterCallerToGenerated.length;
  const real = new Float64Array(order * order);
  const imag = new Float64Array(order * order);
  for (let row = 0; row < order; row += 1) {
    for (let column = 0; column < order; column += 1) {
      const source = scatterCallerToGenerated[row] * order
        + scatterCallerToGenerated[column];
      const target = row * order + column;
      real[target] = matrix.real[source];
      imag[target] = matrix.imag[source];
    }
  }
  return { real, imag };
}

test("worker Z matrices and fields match direct-mode results", {
  skip: !hasWasm && "WASM artifacts have not been built",
}, async () => {
  const direct = await createNecModel();
  const worker = await createNecWorkerModel();
  try {
    buildDipole(direct);
    await buildDipole(worker);

    const directZ = direct.computeImpedanceMatrix();
    const workerZ = await worker.computeImpedanceMatrix();
    assert.equal(workerZ.impedance.order, "row-major");
    assert.ok(relativeError(directZ.impedance.real, workerZ.impedance.real) <= 1e-12);
    assert.ok(relativeError(directZ.impedance.imag, workerZ.impedance.imag) <= 1e-12);
    assert.ok(relativeError(directZ.admittance.real, workerZ.admittance.real) <= 1e-12);
    assert.ok(relativeError(directZ.admittance.imag, workerZ.admittance.imag) <= 1e-12);

    const voltages = {
      real: new Float64Array([1]),
      imag: new Float64Array([0]),
    };
    direct.solveVoltages(voltages);
    await worker.solveVoltages(voltages);

    const directField = direct.computeFarField(farFieldRequest);
    const workerField = await worker.computeFarField(farFieldRequest);
    assert.equal(workerField.radiusM, directField.radiusM);
    assert.deepEqual([...workerField.thetaDeg], [...directField.thetaDeg]);
    assert.ok(relativeError(directField.eThetaReal, workerField.eThetaReal) <= 1e-12);
    assert.ok(relativeError(directField.ePhiImag, workerField.ePhiImag) <= 1e-12);
  } finally {
    direct.dispose();
    await worker.dispose();
  }
});

test("R1 reflection metadata, gathered Z, and fields agree in direct and worker modes", {
  skip: !hasWasm && "WASM artifacts have not been built",
}, async () => {
  const fixture = createReferenceArrayFixture();
  const reflection = fixture.reflection;
  assert.ok(reflection);
  const direct = await createNecModel();
  const worker = await createNecWorkerModel();
  try {
    const [directCompletion, workerCompletion] = await Promise.all([
      buildR1Reflection(direct, fixture),
      buildR1Reflection(worker, fixture),
    ]);
    assert.deepEqual(workerCompletion, directCompletion);
    assert.equal(directCompletion.symmetry.sectionCount, 4);
    assert.equal(directCompletion.symmetry.fundamentalSegmentCount, 44);
    assert.equal(directCompletion.symmetry.fullSegmentCount, 176);
    assert.deepEqual(
      directCompletion.symmetry.copies.map((copy) => copy.transform.signs),
      reflection.copies.map((copy) => copy.transform.signs),
    );
    assert.ok(Object.isFrozen(directCompletion.symmetry.copies));
    assert.ok(Object.isFrozen(workerCompletion.symmetry.copies));

    const [directMatrices, workerMatrices] = await Promise.all([
      Promise.resolve(direct.computeImpedanceMatrix()),
      worker.computeImpedanceMatrix(),
    ]);
    const directZ = gatherMatrix(
      directMatrices.impedance,
      reflection.scatterCallerToGenerated,
    );
    const workerZ = gatherMatrix(
      workerMatrices.impedance,
      reflection.scatterCallerToGenerated,
    );
    assert.ok(relativeError(directZ.real, workerZ.real) <= 1e-12);
    assert.ok(relativeError(directZ.imag, workerZ.imag) <= 1e-12);

    const callerReal = Float64Array.from(
      { length: fixture.ports.length },
      (_, index) => Math.cos(index * 0.37),
    );
    const callerImag = Float64Array.from(
      { length: fixture.ports.length },
      (_, index) => Math.sin(index * 0.37),
    );
    const nativeReal = new Float64Array(fixture.ports.length);
    const nativeImag = new Float64Array(fixture.ports.length);
    for (let caller = 0; caller < fixture.ports.length; caller += 1) {
      const native = reflection.scatterCallerToGenerated[caller];
      nativeReal[native] = callerReal[caller];
      nativeImag[native] = callerImag[caller];
    }
    const currents = { real: nativeReal, imag: nativeImag };
    await Promise.all([
      Promise.resolve(direct.solveCurrents(currents)),
      worker.solveCurrents(currents),
    ]);
    const [directField, workerField] = await Promise.all([
      Promise.resolve(direct.computeFarField(farFieldRequest)),
      worker.computeFarField(farFieldRequest),
    ]);
    for (const component of [
      "eThetaReal",
      "eThetaImag",
      "ePhiReal",
      "ePhiImag",
    ]) {
      assert.ok(relativeError(directField[component], workerField[component]) <= 1e-12);
    }
  } finally {
    direct.dispose();
    await worker.dispose();
  }
});

test("incomplete symmetric load orbits retain typed failure details across workers", {
  skip: !hasWasm && "WASM artifacts have not been built",
}, async () => {
  const progress = [];
  const direct = await createNecModel();
  const worker = await createNecWorkerModel({
    onProgress: (event) => progress.push(`${event.operation}:${event.phase}`),
  });
  const configure = async (model) => {
    await Promise.resolve(model.addWire({
      tag: 1,
      segments: 11,
      start: [0.25, 0.25, 0.1],
      end: [0.25, 0.25, 0.4],
      radiusM: 0.001,
    }));
    await Promise.resolve(model.completeGeometry({
      symmetry: {
        kind: "reflection",
        planes: ["x=0", "y=0"],
        tagIncrement: 1,
      },
    }));
    await Promise.resolve(model.definePorts(
      [1, 2, 3, 4].map((tag) => ({ tag, segment: 6 })),
    ));
    await Promise.resolve(model.addLoad({
      kind: "impedance",
      target: { tag: 1 },
      resistanceOhm: 25,
      reactanceOhm: 0,
    }));
  };
  try {
    await configure(direct);
    await configure(worker);
    const isIncompleteLoadError = (error) => error instanceof NecGeometryError
      && error.code === "NEC_GEOMETRY"
      && error.details?.symmetryFailure === "INCOMPLETE_LOAD_ORBIT";
    assert.throws(
      () => direct.prepare({ frequencyMHz: 300 }),
      isIncompleteLoadError,
    );
    await assert.rejects(
      worker.prepare({ frequencyMHz: 300 }),
      isIncompleteLoadError,
    );
    assert.equal(direct.state, "geometry-complete");
    assert.equal(worker.state, "geometry-complete");
    assert.ok(progress.includes("prepare:start"));
    assert.ok(progress.includes("prepare:complete"));
  } finally {
    direct.dispose();
    await worker.dispose();
  }
});

test("two real worker models remain isolated", {
  skip: !hasWasm && "WASM artifacts have not been built",
}, async () => {
  const first = await createNecWorkerModel();
  const second = await createNecWorkerModel();
  try {
    await buildDipole(first);
    await buildDipole(second);
    await first.prepare({ frequencyMHz: 150 });
    await second.prepare({ frequencyMHz: 300 });

    const [firstZ, secondZ] = await Promise.all([
      first.computeImpedanceMatrix(),
      second.computeImpedanceMatrix(),
    ]);
    assert.equal(firstZ.frequencyMHz, 150);
    assert.equal(secondZ.frequencyMHz, 300);
    assert.notEqual(firstZ.impedance.real[0], secondZ.impedance.real[0]);
  } finally {
    await first.dispose();
    await second.dispose();
  }
});

test("terminating a real worker rejects outstanding work", {
  skip: !hasWasm && "WASM artifacts have not been built",
}, async () => {
  const model = await createNecWorkerModel();
  await buildDipole(model);
  const pending = model.computeFarField({
    radiusM: 1,
    theta: { startDeg: 0, count: 37, stepDeg: 5 },
    phi: { startDeg: 0, count: 73, stepDeg: 5 },
  });
  model.terminate();
  await assert.rejects(pending, (error) => error.message.includes("terminated"));
  assert.equal(model.state, "disposed");
});
