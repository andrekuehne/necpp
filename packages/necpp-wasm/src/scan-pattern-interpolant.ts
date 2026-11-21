import {
  KAPPA_NEAR,
  compatible,
  liftedDistanceSquared,
  locate,
  type LocatedNode,
  type WoodCircle,
} from "./scan-pattern-grid.js";

// Interpolation of values sampled on a scan-pattern grid, never across a Wood
// circle. A point is interpolated from the nodes on its own side of every
// circle (nodes on a circle serve both sides), by a local polyharmonic spline
// (r^3) in lifted coordinates: u, v and the lift of kappa (`liftOf`) of each
// Wood circle near the point, in which the graded rows along a circle are
// evenly spaced. Its polynomial tail also holds kappa itself, times 1, u and
// v, so a function A + kappa B with A and B smooth, the square-root kink at a
// circle, is reproduced to the order of the tail. Each stencil serves the
// points nearest its anchor node. The stated error combines its leave-one-out
// errors (Rippa's formula) with the spread between alternative interpolants
// of the same point.

/** Interpolated values at one point and their stated errors. */
export interface InterpolatedValues {
  readonly values: Float64Array;
  /** Per value: the stated error (see `evaluate`); 0 at a node. */
  readonly errors: Float64Array;
  /** The node at exactly this point, if any. */
  readonly node: number | undefined;
}

/**
 * Polynomial tails, richest first: cubic (3) or quadratic (2) in (u, v),
 * with the lift and kappa (1, u, v) of each lifted circle and the kappa
 * products of crossing circles; linear with lift and kappa (1); linear in
 * (u, v) without lifting (0).
 */
type TailLevel = 3 | 2 | 1 | 0;

interface Stencil {
  readonly anchor: LocatedNode;
  /** Circles whose lift is a coordinate. */
  readonly near: readonly number[];
  readonly level: TailLevel | "constant";
  /** Stencil nodes, nearest the anchor first. */
  readonly nodes: readonly number[];
  /** The largest lifted distance from the anchor to a stencil node. */
  readonly radius: number;
  /** Coordinates are relative to the anchor and multiplied by this, so that the stencil fits the unit ball. */
  readonly scale: number;
  /**
   * Per stencil node, relative to the anchor and scaled: u, v and the lifts
   * of the near circles (the spline's coordinates), then their kappas (for
   * the tail).
   */
  readonly points: Float64Array;
  /** Terms of the full tail of `level`. */
  readonly basisSize: number;
  /** The tail's terms in use, by index in the full tail. */
  readonly terms: readonly number[];
  /** Row per stencil node then per term in use, column per value. */
  readonly coefficients: Float64Array;
  /** Row per stencil node, column per value: absolute leave-one-out errors. */
  readonly leaveOneOut: Float64Array;
}

/** Stencil nodes whose leave-one-out errors make up a point's stated error. */
const ERROR_NODES = 6;
/**
 * The stated error is this multiple of the largest error indicator. With it,
 * on dipole arrays the actual error stayed below half the stated one; on an
 * analytic function with a kink at each of seven Wood circles it exceeded the
 * stated error at 0.3 % of points, by up to 4 times, near crossings of two
 * circles.
 */
export const ERROR_SAFETY = 3;
/** Relative pivot below which a stencil system counts as singular. */
const SINGULAR_PIVOT = 1e-13;

function polynomialCount(level: TailLevel, near: number): number {
  if (level === 0) return 3;
  if (level === 1) return 3 + 2 * near;
  return (level === 3 ? 10 : 6) + 4 * near + near * (near - 1) / 2;
}

/**
 * Nodes in a stencil with a tail of `polynomials` terms. Two and a half
 * times the tail kept the worst error on dipole arrays at a sixth of that of
 * twice the tail, at spacing 0.1.
 */
function stencilSize(polynomials: number): number {
  return Math.max(15, Math.ceil(2.5 * polynomials) + 2);
}

/** Values per stencil node in `Stencil.points`. */
function pointSize(near: number): number {
  return 2 + 2 * near;
}

