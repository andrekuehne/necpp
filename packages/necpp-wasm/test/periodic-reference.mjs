// Shared unit cells and finite-array references for the periodic-model tests.
import { createNecArraySolver, createNecPeriodicModel } from "../.test-build/src/index.js";

// About one-metre wavelength; half-wave dipoles along x.
export const FREQUENCY_MHZ = 299.792458;
// The engine's wavenumber at FREQUENCY_MHZ: its speed of light follows from
// NEC's permittivity 8.854e-12, so one metre is not exactly one wavelength.
export const WAVENUMBER_PER_M = 2 * Math.PI * FREQUENCY_MHZ * 1e6 * Math.sqrt(8.854e-12 * 4e-7 * Math.PI);
export const HALF_LENGTH_M = 0.24;
export const RADIUS_M = 0.001;
export const SEGMENTS = 11;
export const FEED_SEGMENT = 6;

/** A half-wave dipole along x, centred at `centre` (z defaults to 0), as a finite-array pattern wire. */
export const dipoleWire = (id, [x, y, z = 0], radiusM = RADIUS_M) => ({
  id,
  segments: SEGMENTS,
  startM: [x - HALF_LENGTH_M, y, z],
  endM: [x + HALF_LENGTH_M, y, z],
  radiusM,
});

/**
 * A periodic model of x-directed half-wave dipoles centred at `centres`, one
 * port per dipole at its centre segment (`segments` odd), without a lattice.
 */
export async function dipoleCell(centres, radiusM = RADIUS_M, segments = SEGMENTS) {
  const cell = await createNecPeriodicModel();
  centres.forEach(([x, y], index) => {
    cell.addWire({
      tag: index + 1,
      segments,
      start: [x - HALF_LENGTH_M, y, 0],
      end: [x + HALF_LENGTH_M, y, 0],
      radiusM,
    });
  });
  cell.completeGeometry();
  cell.definePorts(centres.map((_, index) => ({ tag: index + 1, segment: (segments + 1) / 2 })));
  return cell;
}

export function entry(matrix, row, column) {
  const index = row * matrix.columns + column;
  return [matrix.real[index], matrix.imag[index]];
}

export function distance([ar, ai], [br, bi]) {
  return Math.hypot(ar - br, ai - bi);
}

export function magnitude([real, imag]) {
  return Math.hypot(real, imag);
}

/** Largest entry difference of two P x P matrices, relative to the largest entry of `reference`. */
export function relativeMatrixError(matrix, reference) {
  let scale = 0;
  let error = 0;
  for (let row = 0; row < reference.rows; row += 1) {
    for (let column = 0; column < reference.columns; column += 1) {
      scale = Math.max(scale, magnitude(entry(reference, row, column)));
      error = Math.max(error, distance(entry(matrix, row, column), entry(reference, row, column)));
    }
  }
  return error / scale;
}

/**
 * Active impedances at the centre cell of a large finite array: the finite
 * estimate of the scan impedance.
 *
 * Cells sit at m * a1M + n * a2M for |m|, |n| <= `cells` and |rho| <= `radiusM`.
 * For each port p, every cell's port p carries the current
 * exp(-|rho|^2 / (2 sigmaM^2)) exp(j (m psi1 + n psi2)) and all other ports
 * are open; the centre cell then carries unit current, so its port voltages
 * are column p of the scan impedance. The Gaussian taper suppresses the edge
 * waves that make the centre of a uniformly driven array converge only like
 * N^(-1/2). `ground` is the array's ground model.
 *
 * Returns { rows, columns, real, imag } like the periodic model's impedance.
 */
export async function finiteArrayCentreImpedance({
  frequencyMHz,
  a1M,
  a2M,
  cells,
  radiusM = Infinity,
  sigmaM,
  psi,
  wires,
  ports,
  ground = { kind: "free-space" },
}) {
  const elements = [];
  const phases = [];
  const amplitudes = [];
  for (let m = -cells; m <= cells; m += 1) {
    for (let n = -cells; n <= cells; n += 1) {
      const x = m * a1M[0] + n * a2M[0];
      const y = m * a1M[1] + n * a2M[1];
      const radius = Math.hypot(x, y);
      if (radius > radiusM) {
        continue;
      }
      elements.push({ id: `cell_${m}_${n}`, positionM: [x, y], patternId: "cell" });
      amplitudes.push(Math.exp(-(radius * radius) / (2 * sigmaM * sigmaM)));
      phases.push(m * psi[0] + n * psi[1]);
    }
  }
  const centre = elements.findIndex((element) => element.id === "cell_0_0");
  const portCount = ports.length;
  const solver = await createNecArraySolver({
    elements,
    patterns: [{ id: "cell", kind: "straight-wire-pattern", wires, ports }],
    ground,
  }, { symmetry: "auto", symmetrizer: { positionEpsilonM: 1e-9 } });
  try {
    await solver.prepare({ frequencyMHz });
    const real = new Float64Array(portCount * portCount);
    const imag = new Float64Array(portCount * portCount);
    for (let column = 0; column < portCount; column += 1) {
      const currents = {
        real: new Float64Array(elements.length * portCount),
        imag: new Float64Array(elements.length * portCount),
      };
      for (let cell = 0; cell < elements.length; cell += 1) {
        currents.real[cell * portCount + column] = amplitudes[cell] * Math.cos(phases[cell]);
        currents.imag[cell * portCount + column] = amplitudes[cell] * Math.sin(phases[cell]);
      }
      const solution = await solver.solveCurrents(currents);
      for (let row = 0; row < portCount; row += 1) {
        real[row * portCount + column] = solution.voltages.real[centre * portCount + row];
        imag[row * portCount + column] = solution.voltages.imag[centre * portCount + row];
      }
    }
    return { rows: portCount, columns: portCount, real, imag };
  } finally {
    await solver.dispose();
  }
}
