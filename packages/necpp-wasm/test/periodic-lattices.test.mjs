import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import {
  NecGeometryError,
  NecInputError,
  NecStateError,
  centeredRectangularLattice,
  createNecPeriodicModel,
  hexagonalLattice,
  rectangularLattice,
  scanPhasesForDirection,
  squareLattice,
} from "../.test-build/src/index.js";
import { finiteArrayCentreImpedance, relativeMatrixError } from "./periodic-reference.mjs";

const hasWasm = existsSync(new URL("../.test-build/src/nec2pp.wasm", import.meta.url));
const skip = !hasWasm && "WASM artifacts have not been built";

// About one-metre wavelength.
const FREQUENCY_MHZ = 299.792458;
const HALF_LENGTH_M = 0.24;
const RADIUS_M = 0.001;
const SEGMENTS = 11;
const FEED_SEGMENT = 6;

/** A half-wave dipole along x, centred at `centre`, as a finite-array pattern wire. */
const dipoleWire = (id, [x, y]) => ({
  id,
  segments: SEGMENTS,
  startM: [x - HALF_LENGTH_M, y, 0],
  endM: [x + HALF_LENGTH_M, y, 0],
  radiusM: RADIUS_M,
});

/** A periodic model of x-directed dipoles centred at `centres`, without a lattice. */
async function dipoleCell(centres) {
  const cell = await createNecPeriodicModel();
  centres.forEach(([x, y], index) => {
    cell.addWire({
      tag: index + 1,
      segments: SEGMENTS,
      start: [x - HALF_LENGTH_M, y, 0],
      end: [x + HALF_LENGTH_M, y, 0],
      radiusM: RADIUS_M,
    });
  });
  cell.completeGeometry();
  cell.definePorts(centres.map((_, index) => ({ tag: index + 1, segment: FEED_SEGMENT })));
  return cell;
}

/**
 * Scan impedance of a unit cell of x-directed dipoles at the given centres,
 * one port per dipole, from the periodic model.
 */
async function periodicScanImpedance({ lattice, centres, request }) {
  const cell = await dipoleCell(centres);
  try {
    cell.setLattice(lattice);
    return cell.computeScanImpedance(request);
  } finally {
    cell.dispose();
  }
}

/** Centre-cell impedances of the same cell in a tapered finite array; see finiteArrayCentreImpedance. */
function finiteCentreImpedance({ lattice, centres, psi, cells, sigmaCells }) {
  const spacing = Math.min(Math.hypot(...lattice.a1M), Math.hypot(...lattice.a2M));
  const wires = centres.map((centre, index) => dipoleWire(`dipole${index}`, centre));
  return finiteArrayCentreImpedance({
    frequencyMHz: FREQUENCY_MHZ,
    a1M: lattice.a1M,
    a2M: lattice.a2M,
    cells,
    // A round array, whatever the lattice, so the taper is cut off evenly.
    radiusM: cells * spacing,
    sigmaM: sigmaCells * spacing,
    psi,
    wires,
    ports: wires.map((wire) => ({ wireId: wire.id, segment: FEED_SEGMENT })),
  });
}

function assertVectors(lattice, a1M, a2M) {
  const close = (actual, expected) => actual.every((value, index) =>
    Math.abs(value - expected[index]) < 1e-12);
  assert.ok(close(lattice.a1M, a1M) && close(lattice.a2M, a2M),
    `${JSON.stringify(lattice)} vs a1M ${a1M}, a2M ${a2M}`);
}

test("lattice presets give the documented lattice vectors", () => {
  assertVectors(squareLattice({ spacingM: 0.5 }), [0.5, 0], [0, 0.5]);
  assertVectors(rectangularLattice({ spacingXM: 0.6, spacingYM: 0.5 }), [0.6, 0], [0, 0.5]);
  // Rows along x, 0.7 m apart within a row, rows 0.45 m apart, every other row
  // shifted by half the in-row spacing.
  assertVectors(
    centeredRectangularLattice({ spacingXM: 0.7, spacingYM: 0.45 }),
    [0.7, 0],
    [0.35, 0.45],
  );
  // Equal lengths at 60 degrees; rows along x by default.
  const rowHeight = 0.6 * Math.sqrt(3) / 2;
  assertVectors(hexagonalLattice({ spacingM: 0.6 }), [0.6, 0], [0.3, rowHeight]);
  assertVectors(hexagonalLattice({ spacingM: 0.6, rowsAlong: "x" }), [0.6, 0], [0.3, rowHeight]);
  assertVectors(hexagonalLattice({ spacingM: 0.6, rowsAlong: "y" }), [0, 0.6], [rowHeight, 0.3]);
});

