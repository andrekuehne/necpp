// The scan element pattern's sampling grid and interpolant, on an analytic
// function with the square-root kinks a scan element pattern has at its Wood
// circles. No WASM needed.
import assert from "node:assert/strict";
import test from "node:test";

import {
  KAPPA_BAND,
  autoSpacingUV,
  kappaOf,
  patternGrid,
  woodCircles,
} from "../.test-build/src/scan-pattern-grid.js";
import { LiftedInterpolant } from "../.test-build/src/scan-pattern-interpolant.js";
import { necWavenumberPerM } from "../.test-build/src/nec-constants.js";

const FREQUENCY_MHZ = 299.792458;
const WAVELENGTH_M = 2 * Math.PI / necWavenumberPerM(FREQUENCY_MHZ);
// Hexagonal, 0.8 wavelengths: grating lobes in visible space and Wood circles
// that cross each other and the horizon.
const LATTICE = {
  a1M: [0.8 * WAVELENGTH_M, 0],
  a2M: [0.4 * WAVELENGTH_M, 0.8 * WAVELENGTH_M * Math.sqrt(3) / 2],
};

/** A deterministic sequence in [0, 1). */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/**
 * A complex function of the form a scan element pattern has: smooth terms
 * plus kappa_c B_c for each Wood circle c, with kappa_c = |kz_c| / k and the
 * factor -j on the evanescent side (kz = -j |kz|), so it is continuous with a
 * square-root kink across every circle. Returned as [real, imag].
 */
function analytic(circles, u, v) {
  let real = Math.cos(2 * u + 1) * Math.exp(0.5 * v);
  let imag = 0.3 * Math.sin(3 * v - u);
  const factors = circles.map(({ centreUV: [cu, cv] }, index) => {
    const squared = 1 - (u - cu) ** 2 - (v - cv) ** 2;
    const kappa = Math.sqrt(Math.abs(squared));
    // B_c, smooth and different for every circle.
    const [br, bi] = [0.6 + 0.2 * Math.sin(u - 2 * v + index), 0.3 * Math.cos(2 * u + v - index)];
    // kappa (1 or -j) B_c
    const [fr, fi] = squared >= 0 ? [kappa, 0] : [0, -kappa];
    real += fr * br - fi * bi;
    imag += fr * bi + fi * br;
    return [fr, fi];
  });
  // Where two circles cross, a product term.
  for (let first = 1; first < factors.length; first += 1) {
    for (let second = first + 1; second < factors.length; second += 1) {
      const [ar, ai] = factors[first];
      const [br, bi] = factors[second];
      real += 0.2 * (ar * br - ai * bi);
      imag += 0.2 * (ar * bi + ai * br);
    }
  }
  return [real, imag];
}

function interpolantOf(circles, nodes, spacing) {
  const values = nodes.map(({ u, v }) => Float64Array.from(analytic(circles, u, v)));
  return new LiftedInterpolant(circles, nodes, values, spacing);
}

test("Wood circles are the reciprocal-lattice circles that meet the unit disk", () => {
  const circles = woodCircles(LATTICE, FREQUENCY_MHZ);
  assert.deepEqual([circles[0].p, circles[0].q, ...circles[0].centreUV], [0, 0, 0, 0]);
  // Hexagonal at 0.8 wavelengths: the six nearest reciprocal points at
  // 2 / (sqrt(3) 0.8) = 1.443 k, the next six at 2.5 k (outside).
  assert.equal(circles.length, 7);
  for (const circle of circles.slice(1)) {
    assert.ok(Math.abs(Math.hypot(...circle.centreUV) - 2 / (Math.sqrt(3) * 0.8)) < 1e-6);
    // Mode (p, q) has kt0 + p b1 + q b2 with a_i . b_j = 2 pi delta_ij, so the
    // centre -(p b1 + q b2) / k satisfies centre . a1 = -2 pi p / k.
    const k = necWavenumberPerM(FREQUENCY_MHZ);
    const along = (a) => (circle.centreUV[0] * a[0] + circle.centreUV[1] * a[1]) * k / (2 * Math.PI);
    assert.ok(Math.abs(along(LATTICE.a1M) + circle.p) < 1e-9);
    assert.ok(Math.abs(along(LATTICE.a2M) + circle.q) < 1e-9);
  }
  // A larger cell has more and closer circles, and a finer automatic spacing.
  const small = woodCircles({ a1M: [0.5 * WAVELENGTH_M, 0], a2M: [0, 0.5 * WAVELENGTH_M] }, FREQUENCY_MHZ);
  const large = woodCircles({ a1M: [2 * WAVELENGTH_M, 0], a2M: [0, 2 * WAVELENGTH_M] }, FREQUENCY_MHZ);
  assert.ok(large.length > circles.length);
  assert.equal(autoSpacingUV(small), 0.1);
  assert.ok(Math.abs(autoSpacingUV(large) - 0.05) < 1e-6);
});

