import { necPeriodicWavenumberPerM } from "./nec-constants.js";
import type { FloquetModeIndex, PeriodicLattice } from "./types.js";

// Sampling of the scan element pattern in the u-v plane, (u, v) = kt0 / k.
//
// Floquet mode (p, q) has the transverse wavevector kt0 + p b1 + q b2, so it
// propagates inside the unit circle around -(p b1 + q b2) / k: its Wood
// circle. (0, 0) gives the horizon. Near the Wood circle of mode c the pattern
// is an analytic function of (u, v) and kappa_c = |kz_c| / k
// = sqrt(|1 - |(u, v) - centre_c|^2|), whose square root makes the kink. It
// can also change within a small kappa_c: the low-rank update for the mode
// near cut-off brings a factor (kappa_c D + S)^-1 with S possibly small, so
// a dipole array's pattern drops to a null on the circle within
// kappa_c ~ 0.01. The grid therefore adds rows along both sides of every
// circle, graded geometrically from kappa = 1e-3 and uniform beyond the
// spacing, and the interpolant uses the lift of kappa that makes them evenly
// spaced as a coordinate.

/** A Wood circle in the u-v plane: mode (p, q) is at cut-off on the unit circle around `centreUV`. */
export interface WoodCircle extends FloquetModeIndex {
  /** `-(p b1 + q b2) / k`; the mode propagates inside the circle. (0, 0) is the horizon. */
  readonly centreUV: readonly [number, number];
}

/** One sample of the u-v grid. */
export interface GridNode {
  readonly u: number;
  readonly v: number;
  /** Indices of the Wood circles the node lies on. */
  readonly on: readonly number[];
}

/** Rows run along each side of a Wood circle out to this kappa. */
export const KAPPA_BAND = 0.5;
/** The first row on each side of a Wood circle, at the engine's near-cutoff limit. */
export const KAPPA_MIN = 1e-3;
/** Ratio of consecutive kappa where the rows are graded geometrically. */
const ROW_RATIO = 2;
/**
 * The grid's edge: kappa of the (0, 0) mode (cos theta) on the outermost row,
 * just inside the horizon.
 */
export const HORIZON_KAPPA = 1e-4;
/** The automatic spacing is at most this, and a tenth of the distance to the nearest circle centre. */
const MAX_AUTO_SPACING = 0.1;
/** Nodes closer than this fraction of the spacing (in the lifted metric) are merged. */
const MERGE_FRACTION = 0.4;
/** A point within this of a circle counts as on it. */
const ON_CIRCLE = 1e-9;

function reciprocalVectors(lattice: PeriodicLattice): readonly [readonly [number, number], readonly [number, number]] {
  const [a1x, a1y] = lattice.a1M;
  const [a2x, a2y] = lattice.a2M;
  const det = a1x * a2y - a1y * a2x;
  return [
    [2 * Math.PI * a2y / det, -2 * Math.PI * a2x / det],
    [-2 * Math.PI * a1y / det, 2 * Math.PI * a1x / det],
  ];
}

/**
 * Every Wood circle that meets the closed unit disk, the horizon (0, 0)
 * first, then by distance of the centre.
 */
export function woodCircles(lattice: PeriodicLattice, frequencyMHz: number): readonly WoodCircle[] {
  const k = necPeriodicWavenumberPerM(frequencyMHz);
  const [b1, b2] = reciprocalVectors(lattice);
  // |p| = |G . a1| / (2 pi) <= |G| |a1| / (2 pi), and |G| <= 2 k.
  const pMax = Math.ceil(2 * k * Math.hypot(...lattice.a1M) / (2 * Math.PI));
  const qMax = Math.ceil(2 * k * Math.hypot(...lattice.a2M) / (2 * Math.PI));
  const circles: WoodCircle[] = [];
  for (let p = -pMax; p <= pMax; p += 1) {
    for (let q = -qMax; q <= qMax; q += 1) {
      // `+ 0` turns -0 into 0.
      const centre = [-(p * b1[0] + q * b2[0]) / k + 0, -(p * b1[1] + q * b2[1]) / k + 0] as const;
      if (Math.hypot(...centre) <= 2 + ON_CIRCLE) {
        circles.push(Object.freeze({ p: p + 0, q: q + 0, centreUV: Object.freeze(centre) }));
      }
    }
  }
  circles.sort((left, right) =>
    Math.hypot(...left.centreUV) - Math.hypot(...right.centreUV) || left.p - right.p || left.q - right.q);
  return Object.freeze(circles);
}