/** The tail's polynomials at the point `x[offset...]` laid out as in `Stencil.points`. */
function polynomials(level: TailLevel, x: Float64Array, offset: number, near: number, out: Float64Array): void {
  const u = x[offset]!;
  const v = x[offset + 1]!;
  out[0] = 1;
  out[1] = u;
  out[2] = v;
  if (level === 0) return;
  let index = 3;
  if (level >= 2) {
    out[index++] = u * u;
    out[index++] = u * v;
    out[index++] = v * v;
  }
  if (level === 3) {
    out[index++] = u * u * u;
    out[index++] = u * u * v;
    out[index++] = u * v * v;
    out[index++] = v * v * v;
  }
  for (let c = 0; c < near; c += 1) {
    const kappa = x[offset + 2 + near + c]!;
    out[index++] = x[offset + 2 + c]!;
    out[index++] = kappa;
    if (level >= 2) {
      out[index++] = kappa * u;
      out[index++] = kappa * v;
    }
  }
  if (level >= 2) {
    for (let c = 0; c < near; c += 1) {
      for (let d = c + 1; d < near; d += 1) {
        out[index++] = x[offset + 2 + near + c]! * x[offset + 2 + near + d]!;
      }
    }
  }
}

/** A tail term whose values at the stencil nodes are this close (relatively) to the span of the others is dropped. */
const DEPENDENT_TERM = 1e-6;

/**
 * Indices of a maximal set of columns of `matrix` (row-major, `rows` x
 * `columns`) that are numerically independent: pivoted Gram-Schmidt, taking
 * the column with the largest relative residual first.
 */
function independentColumns(matrix: Float64Array, rows: number, columns: number): number[] {
  const residual = Array.from({ length: columns }, (_, column) =>
    Float64Array.from({ length: rows }, (_, row) => matrix[row * columns + column]!));
  const squaredNorm = (vector: Float64Array): number => {
    let sum = 0;
    for (let row = 0; row < rows; row += 1) sum += vector[row]! * vector[row]!;
    return sum;
  };
  const original = residual.map(squaredNorm);
  const remaining = new Set(Array.from({ length: columns }, (_, column) => column).filter((column) => original[column]! > 0));
  const kept: number[] = [];
  while (remaining.size > 0) {
    let best = -1;
    let bestRatio = 0;
    for (const column of remaining) {
      const ratio = squaredNorm(residual[column]!) / original[column]!;
      if (ratio > bestRatio) {
        best = column;
        bestRatio = ratio;
      }
    }
    if (bestRatio < DEPENDENT_TERM * DEPENDENT_TERM) break;
    remaining.delete(best);
    kept.push(best);
    const pivot = residual[best]!;
    const length = Math.sqrt(squaredNorm(pivot));
    for (let row = 0; row < rows; row += 1) pivot[row]! /= length;
    for (const column of remaining) {
      const vector = residual[column]!;
      let dot = 0;
      for (let row = 0; row < rows; row += 1) dot += vector[row]! * pivot[row]!;
      for (let row = 0; row < rows; row += 1) vector[row]! -= dot * pivot[row]!;
    }
  }
  return kept.sort((left, right) => left - right);
}

/**
 * The inverse of a dense matrix (row-major, order n), or undefined if
 * singular: Gauss-Jordan with partial pivoting on rows [A | I].
 */
function inverse(matrix: Float64Array, n: number): Float64Array | undefined {
  const rows = Array.from({ length: n }, (_, row) => {
    const augmented = new Float64Array(2 * n);
    augmented.set(matrix.subarray(row * n, (row + 1) * n));
    augmented[n + row] = 1;
    return augmented;
  });
  let largest = 0;
  for (let column = 0; column < n; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < n; row += 1) {
      if (Math.abs(rows[row]![column]!) > Math.abs(rows[pivot]![column]!)) pivot = row;
    }
    [rows[column], rows[pivot]] = [rows[pivot]!, rows[column]!];
    const lead = rows[column]!;
    const value = lead[column]!;
    largest = Math.max(largest, Math.abs(value));
    if (!(Math.abs(value) > SINGULAR_PIVOT * largest)) return undefined;
    // Left of the column the lead row is already zero.
    for (let entry = column; entry < 2 * n; entry += 1) lead[entry]! /= value;
    for (let row = 0; row < n; row += 1) {
      if (row === column) continue;
      const target = rows[row]!;
      const factor = target[column]!;
      if (factor === 0) continue;
      for (let entry = column; entry < 2 * n; entry += 1) target[entry]! -= factor * lead[entry]!;
    }
  }
  const result = new Float64Array(n * n);
  rows.forEach((row, index) => result.set(row.subarray(n), index * n));
  return result;
}

