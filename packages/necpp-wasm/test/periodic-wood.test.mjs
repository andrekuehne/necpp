// Wood anomalies. A Floquet mode grazes the lattice plane where its
// transverse wavevector kt = kt0 + p b1 + q b2 has |kt| = k: in the plane of
// kt0, circles of radius k around the reciprocal-lattice points. The scan
// impedance stays finite and continuous there, with a square-root kink, and
// results within |kz| < 1e-3 k of one carry the point status "near-cutoff".
// The circles are predicted here from the lattice vectors alone, independent
// of the solver.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import { createNecPeriodicModel } from "../.test-build/src/index.js";
import { FREQUENCY_MHZ, WAVENUMBER_PER_M as K, distance, entry, magnitude } from "./periodic-reference.mjs";

const hasWasm = existsSync(new URL("../.test-build/src/nec2pp.wasm", import.meta.url));
const skip = !hasWasm && "WASM artifacts have not been built";

const TOLERANCE = 1e-5;

/** Reciprocal vectors of a1, a2: a_i . b_j = 2 pi delta_ij. */
function reciprocal({ a1M: a1, a2M: a2 }) {
  const det = a1[0] * a2[1] - a1[1] * a2[0];
  return [
    [(2 * Math.PI * a2[1]) / det, (-2 * Math.PI * a2[0]) / det],
    [(-2 * Math.PI * a1[1]) / det, (2 * Math.PI * a1[0]) / det],
  ];
}

/** The scan wavevector kt0 of scan phases psi_i = -kt0 . a_i. */
function scanWavevector(lattice, [psi1, psi2]) {
  const [b1, b2] = reciprocal(lattice);
  return [-(psi1 * b1[0] + psi2 * b2[0]) / (2 * Math.PI), -(psi1 * b1[1] + psi2 * b2[1]) / (2 * Math.PI)];
}

const along = (from, to, t) => [from[0] + t * (to[0] - from[0]), from[1] + t * (to[1] - from[1])];

/**
 * Where the straight sweep of scan phases from -> to crosses a Wood circle:
 * the t in (0, 1) at which |kt0(t) + p b1 + q b2| = k, a quadratic in t.
 */
function woodCrossings(lattice, from, to) {
  const [b1, b2] = reciprocal(lattice);
  const start = scanWavevector(lattice, from);
  const end = scanWavevector(lattice, to);
  const step = [end[0] - start[0], end[1] - start[1]];
  const crossings = [];
  for (let p = -4; p <= 4; ++p) {
    for (let q = -4; q <= 4; ++q) {
      const kt = [start[0] + p * b1[0] + q * b2[0], start[1] + p * b1[1] + q * b2[1]];
      const a = step[0] ** 2 + step[1] ** 2;
      const b = 2 * (kt[0] * step[0] + kt[1] * step[1]);
      const c = kt[0] ** 2 + kt[1] ** 2 - K * K;
      const discriminant = b * b - 4 * a * c;
      if (discriminant <= 0) continue;
      for (const sign of [-1, 1]) {
        const t = (-b + sign * Math.sqrt(discriminant)) / (2 * a);
        if (t > 0 && t < 1) crossings.push({ p, q, t });
      }
    }
  }
  return crossings.sort((x, y) => x.t - y.t);
}

/** |kz| / k of the Floquet mode nearest to cut-off. */
function nearestCutoff(lattice, psi) {
  const [b1, b2] = reciprocal(lattice);
  const kt0 = scanWavevector(lattice, psi);
  let nearest = Infinity;
  for (let p = -4; p <= 4; ++p) {
    for (let q = -4; q <= 4; ++q) {
      const kt2 = (kt0[0] + p * b1[0] + q * b2[0]) ** 2 + (kt0[1] + p * b1[1] + q * b2[1]) ** 2;
      nearest = Math.min(nearest, Math.sqrt(Math.abs(1 - kt2 / (K * K))));
    }
  }
  return nearest;
}

// A dipole tilted out of the axes, so that every Floquet mode couples to it.
async function tiltedDipoleCell(lattice) {
  const cell = await createNecPeriodicModel();
  cell.addWire({ tag: 1, segments: 11, start: [-0.2, -0.1, -0.08], end: [0.2, 0.1, 0.08], radiusM: 0.001 });
  cell.completeGeometry();
  cell.definePorts([{ tag: 1, segment: 6 }]);
  cell.setLattice(lattice);
  return cell;
}

