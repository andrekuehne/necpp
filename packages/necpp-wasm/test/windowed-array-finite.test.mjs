// Windowed arrays against direct finite-array solves of the same layout.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import { createNecArraySolver, createNecPeriodicModel, windowedArray } from "../.test-build/src/index.js";
import { FREQUENCY_MHZ, WAVENUMBER_PER_M } from "./periodic-reference.mjs";

const hasWasm = existsSync(new URL("../.test-build/src/nec2pp.wasm", import.meta.url));
const skip = !hasWasm && "WASM artifacts have not been built";

// x-directed half-wave dipoles of three segments on a 0.6 x 0.5 wavelength
// lattice: few unknowns, so that a 32 x 32 array solves directly in seconds.
// The periodic and the finite model share the discretization.
const lattice = { a1M: [0.6, 0], a2M: [0, 0.5] };
const dipole = { segments: 3, radiusM: 0.001 };
const [START, END] = [[-0.24, 0, 0], [0.24, 0, 0]];
const DEG = Math.PI / 180;

async function dipoleCell() {
  const cell = await createNecPeriodicModel();
  cell.addWire({ tag: 1, ...dipole, start: START, end: END });
  cell.completeGeometry();
  cell.definePorts([{ tag: 1, segment: 2 }]);
  cell.setLattice(lattice);
  return cell;
}

/** Cells m, n = 0 .. size - 1, with the excitation `taper(m, n)` (a real weight). */
function window(size, taper = () => 1) {
  const cells = [];
  const real = [];
  for (let m = 0; m < size; m += 1) {
    for (let n = 0; n < size; n += 1) {
      cells.push([m, n]);
      real.push(taper(m, n));
    }
  }
  return { cells, excitation: { real: Float64Array.from(real), imag: new Float64Array(real.length) } };
}

/** The prepared finite array of `cells`, the window without the surrounding cells. */
async function finiteArray(cells) {
  const { a1M, a2M } = lattice;
  const solver = await createNecArraySolver({
    elements: cells.map(([m, n]) => ({
      id: `cell_${m}_${n}`,
      positionM: [m * a1M[0] + n * a2M[0], m * a1M[1] + n * a2M[1]],
      patternId: "cell",
    })),
    patterns: [{
      id: "cell",
      kind: "straight-wire-pattern",
      wires: [{ id: "dipole", ...dipole, startM: START, endM: END }],
      ports: [{ wireId: "dipole", segment: 2 }],
    }],
    ground: { kind: "free-space" },
  }, { symmetry: "off" });
  await solver.prepare({ frequencyMHz: FREQUENCY_MHZ });
  return solver;
}

/**
 * The largest field difference along the cut through the beam (theta all
 * round, phi of the steering direction), in the main beam and the near
 * sidelobes above and below the array (four null widths either side),
 * relative to the finite array's peak.
 */
async function beamError(array, solver, { thetaDeg, phiDeg }, size) {
  const request = { theta: { startDeg: -180, count: 1440, stepDeg: 0.25 }, phi: { startDeg: phiDeg, count: 1, stepDeg: 0 } };
  const finite = await solver.computeFarField(request);
  const windowed = array.computeFarField(request);
  const field = (result, index) => [result.eThetaReal[index], result.eThetaImag[index], result.ePhiReal[index], result.ePhiImag[index]];
  let peak = 0;
  for (let index = 0; index < 1440; index += 1) peak = Math.max(peak, Math.hypot(...field(finite, index)));
  // The cells' spacing along the cut and the beam's null width in sin(theta).
  const spacing = Math.hypot(lattice.a1M[0] * Math.cos(phiDeg * DEG), lattice.a2M[1] * Math.sin(phiDeg * DEG));
  const nullWidth = 2 * Math.PI / (WAVENUMBER_PER_M * size * spacing);
  let error = 0;
  for (let index = 0; index < 1440; index += 1) {
    const theta = (-180 + 0.25 * index) * DEG;
    if (Math.abs(Math.sin(theta) - Math.sin(thetaDeg * DEG)) > 4 * nullWidth) continue;
    const [a, b] = [field(windowed, index), field(finite, index)];
    error = Math.max(error, Math.hypot(...a.map((value, part) => value - b[part])) / peak);
  }
  return error;
}

test("windowed-array patterns approach direct finite-array solves as the array grows", {
  skip,
  timeout: 900_000,
}, async () => {
  const cell = await dipoleCell();
  try {
    const steeredTo = { thetaDeg: 30, phiDeg: 0 };
    const steering = cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanDirection: steeredTo });
    const sizes = [8, 16, 32];
    // Each array solver has a worker of its own: the direct solves are
    // prepared while the pattern's sweep runs.
    const preparing = Promise.all(sizes.map((size) => finiteArray(window(size).cells)));
    const pattern = await cell.computeScanElementPattern({ frequencyMHz: FREQUENCY_MHZ });
    const arrays = sizes.map((size) => windowedArray(pattern, { steering, ...window(size) }));
    const solvers = await preparing;
    try {
      const errors = [];
      const solutions = [];
      for (const [index, size] of sizes.entries()) {
        solutions.push(await solvers[index].solveVoltages(arrays[index].drive));
        errors.push(await beamError(arrays[index], solvers[index], steeredTo, size));
      }
      // The edge effects of a uniformly driven finite array, measured 7.8,
      // 4.8 and 2.2 % of the peak.
      assert.ok(errors[0] < 0.1 && errors[1] < 0.06 && errors[2] < 0.03, `errors ${errors}`);
      assert.ok(errors[0] > errors[1] && errors[1] > errors[2], `edge error shrinking: ${errors}`);

      // The centre elements of the 32 x 32 array see nearly the scan
      // impedance offered as every element's active impedance (measured
      // 0.7 % apart).
      const solution = solutions[2];
      const centre = arrays[2].cells.findIndex(([m, n]) => m === 16 && n === 16);
      const actual = [solution.activeImpedances.real[centre], solution.activeImpedances.imag[centre]];
      const offered = [arrays[2].activeImpedances.real[centre], arrays[2].activeImpedances.imag[centre]];
      assert.equal(arrays[2].activeImpedances.approximate, true);
      assert.ok(
        Math.hypot(actual[0] - offered[0], actual[1] - offered[1]) < 0.03 * Math.hypot(...offered),
        `centre active impedance ${actual} vs ${offered}`,
      );
    } finally {
      await Promise.all(solvers.map((solver) => solver.dispose()));
    }

    // A cosine taper weights the inner cells and leaves little of the edge
    // effects, in any steering plane: measured 0.5 % (H-plane) and 1.0 %
    // (diagonal plane, whose largest error is in the beam below the array).
    for (const steeredTo of [{ thetaDeg: 30, phiDeg: 90 }, { thetaDeg: 40, phiDeg: 45 }]) {
      const size = 16;
      const taper = (m, n) => Math.cos(Math.PI * (m - (size - 1) / 2) / size) * Math.cos(Math.PI * (n - (size - 1) / 2) / size);
      const array = windowedArray(pattern, {
        steering: cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanDirection: steeredTo }),
        ...window(size, taper),
      });
      const solver = await finiteArray(array.cells);
      try {
        await solver.solveVoltages(array.drive);
        const error = await beamError(array, solver, steeredTo, size);
        assert.ok(error < 0.015, `steered to ${JSON.stringify(steeredTo)}: ${error}`);
      } finally {
        await solver.dispose();
      }
    }
  } finally {
    cell.dispose();
  }
});