test("the grid has nodes on every Wood circle and rows along both sides of it", () => {
  const circles = woodCircles(LATTICE, FREQUENCY_MHZ);
  const spacing = 0.1;
  const nodes = patternGrid(circles, spacing);
  circles.forEach(({ centreUV: [cu, cv] }, index) => {
    if (index === 0) {
      // The horizon's row lies just inside it, at cos(theta) = 1e-4.
      const edge = nodes.filter((node) => Math.abs(Math.hypot(node.u, node.v) - Math.sqrt(1 - 1e-8)) < 1e-12);
      assert.ok(edge.length > 50, `${edge.length} nodes on the edge`);
      assert.ok(nodes.every((node) => !node.on.includes(0) && Math.hypot(node.u, node.v) < 1));
      return;
    }
    const on = nodes.filter((node) => node.on.includes(index));
    assert.ok(on.length > 5, `circle ${index}: ${on.length} nodes on it`);
    for (const node of on) assert.ok(Math.abs(Math.hypot(node.u - cu, node.v - cv) - 1) < 1e-9);
    // Rows on both sides, graded from kappa = 1e-3 and uniform beyond the
    // spacing out to kappa = 0.5.
    for (const side of [1, -1]) {
      // Rows: kappas (to 8 digits) shared by more than three nodes.
      const counts = new Map();
      for (const node of nodes) {
        if (node.on.length > 0 || node.sides[index] !== side) continue;
        const kappa = Number(kappaOf(circles[index], node.u, node.v).toPrecision(8));
        counts.set(kappa, (counts.get(kappa) ?? 0) + 1);
      }
      const rows = [...counts].filter(([, count]) => count > 3).map(([kappa]) => kappa);
      assert.ok(rows.some((kappa) => kappa >= 9e-4 && kappa <= 1.1e-3), `circle ${index}, side ${side}: no row near 1e-3`);
      assert.ok(rows.some((kappa) => kappa >= 0.49 && kappa <= 0.51), `circle ${index}, side ${side}: no row near 0.5`);
      assert.ok(rows.filter((kappa) => kappa < spacing).length >= 6, `circle ${index}, side ${side}: rows ${rows}`);
    }
  });
  for (const node of nodes) assert.ok(node.u ** 2 + node.v ** 2 <= 1 + 1e-9);
});

test("a manual spacing and explicit points are honoured", () => {
  const circles = woodCircles(LATTICE, FREQUENCY_MHZ);
  // The square grid of a spacing, clear of the rows along the Wood circles
  // (next to them, a square-grid point may merge into a row node).
  const square = (spacing) => {
    const points = [];
    for (let ix = -20; ix <= 20; ix += 1) {
      for (let iy = -20; iy <= 20; iy += 1) {
        const [u, v] = [ix * spacing, iy * spacing];
        if (u * u + v * v < 1 && circles.every((circle) => kappaOf(circle, u, v) >= KAPPA_BAND + spacing)) {
          points.push({ u, v });
        }
      }
    }
    return points;
  };
  const contains = (nodes, { u, v }) => nodes.some((node) => node.u === u && node.v === v);
  for (const spacing of [0.1, 0.05]) {
    const nodes = patternGrid(circles, spacing);
    const expected = square(spacing);
    assert.ok(expected.length > 10);
    for (const point of expected) assert.ok(contains(nodes, point), `${spacing}: (${point.u}, ${point.v})`);
  }
  // Explicit points replace the square grid; the Wood-circle rows are added.
  const points = [{ u: 0.01, v: 0.02 }, { u: -0.3, v: 0.4 }, { u: 0.123, v: -0.456 }];
  const given = patternGrid(circles, 0.1, points);
  for (const point of points) assert.ok(contains(given, point));
  assert.ok(square(0.1).every((point) => !contains(given, point)));
  assert.ok(given.filter((node) => node.on.includes(1)).length > 5);
});

