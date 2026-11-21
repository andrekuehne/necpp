import {
  embeddedNormalization,
  finiteNumber,
  inputError,
  nativeNormalization,
  positiveNumber,
  requireRecord,
} from "./model.js";
import { necPeriodicWavenumberPerM } from "./nec-constants.js";
import { validScanDirection } from "./periodic-lattice.js";
import { validSweep } from "./periodic-sweep.js";
import {
  HORIZON_KAPPA,
  autoSpacingUV,
  circlesThrough,
  compatible,
  liftedDistanceSquared,
  locate,
  patternGrid,
  woodCircles,
  type LocatedNode,
  type WoodCircle,
} from "./scan-pattern-grid.js";
import { ERROR_SAFETY, LiftedInterpolant } from "./scan-pattern-interpolant.js";
import type {
  ComplexVector,
  DirectionUV,
  EmbeddedFieldNormalization,
  FloquetSide,
  PeriodicLattice,
  ScanElementAmplitudes,
  ScanElementPattern,
  ScanElementPatternDirection,
  ScanElementPatternOptions,
  ScanElementPatternSample,
  ScanElementPatternValue,
  ScanElementWoodCircle,
  ScanImpedanceResult,
  ScanSweepChunk,
  ScanSweepOptions,
  ScanSweepRequest,
} from "./types.js";

// The scan element pattern a(u, v) is the (0, 0) Floquet amplitude at the
// scan state pointing to (u, v). Its power normalization makes it behave like
// sqrt(cos theta) at the horizon, where the projected radiation vector
// vanishes with cos theta, so the interpolant works on
// h = (te phi-hat + tm theta-hat) / sqrt(cos theta) in Cartesian components:
// finite at the horizon and smooth through broadside, where phi-hat and
// theta-hat turn.

/** More samples than this are refused. */
const MAX_SAMPLES = 50_000;
/** The automatic grid widens its spacing until it has at most this many samples. */
const AUTO_SAMPLES = 8_000;
/** Explicit points must lie inside the grid's edge. */
const EDGE_SQUARED = 1 - HORIZON_KAPPA * HORIZON_KAPPA;
/** Interpolated values per port and side: real and imaginary x, y, z of h. */
const COMPONENTS = 6;

/** Adaptive refinement by default. */
const DEFAULT_TOLERANCE = 0.01;
const DEFAULT_ROUNDS = 4;

/** @internal A scan element pattern request, validated. */
export interface ValidPatternRequest {
  readonly frequencyMHz: number;
  readonly normalization: EmbeddedFieldNormalization;
  readonly spacingUV: number | undefined;
  readonly points: readonly DirectionUV[] | undefined;
  readonly refinement: false | {
    readonly tolerance: number;
    readonly maxRounds: number;
    readonly maxSamples: number | undefined;
  };
}

function validRefinement(value: unknown): ValidPatternRequest["refinement"] {
  if (value === false) return false;
  const record = requireRecord(value ?? {}, "request.refinement");
  const tolerance = record.tolerance === undefined
    ? DEFAULT_TOLERANCE
    : positiveNumber(record.tolerance, "request.refinement.tolerance");
  const maxRounds = record.maxRounds ?? DEFAULT_ROUNDS;
  if (!Number.isInteger(maxRounds) || (maxRounds as number) < 0 || (maxRounds as number) > 8) {
    inputError("request.refinement.maxRounds must be an integer from 0 through 8", {
      name: "request.refinement.maxRounds",
      value: maxRounds,
    });
  }
  const maxSamples = record.maxSamples;
  if (maxSamples !== undefined
      && (!Number.isInteger(maxSamples) || (maxSamples as number) < 1 || (maxSamples as number) > MAX_SAMPLES)) {
    inputError(`request.refinement.maxSamples must be an integer from 1 through ${MAX_SAMPLES}`, {
      name: "request.refinement.maxSamples",
      value: maxSamples,
    });
  }
  return Object.freeze({ tolerance, maxRounds: maxRounds as number, maxSamples: maxSamples as number | undefined });
}

function validPoint(value: unknown, name: string): DirectionUV {
  const record = requireRecord(value, name);
  const u = finiteNumber(record.u, `${name}.u`);
  const v = finiteNumber(record.v, `${name}.v`);
  if (u * u + v * v > EDGE_SQUARED) {
    inputError(`${name} must lie inside the horizon (u^2 + v^2 <= 1 - 1e-8)`, { name, value: [u, v] });
  }
  return Object.freeze({ u, v });
}

