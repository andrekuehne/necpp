import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import { NecGeometryError } from "../.test-build/src/index.js";
import { FREQUENCY_MHZ, RADIUS_M, WAVENUMBER_PER_M, dipoleCell, entry } from "./periodic-reference.mjs";

const hasWasm = existsSync(new URL("../.test-build/src/nec2pp.wasm", import.meta.url));
const skip = !hasWasm && "WASM artifacts have not been built";

// The periodic solver's fixed tolerance (docs/wasm-api.md): the estimated
// error of every result is at most this, relative to the largest entry.
const TOLERANCE = 1e-5;

/** Solve one scan state of a dipole cell and return the whole result. */
async function solve({ centres = [[0, 0]], lattice, request }) {
  const cell = await dipoleCell(centres);
  try {
    cell.setLattice(lattice);
    return cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, ...request });
  } finally {
    cell.dispose();
  }
}

test("every scan impedance carries an estimated error within the tolerance and a point status", {
  skip,
  timeout: 120_000,
}, async () => {
  const cases = [
    { lattice: { a1M: [0.7, 0], a2M: [0, 0.5] }, request: { scanPhasesRad: [0.8, 0.6] } },
    { lattice: { a1M: [0.6, 0], a2M: [0.3, 0.5] }, request: { scanDirection: { thetaDeg: 30, phiDeg: 45 } } },
    // Collinear dipoles with 5 mm end gaps: close images on both sides.
    { lattice: { a1M: [0.485, 0], a2M: [0, 0.5] }, request: { scanPhasesRad: [-1.1, 0.4] } },
    // Two dipoles per cell.
    { centres: [[0, 0], [0, 0.25]], lattice: { a1M: [0.6, 0], a2M: [0, 0.5] }, request: { scanPhasesRad: [0.3, -0.9] } },
  ];
  for (const testCase of cases) {
    const { diagnostics } = await solve(testCase);
    assert.ok(Number.isFinite(diagnostics.estimatedError), JSON.stringify(diagnostics));
    assert.ok(diagnostics.estimatedError > 0, JSON.stringify(diagnostics));
    assert.ok(diagnostics.estimatedError <= TOLERANCE, JSON.stringify(diagnostics));
    assert.equal(diagnostics.status, "ok");
  }
});

test("the estimated error grows with the segment length", {
  skip,
  timeout: 120_000,
}, async () => {
  // The quadrature over each segment is the size-dependent part of the
  // estimate: 0.044 wavelength segments stay at the kernel's 1e-10 level,
  // 0.16 wavelength segments come to about 1e-8.
  const estimates = [];
  for (const segments of [11, 3]) {
    const cell = await dipoleCell([[0, 0]], RADIUS_M, segments);
    try {
      cell.setLattice({ a1M: [0.7, 0], a2M: [0, 0.5] });
      estimates.push(cell.computeScanImpedance({
        frequencyMHz: FREQUENCY_MHZ,
        scanPhasesRad: [0.8, 0.6],
      }).diagnostics.estimatedError);
    } finally {
      cell.dispose();
    }
  }
  const [short, long] = estimates;
  assert.ok(short < 1e-9, `11 segments: ${short}`);
  assert.ok(long > 10 * short && long <= TOLERANCE, `3 segments: ${long}, 11 segments: ${short}`);
});

test("scan states on and next to a Wood anomaly give finite results within the tolerance", {
  skip,
  timeout: 120_000,
}, async () => {
  // Square lattice of 0.7 m at about one-metre wavelength: the Floquet mode
  // (-1, 0) grazes the lattice plane at psi1 = 2 pi - k d. The scan impedance
  // has a square-root kink there, so neighbouring states differ steeply, but
  // every value is finite and none is refused. Within |kz| < 1e-3 k (offsets
  // below about 1e-6 here) the status says so.
  const onset = 2 * Math.PI - WAVENUMBER_PER_M * 0.7;
  const cell = await dipoleCell([[0, 0]]);
  try {
    cell.setLattice({ a1M: [0.7, 0], a2M: [0, 0.7] });
    for (const offset of [-1e-5, -1e-12, 0, 1e-12, 1e-5]) {
      const result = cell.computeScanImpedance({
        frequencyMHz: FREQUENCY_MHZ,
        scanPhasesRad: [onset * (1 + offset), 0],
      });
      const [real, imag] = entry(result.impedance, 0, 0);
      assert.ok(Number.isFinite(real) && Number.isFinite(imag), `offset ${offset}: ${real}, ${imag}`);
      assert.ok(result.diagnostics.estimatedError <= TOLERANCE, `offset ${offset}`);
      assert.equal(result.diagnostics.status, Math.abs(offset) < 1e-6 ? "near-cutoff" : "ok", `offset ${offset}`);
    }
  } finally {
    cell.dispose();
  }
});

test("a unit cell too large for the tolerance is refused with the reason", {
  skip,
  timeout: 120_000,
}, async () => {
  // 20 m x 20 m at about one-metre wavelength: 400 square wavelengths, whose
  // spectral sum would need about 12600 Floquet modes per kernel evaluation.
  const cell = await dipoleCell([[0, 0]]);
  try {
    cell.setLattice({ a1M: [20, 0], a2M: [0, 20] });
    assert.throws(
      () => cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanPhasesRad: [0.3, 0.2] }),
      (error) => error instanceof NecGeometryError && /UNIT CELL TOO LARGE/.test(error.message),
    );
  } finally {
    cell.dispose();
  }
});
