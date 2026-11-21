// The scan element pattern at the package seam: built from a scan sweep and
// evaluated in any direction, compared with direct solves at the scan states
// pointing that way. The interpolant itself is tested without WASM in
// scan-pattern-interpolant.test.mjs.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import {
  NecCancellationError,
  NecInputError,
  NecStateError,
  createNecPeriodicModel,
} from "../.test-build/src/index.js";
import { necPeriodicWavenumberPerM } from "../.test-build/src/nec-constants.js";
import { FREQUENCY_MHZ, dipoleCell } from "./periodic-reference.mjs";

const hasWasm = existsSync(new URL("../.test-build/src/nec2pp.wasm", import.meta.url));
const skip = !hasWasm && "WASM artifacts have not been built";

// The kernel's wavenumber: (u, v) = kt0 / k exactly as the pattern samples it.
const K_PER_M = necPeriodicWavenumberPerM(FREQUENCY_MHZ);
// Grating lobes in visible space: Wood circles of (+-1, 0) and (0, +-1).
const LATTICE = { a1M: [0.7, 0], a2M: [0, 0.6] };

/** A deterministic sequence in [0, 1). */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** The (0, 0) amplitudes of a direct solve at the scan state pointing to (u, v). */
function directAmplitudes(cell, lattice, u, v, side = "above") {
  const scanPhasesRad = [
    -K_PER_M * (u * lattice.a1M[0] + v * lattice.a1M[1]),
    -K_PER_M * (u * lattice.a2M[0] + v * lattice.a2M[1]),
  ];
  const result = cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanPhasesRad });
  return result.floquet.modes.find((mode) => mode.p === 0 && mode.q === 0 && mode.side === side);
}

/** sqrt(|te - te'|^2 + |tm - tm'|^2) of one port. */
function amplitudeError(value, reference, port) {
  return Math.hypot(
    value.te.real[port] - reference.te.real[port],
    value.te.imag[port] - reference.te.imag[port],
    value.tm.real[port] - reference.tm.real[port],
    value.tm.imag[port] - reference.tm.imag[port],
  );
}

function amplitudeNorm(value, port) {
  return Math.hypot(value.te.real[port], value.te.imag[port], value.tm.real[port], value.tm.imag[port]);
}

let shared;
/** A free-space dipole cell on LATTICE and its pattern at spacing 0.2, built once. */
function freeSpacePattern() {
  shared ??= (async () => {
    const cell = await dipoleCell([[0, 0]]);
    cell.setLattice(LATTICE);
    const pattern = await cell.computeScanElementPattern({
      frequencyMHz: FREQUENCY_MHZ,
      grid: { spacingUV: 0.2 },
    });
    return { cell, pattern };
  })();
  return shared;
}

test.after(async () => {
  if (shared !== undefined) (await shared).cell.dispose();
});

test("at its sweep points the pattern returns the solved (0,0) amplitudes exactly", { skip }, async () => {
  const { cell, pattern } = await freeSpacePattern();
  assert.deepEqual(pattern.sides, ["above", "below"]);
  assert.equal(pattern.portCount, 1);
  assert.equal(pattern.spacingUV, 0.2);
  assert.ok(pattern.samples.length > 500);
  for (const sample of pattern.samples.filter((_, index) => index % 40 === 0)) {
    for (const side of ["above", "below"]) {
      const value = pattern.evaluate({ u: sample.u, v: sample.v }, side);
      assert.equal(value.sampled, true);
      assert.deepEqual([...value.interpolationError], [0]);
      for (const component of ["te", "tm"]) {
        assert.deepEqual([...value[component].real], [...sample[side][component].real]);
        assert.deepEqual([...value[component].imag], [...sample[side][component].imag]);
      }
    }
    // The samples are the sweep's solves: those of a direct solve.
    const direct = directAmplitudes(cell, LATTICE, sample.u, sample.v);
    assert.ok(amplitudeError(sample.above, direct, 0) <= 1e-9 * amplitudeNorm(direct, 0));
  }
});