// Sweeps of the scan phases that cross four Wood circles each, at least 0.09
// of the sweep apart, in visible and invisible space.
const SWEEPS = [
  {
    name: "rectangular",
    lattice: { a1M: [0.7, 0], a2M: [0, 0.55] },
    from: [2.69, -3.03],
    to: [-3.11, -2.92],
  },
  {
    name: "hexagonal",
    lattice: { a1M: [0.6, 0], a2M: [0.3, 0.3 * Math.sqrt(3)] },
    from: [3.02, -2.19],
    to: [-0.31, -3.07],
  },
];
const STEPS = 160;

for (const { name, lattice, from, to } of SWEEPS) {
  test(`the kinks of the scan impedance on a ${name} lattice lie on the Wood circles of its reciprocal lattice`, {
    skip,
    timeout: 300_000,
  }, async () => {
    const predicted = woodCrossings(lattice, from, to);
    assert.equal(predicted.length, 4, JSON.stringify(predicted));
    const cell = await tiltedDipoleCell(lattice);
    try {
      const solve = (t) => {
        const psi = along(from, to, t);
        return { psi, ...cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanPhasesRad: psi }) };
      };

      const z = [];
      for (let i = 0; i <= STEPS; ++i) {
        const result = solve(i / STEPS);
        const value = entry(result.impedance, 0, 0);
        assert.ok(value.every(Number.isFinite), `t = ${i / STEPS}: ${value}`);
        const expected = nearestCutoff(lattice, result.psi) < 1e-3 ? "near-cutoff" : "ok";
        assert.equal(result.diagnostics.status, expected, `t = ${i / STEPS}`);
        z.push(value);
      }
      // A square-root kink makes the second difference of order sqrt(h)
      // instead of h^2: the kinks are its outstanding local maxima.
      const curvature = z.map((value, i) => i === 0 || i === STEPS
        ? 0
        : magnitude([z[i - 1][0] - 2 * value[0] + z[i + 1][0], z[i - 1][1] - 2 * value[1] + z[i + 1][1]]));
      const typical = [...curvature.slice(1, -1)].sort((a, b) => a - b)[Math.floor((STEPS - 1) / 2)];
      const kinks = [];
      for (let i = 1; i < STEPS; ++i) {
        if (curvature[i] > 10 * typical && curvature[i] >= curvature[i - 1] && curvature[i] >= curvature[i + 1]) {
          kinks.push(i / STEPS);
        }
      }
      const near = (a, b) => Math.abs(a - b) <= 1.5 / STEPS;
      for (const { p, q, t } of predicted) {
        assert.ok(kinks.some((kink) => near(kink, t)), `no kink at mode (${p}, ${q}), t = ${t}; kinks ${kinks}`);
      }
      for (const kink of kinks) {
        assert.ok(predicted.some(({ t }) => near(kink, t)), `kink at t = ${kink} off every Wood circle`);
      }

      // On each circle (to the engine's rounding of pi, |kz| about 3e-6 k)
      // the result is finite, flagged and within the tolerance; nearby it
      // approaches that value like the square root of the distance.
      for (const { p, q, t } of predicted) {
        const on = solve(t);
        const value = entry(on.impedance, 0, 0);
        assert.ok(value.every(Number.isFinite), `mode (${p}, ${q}): ${value}`);
        assert.equal(on.diagnostics.status, "near-cutoff", `mode (${p}, ${q})`);
        assert.ok(on.diagnostics.estimatedError <= TOLERANCE, `mode (${p}, ${q})`);
        for (const side of [-1, 1]) {
          const changes = [1e-4, 1e-6, 1e-8].map((offset) =>
            distance(entry(solve(t + side * offset).impedance, 0, 0), value) / magnitude(value));
          assert.ok(changes[1] < changes[0] / 3 && changes[2] < changes[1] / 3,
            `mode (${p}, ${q}), side ${side}: ${changes}`);
        }
      }
    } finally {
      cell.dispose();
    }
  });
}
