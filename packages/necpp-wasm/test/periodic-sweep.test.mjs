// Scan sweeps: many scan states at one frequency. A scan change at a fixed
// frequency reuses the scan-independent part of the fill (the free-space
// matrix and the sum over lattice points), so it is cheaper than a solve at
// a new frequency.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import { NecCancellationError } from "../.test-build/src/index.js";
import { createNecPeriodicWorkerModel } from "../.test-build/src/worker.js";
import { FREQUENCY_MHZ, WAVENUMBER_PER_M, dipoleCell, relativeMatrixError } from "./periodic-reference.mjs";

const hasWasm = existsSync(new URL("../.test-build/src/nec2pp.wasm", import.meta.url));
const skip = !hasWasm && "WASM artifacts have not been built";

const LATTICE = { a1M: [0.62, 0], a2M: [0.1, 0.55] };

/** Shortest of `runs` wall-clock times of `solve(run)`, in ms. */
function bestTime(runs, solve) {
  let best = Infinity;
  for (let run = 0; run < runs; run += 1) {
    const started = performance.now();
    solve(run);
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

test("a scan change at a fixed frequency is cheaper than a solve at a new frequency", { skip }, async () => {
  const cell = await dipoleCell([[0, 0], [0.05, 0.27]], undefined, 21);
  try {
    cell.setLattice(LATTICE);
    cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanPhasesRad: [0, 0] });
    // A new frequency each time: the whole fill.
    const fresh = bestTime(3, (run) => {
      cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ * (1.01 + 0.01 * run), scanPhasesRad: [0.4, 0.1] });
    });
    cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanPhasesRad: [0, 0] });
    const scanOnly = bestTime(3, (run) => {
      cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanPhasesRad: [0.4 + 0.3 * run, 0.1] });
    });
    // About 2x expected: the sum over lattice points is half the fill.
    assert.ok(scanOnly < 0.75 * fresh, `scan-only ${scanOnly.toFixed(0)} ms, fresh ${fresh.toFixed(0)} ms`);
  } finally {
    cell.dispose();
  }
});

// On the Wood circle of the mode kt0 + b1 at psi2 = 0: kt0 = -psi1 b1 / (2 pi),
// so |kt0 + b1| = (1 - psi1 / (2 pi)) |b1| = k.
const B1_LENGTH = (2 * Math.PI * Math.hypot(LATTICE.a2M[0], LATTICE.a2M[1]))
  / (LATTICE.a1M[0] * LATTICE.a2M[1] - LATTICE.a1M[1] * LATTICE.a2M[0]);
const WOOD_PSI1 = 2 * Math.PI * (1 - WAVENUMBER_PER_M / B1_LENGTH);

// Scan states across visible and invisible space; the third on a Wood circle.
const SCAN_STATES = [
  { scanPhasesRad: [0, 0] },
  { scanDirection: { thetaDeg: 35, phiDeg: 20 } },
  { scanPhasesRad: [WOOD_PSI1, 0] },
  { scanPhasesRad: [-2.4, 2.9] },
  { scanPhasesRad: [1.2, -0.7] },
  { scanDirection: { thetaDeg: 60, phiDeg: 135 } },
  { scanPhasesRad: [3.1, 3.1] },
  { scanPhasesRad: [-0.3, 1.6] },
];

async function collect(sweep) {
  const chunks = [];
  for await (const chunk of sweep) chunks.push(chunk);
  return chunks;
}

function assertSameAsSingleSolves(chunks, singles) {
  const seen = new Set();
  let completed = 0;
  for (const chunk of chunks) {
    assert.ok(chunk.points.length > 0);
    completed += chunk.points.length;
    assert.equal(chunk.completed, completed);
    assert.equal(chunk.total, singles.length);
    for (const { index, result } of chunk.points) {
      assert.equal(seen.has(index), false, `scan state ${index} delivered twice`);
      seen.add(index);
      const single = singles[index];
      assert.deepEqual(result.scanPhasesRad, single.scanPhasesRad);
      assert.deepEqual(result.diagnostics, single.diagnostics);
      assert.equal(result.frequencyMHz, single.frequencyMHz);
      assert.ok(relativeMatrixError(result.impedance, single.impedance) < 1e-12, `scan state ${index}`);
      assert.ok(relativeMatrixError(result.admittance, single.admittance) < 1e-12, `scan state ${index}`);
    }
  }
  assert.equal(seen.size, singles.length);
}