test("between sweep points the pattern stays close to direct solves, within its stated error at 95 % of points", { skip }, async () => {
  const { cell, pattern } = await freeSpacePattern();
  const next = random(30);
  const directions = [];
  for (let index = 0; index < 30; index += 1) {
    const radius = Math.sqrt(next()) * 0.999;
    const angle = 2 * Math.PI * next();
    directions.push([radius * Math.cos(angle), radius * Math.sin(angle)]);
  }
  // Close to every grating-lobe circle, on both sides.
  for (const { centreUV: [cu, cv] } of pattern.woodCircles.slice(1)) {
    const angle = Math.atan2(-cv, -cu) + 0.3 * (next() - 0.5);
    for (const offset of [1e-2, 1e-3, -1e-3, -1e-2]) {
      directions.push([cu + (1 + offset) * Math.cos(angle), cv + (1 + offset) * Math.sin(angle)]);
    }
  }
  const relative = [];
  const ratios = [];
  for (const [u, v] of directions) {
    for (const side of ["above", "below"]) {
      const value = pattern.evaluate({ u, v }, side);
      const direct = directAmplitudes(cell, LATTICE, u, v, side);
      const error = amplitudeError(value, direct, 0);
      ratios.push(error / value.interpolationError[0]);
      relative.push(error / amplitudeNorm(direct, 0));
    }
  }
  relative.sort((left, right) => left - right);
  ratios.sort((left, right) => left - right);
  // Spacing 0.2 with refinement: measured median 1e-4 of the amplitude.
  assert.ok(relative[relative.length >> 1] < 2e-3, `median relative error ${relative[relative.length >> 1]}`);
  // The stated error is an estimate. Over 400 random directions it covered
  // 99.5 %; it fell short, by up to 3x, only where two Wood circles (or one
  // and the horizon) are both within kappa ~ 0.3.
  assert.ok(ratios.filter((ratio) => ratio <= 1).length >= 0.95 * ratios.length, `error / stated ${ratios}`);
  assert.ok(ratios.at(-1) < 5, `largest error / stated ${ratios.at(-1)}`);
});

test("the null of a Wood anomaly is resolved on both sides of its Wood circle", { skip }, async () => {
  const { cell, pattern } = await freeSpacePattern();
  // At the onset of the (1, 0) grating lobe, along the E-plane, the pattern of
  // this dipole array drops to a null on the Wood circle and recovers within
  // |kz| / k ~ 0.01 on either side: interpolating across the circle, or
  // over-smoothing along it, fills the null in.
  const circle = pattern.woodCircles.find(({ p, q }) => p === 1 && q === 0);
  const [cu, cv] = circle.centreUV;
  const angle = Math.atan2(0.15 - cv, -0.45 - cu);
  const peak = Math.max(...pattern.samples.map((sample) => amplitudeNorm(sample.above, 0)));
  const values = [];
  for (const kappa of [-0.03, -0.01, -3e-3, -1e-3, 1e-3, 3e-3, 1e-2, 3e-2]) {
    // kappa < 0: inside the circle, where the grating lobe propagates.
    const radius = Math.sqrt(1 - Math.sign(kappa) * kappa * kappa);
    const [u, v] = [cu + radius * Math.cos(angle), cv + radius * Math.sin(angle)];
    const value = pattern.evaluate({ u, v });
    const direct = directAmplitudes(cell, LATTICE, u, v);
    const error = amplitudeError(value, direct, 0);
    assert.ok(error <= value.interpolationError[0], `kappa ${kappa}: error ${error}, stated ${value.interpolationError[0]}`);
    // Refinement aims at 1 % of the peak.
    assert.ok(error < 0.03 * peak, `kappa ${kappa}: error ${error}, peak ${peak}`);
    values.push(amplitudeNorm(value, 0));
  }
  // The null: smallest next to the circle, on each side.
  assert.ok(values[3] < 0.1 * values[0], `propagating side ${values.slice(0, 4)}`);
  assert.ok(values[4] < 0.2 * values[7], `evanescent side ${values.slice(4)}`);
  // Refinement put the samples that resolve it next to the circle.
  const refined = pattern.samples.filter((sample) => sample.round > 0
    && Math.abs(Math.hypot(sample.u - cu, sample.v - cv) - 1) < 1e-2
    && Math.abs(Math.atan2(sample.v - cv, sample.u - cu) - angle) < 0.2);
  assert.ok(refined.length > 10, `${refined.length} refined samples near the null`);
});