/**
 * The automatic grid spacing in u-v: a tenth of the distance from the horizon's
 * centre to the nearest other Wood circle's, at most 0.1. Larger cells have
 * more Wood circles, closer together.
 */
export function autoSpacingUV(circles: readonly WoodCircle[]): number {
  let nearest = Infinity;
  for (const { centreUV } of circles) {
    const distance = Math.hypot(...centreUV);
    if (distance > 0) nearest = Math.min(nearest, distance);
  }
  return Math.min(MAX_AUTO_SPACING, nearest / 10);
}

/** +1 inside circle c (the mode propagates, also on the circle), -1 outside. */
export function sideOf(circle: WoodCircle, u: number, v: number): 1 | -1 {
  return (u - circle.centreUV[0]) ** 2 + (v - circle.centreUV[1]) ** 2 <= 1 ? 1 : -1;
}

/** `|kz| / k` of the circle's mode at (u, v). */
export function kappaOf(circle: WoodCircle, u: number, v: number): number {
  return Math.sqrt(Math.abs(1 - (u - circle.centreUV[0]) ** 2 - (v - circle.centreUV[1]) ** 2));
}

/**
 * The lifted coordinate of a kappa at the given grid spacing:
 * `kappa + spacing ln(1 + kappa / KAPPA_MIN) / ln(ROW_RATIO)`, so the rows
 * (graded geometrically from `KAPPA_MIN`, uniform beyond the spacing) are
 * about one spacing apart in it.
 */
export function liftOf(kappa: number, spacing: number): number {
  return kappa + spacing * Math.log1p(kappa / KAPPA_MIN) / Math.log(ROW_RATIO);
}

