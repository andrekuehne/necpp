import assert from "node:assert/strict";
import test from "node:test";

import {
  createNecArraySolver,
  NecRuntimeError,
} from "../.test-build/src/index.js";

const perfectDescription = {
  elements: [{ id: "element", positionM: [0, 0], patternId: "dipole" }],
  patterns: [{
    id: "dipole",
    kind: "straight-wire-pattern",
    wires: [{
      id: "wire",
      segments: 11,
      startM: [-0.235, 0, 0.25],
      endM: [0.235, 0, 0.25],
      radiusM: 0.001,
    }],
    ports: [{ wireId: "wire", segment: 6 }],
  }],
  ground: { kind: "perfect" },
};

const smallRequest = {
  radiusM: 1,
  theta: { startDeg: 0, count: 21, stepDeg: 4.5 },
  phi: { startDeg: 0, count: 20, stepDeg: 18 },
};

function maximumScaledDifference(referenceReal, referenceImag, real, imag) {
  let scale = 1;
  let difference = 0;
  for (let index = 0; index < real.length; index += 1) {
    scale = Math.max(scale, Math.hypot(referenceReal[index], referenceImag[index]));
    difference = Math.max(difference, Math.hypot(
      referenceReal[index] - real[index],
      referenceImag[index] - imag[index],
    ));
  }
  return difference / scale;
}

async function solved(options, description = perfectDescription) {
  const solver = await createNecArraySolver(description, {
    symmetry: "off",
    ...options,
  });
  await solver.prepare({ frequencyMHz: 300 });
  await solver.solveVoltages({
    real: new Float64Array([1]),
    imag: new Float64Array([0]),
  });
  return solver;
}

test("production one-worker and evaluator-pool fields are numerically equivalent", async () => {
  const serial = await solved({ fieldWorkers: 1 });
  const pooled = await solved({
    fieldWorkers: 2,
    fieldWorkerAssetBaseUrl: new URL("../.test-build/src/", import.meta.url),
  });
  try {
    const [reference, actual] = await Promise.all([
      serial.computeFarField(smallRequest),
      pooled.computeFarField(smallRequest),
    ]);
    assert.equal(reference.fieldBackend.backend, "serial");
    assert.equal(reference.fieldBackend.fallbackReason, "explicit-one-worker");
    assert.equal(actual.fieldBackend.backend, "worker-pool");
    assert.equal(actual.fieldBackend.activeWorkerCount, 2);
    assert.equal(actual.fieldBackend.tileSize, 512);
    assert.equal(actual.fieldBackend.resultBytes, (4 * 420 + 21 + 20) * 8);
    assert.equal(actual.fieldBackend.completedTiles, actual.fieldBackend.totalTiles);
    assert.equal(actual.fieldBackend.snapshotBytesPerWorker, 11 * 13 * 8);
    assert.ok(maximumScaledDifference(
      reference.eThetaReal,
      reference.eThetaImag,
      actual.eThetaReal,
      actual.eThetaImag,
    ) <= 1e-10);
    assert.ok(maximumScaledDifference(
      reference.ePhiReal,
      reference.ePhiImag,
      actual.ePhiReal,
      actual.ePhiImag,
    ) <= 1e-10);
    assert.equal(pooled.getDiagnostics().field, actual.fieldBackend);

    await pooled.solveVoltages({
      real: new Float64Array([0.25]),
      imag: new Float64Array([-0.5]),
    });
    const updated = await pooled.computeFarField(smallRequest);
    assert.equal(updated.fieldBackend.geometryReused, true);
    assert.equal(updated.fieldBackend.lastBroadcastBytesPerWorker, 11 * 6 * 8);
  } finally {
    await serial.dispose();
    await pooled.dispose();
  }
});

test("auto keeps small fields serial and reports the selection", async () => {
  const solver = await solved({ fieldWorkers: "auto" });
  try {
    const field = await solver.computeFarField({
      theta: { startDeg: 0, count: 5, stepDeg: 22.5 },
      phi: { startDeg: 0, count: 3, stepDeg: 90 },
    });
    assert.equal(field.fieldBackend.backend, "serial");
    assert.equal(field.fieldBackend.requestedWorkers, "auto");
    assert.equal(field.fieldBackend.fallbackReason, "below-auto-threshold");
  } finally {
    await solver.dispose();
  }
});

