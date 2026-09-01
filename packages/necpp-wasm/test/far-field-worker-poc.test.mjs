import assert from "node:assert/strict";
import test from "node:test";

import { createNecModel } from "../.test-build/src/index.js";
import {
  FarFieldWorkerPool,
  StaleFarFieldJobError,
} from "../.test-build/src/field-worker-pool.js";

function maximumScaledDifference(referenceReal, referenceImag, real, imag) {
  let scale = 1;
  let difference = 0;
  for (let index = 0; index < real.length; index += 1) {
    scale = Math.max(scale, Math.hypot(referenceReal[index], referenceImag[index]));
    difference = Math.max(difference, Math.hypot(
      referenceReal[index] - real[index], referenceImag[index] - imag[index],
    ));
  }
  return difference / scale;
}

async function solvedPerfectGroundDipole() {
  const model = await createNecModel();
  model.addWire({
    tag: 1, segments: 11,
    start: [-0.235, 0, 0.25], end: [0.235, 0, 0.25], radiusM: 0.001,
  });
  model.completeGeometry();
  model.definePorts([{ tag: 1, segment: 6 }]);
  model.setGround({ kind: "perfect" });
  model.prepare({ frequencyMHz: 300 });
  model.solveVoltages({ real: new Float64Array([1]), imag: new Float64Array([0]) });
  return model;
}

test("one stateless evaluator matches the serial perfect-ground field", async () => {
  const model = await solvedPerfectGroundDipole();
  const pool = new FarFieldWorkerPool(1, 37);
  try {
    const snapshot = model.captureFarFieldEvaluationSnapshot();
    assert.equal(snapshot.capability, "supported");
    assert.equal(snapshot.segmentCount, 11);
    assert.equal(snapshot.solutionGeneration, 1);
    await pool.setSnapshot(snapshot);
    const request = {
      radiusM: 1,
      theta: { startDeg: 0, count: 31, stepDeg: 3 },
      phi: { startDeg: 0, count: 40, stepDeg: 9 },
    };
    const serial = model.computeFarField(request);
    const parallel = await pool.computeFarField(request);
    assert.deepEqual([...parallel.thetaDeg], [...serial.thetaDeg]);
    assert.deepEqual([...parallel.phiDeg], [...serial.phiDeg]);
    const thetaError = maximumScaledDifference(
      serial.eThetaReal, serial.eThetaImag,
      parallel.eThetaReal, parallel.eThetaImag,
    );
    const phiError = maximumScaledDifference(
      serial.ePhiReal, serial.ePhiImag,
      parallel.ePhiReal, parallel.ePhiImag,
    );
    assert.ok(thetaError <= 1e-10, `E-theta scaled error ${thetaError}`);
    assert.ok(phiError <= 1e-10, `E-phi scaled error ${phiError}`);
    assert.equal(parallel.poolDiagnostics.snapshotBytesPerWorker, 11 * 13 * 8);
  } finally {
    pool.dispose();
    model.dispose();
  }
});

test("the full NEC artifact can run in evaluator-only mode", async () => {
  const model = await solvedPerfectGroundDipole();
  const pool = new FarFieldWorkerPool(1, 37, "full-nec");
  try {
    await pool.setSnapshot(model.captureFarFieldEvaluationSnapshot());
    const request = {
      radiusM: 1,
      theta: { startDeg: 0, count: 11, stepDeg: 9 },
      phi: { startDeg: 0, count: 12, stepDeg: 30 },
    };
    const serial = model.computeFarField(request);
    const evaluated = await pool.computeFarField(request);
    assert.ok(maximumScaledDifference(
      serial.eThetaReal, serial.eThetaImag,
      evaluated.eThetaReal, evaluated.eThetaImag,
    ) <= 1e-10);
  } finally {
    pool.dispose();
    model.dispose();
  }
});

test("the tile pool restarts a failed evaluator without mixed generations", async () => {
  const model = await solvedPerfectGroundDipole();
  const pool = new FarFieldWorkerPool(2, 29);
  try {
    await pool.setSnapshot(model.captureFarFieldEvaluationSnapshot());
    pool.terminateEvaluatorForTest(0);
    const field = await pool.computeFarField({
      radiusM: 1,
      theta: { startDeg: 0, count: 21, stepDeg: 4.5 },
      phi: { startDeg: 0, count: 20, stepDeg: 18 },
    });
    assert.equal(field.eThetaReal.length, 420);
    assert.ok(field.eThetaReal.every(Number.isFinite));
    assert.equal(field.poolDiagnostics.restartedWorkers, 1);
  } finally {
    pool.dispose();
    model.dispose();
  }
});

test("a superseded job stops dispatching and cannot publish mixed output", async () => {
  const model = await solvedPerfectGroundDipole();
  const pool = new FarFieldWorkerPool(2, 17);
  try {
    await pool.setSnapshot(model.captureFarFieldEvaluationSnapshot());
    const request = {
      radiusM: 1,
      theta: { startDeg: 0, count: 61, stepDeg: 1.5 },
      phi: { startDeg: 0, count: 80, stepDeg: 4.5 },
    };
    const stale = pool.computeFarField(request);
    const newest = pool.computeFarField(request);
    await assert.rejects(stale, (error) => error instanceof StaleFarFieldJobError);
    const field = await newest;
    assert.equal(field.eThetaReal.length, 4_880);
  } finally {
    pool.dispose();
    model.dispose();
  }
});

test("a repeated solve broadcasts only the six current arrays", async () => {
  const model = await solvedPerfectGroundDipole();
  const pool = new FarFieldWorkerPool(2, 31);
  try {
    await pool.setSnapshot(model.captureFarFieldEvaluationSnapshot());
    model.solveVoltages({
      real: new Float64Array([0.25]), imag: new Float64Array([-0.5]),
    });
    const next = model.captureFarFieldEvaluationSnapshot();
    assert.equal(next.modelGeneration, 1);
    assert.equal(next.solutionGeneration, 2);
    await pool.setSnapshot(next);
    const request = {
      radiusM: 1,
      theta: { startDeg: 0, count: 21, stepDeg: 4.5 },
      phi: { startDeg: 0, count: 20, stepDeg: 18 },
    };
    const [serial, field] = await Promise.all([
      Promise.resolve(model.computeFarField(request)), pool.computeFarField(request),
    ]);
    assert.equal(field.poolDiagnostics.geometryReused, true);
    assert.equal(field.poolDiagnostics.lastBroadcastBytesPerWorker, 11 * 6 * 8);
    assert.ok(maximumScaledDifference(
      serial.eThetaReal, serial.eThetaImag, field.eThetaReal, field.eThetaImag,
    ) <= 1e-10);
  } finally {
    pool.dispose();
    model.dispose();
  }
});

test("finite-ground snapshots return a capability fallback", async () => {
  const model = await createNecModel();
  try {
    model.addWire({
      tag: 1, segments: 11,
      start: [-0.235, 0, 0.25], end: [0.235, 0, 0.25], radiusM: 0.001,
    });
    model.completeGeometry();
    model.definePorts([{ tag: 1, segment: 6 }]);
    model.setGround({
      kind: "finite",
      method: "reflection-coefficient",
      relativePermittivity: 13,
      conductivitySPerM: 0.005,
    });
    model.prepare({ frequencyMHz: 300 });
    model.solveVoltages({ real: new Float64Array([1]), imag: new Float64Array([0]) });
    const snapshot = model.captureFarFieldEvaluationSnapshot();
    assert.equal(snapshot.capability, "finite-ground");
    assert.equal(snapshot.segmentCount, 0);
  } finally {
    model.dispose();
  }
});
