import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import { NecGeometryError, createNecPeriodicModel } from "../.test-build/src/index.js";
import {
  FEED_SEGMENT,
  FREQUENCY_MHZ,
  HALF_LENGTH_M,
  RADIUS_M,
  SEGMENTS,
  dipoleWire,
  distance,
  entry,
  finiteArrayCentreImpedance,
  magnitude,
  relativeMatrixError,
} from "./periodic-reference.mjs";

const hasWasm = existsSync(new URL("../.test-build/src/nec2pp.wasm", import.meta.url));
const skip = !hasWasm && "WASM artifacts have not been built";

/** A unit cell of straight wires, each fed at its centre segment. */
async function wireCell(wires, ground) {
  const cell = await createNecPeriodicModel();
  wires.forEach(({ start, end }, index) => {
    cell.addWire({ tag: index + 1, segments: SEGMENTS, start, end, radiusM: RADIUS_M });
  });
  cell.completeGeometry();
  cell.definePorts(wires.map((_, index) => ({ tag: index + 1, segment: (SEGMENTS + 1) / 2 })));
  if (ground !== undefined) {
    cell.setGround(ground);
  }
  return cell;
}

async function scanImpedance({ wires, ground, a1M, a2M, scanPhasesRad }) {
  const cell = await wireCell(wires, ground);
  try {
    cell.setLattice({ a1M, a2M });
    return cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanPhasesRad }).impedance;
  } finally {
    cell.dispose();
  }
}

const mirrored = ([x, y, z]) => [x, y, -z];
const PERFECT = { kind: "perfect" };

for (const [name, wire] of [
  ["a horizontal dipole", { start: [-0.24, 0, 0.25], end: [0.24, 0, 0.25] }],
  ["a tilted dipole", { start: [-0.2, -0.05, 0.12], end: [0.2, 0.05, 0.36] }],
]) {
  test(`perfect ground under ${name} acts as its mirror image in free space`, {
    skip,
    timeout: 60_000,
  }, async () => {
    // Image theory: over perfect ground, the array radiates as in free space
    // together with its mirror image, whose current runs along the mirrored
    // wire with the opposite sign. In a free-space cell holding the wire and
    // its mirror, driving the mirror with the opposite current gives
    // Z = Z00 - Z01.
    const lattice = { a1M: [0.6, 0], a2M: [0.1, 0.5], scanPhasesRad: [0.8, -0.6] };
    const grounded = entry(await scanImpedance({
      wires: [wire],
      ground: PERFECT,
      ...lattice,
    }), 0, 0);
    const pair = await scanImpedance({
      wires: [wire, { start: mirrored(wire.start), end: mirrored(wire.end) }],
      ...lattice,
    });
    const [z00r, z00i] = entry(pair, 0, 0);
    const [z01r, z01i] = entry(pair, 0, 1);
    const image = [z00r - z01r, z00i - z01i];
    // Measured below 1e-13: both routes evaluate the same images.
    const error = distance(grounded, image) / magnitude(image);
    assert.ok(error < 1e-10, `grounded ${grounded}, image ${image}, relative ${error}`);
  });
}

const HEIGHT_M = 0.25;
const horizontalDipole = ([x, y, z]) => ({
  start: [x - HALF_LENGTH_M, y, z],
  end: [x + HALF_LENGTH_M, y, z],
});

test("scan impedance over perfect ground matches the centre of a large finite array over it", {
  skip,
  timeout: 300_000,
}, async () => {
  // Quarter-wave height, off broadside, so that the ground image, the scan
  // phase and the mutual coupling all enter.
  const a1M = [0.6, 0];
  const a2M = [0, 0.5];
  const psi = [-0.9, 0.5];
  const periodic = entry(await scanImpedance({
    wires: [horizontalDipole([0, 0, HEIGHT_M])],
    ground: PERFECT,
    a1M,
    a2M,
    scanPhasesRad: psi,
  }), 0, 0);
  const finite = entry(await finiteArrayCentreImpedance({
    frequencyMHz: FREQUENCY_MHZ,
    a1M,
    a2M,
    cells: 7,
    sigmaM: 1.8,
    psi,
    wires: [dipoleWire("dipole", [0, 0, HEIGHT_M])],
    ports: [{ wireId: "dipole", segment: FEED_SEGMENT }],
    ground: PERFECT,
  }), 0, 0);
  // Measured 1.9 %, falling to 0.9 % at 21 x 21: the finite array's edge
  // error. Without the ground images of the other cells the periodic result
  // is 86 % off.
  const relative = distance(periodic, finite) / magnitude(periodic);
  assert.ok(relative < 0.05, `periodic ${periodic}, finite ${finite}, relative ${relative}`);
});

test("scan impedance over perfect ground is reciprocal as Z(psi) = Z(-psi)^T", {
  skip,
  timeout: 120_000,
}, async () => {
  const wires = [
    horizontalDipole([0, 0, HEIGHT_M]),
    { start: [0.1, 0.2, 0.05], end: [0.25, 0.45, 0.2] },
  ];
  const lattice = { a1M: [0.8, 0], a2M: [0.25, 0.75] };
  const forward = await scanImpedance({ wires, ground: PERFECT, ...lattice, scanPhasesRad: [1.1, -0.6] });
  const backward = await scanImpedance({ wires, ground: PERFECT, ...lattice, scanPhasesRad: [-1.1, 0.6] });
  const transposed = {
    rows: 2,
    columns: 2,
    real: Float64Array.from([0, 2, 1, 3], (index) => backward.real[index]),
    imag: Float64Array.from([0, 2, 1, 3], (index) => backward.imag[index]),
  };
  // NEC's point matching is not exactly reciprocal (4.9e-3 for this cell in
  // free space without a lattice); measured 7.8e-5 here, 2.5e-4 in free space.
  const error = relativeMatrixError(forward, transposed);
  assert.ok(error < 1e-3, `${error}`);
  const asymmetry = distance(entry(forward, 0, 1), entry(forward, 1, 0)) / magnitude(entry(forward, 0, 1));
  assert.ok(asymmetry > 0.1, `Z(psi) should not be symmetric: ${asymmetry}`);
});

test("finite ground and conductors on the ground plane are refused with the reason", { skip }, async () => {
  const lattice = { a1M: [0.6, 0], a2M: [0, 0.5] };
  const cell = await wireCell([horizontalDipole([0, 0, 0])]);
  try {
    cell.setLattice(lattice);
    assert.throws(() => cell.setGround(PERFECT), (error) =>
      error instanceof NecGeometryError && /GROUND PLANE/.test(error.message));
    assert.throws(() => cell.setGround({
      kind: "finite",
      method: "reflection-coefficient",
      relativePermittivity: 13,
      conductivitySPerM: 0.005,
    }), (error) => error instanceof NecGeometryError && /FINITE GROUND/.test(error.message));
    // Both refusals left the cell in free space.
    const result = cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanPhasesRad: [0, 0] });
    assert.ok(Number.isFinite(result.impedance.real[0]));
  } finally {
    cell.dispose();
  }
});