test("lattice presets reject invalid spacings", () => {
  assert.throws(() => squareLattice({ spacingM: 0 }), NecInputError);
  assert.throws(() => rectangularLattice({ spacingXM: 0.5, spacingYM: -1 }), NecInputError);
  assert.throws(() => centeredRectangularLattice({ spacingXM: Number.NaN, spacingYM: 0.5 }), NecInputError);
  assert.throws(() => hexagonalLattice({ spacingM: Infinity }), NecInputError);
  assert.throws(() => hexagonalLattice({ spacingM: 0.6, rowsAlong: "z" }), NecInputError);
  assert.throws(() => squareLattice(undefined), NecInputError);
});

// Each case scans off broadside along both lattice vectors, inside visible
// space and clear of grating lobes, and compares the periodic scan impedance
// with the centre of a tapered finite array of the same lattice. Measured
// errors are given per case; the broadside scan impedance differs from the
// same finite results by 19 to 29 %, so the comparison sees the scan state.
for (const { name, lattice, psi, cells, sigmaCells } of [
  {
    // sin(theta) = 0.61; measured 4.1 % (6.7 % at 7 cells).
    name: "rectangular",
    lattice: rectangularLattice({ spacingXM: 0.6, spacingYM: 0.5 }),
    psi: [1.8, -1.2],
    cells: 9,
    sigmaCells: 3,
  },
  {
    // sin(theta) = 0.41; measured 2.8 % (4.5 % at 7 cells).
    name: "centered rectangular",
    lattice: centeredRectangularLattice({ spacingXM: 0.7, spacingYM: 0.45 }),
    psi: [1.8, 0.9],
    cells: 9,
    sigmaCells: 3,
  },
  {
    // sin(theta) = 0.58; measured 2.3 %.
    name: "hexagonal",
    lattice: hexagonalLattice({ spacingM: 0.6 }),
    psi: [-1.2, 1.0],
    cells: 7,
    sigmaCells: 2.5,
  },
]) {
  test(`${name} lattice: scan impedance matches the centre of a large finite array`, {
    skip,
    timeout: 300_000,
  }, async () => {
    const centres = [[0, 0]];
    const periodic = await periodicScanImpedance({
      lattice,
      centres,
      request: { frequencyMHz: FREQUENCY_MHZ, scanPhasesRad: psi },
    });
    const finite = await finiteCentreImpedance({ lattice, centres, psi, cells, sigmaCells });
    const error = relativeMatrixError(finite, periodic.impedance);
    assert.ok(error < 0.06, `${name}: relative error ${error}`);
  });
}

test("honeycomb: a hexagonal lattice with two elements per cell matches the finite array", {
  skip,
  timeout: 300_000,
}, async () => {
  // The second sub-lattice sits at (a1 + a2) / 3. Each port is driven alone,
  // so every entry of the 2 x 2 scan impedance is compared, including the
  // non-reciprocal mutual terms Z01 != Z10.
  const lattice = hexagonalLattice({ spacingM: 0.7 });
  const centres = [
    [0, 0],
    [(lattice.a1M[0] + lattice.a2M[0]) / 3, (lattice.a1M[1] + lattice.a2M[1]) / 3],
  ];
  const psi = [0.9, -0.6];
  const periodic = await periodicScanImpedance({
    lattice,
    centres,
    request: { frequencyMHz: FREQUENCY_MHZ, scanPhasesRad: psi },
  });
  const finite = await finiteCentreImpedance({ lattice, centres, psi, cells: 7, sigmaCells: 2.5 });
  const error = relativeMatrixError(finite, periodic.impedance);
  // Measured 3.7 %, with Z01 = 57 - 39j and Z10 = 26 - 28j ohm.
  assert.ok(error < 0.06, `honeycomb: relative error ${error}`);
});