test("a sweep returns the results of the equivalent single solves, in chunks", { skip }, async () => {
  const cell = await dipoleCell([[0, 0], [0.05, 0.27]]);
  try {
    cell.setLattice(LATTICE);
    const singles = SCAN_STATES.map((state) => cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, ...state }));
    assert.equal(singles[2].diagnostics.status, "near-cutoff");
    const chunks = await collect(cell.sweepScanImpedance(
      { frequencyMHz: FREQUENCY_MHZ, scanStates: SCAN_STATES },
      { workers: 2 },
    ));
    assert.ok(chunks.length > 1, `${chunks.length} chunk(s)`);
    assertSameAsSingleSolves(chunks, singles);
  } finally {
    cell.dispose();
  }
});

test("a worker model's sweep returns the results of its single solves", { skip }, async () => {
  const cell = await createNecPeriodicWorkerModel();
  try {
    // The workers replay the wire as passed, not as changed afterwards.
    const wire = { tag: 1, segments: 11, start: [-0.24, 0, 0.2], end: [0.24, 0, 0.2], radiusM: 0.001 };
    await cell.addWire(wire);
    wire.start[2] = 0.35;
    await cell.completeGeometry();
    await cell.definePorts([{ tag: 1, segment: 6 }]);
    await cell.setGround({ kind: "perfect" });
    // Recorded for the sweep workers only once it succeeds.
    await assert.rejects(cell.setLattice({ a1M: [0.001, 0], a2M: [0, 0.5] }));
    await cell.setLattice(LATTICE);
    const states = SCAN_STATES.slice(0, 4);
    const singles = [];
    for (const state of states) singles.push(await cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, ...state }));
    // The sweep solves the cell as it is when sweepScanImpedance is called.
    const sweep = cell.sweepScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanStates: states }, { workers: 2 });
    await cell.setLattice({ a1M: [0.7, 0], a2M: [0, 0.6] });
    assertSameAsSingleSolves(await collect(sweep), singles);
  } finally {
    await cell.dispose();
  }
});

test("aborting a sweep rejects it at once and frees the workers for the next sweep", { skip }, async () => {
  const cell = await dipoleCell([[0, 0], [0.05, 0.27]]);
  try {
    cell.setLattice(LATTICE);
    cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanPhasesRad: [0, 0] });
    const single = bestTime(3, (run) => {
      cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanPhasesRad: [0.2 * run, 0.5] });
    });

    const controller = new AbortController();
    const states = Array.from({ length: 24 }, (_, index) => ({ scanPhasesRad: [0.1 * index, -0.05 * index] }));
    const sweep = cell.sweepScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanStates: states }, {
      workers: 2,
      signal: controller.signal,
    })[Symbol.asyncIterator]();
    const first = await sweep.next();
    assert.equal(first.done, false);
    controller.abort();
    await assert.rejects(sweep.next(), (error) => error instanceof NecCancellationError);

    // Each worker finishes at most the one scan state it was solving; the
    // other twenty-odd are never dispatched, which would take about eleven
    // single solves per worker.
    const started = performance.now();
    const chunks = await collect(cell.sweepScanImpedance(
      { frequencyMHz: FREQUENCY_MHZ, scanStates: states.slice(0, 2) },
      { workers: 2 },
    ));
    const elapsed = performance.now() - started;
    assert.equal(chunks.at(-1).completed, 2);
    assert.ok(elapsed < 6 * single, `next sweep ${elapsed.toFixed(0)} ms, single solve ${single.toFixed(0)} ms`);
  } finally {
    cell.dispose();
  }
});