/** The kappa whose lift is `lift`. */
function kappaOfLift(lift: number, spacing: number): number {
  // The lift grows monotonically and is at least kappa: bisect on [0, lift].
  let low = 0;
  let high = lift;
  for (let step = 0; step < 100 && high - low > 1e-15 * high; step += 1) {
    const middle = (low + high) / 2;
    if (liftOf(middle, spacing) < lift) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

/** A grid node with its side of, kappa for and lift for every circle (0 on a circle). */
export interface LocatedNode extends GridNode {
  readonly sides: Int8Array;
  readonly kappa: Float64Array;
  readonly lift: Float64Array;
}

export function locate(
  circles: readonly WoodCircle[],
  u: number,
  v: number,
  on: readonly number[],
  spacing: number,
): LocatedNode {
  const sides = new Int8Array(circles.length);
  const kappa = new Float64Array(circles.length);
  const lift = new Float64Array(circles.length);
  circles.forEach((circle, index) => {
    if (on.includes(index)) return;
    sides[index] = sideOf(circle, u, v);
    kappa[index] = kappaOf(circle, u, v);
    lift[index] = liftOf(kappa[index]!, spacing);
  });
  return { u, v, on, sides, kappa, lift };
}

/** Nodes `a` and `b` may share an interpolant: on no circle are they on opposite sides. */
export function compatible(a: Int8Array, b: Int8Array): boolean {
  for (let index = 0; index < a.length; index += 1) {
    if (a[index]! * b[index]! < 0) return false;
  }
  return true;
}

/**
 * Circles whose kappa at a point is below this enter the interpolant's lifted
 * coordinates there; further away the pattern is smooth in (u, v) alone.
 */
export const KAPPA_NEAR = 0.6;

/** Squared distance in the lifted coordinates (u, v, lift of the circles near either node). */
export function liftedDistanceSquared(a: LocatedNode, b: LocatedNode): number {
  let sum = (a.u - b.u) ** 2 + (a.v - b.v) ** 2;
  for (let index = 0; index < a.kappa.length; index += 1) {
    if (Math.min(a.kappa[index]!, b.kappa[index]!) < KAPPA_NEAR) {
      sum += (a.lift[index]! - b.lift[index]!) ** 2;
    }
  }
  return sum;
}

/** Nodes, merged as they are added, bucketed by position. */
class NodeSet {
  readonly nodes: LocatedNode[] = [];
  readonly #circles: readonly WoodCircle[];
  readonly #mergeDistance: number;
  readonly #buckets = new Map<number, number[]>();
  readonly #spacing: number;

  constructor(circles: readonly WoodCircle[], spacing: number) {
    this.#circles = circles;
    this.#mergeDistance = MERGE_FRACTION * spacing;
    this.#spacing = spacing;
  }

  #key(ix: number, iy: number): number {
    return (ix + 32768) * 65536 + (iy + 32768);
  }

  /** Add a node unless a compatible node lies within the merge distance (`always`: only an identical one). */
  add(u: number, v: number, on: readonly number[], always = false): void {
    if (u * u + v * v > 1 + ON_CIRCLE) return;
    const node = locate(this.#circles, u, v, on, this.#spacing);
    const ix = Math.floor(u / this.#spacing);
    const iy = Math.floor(v / this.#spacing);
    const reach = Math.ceil(this.#mergeDistance / this.#spacing);
    for (let dx = -reach; dx <= reach; dx += 1) {
      for (let dy = -reach; dy <= reach; dy += 1) {
        for (const index of this.#buckets.get(this.#key(ix + dx, iy + dy)) ?? []) {
          const other = this.nodes[index]!;
          if (other.u === u && other.v === v) return;
          if (!always && compatible(other.sides, node.sides)
              && liftedDistanceSquared(other, node) < this.#mergeDistance ** 2) {
            return;
          }
        }
      }
    }
    const key = this.#key(ix, iy);
    const bucket = this.#buckets.get(key);
    if (bucket === undefined) this.#buckets.set(key, [this.nodes.length]);
    else bucket.push(this.nodes.length);
    this.nodes.push(node);
  }
}

/** Circles (by index) a point lies on, besides those it was constructed on. */
export function circlesThrough(circles: readonly WoodCircle[], u: number, v: number, known: readonly number[]): number[] {
  const on = [...known];
  circles.forEach((circle, index) => {
    if (!on.includes(index)
        && Math.abs(Math.hypot(u - circle.centreUV[0], v - circle.centreUV[1]) - 1) < ON_CIRCLE) {
      on.push(index);
    }
  });
  return on.sort((left, right) => left - right);
}

/**
 * Points along the circle of radius `radius` around `centre` that lie in the
 * disk of radius `disk` around the origin, about `spacing` apart, including
 * the ends of each arc.
 */
function arcPoints(
  centre: readonly [number, number],
  radius: number,
  spacing: number,
  disk: number,
): [number, number][] {
  const distance = Math.hypot(...centre);
  let first = 0;
  let length = 2 * Math.PI;
  if (distance > 0) {
    // |centre + radius (cos t, sin t)| <= disk for cos(t - t_c) <= limit.
    const limit = (disk * disk - distance * distance - radius * radius) / (2 * radius * distance);
    if (limit < -1) return [];
    if (limit < 1) {
      const half = Math.acos(limit);
      const towards = Math.atan2(centre[1], centre[0]);
      first = towards + half;
      length = 2 * (Math.PI - half);
    }
  }
  const closed = length === 2 * Math.PI;
  const count = Math.max(1, Math.ceil(length * radius / spacing));
  const points: [number, number][] = [];
  for (let index = 0; index <= (closed ? count - 1 : count); index += 1) {
    const angle = first + length * index / count;
    points.push([centre[0] + radius * Math.cos(angle), centre[1] + radius * Math.sin(angle)]);
  }
  return points;
}

/**
 * The sampling grid of a scan element pattern, in priority order (earlier
 * nodes win a merge): the crossings of Wood circles, the points on each circle,
 * the rows along both sides of each circle (uniform in kappa, out to
 * `KAPPA_BAND`), then the explicit `points` (always kept) or a square grid of
 * the given spacing outside the bands.
 */
export function patternGrid(
  circles: readonly WoodCircle[],
  spacing: number,
  points?: readonly { readonly u: number; readonly v: number }[],
): readonly LocatedNode[] {
  const set = new NodeSet(circles, spacing);
  // The horizon's row: on the horizon the (0, 0) mode carries no power and its
  // amplitude is zero by convention, so the grid's edge lies just inside.
  const edge = Math.sqrt(1 - HORIZON_KAPPA * HORIZON_KAPPA);
  // Crossings of two circles (and any other circle through the same point),
  // with the horizon replaced by the edge.
  for (let first = 0; first < circles.length; first += 1) {
    for (let second = first + 1; second < circles.length; second += 1) {
      const [ax, ay] = circles[first]!.centreUV;
      const [bx, by] = circles[second]!.centreUV;
      const ra = Math.hypot(ax, ay) === 0 ? edge : 1;
      const distance = Math.hypot(bx - ax, by - ay);
      if (distance === 0 || distance > ra + 1 || distance < Math.abs(ra - 1)) continue;
      // Along the line of centres from a, then across it.
      const along = (distance * distance + ra * ra - 1) / (2 * distance);
      const across = Math.sqrt(Math.max(0, ra * ra - along * along));
      const [ex, ey] = [(bx - ax) / distance, (by - ay) / distance];
      for (const sign of [1, -1]) {
        const u = ax + along * ex - sign * across * ey;
        const v = ay + along * ey + sign * across * ex;
        set.add(u, v, circlesThrough(circles, u, v, ra === 1 ? [first, second] : [second]));
      }
    }
  }
  // On each circle (the horizon: on the edge), then the rows along it, one
  // spacing apart in the lift of kappa.
  for (const [index, circle] of circles.entries()) {
    const horizon = Math.hypot(...circle.centreUV) === 0;
    for (const [u, v] of arcPoints(circle.centreUV, horizon ? edge : 1, spacing, edge)) {
      set.add(u, v, circlesThrough(circles, u, v, horizon ? [] : [index]));
    }
  }
  const rows = Math.round(liftOf(KAPPA_BAND, spacing) / spacing);
  for (let row = 1; row <= rows; row += 1) {
    const kappa = kappaOfLift(row * liftOf(KAPPA_BAND, spacing) / rows, spacing);
    for (const circle of circles) {
      // Only inside the horizon.
      const radii = Math.hypot(...circle.centreUV) === 0
        ? [Math.sqrt(1 - kappa * kappa)]
        : [Math.sqrt(1 - kappa * kappa), Math.sqrt(1 + kappa * kappa)];
      for (const radius of radii) {
        for (const [u, v] of arcPoints(circle.centreUV, radius, spacing, edge)) {
          set.add(u, v, circlesThrough(circles, u, v, []));
        }
      }
    }
  }
  if (points !== undefined) {
    for (const { u, v } of points) set.add(u, v, circlesThrough(circles, u, v, []), true);
  } else {
    const steps = Math.floor(1 / spacing);
    for (let ix = -steps; ix <= steps; ix += 1) {
      for (let iy = -steps; iy <= steps; iy += 1) {
        const u = ix * spacing;
        const v = iy * spacing;
        if (u * u + v * v >= 1) continue;
        if (circles.some((circle) => kappaOf(circle, u, v) < KAPPA_BAND)) continue;
        set.add(u, v, circlesThrough(circles, u, v, []));
      }
    }
  }
  return set.nodes;
}