test("the interpolant returns the samples exactly at the nodes", () => {
  const circles = woodCircles(LATTICE, FREQUENCY_MHZ);
  const nodes = patternGrid(circles, 0.1);
  const interpolant = interpolantOf(circles, nodes, 0.1);
  for (const node of nodes) {
    const { values, errors } = interpolant.evaluate(node.u, node.v);
    assert.deepEqual([...values], analytic(circles, node.u, node.v));
    assert.deepEqual([...errors], [0, 0]);
  }
});

test("between nodes the error is small and within the stated error at 99 % of points", () => {
  const circles = woodCircles(LATTICE, FREQUENCY_MHZ);
  const spacing = 0.1;
  const interpolant = interpolantOf(circles, patternGrid(circles, spacing), spacing);
  const next = random(29);
  let worst = 0;
  const stated = [];
  const ratios = [];
  for (let trial = 0; trial < 3000; trial += 1) {
    const radius = Math.sqrt(next());
    const angle = 2 * Math.PI * next();
    const [u, v] = [radius * Math.cos(angle), radius * Math.sin(angle)];
    const { values, errors } = interpolant.evaluate(u, v);
    const exact = analytic(circles, u, v);
    for (let output = 0; output < 2; output += 1) {
      const error = Math.abs(values[output] - exact[output]);
      worst = Math.max(worst, error);
      stated.push(errors[output]);
      ratios.push(error / errors[output]);
    }
  }
  stated.sort((left, right) => left - right);
  ratios.sort((left, right) => left - right);
  // Values of order 1, spacing 0.1, a kink at each of seven circles: measured
  // worst error 4.9e-3 (near crossings of two circles), stated median 1e-4.
  // The stated error is an estimate: exceeded at 0.3 % of points, by at most 4x.
  assert.ok(worst < 1e-2, `worst error ${worst}`);
  assert.ok(stated[Math.floor(stated.length / 2)] < 1e-3, `median stated error ${stated[stated.length >> 1]}`);
  assert.ok(ratios[Math.floor(0.99 * ratios.length)] <= 1, `99th percentile of error / stated ${ratios[Math.floor(0.99 * ratios.length)]}`);
  assert.ok(ratios.at(-1) < 5, `largest error / stated ${ratios.at(-1)}`);
});

test("the interpolant does not smear across a Wood circle", () => {
  const circles = woodCircles(LATTICE, FREQUENCY_MHZ);
  const spacing = 0.1;
  const interpolant = interpolantOf(circles, patternGrid(circles, spacing), spacing);
  const next = random(7);
  for (const [index, { centreUV: [cu, cv] }] of circles.entries()) {
    if (index === 0) continue;
    // Points just inside and just outside the circle, within the unit disk.
    let tested = 0;
    for (let trial = 0; trial < 400 && tested < 40; trial += 1) {
      const angle = 2 * Math.PI * next();
      for (const offset of [1e-2, 1e-3, 1e-4, 1e-5, -1e-5, -1e-4, -1e-3, -1e-2]) {
        const [u, v] = [cu + (1 + offset) * Math.cos(angle), cv + (1 + offset) * Math.sin(angle)];
        if (u * u + v * v > 1) continue;
        // One circle at a time: near a crossing of two, the fixed grid leaves
        // thin wedges that only refinement resolves.
        if (circles.some((other, otherIndex) => otherIndex !== index && kappaOf(other, u, v) < 0.3)) continue;
        tested += 1;
        const { values, errors } = interpolant.evaluate(u, v);
        const exact = analytic(circles, u, v);
        for (let output = 0; output < 2; output += 1) {
          // Interpolating across the circle would be off by about
          // sqrt(2 |offset|) |B_c|: 2.7e-2 at an offset of 1e-3.
          const smeared = Math.sqrt(2 * Math.abs(offset)) * 0.6;
          const error = Math.abs(values[output] - exact[output]);
          assert.ok(error < 0.2 * smeared + 1e-4,
            `circle ${index} offset ${offset}: error ${error}, stated ${errors[output]}`);
        }
      }
    }
    assert.ok(tested > 0);
  }
});
