import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import { createNecModel } from "../.test-build/src/index.js";
import { createNecWorkerModel } from "../.test-build/src/worker.js";

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