/** @internal Validate a scan element pattern request and its options before anything starts. */
export function validPatternRequest(request: unknown, options: unknown): ValidPatternRequest {
  const record = requireRecord(request, "request");
  const frequencyMHz = positiveNumber(record.frequencyMHz, "request.frequencyMHz");
  const normalization = embeddedNormalization(
    record.normalization === undefined ? 0 : nativeNormalization(record.normalization, "request.normalization"),
  );
  if (options !== undefined) {
    // The sweep options, as every sweep behind the pattern will check them.
    validSweep({ frequencyMHz, scanStates: [] }, options as ScanSweepOptions);
    const onProgress = requireRecord(options, "options").onProgress;
    if (onProgress !== undefined && typeof onProgress !== "function") {
      inputError("options.onProgress must be a function", { name: "options.onProgress" });
    }
  }
  const refinement = validRefinement(record.refinement);
  const grid = record.grid ?? "auto";
  if (grid === "auto") return { frequencyMHz, normalization, spacingUV: undefined, points: undefined, refinement };
  if (typeof grid !== "object" || grid === null) {
    inputError('request.grid must be "auto" or { spacingUV?, points? }', { name: "request.grid", value: grid });
  }
  const { spacingUV, points } = grid as Readonly<Record<string, unknown>>;
  const spacing = spacingUV === undefined ? undefined : positiveNumber(spacingUV, "request.grid.spacingUV");
  if (spacing !== undefined && spacing > 0.5) {
    inputError("request.grid.spacingUV must be at most 0.5", { name: "request.grid.spacingUV", value: spacing });
  }
  if (points !== undefined && !Array.isArray(points)) {
    inputError("request.grid.points must be an array of { u, v }", { name: "request.grid.points" });
  }
  return {
    frequencyMHz,
    normalization,
    spacingUV: spacing,
    points: points === undefined
      ? undefined
      : Object.freeze((points as readonly unknown[]).map((point, index) =>
        validPoint(point, `request.grid.points[${index}]`))),
    refinement,
  };
}

/** phi-hat and theta-hat of the direction (u, v) above or below the cell, and cos(theta) above. */
function frame(u: number, v: number, side: FloquetSide): {
  readonly phi: readonly [number, number, number];
  readonly theta: readonly [number, number, number];
  readonly kappa: number;
} {
  const sine = Math.hypot(u, v);
  const kappa = Math.sqrt(Math.max(0, 1 - sine * sine));
  // phi = 0 at broadside, as for the Floquet amplitudes.
  const [cosPhi, sinPhi] = sine > 0 ? [u / sine, v / sine] : [1, 0];
  const cosTheta = side === "above" ? kappa : -kappa;
  return {
    phi: [-sinPhi, cosPhi, 0],
    theta: [cosTheta * cosPhi, cosTheta * sinPhi, -sine],
    kappa,
  };
}

function complexVector(real: ArrayLike<number>, imag: ArrayLike<number>): ComplexVector {
  return Object.freeze({ real: Float64Array.from(real), imag: Float64Array.from(imag) });
}

function copyAmplitudes(amplitudes: ScanElementAmplitudes): ScanElementAmplitudes {
  return Object.freeze({
    te: complexVector(amplitudes.te.real, amplitudes.te.imag),
    tm: complexVector(amplitudes.tm.real, amplitudes.tm.imag),
  });
}

/** The (0, 0) amplitudes of a scan result on one side, if it has them. */
function zeroOrder(result: ScanImpedanceResult, side: FloquetSide): ScanElementAmplitudes | undefined {
  const mode = result.floquet.modes.find((entry) => entry.p === 0 && entry.q === 0 && entry.side === side);
  return mode === undefined ? undefined : copyAmplitudes(mode);
}

class ComputedScanElementPattern implements ScanElementPattern {
  readonly frequencyMHz: number;
  readonly normalization: EmbeddedFieldNormalization;
  readonly portCount: number;
  readonly sides: readonly FloquetSide[];
  readonly spacingUV: number;
  readonly woodCircles: readonly ScanElementWoodCircle[];
  readonly samples: readonly ScanElementPatternSample[];
  readonly #interpolant: LiftedInterpolant;

  constructor(
    request: ValidPatternRequest,
    spacing: number,
    circles: readonly WoodCircle[],
    interpolant: LiftedInterpolant,
    samples: readonly ScanElementPatternSample[],
  ) {
    this.frequencyMHz = request.frequencyMHz;
    this.normalization = request.normalization;
    this.portCount = samples[0]!.above.te.real.length;
    this.sides = Object.freeze(samples[0]!.below === undefined ? ["above"] : ["above", "below"]);
    this.spacingUV = spacing;
    this.woodCircles = circles;
    this.samples = samples;
    this.#interpolant = interpolant;
    Object.freeze(this);
  }

