import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import {
  FEED_SEGMENT,
  FREQUENCY_MHZ,
  HALF_LENGTH_M,
  RADIUS_M,
  SEGMENTS,
  dipoleCell,
  dipoleWire,
  distance,
  entry,
  finiteArrayCentreImpedance,
  magnitude,
  relativeMatrixError,
} from "./periodic-reference.mjs";

const hasWasm = existsSync(new URL("../.test-build/src/nec2pp.wasm", import.meta.url));
const skip = !hasWasm && "WASM artifacts have not been built";

const SEGMENT_LENGTH_M = (2 * HALF_LENGTH_M) / SEGMENTS;

/** Scan impedance of a unit cell of x-directed dipoles at the given centres. */
async function scanImpedance({ centres, a1M, a2M, scanPhasesRad, radiusM = RADIUS_M }) {
  const cell = await dipoleCell(centres, radiusM);
  try {
    cell.setLattice({ a1M, a2M });
    return cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanPhasesRad }).impedance;
  } finally {
    cell.dispose();
  }
}

/** Collinear dipoles along x with the given end gap, rows 0.5 m apart. */
async function collinear(gapM, radiusM = RADIUS_M) {
  return entry(await scanImpedance({
    centres: [[0, 0]],
    a1M: [2 * HALF_LENGTH_M + gapM, 0],
    a2M: [0, 0.5],
    scanPhasesRad: [0.8, 0.6],
    radiusM,
  }), 0, 0);
}

function relative(value, reference) {
  return distance(value, reference) / magnitude(reference);
}

test("the scan impedance does not depend on how the array is divided into cells", {
  skip,
  timeout: 120_000,
}, async () => {
  // Parallel dipoles stacked 10 mm (ten wire radii) apart along y. As a
  // one-dipole cell, every close neighbour is a periodic image. As a
  // two-dipole supercell with a2' = 2 a2, every other close pair lies inside
  // the cell, where the finite model's own fill evaluates it. Both describe
  // the same array: with the second dipole of the supercell one cell along
  // a2, its current leads by psi2, so Z = Z'00 + Z'01 exp(j psi2).
  const a1M = [0.6, 0];
  const a2M = [0, 0.01];
  const psi = [0.8, 0.03];
  const single = entry(await scanImpedance({ centres: [[0, 0]], a1M, a2M, scanPhasesRad: psi }), 0, 0);
  const supercell = await scanImpedance({
    centres: [[0, 0], a2M],
    a1M,
    a2M: [2 * a2M[0], 2 * a2M[1]],
    scanPhasesRad: [psi[0], 2 * psi[1]],
  });
  const [z00r, z00i] = entry(supercell, 0, 0);
  const [z01r, z01i] = entry(supercell, 0, 1);
  const [c, s] = [Math.cos(psi[1]), Math.sin(psi[1])];
  const folded = [z00r + z01r * c - z01i * s, z00i + z01r * s + z01i * c];
  // Measured 3.0e-6, the level at which the filament and thin-wire routes of
  // one pair differ; 9.5e-4 while every close image went through the smooth
  // kernel as a filament.
  const error = relative(single, folded);
  assert.ok(error < 1e-4, `single ${single}, supercell ${folded}, relative ${error}`);
});

test("collinear dipoles with small end gaps match the centre of a large finite array", {
  skip,
  timeout: 300_000,
}, async () => {
  // 5 mm end gaps, five wire radii. Measured 1.2 %. That is the finite
  // array's edge error at this size, larger than the close-image effect
  // itself (below 4e-4 here), so this case only guards against gross errors;
  // the supercell test above is the sharp check.
  const gapM = 0.005;
  const psi = [0.8, 0.6];
  const periodic = await scanImpedance({
    centres: [[0, 0]],
    a1M: [2 * HALF_LENGTH_M + gapM, 0],
    a2M: [0, 0.5],
    scanPhasesRad: psi,
  });
  const finite = await finiteArrayCentreImpedance({
    frequencyMHz: FREQUENCY_MHZ,
    a1M: [2 * HALF_LENGTH_M + gapM, 0],
    a2M: [0, 0.5],
    cells: 7,
    sigmaM: 1.25,
    psi,
    wires: [dipoleWire("dipole", [0, 0])],
    ports: [{ wireId: "dipole", segment: FEED_SEGMENT }],
  });
  const error = relativeMatrixError(finite, periodic);
  assert.ok(error < 0.03, `relative error ${error}`);
});

// An image of a source segment takes the thin-wire route when it comes within
// max(2 segment lengths, 40 radii) of an observation point (a segment
// centre). For collinear dipoles the first pair to switch is an end segment's
// centre and the next dipole's end segment, at an end gap of that reach minus
// half a segment length. The scan impedance changes by about 2e-6 per
// micrometre of gap, so 1 nm either side measures the jump itself.
for (const { name, radiusM, reachM, measured } of [
  { name: "thin wires", radiusM: RADIUS_M, reachM: 2 * SEGMENT_LENGTH_M, measured: "2.1e-6" },
  // 5 mm radius, segments 8.7 radii long: the radius sets the reach. With
  // two segment lengths instead, the jump was 9e-5.
  { name: "thick wires", radiusM: 0.005, reachM: 40 * 0.005, measured: "3.3e-6" },
]) {
  test(`${name}: the scan impedance is continuous where close images switch route (measured ${measured})`, {
    skip,
    timeout: 120_000,
  }, async () => {
    const threshold = reachM - SEGMENT_LENGTH_M / 2;
    const below = await collinear(threshold - 1e-9, radiusM);
    const above = await collinear(threshold + 1e-9, radiusM);
    const jump = relative(below, above);
    assert.ok(jump < 2e-5, `below ${below}, above ${above}, relative ${jump}`);
  });
}

test("cells without close images give the same scan impedance as before", {
  skip,
  timeout: 120_000,
}, async () => {
  // 10 cm end gaps: the closest image segment is 12.2 cm from any segment
  // centre, beyond the 8.7 cm reach. Reference value from the periodic solver
  // before close images were split out (native build of 06fcd4d).
  const reference = [61.5155827998, -31.6562852339];
  const error = relative(await collinear(0.1), reference);
  assert.ok(error < 1e-9, `relative ${error}`);
});