test("a scan-blindness notch next to a Wood circle is resolved", { skip }, async () => {
  // x-dipoles 0.25 wavelengths over ground with three layers of shorter
  // parasitic dipoles above them, rows 0.65 wavelengths apart: in the H-plane
  // the pattern drops to a null at v = 0.452, 0.086 before the onset of the
  // (0, -1) grating lobe at v = 0.538, where a guided wave along the
  // parasitic layers is phase-matched to the scan.
  const cell = await createNecPeriodicModel();
  try {
    cell.addWire({ tag: 1, segments: 5, start: [-0.24, 0, 0.25], end: [0.24, 0, 0.25], radiusM: 0.002 });
    [0.4, 0.55, 0.7].forEach((z, index) => {
      cell.addWire({ tag: 2 + index, segments: 5, start: [-0.22, 0, z], end: [0.22, 0, z], radiusM: 0.002 });
    });
    cell.completeGeometry();
    cell.definePorts([{ tag: 1, segment: 3 }]);
    cell.setGround({ kind: "perfect" });
    const lattice = { a1M: [0.5, 0], a2M: [0, 0.65] };
    cell.setLattice(lattice);
    // Samples along the H-plane cut 0.05 apart, too coarse for the notch on
    // their own; refinement has to find it.
    const cut = Array.from({ length: 13 }, (_, index) => ({ u: 0, v: 0.1 + 0.05 * index }));
    const pattern = await cell.computeScanElementPattern({
      frequencyMHz: FREQUENCY_MHZ,
      grid: { spacingUV: 0.4, points: cut },
      refinement: { maxRounds: 3, maxSamples: 700 },
    });
    const onset = 2 * Math.PI / lattice.a2M[1] / K_PER_M - 1;
    let interpolatedMinimum = Infinity;
    let directMinimum = Infinity;
    let peak = 0;
    for (let v = 0.3; v < 0.65; v += 0.0071) {
      const value = pattern.evaluate({ u: 0, v });
      const direct = directAmplitudes(cell, lattice, 0, v);
      const error = amplitudeError(value, direct, 0);
      assert.ok(error <= value.interpolationError[0], `v ${v}: error ${error}, stated ${value.interpolationError[0]}`);
      peak = Math.max(peak, amplitudeNorm(direct, 0));
      if (v > 0.4 && v < 0.5) {
        interpolatedMinimum = Math.min(interpolatedMinimum, amplitudeNorm(value, 0));
        directMinimum = Math.min(directMinimum, amplitudeNorm(direct, 0));
      }
    }
    // The notch is not filled in: at the same directions, the interpolated
    // minimum is close to the solved one, far below the peak.
    assert.ok(directMinimum < 0.05 * peak, `direct minimum ${directMinimum}, peak ${peak}`);
    assert.ok(interpolatedMinimum < directMinimum + 0.02 * peak,
      `interpolated minimum ${interpolatedMinimum}, direct ${directMinimum}, peak ${peak}`);
    // Across the Wood circle, on both sides of the onset.
    for (const v of [onset - 1e-3, onset + 1e-3]) {
      const value = pattern.evaluate({ u: 0, v });
      const error = amplitudeError(value, directAmplitudes(cell, lattice, 0, v), 0);
      assert.ok(error <= value.interpolationError[0], `v ${v}: error ${error}, stated ${value.interpolationError[0]}`);
    }
    assert.ok(pattern.samples.some((sample) => sample.round > 0 && Math.hypot(sample.u, sample.v - 0.452) < 0.03));
  } finally {
    cell.dispose();
  }
});

test("explicit points and a manual spacing are honoured", { skip }, async () => {
  const cell = await dipoleCell([[0, 0]]);
  try {
    cell.setLattice({ a1M: [0.5, 0], a2M: [0, 0.5] });
    const points = [{ u: 0.11, v: 0.07 }, { u: -0.4, v: 0.3 }, { u: 0.2, v: -0.65 }];
    let progress;
    const pattern = await cell.computeScanElementPattern(
      { frequencyMHz: FREQUENCY_MHZ, grid: { spacingUV: 0.3, points } },
      { onProgress: (event) => { progress = event; } },
    );
    assert.equal(pattern.spacingUV, 0.3);
    for (const point of points) {
      const sample = pattern.samples.find(({ u, v }) => u === point.u && v === point.v);
      assert.ok(sample !== undefined, `(${point.u}, ${point.v}) not sampled`);
      assert.equal(pattern.evaluate(point).sampled, true);
    }
    // No square grid: every other sample of the grid lies on a row along the horizon.
    const others = pattern.samples.filter(({ u, v, round }) =>
      round === 0 && !points.some((point) => point.u === u && point.v === v));
    assert.ok(others.every(({ u, v }) => Math.sqrt(1 - u * u - v * v) <= 0.5 + 1e-9));
    assert.equal(progress.completed, pattern.samples.length);
    assert.equal(progress.total, pattern.samples.length);
    assert.equal(progress.round, Math.max(...pattern.samples.map((sample) => sample.round)));
  } finally {
    cell.dispose();
  }
});

