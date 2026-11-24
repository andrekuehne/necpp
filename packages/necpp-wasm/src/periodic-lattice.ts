import { finiteNumber, inputError, positiveNumber, requireRecord } from "./model.js";
import { necWavenumberPerM } from "./nec-constants.js";
import type {
  LatticeVectorM,
  PeriodicGeometryOptions,
  PeriodicLattice,
  ScanDirection,
  ScanPhasesRad,
} from "./types.js";

// Named lattices exist only here: the engine and the C ABI take any two
// lattice vectors. Every preset fixes the meaning of the scan phases through
// the vectors it returns.

function lattice(a1M: LatticeVectorM, a2M: LatticeVectorM): PeriodicLattice {
  return Object.freeze({ a1M: Object.freeze(a1M), a2M: Object.freeze(a2M) });
}

/** Square lattice: `a1M = [d, 0]`, `a2M = [0, d]`. */
export function squareLattice(options: { readonly spacingM: number }): PeriodicLattice {
  const record = requireRecord(options, "options");
  const spacing = positiveNumber(record.spacingM, "options.spacingM");
  return lattice([spacing, 0], [0, spacing]);
}

/** Rectangular lattice: `a1M = [dx, 0]`, `a2M = [0, dy]`. */
export function rectangularLattice(options: {
  readonly spacingXM: number;
  readonly spacingYM: number;
}): PeriodicLattice {
  const record = requireRecord(options, "options");
  const dx = positiveNumber(record.spacingXM, "options.spacingXM");
  const dy = positiveNumber(record.spacingYM, "options.spacingYM");
  return lattice([dx, 0], [0, dy]);
}

/**
 * Centered rectangular lattice (staggered rows): rows along x with in-row
 * spacing `spacingXM`, rows `spacingYM` apart, every other row shifted by half
 * the in-row spacing. `a1M = [dx, 0]`, `a2M = [dx / 2, dy]`.
 */
export function centeredRectangularLattice(options: {
  readonly spacingXM: number;
  readonly spacingYM: number;
}): PeriodicLattice {
  const record = requireRecord(options, "options");
  const dx = positiveNumber(record.spacingXM, "options.spacingXM");
  const dy = positiveNumber(record.spacingYM, "options.spacingYM");
  return lattice([dx, 0], [dx / 2, dy]);
}

/**
 * Hexagonal lattice (equilateral triangular grid): lattice vectors of length
 * `spacingM` at 60 degrees. Rows along x (the default) give
 * `a1M = [d, 0]`, `a2M = [d / 2, d sqrt(3) / 2]`; rows along y give
 * `a1M = [0, d]`, `a2M = [d sqrt(3) / 2, d / 2]`.
 */
export function hexagonalLattice(options: {
  readonly spacingM: number;
  readonly rowsAlong?: "x" | "y";
}): PeriodicLattice {
  const record = requireRecord(options, "options");
  const spacing = positiveNumber(record.spacingM, "options.spacingM");
  const rowsAlong = record.rowsAlong ?? "x";
  const rowHeight = spacing * Math.sqrt(3) / 2;
  if (rowsAlong === "x") {
    return lattice([spacing, 0], [spacing / 2, rowHeight]);
  }
  if (rowsAlong === "y") {
    return lattice([0, spacing], [rowHeight, spacing / 2]);
  }
  return inputError('options.rowsAlong must be "x" or "y"', {
    name: "options.rowsAlong",
    value: rowsAlong,
  });
}

/** @internal Validate a pair of finite numbers, such as a lattice vector or scan phases. */
export function finitePair(value: unknown, name: string): readonly [number, number] {
  if (
    !Array.isArray(value)
    || value.length !== 2
    || !value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  ) {
    inputError(`${name} must be a pair of finite numbers`, { name, value });
  }
  return Object.freeze([value[0] as number, value[1] as number]);
}

/** @internal Validate the shape of a lattice; the engine checks that the vectors are not parallel. */
export function validLattice(value: unknown, name: string): PeriodicLattice {
  const record = requireRecord(value, name);
  return lattice(finitePair(record.a1M, `${name}.a1M`), finitePair(record.a2M, `${name}.a2M`));
}

/** @internal Validate a scan direction in visible space. */
export function validScanDirection(value: unknown, name: string): ScanDirection {
  const record = requireRecord(value, name);
  const thetaDeg = finiteNumber(record.thetaDeg, `${name}.thetaDeg`);
  const phiDeg = finiteNumber(record.phiDeg, `${name}.phiDeg`);
  if (thetaDeg < 0 || thetaDeg > 90) {
    inputError(`${name}.thetaDeg must be between 0 and 90 (visible space)`, {
      name: `${name}.thetaDeg`,
      value: thetaDeg,
    });
  }
  return Object.freeze({ thetaDeg, phiDeg });
}

/**
 * Scan phases along the given lattice vectors for a scan direction in visible
 * space: `psi_i = -kt0 . a_i` with `kt0 = k sin(theta) [cos(phi), sin(phi)]`
 * and k the free-space wavenumber at `frequencyMHz`. The current in cell
 * (m, n) then advances by `exp(j (m psi1 + n psi2))` and the main beam points
 * to (theta, phi).
 */
export function scanPhasesForDirection(options: {
  readonly lattice: PeriodicLattice;
  readonly frequencyMHz: number;
  readonly thetaDeg: number;
  readonly phiDeg: number;
}): ScanPhasesRad {
  const record = requireRecord(options, "options");
  const { a1M, a2M } = validLattice(record.lattice, "options.lattice");
  const frequencyMHz = positiveNumber(record.frequencyMHz, "options.frequencyMHz");
  const { thetaDeg, phiDeg } = validScanDirection(record, "options");
  const transverse = necWavenumberPerM(frequencyMHz) * Math.sin(thetaDeg * Math.PI / 180);
  const phi = phiDeg * Math.PI / 180;
  const kx = transverse * Math.cos(phi);
  const ky = transverse * Math.sin(phi);
  return Object.freeze([-(kx * a1M[0] + ky * a1M[1]), -(kx * a2M[0] + ky * a2M[1])]);
}

/**
 * The geometry options of a unit cell, validated: only `"none"` and
 * `"interpolate"` ground connections, and no symmetry.
 */
export function validPeriodicGeometryOptions(options: unknown): PeriodicGeometryOptions {
  const record = requireRecord(options ?? {}, "options");
  for (const key of Object.keys(record)) {
    if (key !== "groundConnection") {
      inputError(`options.${key} is not supported in periodic mode`, { name: `options.${key}` });
    }
  }
  const connection = record.groundConnection ?? "none";
  if (connection === "zero-current") {
    inputError(
      'options.groundConnection "zero-current" is not supported in periodic mode; use "interpolate"',
      { name: "options.groundConnection", value: connection },
    );
  }
  if (connection !== "none" && connection !== "interpolate") {
    inputError('options.groundConnection must be "none" or "interpolate"', {
      name: "options.groundConnection",
      value: connection,
    });
  }
  return Object.freeze({ groundConnection: connection });
}