/** @internal */
export class LiftedInterpolant {
  readonly #circles: readonly WoodCircle[];
  readonly #nodes: LocatedNode[] = [];
  readonly #values: Float64Array[] = [];
  readonly #outputs: number;
  readonly #spacing: number;
  readonly #buckets = new Map<number, number[]>();
  readonly #stencils = new Map<string, Stencil>();

  /**
   * `values[i]` holds the values at node `i`, all of the same length;
   * `spacing` is the grid's spacing in u-v.
   */
  constructor(
    circles: readonly WoodCircle[],
    nodes: readonly LocatedNode[],
    values: readonly Float64Array[],
    spacing: number,
  ) {
    this.#circles = circles;
    this.#outputs = values[0]?.length ?? 0;
    this.#spacing = spacing;
    this.#append(nodes, values);
  }

  #append(nodes: readonly LocatedNode[], values: readonly Float64Array[]): void {
    nodes.forEach((node, offset) => {
      const index = this.#nodes.length;
      this.#nodes.push(node);
      this.#values.push(values[offset]!);
      const key = this.#key(node.u, node.v);
      const bucket = this.#buckets.get(key);
      if (bucket === undefined) this.#buckets.set(key, [index]);
      else bucket.push(index);
    });
  }

  /** Add nodes, dropping the stencils they would change. */
  add(nodes: readonly LocatedNode[], values: readonly Float64Array[]): void {
    for (const [key, stencil] of this.#stencils) {
      const { anchor, radius } = stencil;
      // The lifted distance is at least the planar one.
      if (nodes.some((node) => (node.u - anchor.u) ** 2 + (node.v - anchor.v) ** 2 <= radius * radius)) {
        this.#stencils.delete(key);
      }
    }
    this.#append(nodes, values);
  }

  /** The sides a node can be interpolated from: one per choice of side on each circle it lies on. */
  #sideVariants(node: LocatedNode): Int8Array[] {
    let variants = [Int8Array.from(node.sides)];
    for (const circle of node.on) {
      variants = variants.flatMap((sides) => [1, -1].map((side) => {
        const copy = Int8Array.from(sides);
        copy[circle] = side;
        return copy;
      }));
    }
    return variants;
  }

  /**
   * The leave-one-out errors of a node in the stencils anchored on it (one
   * per side variant), per value: how well its neighbours predict it.
   */
  leaveOneOut(index: number): Float64Array[] {
    return this.#sideVariants(this.#nodes[index]!).map((sides) => {
      const stencil = this.#stencil(index, sides, 3);
      if (stencil.level === "constant") return Float64Array.from(stencil.leaveOneOut);
      const row = stencil.nodes.indexOf(index);
      return Float64Array.from(stencil.leaveOneOut.subarray(row * this.#outputs, (row + 1) * this.#outputs));
    });
  }

  /** Up to `count` nodes nearest a node in the lifted metric, on its sides of every circle (any side of one it lies on). */
  neighbours(index: number, count: number): number[] {
    const found = new Set<number>();
    for (const sides of this.#sideVariants(this.#nodes[index]!)) {
      const stencil = this.#stencil(index, sides, 3);
      for (const node of stencil.nodes.filter((node) => node !== index).slice(0, count)) found.add(node);
    }
    return [...found];
  }

  /** The lifted distance from (u, v) on the circles `on` to the nearest node it may share an interpolant with. */
  nearestDistance(u: number, v: number, on: readonly number[]): number {
    const point = locate(this.#circles, u, v, on, this.#spacing);
    const [nearest] = this.#anchors(point);
    return nearest === undefined ? Infinity : Math.sqrt(liftedDistanceSquared(this.#nodes[nearest]!, point));
  }

  #cell(value: number): number {
    return Math.floor(value / this.#spacing);
  }

  #key(u: number, v: number): number {
    return this.#bucketKey(this.#cell(u), this.#cell(v));
  }

  #bucketKey(ix: number, iy: number): number {
    return (ix + 32768) * 65536 + (iy + 32768);
  }

  /** Nodes compatible with `sides` within `radius` of (u, v) in the plane. */
  #within(u: number, v: number, radius: number, sides: Int8Array): number[] {
    const found: number[] = [];
    const reach = Math.ceil(radius / this.#spacing);
    const ix = this.#cell(u);
    const iy = this.#cell(v);
    for (let dx = -reach; dx <= reach; dx += 1) {
      for (let dy = -reach; dy <= reach; dy += 1) {
        for (const index of this.#buckets.get(this.#bucketKey(ix + dx, iy + dy)) ?? []) {
          const node = this.#nodes[index]!;
          if ((node.u - u) ** 2 + (node.v - v) ** 2 <= radius * radius && compatible(node.sides, sides)) {
            found.push(index);
          }
        }
      }
    }
    return found;
  }

  /**
   * The two nodes nearest `point` in the lifted metric among those compatible
   * with its sides, nearest first (fewer if the side has fewer).
   */
  #anchors(point: LocatedNode): number[] {
    for (let radius = 2 * this.#spacing; ; radius *= 2) {
      const nearest = this.#within(point.u, point.v, radius, point.sides)
        .map((index) => ({ index, distance: liftedDistanceSquared(this.#nodes[index]!, point) }))
        .sort((left, right) => left.distance - right.distance || left.index - right.index)
        .slice(0, 2);
      // Lifted distances are at least the planar ones: nothing outside is nearer.
      if ((nearest.length === 2 && nearest[1]!.distance <= radius * radius) || radius > 2) {
        return nearest.map(({ index }) => index);
      }
    }
  }

  /** `point` relative to `anchor` as laid out in `Stencil.points`. */
  #lift(
    point: LocatedNode,
    anchor: LocatedNode,
    near: readonly number[],
    scale: number,
    out: Float64Array,
    offset: number,
  ): void {
    out[offset] = (point.u - anchor.u) * scale;
    out[offset + 1] = (point.v - anchor.v) * scale;
    near.forEach((circle, index) => {
      out[offset + 2 + index] = (point.lift[circle]! - anchor.lift[circle]!) * scale;
      out[offset + 2 + near.length + index] = (point.kappa[circle]! - anchor.kappa[circle]!) * scale;
    });
  }

  #liftedDistance(point: LocatedNode, anchor: LocatedNode, near: readonly number[]): number {
    let sum = (point.u - anchor.u) ** 2 + (point.v - anchor.v) ** 2;
    for (const circle of near) sum += (point.lift[circle]! - anchor.lift[circle]!) ** 2;
    return Math.sqrt(sum);
  }

  /** The `count` nodes compatible with `sides` nearest the anchor in the lifted metric. */
  #nearestLifted(anchor: LocatedNode, near: readonly number[], sides: Int8Array, count: number): number[] {
    for (let radius = 3 * this.#spacing; ; radius *= 1.6) {
      const candidates = this.#within(anchor.u, anchor.v, radius, sides)
        .map((index) => ({ index, distance: this.#liftedDistance(this.#nodes[index]!, anchor, near) }))
        .filter(({ distance }) => distance <= radius)
        .sort((left, right) => left.distance - right.distance || left.index - right.index);
      if (candidates.length >= count || radius > 3) {
        return candidates.slice(0, count).map(({ index }) => index);
      }
    }
  }

  #solve(anchor: LocatedNode, near: readonly number[], level: TailLevel, nodes: readonly number[]): Stencil | undefined {
    const count = nodes.length;
    const basisSize = polynomialCount(level, near.length);
    // The spline's coordinates: u, v and the lifts.
    const dimension = 2 + near.length;
    const size = pointSize(near.length);
    const radius = Math.max(...nodes.map((node) => this.#liftedDistance(this.#nodes[node]!, anchor, near)));
    const scale = 1 / radius;
    const points = new Float64Array(count * size);
    nodes.forEach((node, row) => this.#lift(this.#nodes[node]!, anchor, near, scale, points, row * size));
    const basis = new Float64Array(count * basisSize);
    for (let row = 0; row < count; row += 1) {
      polynomials(level, points, row * size, near.length, basis.subarray(row * basisSize, (row + 1) * basisSize));
    }
    // Rows along a circle lie within kappa^2 / 2 of it, so across a stencil
    // close to a circle u and v hardly vary but along it: keep the tail's
    // terms that the stencil nodes tell apart.
    const terms = independentColumns(basis, count, basisSize);
    const tail = terms.length;
    const order = count + tail;
    const matrix = new Float64Array(order * order);
    for (let row = 0; row < count; row += 1) {
      for (let column = 0; column < count; column += 1) {
        let sum = 0;
        for (let axis = 0; axis < dimension; axis += 1) {
          sum += (points[row * size + axis]! - points[column * size + axis]!) ** 2;
        }
        matrix[row * order + column] = sum ** 1.5;
      }
      terms.forEach((term, index) => {
        const value = basis[row * basisSize + term]!;
        matrix[row * order + count + index] = value;
        matrix[(count + index) * order + row] = value;
      });
    }
    const inverted = inverse(matrix, order);
    if (inverted === undefined) return undefined;
    const outputs = this.#outputs;
    const coefficients = new Float64Array(order * outputs);
    for (let row = 0; row < order; row += 1) {
      for (let column = 0; column < count; column += 1) {
        const weight = inverted[row * order + column]!;
        const values = this.#values[nodes[column]!]!;
        for (let output = 0; output < outputs; output += 1) {
          coefficients[row * outputs + output]! += weight * values[output]!;
        }
      }
    }
    const leaveOneOut = new Float64Array(count * outputs);
    for (let row = 0; row < count; row += 1) {
      const diagonal = inverted[row * order + row]!;
      for (let output = 0; output < outputs; output += 1) {
        leaveOneOut[row * outputs + output] = Math.abs(coefficients[row * outputs + output]! / diagonal);
      }
    }
    if (!coefficients.every(Number.isFinite) || !leaveOneOut.every(Number.isFinite)) return undefined;
    return { anchor, near, level, nodes, radius, scale, points, basisSize, terms, coefficients, leaveOneOut };
  }

  /** Circles whose kappa is below `KAPPA_NEAR` at any of the nodes. */
  #nearCircles(nodes: readonly number[]): number[] {
    return this.#circles.flatMap((_, circle) =>
      nodes.some((node) => this.#nodes[node]!.kappa[circle]! < KAPPA_NEAR) ? [circle] : []);
  }


  /** The richest stencil of at most `level` around the anchor, on the side `sides` gives for its circles. */
  #stencil(anchorIndex: number, sides: Int8Array, level: TailLevel): Stencil {
    const anchor = this.#nodes[anchorIndex]!;
    const key = `${anchorIndex}:${level}:${anchor.on.map((circle) => sides[circle]).join(",")}`;
    const cached = this.#stencils.get(key);
    if (cached !== undefined) return cached;
    let stencil: Stencil | undefined;
    for (const tail of ([3, 2, 1, 0] as const).filter((candidate) => candidate <= level)) {
      // Lift every circle near any stencil node, choosing the nodes again
      // until the set stops growing.
      let near = tail === 0 ? [] : this.#nearCircles([anchorIndex]);
      let nodes = this.#nearestLifted(anchor, near, sides, stencilSize(polynomialCount(tail, near.length)));
      for (let round = 0; tail !== 0 && round < 4; round += 1) {
        const grown = [...new Set([...near, ...this.#nearCircles(nodes)])].sort((left, right) => left - right);
        if (grown.length === near.length) break;
        near = grown;
        nodes = this.#nearestLifted(anchor, near, sides, stencilSize(polynomialCount(tail, near.length)));
      }
      if (nodes.length < polynomialCount(tail, near.length) + 3) continue;
      stencil = this.#solve(anchor, near, tail, nodes);
      if (stencil !== undefined) break;
    }
    if (stencil === undefined) {
      // Too few nodes on this side for any tail: the anchor's values, with the
      // spread of its nearest neighbours as the error.
      const nodes = this.#nearestLifted(anchor, [], sides, ERROR_NODES + 1);
      const outputs = this.#outputs;
      const spread = new Float64Array(outputs).fill(nodes.length > 1 ? 0 : Infinity);
      for (const node of nodes) {
        for (let output = 0; output < outputs; output += 1) {
          spread[output] = Math.max(
            spread[output]!,
            Math.abs(this.#values[node]![output]! - this.#values[anchorIndex]![output]!),
          );
        }
      }
      stencil = {
        anchor,
        near: [],
        level: "constant",
        nodes,
        radius: Math.max(0, ...nodes.map((node) => this.#liftedDistance(this.#nodes[node]!, anchor, []))),
        scale: 1,
        points: new Float64Array(2),
        basisSize: 0,
        terms: [],
        coefficients: Float64Array.from(this.#values[anchorIndex]!),
        leaveOneOut: spread,
      };
    }
    this.#stencils.set(key, stencil);
    return stencil;
  }

  /**
   * The stencil's interpolant at `point`, and the largest leave-one-out error
   * of the stencil nodes nearest it.
   */
  #apply(stencil: Stencil, point: LocatedNode): { values: Float64Array; errors: Float64Array } {
    const outputs = this.#outputs;
    if (stencil.level === "constant") {
      return { values: Float64Array.from(stencil.coefficients), errors: Float64Array.from(stencil.leaveOneOut) };
    }
    const dimension = 2 + stencil.near.length;
    const size = pointSize(stencil.near.length);
    const x = new Float64Array(size);
    this.#lift(point, stencil.anchor, stencil.near, stencil.scale, x, 0);
    const count = stencil.nodes.length;
    const values = new Float64Array(outputs);
    const distances = new Float64Array(count);
    for (let row = 0; row < count; row += 1) {
      let sum = 0;
      for (let axis = 0; axis < dimension; axis += 1) {
        sum += (x[axis]! - stencil.points[row * size + axis]!) ** 2;
      }
      distances[row] = sum;
      const weight = sum ** 1.5;
      for (let output = 0; output < outputs; output += 1) {
        values[output]! += weight * stencil.coefficients[row * outputs + output]!;
      }
    }
    const basis = new Float64Array(stencil.basisSize);
    polynomials(stencil.level, x, 0, stencil.near.length, basis);
    stencil.terms.forEach((term, index) => {
      for (let output = 0; output < outputs; output += 1) {
        values[output]! += basis[term]! * stencil.coefficients[(count + index) * outputs + output]!;
      }
    });
    const nearest = Array.from(distances.keys())
      .sort((left, right) => distances[left]! - distances[right]!)
      .slice(0, ERROR_NODES);
    const errors = new Float64Array(outputs);
    for (const row of nearest) {
      for (let output = 0; output < outputs; output += 1) {
        errors[output] = Math.max(errors[output]!, stencil.leaveOneOut[row * outputs + output]!);
      }
    }
    return { values, errors };
  }

  /** Index of the node at exactly (u, v), if any. */
  nodeAt(u: number, v: number): number | undefined {
    return this.#buckets.get(this.#key(u, v))?.find((index) => {
      const node = this.#nodes[index]!;
      return node.u === u && node.v === v;
    });
  }

  /**
   * Values at (u, v) in the closed unit disk, interpolated from its side of
   * every Wood circle: per value, the median of three interpolants (the cubic
   * and the quadratic tail at the nearest node, the cubic at the
   * second-nearest). The stated error of each value is `ERROR_SAFETY` times
   * the largest of their leave-one-out errors near the point and of their
   * differences from the median.
   */
  evaluate(u: number, v: number): InterpolatedValues {
    const outputs = this.#outputs;
    const exact = this.nodeAt(u, v);
    if (exact !== undefined) {
      return { values: Float64Array.from(this.#values[exact]!), errors: new Float64Array(outputs), node: exact };
    }
    const point = locate(this.#circles, u, v, [], this.#spacing);
    const [anchorIndex, secondIndex] = this.#anchors(point);
    if (anchorIndex === undefined) {
      return {
        values: new Float64Array(outputs).fill(Number.NaN),
        errors: new Float64Array(outputs).fill(Infinity),
        node: undefined,
      };
    }
    const richer = this.#stencil(anchorIndex, point.sides, 3);
    const candidates = [this.#apply(richer, point)];
    if (typeof richer.level === "number" && richer.level > 0) {
      candidates.push(this.#apply(this.#stencil(anchorIndex, point.sides, (richer.level - 1) as TailLevel), point));
    }
    if (secondIndex !== undefined) candidates.push(this.#apply(this.#stencil(secondIndex, point.sides, 3), point));
    // Per value, the median of the candidates (of two, the one with the
    // smaller leave-one-out errors), so that one stencil gone wild cannot
    // decide it; the spread of the candidates adds to the error.
    const largest = (errors: Float64Array): number => Math.max(...errors);
    candidates.sort((left, right) => largest(left.errors) - largest(right.errors));
    const values = new Float64Array(outputs);
    const errors = new Float64Array(outputs);
    const column = new Float64Array(candidates.length);
    for (let output = 0; output < outputs; output += 1) {
      candidates.forEach((candidate, index) => { column[index] = candidate.values[output]!; });
      const value = candidates.length === 3 ? [...column].sort((left, right) => left - right)[1]! : column[0]!;
      let error = Math.max(...candidates.map((candidate) => candidate.errors[output]!));
      for (const candidate of column) error = Math.max(error, Math.abs(candidate - value));
      values[output] = value;
      errors[output] = ERROR_SAFETY * error;
    }
    return { values, errors, node: undefined };
  }
}