  evaluate(direction: ScanElementPatternDirection, side: FloquetSide = "above"): ScanElementPatternValue {
    const record = requireRecord(direction, "direction");
    let u: number;
    let v: number;
    if (record.thetaDeg !== undefined || record.phiDeg !== undefined) {
      const { thetaDeg, phiDeg } = validScanDirection(record, "direction");
      const sine = Math.sin(thetaDeg * Math.PI / 180);
      u = sine * Math.cos(phiDeg * Math.PI / 180);
      v = sine * Math.sin(phiDeg * Math.PI / 180);
    } else {
      u = finiteNumber(record.u, "direction.u");
      v = finiteNumber(record.v, "direction.v");
      if (u * u + v * v > 1 + 1e-12) {
        inputError("direction must lie in visible space (u^2 + v^2 <= 1)", { name: "direction", value: [u, v] });
      }
    }
    const sideIndex = this.sides.indexOf(side);
    if (sideIndex < 0) {
      inputError(
        side === "below" ? "There is no field below the cell over ground" : 'side must be "above" or "below"',
        { name: "side", value: side },
      );
    }
    const ports = this.portCount;
    const { values, errors, node } = this.#interpolant.evaluate(u, v);
    if (node !== undefined) {
      const sample = this.samples[node]!;
      return Object.freeze({
        ...copyAmplitudes(side === "above" ? sample.above : sample.below!),
        interpolationError: new Float64Array(ports),
        sampled: true,
      });
    }
    const { phi, theta, kappa } = frame(u, v, side);
    const scale = Math.sqrt(kappa);
    const te = { real: new Float64Array(ports), imag: new Float64Array(ports) };
    const tm = { real: new Float64Array(ports), imag: new Float64Array(ports) };
    const interpolationError = new Float64Array(ports);
    for (let port = 0; port < ports; port += 1) {
      const offset = (sideIndex * ports + port) * COMPONENTS;
      let squared = 0;
      for (let axis = 0; axis < 3; axis += 1) {
        const real = values[offset + 2 * axis]!;
        const imag = values[offset + 2 * axis + 1]!;
        te.real[port]! += scale * phi[axis]! * real;
        te.imag[port]! += scale * phi[axis]! * imag;
        tm.real[port]! += scale * theta[axis]! * real;
        tm.imag[port]! += scale * theta[axis]! * imag;
        squared += errors[offset + 2 * axis]! ** 2 + errors[offset + 2 * axis + 1]! ** 2;
      }
      interpolationError[port] = scale * Math.sqrt(squared);
    }
    return Object.freeze({
      te: Object.freeze(te),
      tm: Object.freeze(tm),
      interpolationError,
      sampled: false,
    });
  }
}

/** h = (te phi-hat + tm theta-hat) / sqrt(cos theta) of every port and side, as interpolated values. */
function interpolatedValues(sample: ScanElementPatternSample, sides: readonly FloquetSide[], ports: number): Float64Array {
  const values = new Float64Array(sides.length * ports * COMPONENTS);
  sides.forEach((side, sideIndex) => {
    const { phi, theta, kappa } = frame(sample.u, sample.v, side);
    const amplitudes = side === "above" ? sample.above : sample.below!;
    const scale = 1 / Math.sqrt(kappa);
    for (let port = 0; port < ports; port += 1) {
      const offset = (sideIndex * ports + port) * COMPONENTS;
      for (let axis = 0; axis < 3; axis += 1) {
        values[offset + 2 * axis] = scale
          * (amplitudes.te.real[port]! * phi[axis]! + amplitudes.tm.real[port]! * theta[axis]!);
        values[offset + 2 * axis + 1] = scale
          * (amplitudes.te.imag[port]! * phi[axis]! + amplitudes.tm.imag[port]! * theta[axis]!);
      }
    }
  });
  return values;
}


/** A direction to add as a sample, with the Wood circles (by index) it lies on. */
type RefinementPoint = DirectionUV & { on: number[] };