test("over ground the pattern has no side below the cell", { skip }, async () => {
  const cell = await createNecPeriodicModel();
  try {
    cell.addWire({ tag: 1, segments: 11, start: [-0.24, 0, 0.25], end: [0.24, 0, 0.25], radiusM: 0.001 });
    cell.completeGeometry();
    cell.definePorts([{ tag: 1, segment: 6 }]);
    cell.setGround({ kind: "perfect" });
    cell.setLattice({ a1M: [0.5, 0], a2M: [0, 0.5] });
    const pattern = await cell.computeScanElementPattern({ frequencyMHz: FREQUENCY_MHZ, grid: { spacingUV: 0.4 } });
    assert.deepEqual(pattern.sides, ["above"]);
    assert.ok(pattern.samples.every((sample) => sample.below === undefined));
    assert.throws(() => pattern.evaluate({ u: 0.1, v: 0.2 }, "below"), NecInputError);
    // Angles and u-v give the same direction.
    const byAngles = pattern.evaluate({ thetaDeg: 30, phiDeg: 40 });
    const s = Math.sin(Math.PI / 6);
    const byUV = pattern.evaluate({ u: s * Math.cos(40 * Math.PI / 180), v: s * Math.sin(40 * Math.PI / 180) });
    assert.ok(amplitudeError(byAngles, byUV, 0) <= 1e-12 * amplitudeNorm(byUV, 0));
  } finally {
    cell.dispose();
  }
});

test("pattern requests and directions are validated, and a sweep can be aborted", { skip }, async () => {
  const cell = await dipoleCell([[0, 0]]);
  try {
    await assert.rejects(cell.computeScanElementPattern({ frequencyMHz: FREQUENCY_MHZ }), NecStateError);
    cell.setLattice({ a1M: [0.5, 0], a2M: [0, 0.5] });
    for (const request of [
      { frequencyMHz: -1 },
      { frequencyMHz: FREQUENCY_MHZ, grid: "fine" },
      { frequencyMHz: FREQUENCY_MHZ, grid: { spacingUV: 0 } },
      { frequencyMHz: FREQUENCY_MHZ, grid: { spacingUV: 0.6 } },
      { frequencyMHz: FREQUENCY_MHZ, grid: { points: [{ u: 1, v: 0 }] } },
      { frequencyMHz: FREQUENCY_MHZ, grid: { points: {} } },
      { frequencyMHz: FREQUENCY_MHZ, normalization: { kind: "unit-current", valueA: 2 } },
    ]) {
      await assert.rejects(cell.computeScanElementPattern(request), NecInputError, JSON.stringify(request));
    }
    await assert.rejects(
      cell.computeScanElementPattern({ frequencyMHz: FREQUENCY_MHZ }, { onProgress: 1 }),
      NecInputError,
    );
    const controller = new AbortController();
    controller.abort();
    // More explicit points than the automatic grid's limit are kept, not
    // widened away (the grid is built, then the aborted sweep stops).
    const many = Array.from({ length: 8100 }, (_, index) => ({
      u: 0.9 * (index / 8100) * Math.cos(index),
      v: 0.9 * (index / 8100) * Math.sin(index),
    }));
    await assert.rejects(
      cell.computeScanElementPattern({ frequencyMHz: FREQUENCY_MHZ, grid: { points: many } }, { signal: controller.signal }),
      NecCancellationError,
    );
    await assert.rejects(cell.computeScanElementPattern({ frequencyMHz: FREQUENCY_MHZ }, { workers: 9 }), NecInputError);
    await assert.rejects(
      cell.computeScanElementPattern({ frequencyMHz: FREQUENCY_MHZ, grid: { spacingUV: 0.4 } }, { signal: controller.signal }),
      NecCancellationError,
    );
    const pattern = await cell.computeScanElementPattern({
      frequencyMHz: FREQUENCY_MHZ,
      normalization: { kind: "unit-current", valueA: 1 },
      grid: { spacingUV: 0.4 },
    });
    assert.deepEqual(pattern.normalization, { kind: "unit-current", valueA: 1 });
    assert.throws(() => pattern.evaluate({ u: 0.8, v: 0.7 }), NecInputError);
    assert.throws(() => pattern.evaluate({ thetaDeg: 95, phiDeg: 0 }), NecInputError);
    assert.throws(() => pattern.evaluate({ u: Number.NaN, v: 0 }), NecInputError);
    assert.throws(() => pattern.evaluate({ u: 0.1, v: 0 }, "sideways"), NecInputError);
  } finally {
    cell.dispose();
  }
});