test("an oblique lattice and its reduced equivalent give the same scan impedance", {
  skip,
  timeout: 120_000,
}, async () => {
  // a1' = 2 a1 + a2 and a2' = 3 a1 + 2 a2 span the same lattice (the integer
  // matrix has determinant 1) but are strongly skewed. The same physical scan
  // state has psi_i' = -kt0 . a_i', so psi1' = 2 psi1 + psi2 and
  // psi2' = 3 psi1 + 2 psi2. A two-port cell with an offset second dipole
  // makes the result depend on the sign and direction of the scan.
  const a1M = [0.7, 0];
  const a2M = [0.2, 0.65];
  const psi = [0.8, -1.1];
  const skewed = {
    a1M: [2 * a1M[0] + a2M[0], 2 * a1M[1] + a2M[1]],
    a2M: [3 * a1M[0] + 2 * a2M[0], 3 * a1M[1] + 2 * a2M[1]],
  };
  const skewedPsi = [2 * psi[0] + psi[1], 3 * psi[0] + 2 * psi[1]];
  const centres = [[0, 0], [0.15, 0.3]];
  const reduced = await periodicScanImpedance({
    lattice: { a1M, a2M },
    centres,
    request: { frequencyMHz: FREQUENCY_MHZ, scanPhasesRad: psi },
  });
  const oblique = await periodicScanImpedance({
    lattice: skewed,
    centres,
    request: { frequencyMHz: FREQUENCY_MHZ, scanPhasesRad: skewedPsi },
  });
  const error = relativeMatrixError(oblique.impedance, reduced.impedance);
  // Measured 8e-15: the engine reduces both bases to the same vectors.
  assert.ok(error < 1e-8, `oblique against reduced: relative error ${error}`);
  assert.deepEqual(oblique.scanPhasesRad, skewedPsi);
});

// The frequency at which NEC's wavelength is exactly 1 m. NEC takes the
// speed of light as 1 / sqrt(eps0 mu0) with eps0 = 8.854e-12 F/m
// (electromag.cpp), which is 1.2e-5 above the SI value.
const ONE_METRE_WAVELENGTH_MHZ = 1e-6 / Math.sqrt(8.854e-12 * 4e-7 * Math.PI);

test("a scan direction maps to the scan phases of visible space", () => {
  // Worked example: wavelength 1 m, theta = 30 deg, so |kt0| = k / 2 = pi rad/m.
  // phi = 0 on a 0.5 m square lattice: kt0 = (pi, 0) and psi_i = -kt0 . a_i.
  const square = squareLattice({ spacingM: 0.5 });
  const along = (lattice, direction) => scanPhasesForDirection({
    lattice,
    frequencyMHz: ONE_METRE_WAVELENGTH_MHZ,
    ...direction,
  });
  const close = (actual, expected) => actual.every((value, index) =>
    Math.abs(value - expected[index]) < 1e-12);
  assert.ok(close(along(square, { thetaDeg: 30, phiDeg: 0 }), [-Math.PI / 2, 0]));
  assert.ok(close(along(square, { thetaDeg: 30, phiDeg: 90 }), [0, -Math.PI / 2]));
  assert.ok(close(along(square, { thetaDeg: 0, phiDeg: 37 }), [0, 0]));
  // phi = 60 deg on a 0.6 m hexagonal lattice: kt0 = pi (1/2, sqrt(3)/2), so
  // psi1 = -0.3 pi and psi2 = -pi (0.15 + 0.45) = -0.6 pi.
  assert.ok(close(
    along(hexagonalLattice({ spacingM: 0.6 }), { thetaDeg: 30, phiDeg: 60 }),
    [-0.3 * Math.PI, -0.6 * Math.PI],
  ));

  assert.throws(() => along(square, { thetaDeg: 91, phiDeg: 0 }), NecInputError);
  assert.throws(() => along(square, { thetaDeg: -1, phiDeg: 0 }), NecInputError);
  assert.throws(() => along(square, { thetaDeg: 10, phiDeg: Number.NaN }), NecInputError);
  assert.throws(() => scanPhasesForDirection({
    lattice: square, frequencyMHz: 0, thetaDeg: 10, phiDeg: 0,
  }), NecInputError);
});