/** The largest of `sqrt(|te|^2 + |tm|^2)` over the samples, ports and sides. */
function largestAmplitude(samples: readonly ScanElementPatternSample[]): number {
  let largest = 0;
  for (const sample of samples) {
    for (const amplitudes of [sample.above, sample.below]) {
      if (amplitudes === undefined) continue;
      for (let port = 0; port < amplitudes.te.real.length; port += 1) {
        largest = Math.max(largest, Math.hypot(
          amplitudes.te.real[port]!,
          amplitudes.te.imag[port]!,
          amplitudes.tm.real[port]!,
          amplitudes.tm.imag[port]!,
        ));
      }
    }
  }
  return largest;
}

/** The largest amplitude error, over ports and sides, that errors of the interpolated values at (u, v) make. */
function amplitudeError(errors: Float64Array, u: number, v: number): number {
  const scale = Math.sqrt(Math.sqrt(Math.max(0, 1 - u * u - v * v)));
  let largest = 0;
  for (let offset = 0; offset < errors.length; offset += COMPONENTS) {
    let squared = 0;
    for (let component = 0; component < COMPONENTS; component += 1) squared += errors[offset + component]! ** 2;
    largest = Math.max(largest, scale * Math.sqrt(squared));
  }
  return largest;
}

/**
 * The point half-way between two samples: along a Wood circle both lie on,
 * along a row (equal kappa of one circle) both lie on, or straight between.
 */
function midpoint(circles: readonly WoodCircle[], a: LocatedNode, b: LocatedNode): RefinementPoint {
  let around: { readonly centre: readonly [number, number]; readonly radius: number } | undefined;
  const shared = a.on.find((circle) => b.on.includes(circle));
  if (shared !== undefined) {
    around = { centre: circles[shared]!.centreUV, radius: 1 };
  } else {
    const row = circles.findIndex((_, circle) => a.sides[circle] === b.sides[circle]
      && Math.abs(a.kappa[circle]! - b.kappa[circle]!) <= 1e-12 * Math.max(1, a.kappa[circle]!));
    if (row >= 0) {
      const centre = circles[row]!.centreUV;
      around = { centre, radius: Math.hypot(a.u - centre[0], a.v - centre[1]) };
    }
  }
  let [u, v] = [(a.u + b.u) / 2, (a.v + b.v) / 2];
  if (around !== undefined) {
    const [cu, cv] = around.centre;
    const length = Math.hypot(u - cu, v - cv);
    if (length > 0) [u, v] = [cu + (u - cu) * around.radius / length, cv + (v - cv) * around.radius / length];
  }
  return { u, v, on: circlesThrough(circles, u, v, shared === undefined ? [] : [shared]) };
}

/** Samples closer than this fraction of the distance between the pair a midpoint splits make it redundant. */
const REDUNDANT_FRACTION = 0.3;
/** Pairs closer than this fraction of the grid spacing are not split further. */
const FINEST_FRACTION = 1 / 64;
/** Neighbours of an under-resolved sample that it is split towards. */
const SPLIT_NEIGHBOURS = 6;

/** Midpoints around the samples whose leave-one-out errors exceed `threshold`, worst first. */
function refinementPoints(
  circles: readonly WoodCircle[],
  nodes: readonly LocatedNode[],
  interpolant: LiftedInterpolant,
  spacing: number,
  threshold: number,
): (RefinementPoint)[] {
  const candidates: { readonly point: RefinementPoint; readonly error: number; readonly gap: number }[] = [];
  nodes.forEach((node, index) => {
    const error = ERROR_SAFETY * Math.max(...interpolant.leaveOneOut(index).map((errors) =>
      amplitudeError(errors, node.u, node.v)));
    if (!(error > threshold)) return;
    for (const neighbour of interpolant.neighbours(index, SPLIT_NEIGHBOURS)) {
      const other = nodes[neighbour]!;
      const gap = Math.sqrt(liftedDistanceSquared(node, other));
      if (gap < FINEST_FRACTION * spacing) continue;
      const point = midpoint(circles, node, other);
      if (point.u * point.u + point.v * point.v > EDGE_SQUARED * (1 + 1e-12)) continue;
      candidates.push({ point, error, gap });
    }
  });
  candidates.sort((left, right) => right.error - left.error);
  const accepted: { readonly located: LocatedNode; readonly gap: number }[] = [];
  const points: (RefinementPoint)[] = [];
  for (const { point, gap } of candidates) {
    const located = locate(circles, point.u, point.v, point.on, spacing);
    if (interpolant.nearestDistance(point.u, point.v, point.on) < REDUNDANT_FRACTION * gap) continue;
    if (accepted.some((other) => compatible(other.located.sides, located.sides)
        && liftedDistanceSquared(other.located, located) < (REDUNDANT_FRACTION * Math.min(gap, other.gap)) ** 2)) {
      continue;
    }
    accepted.push({ located, gap });
    points.push(point);
  }
  return points;
}