test("auto exposes its documented large-field backend", async () => {
  const solver = await solved({ fieldWorkers: "auto" });
  try {
    const field = await solver.computeFarField({
      radiusM: 1,
      theta: { startDeg: 0, count: 181, stepDeg: 0.5 },
      phi: { startDeg: 0, count: 360, stepDeg: 1 },
    });
    const cores = globalThis.navigator?.hardwareConcurrency ?? 1;
    if (cores >= 4) {
      assert.equal(field.fieldBackend.backend, "worker-pool");
      assert.equal(field.fieldBackend.activeWorkerCount, cores >= 8 ? 4 : 2);
    } else {
      assert.equal(field.fieldBackend.backend, "serial");
      assert.equal(
        field.fieldBackend.fallbackReason,
        "insufficient-hardware-or-grid",
      );
    }
  } finally {
    await solver.dispose();
  }
});

test("unsupported ground and missing evaluator assets fall back explicitly", async () => {
  const finite = await solved({ fieldWorkers: 2 }, {
    ...perfectDescription,
    ground: {
      kind: "finite",
      method: "reflection-coefficient",
      relativePermittivity: 13,
      conductivitySPerM: 0.005,
    },
  });
  const missingAssets = await solved({
    fieldWorkers: 2,
    fieldWorkerAssetBaseUrl: new URL("./fixtures/missing-field-assets/", import.meta.url),
  });
  try {
    const [finiteField, assetField] = await Promise.all([
      finite.computeFarField(smallRequest),
      missingAssets.computeFarField(smallRequest),
    ]);
    assert.equal(finiteField.fieldBackend.backend, "serial");
    assert.equal(
      finiteField.fieldBackend.fallbackReason,
      "unsupported-finite-ground",
    );
    assert.equal(assetField.fieldBackend.backend, "serial");
    assert.equal(assetField.fieldBackend.fallbackReason, "worker-pool-failed");
    assert.ok(assetField.eThetaReal.every(Number.isFinite));
  } finally {
    await finite.dispose();
    await missingAssets.dispose();
  }
});

test("the public cancellation entry point stops bounded stale tiles", async () => {
  const cancellationDescription = {
    ...perfectDescription,
    patterns: [{
      ...perfectDescription.patterns[0],
      wires: [{
        ...perfectDescription.patterns[0].wires[0],
        segments: 101,
      }],
      ports: [{ wireId: "wire", segment: 51 }],
    }],
  };
  const solver = await solved({ fieldWorkers: 2 }, cancellationDescription);
  const request = {
    radiusM: 1,
    theta: { startDeg: 0, count: 181, stepDeg: 0.5 },
    phi: { startDeg: 0, count: 360, stepDeg: 1 },
  };
  try {
    // Separate lazy worker startup from the cancellation window so the stale
    // request is already dispatching bounded tiles when it is superseded.
    await solver.computeFarField(smallRequest);
    const stale = solver.computeFarField(request);
    const staleRejection = assert.rejects(
      stale,
      (error) => error instanceof NecRuntimeError
        && error.details?.reason === "superseded",
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    solver.cancelFarField();
    await staleRejection;
    const newest = solver.computeFarField(request);
    const field = await newest;
    assert.equal(field.fieldBackend.backend, "worker-pool");
    assert.equal(field.fieldBackend.cancelledJobs, 1);
    assert.ok(field.fieldBackend.cancelledTiles > 0);
    assert.equal(field.fieldBackend.completedTiles, field.fieldBackend.totalTiles);
  } finally {
    await solver.dispose();
  }
});

test("field worker options reject unbounded counts and malformed asset bases", async () => {
  await assert.rejects(
    createNecArraySolver(perfectDescription, { symmetry: "off", fieldWorkers: 9 }),
    (error) => error.code === "NEC_INPUT",
  );
  await assert.rejects(
    createNecArraySolver(perfectDescription, {
      symmetry: "off",
      fieldWorkerAssetBaseUrl: "",
    }),
    (error) => error.code === "NEC_INPUT",
  );
});