test("a scan direction gives the same scan impedance as its scan phases", {
  skip,
  timeout: 120_000,
}, async () => {
  const lattice = hexagonalLattice({ spacingM: 0.6 });
  const centres = [[0, 0], [0.15, 0.3]];
  const byDirection = await periodicScanImpedance({
    lattice,
    centres,
    request: {
      frequencyMHz: ONE_METRE_WAVELENGTH_MHZ,
      scanDirection: { thetaDeg: 30, phiDeg: 60 },
    },
  });
  const byPhases = await periodicScanImpedance({
    lattice,
    centres,
    request: {
      frequencyMHz: ONE_METRE_WAVELENGTH_MHZ,
      scanPhasesRad: [-0.3 * Math.PI, -0.6 * Math.PI],
    },
  });
  // Equal up to the rounding of the phases (1e-16 rad).
  assert.ok(relativeMatrixError(byDirection.impedance, byPhases.impedance) < 1e-10);
  // The result always reports the scan phases it was solved for.
  assert.ok(Math.abs(byDirection.scanPhasesRad[0] + 0.3 * Math.PI) < 1e-12);
  assert.ok(Math.abs(byDirection.scanPhasesRad[1] + 0.6 * Math.PI) < 1e-12);

  const cell = await dipoleCell([[0, 0]]);
  try {
    cell.setLattice(lattice);
    // Exactly one of scanPhasesRad and scanDirection.
    assert.throws(() => cell.computeScanImpedance({
      frequencyMHz: FREQUENCY_MHZ,
      scanPhasesRad: [0, 0],
      scanDirection: { thetaDeg: 0, phiDeg: 0 },
    }), NecInputError);
    assert.throws(() => cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ }), NecInputError);
    assert.throws(() => cell.computeScanImpedance({
      frequencyMHz: FREQUENCY_MHZ,
      scanDirection: { thetaDeg: 120, phiDeg: 0 },
    }), NecInputError);
  } finally {
    cell.dispose();
  }
});

function assertRefused(cell, lattice, reason) {
  assert.throws(() => cell.setLattice(lattice), (error) => {
    assert.ok(error instanceof NecGeometryError, `${error}`);
    assert.match(error.message, /PERIODIC IMAGE/);
    assert.match(error.message, reason);
    return true;
  });
}

test("a conductor that touches or nearly touches a periodic image is refused with a reason", {
  skip,
}, async () => {
  // 0.48 m dipoles of 1 mm radius.
  const single = await dipoleCell([[0, 0]]);
  try {
    // End to end with the next cell along x: touching, then a 0.5 mm gap.
    assertRefused(single, { a1M: [0.48, 0], a2M: [0, 0.7] }, /TAG 1\b.*TAG 1\b.*CELL \(-?1, 0\)/);
    assertRefused(single, { a1M: [0.4805, 0], a2M: [0, 0.7] }, /TAG 1\b/);
    // Side by side, 1.5 mm between the axes of 1 mm wires: the surfaces overlap.
    assertRefused(single, { a1M: [0.7, 0], a2M: [0, 0.0015] }, /CELL \(0, -?1\)/);
    // The refusal leaves the model without a lattice ...
    assert.throws(
      () => single.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanPhasesRad: [0, 0] }),
      NecStateError,
    );
    // ... and a 1 cm end gap is accepted.
    single.setLattice({ a1M: [0.49, 0], a2M: [0, 0.7] });
    single.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanPhasesRad: [0, 0] });
  } finally {
    single.dispose();
  }

  // The second dipole ends where the first dipole's image in the next cell begins.
  const pair = await dipoleCell([[0, 0], [0.5, 0]]);
  try {
    assertRefused(pair, { a1M: [0.98, 0], a2M: [0, 0.7] }, /TAG [12]\b.*TAG [12]\b/);
    pair.setLattice({ a1M: [1.0, 0], a2M: [0, 0.7] });
  } finally {
    pair.dispose();
  }
});