/**
 * @internal The scan element pattern of the cell on `lattice`, from sweeps
 * with `sweep` (a periodic model's `sweepScanImpedance`): over the pattern's
 * grid, then over the points adaptive refinement adds.
 */
export async function computeScanElementPattern(
  lattice: PeriodicLattice,
  sweep: (request: ScanSweepRequest, options: ScanSweepOptions) => AsyncIterable<ScanSweepChunk>,
  request: ValidPatternRequest,
  options: ScanElementPatternOptions | undefined,
): Promise<ScanElementPattern> {
  const { frequencyMHz, normalization } = request;
  const circles = woodCircles(lattice, frequencyMHz);
  let spacing = request.spacingUV ?? autoSpacingUV(circles);
  let grid = patternGrid(circles, spacing, request.points);
  // Only a grid of its own choosing: explicit points are always kept.
  while (request.spacingUV === undefined && request.points === undefined && grid.length > AUTO_SAMPLES) {
    spacing *= 1.25;
    grid = patternGrid(circles, spacing, request.points);
  }
  if (grid.length > MAX_SAMPLES) {
    inputError(`The scan element pattern grid has ${grid.length} samples, more than ${MAX_SAMPLES}`, {
      name: "request.grid",
      value: grid.length,
    });
  }
  // (u, v) = kt0 / k with the kernel's k: psi_i = -k (u, v) . a_i.
  const k = necPeriodicWavenumberPerM(frequencyMHz);
  const [a1, a2] = [lattice.a1M, lattice.a2M];
  const sweepOptions: ScanSweepOptions = {
    ...(options?.signal === undefined ? {} : { signal: options.signal }),
    ...(options?.workers === undefined ? {} : { workers: options.workers }),
  };
  const nodes: LocatedNode[] = [];
  const samples: ScanElementPatternSample[] = [];
  /** Solve the scan states pointing to `points` and append them as samples of `round`. */
  const solve = async (points: readonly LocatedNode[], round: number): Promise<void> => {
    const scanPhases = points.map(({ u, v }) =>
      Object.freeze([-k * (u * a1[0] + v * a1[1]), -k * (u * a2[0] + v * a2[1])] as const));
    const results: ScanImpedanceResult[] = new Array(points.length);
    const before = samples.length;
    const chunks = sweep(
      { frequencyMHz, normalization, scanStates: scanPhases.map((scanPhasesRad) => ({ scanPhasesRad })) },
      sweepOptions,
    );
    for await (const chunk of chunks) {
      for (const { index, result } of chunk.points) results[index] = result;
      options?.onProgress?.({ completed: before + chunk.completed, total: before + chunk.total, round });
    }
    points.forEach((node, index) => {
      const result = results[index]!;
      nodes.push(node);
      samples.push(Object.freeze({
        u: node.u,
        v: node.v,
        round,
        scanPhasesRad: scanPhases[index]!,
        woodCircles: Object.freeze(node.on.map((circle) => Object.freeze({ p: circles[circle]!.p, q: circles[circle]!.q }))),
        above: zeroOrder(result, "above")!,
        below: zeroOrder(result, "below"),
        diagnostics: result.diagnostics,
      }));
    });
  };
  await solve(grid, 0);
  const sides: readonly FloquetSide[] = samples[0]!.below === undefined ? ["above"] : ["above", "below"];
  const ports = samples[0]!.above.te.real.length;
  const interpolant = new LiftedInterpolant(
    circles,
    nodes,
    samples.map((sample) => interpolatedValues(sample, sides, ports)),
    spacing,
  );
  const refinement = request.refinement;
  if (refinement !== false) {
    // By default at most four times the grid.
    const limit = refinement.maxSamples ?? Math.min(MAX_SAMPLES, 4 * grid.length);
    for (let round = 1; round <= refinement.maxRounds && samples.length < limit; round += 1) {
      const threshold = refinement.tolerance * largestAmplitude(samples);
      const points = refinementPoints(circles, nodes, interpolant, spacing, threshold)
        .slice(0, limit - samples.length)
        .map(({ u, v, on }) => locate(circles, u, v, on, spacing));
      if (points.length === 0) break;
      const first = samples.length;
      await solve(points, round);
      interpolant.add(points, samples.slice(first).map((sample) => interpolatedValues(sample, sides, ports)));
    }
  }
  return new ComputedScanElementPattern(request, spacing, circles, interpolant, Object.freeze(samples));
}
