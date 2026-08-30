import { NecInputError } from "./errors.js";
import type {
  GeometrySymmetry,
  ReflectionPlane,
  RotationalOrder,
  SymmetryCopy,
  SymmetryExpansion,
} from "./types.js";

const INT32_MAX = 2_147_483_647;

const PLANE_BITS: Readonly<Record<ReflectionPlane, number>> = Object.freeze({
  "x=0": 1,
  "y=0": 2,
  "z=0": 4,
});

export interface ValidatedGeometrySymmetry {
  readonly kind: GeometrySymmetry["kind"];
  readonly nativeKind: 1 | 2;
  readonly parameter: number;
  readonly tagIncrement: number;
  readonly sectionCount: number;
  readonly reflectsZ: boolean;
}

function invalidSymmetry(
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): never {
  throw new NecInputError(message, {
    details: { ...details, symmetryFailure: "INVALID_SYMMETRY" },
  });
}

function symmetryRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalidSymmetry("Geometry symmetry must be an object");
  }
  return value as Readonly<Record<string, unknown>>;
}

function positiveInt32(value: unknown, name: string): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 1
    || value > INT32_MAX
  ) {
    invalidSymmetry(`${name} must be an integer from 1 through ${INT32_MAX}`, {
      name,
      value,
    });
  }
  return value;
}

function freezeSigns(
  signs: [1 | -1, 1 | -1, 1 | -1],
): readonly [1 | -1, 1 | -1, 1 | -1] {
  return Object.freeze(signs);
}

function reflectionCopies(
  planes: ReadonlySet<ReflectionPlane>,
  tagIncrement: number,
): readonly SymmetryCopy[] {
  const signs: Array<readonly [1 | -1, 1 | -1, 1 | -1]> = [
    freezeSigns([1, 1, 1]),
  ];
  for (const [plane, coordinate] of [
    ["z=0", 2],
    ["y=0", 1],
    ["x=0", 0],
  ] as const) {
    if (!planes.has(plane)) {
      continue;
    }
    const existingCount = signs.length;
    for (let index = 0; index < existingCount; index += 1) {
      const reflected = [...signs[index]!] as [1 | -1, 1 | -1, 1 | -1];
      reflected[coordinate] = reflected[coordinate] === 1 ? -1 : 1;
      signs.push(freezeSigns(reflected));
    }
  }
  return Object.freeze(signs.map((copySigns, index) => Object.freeze({
    index,
    tagOffset: index * tagIncrement,
    transform: Object.freeze({
      kind: "cartesian-signs" as const,
      signs: copySigns,
    }),
  })));
}

function rotationalCopies(
  order: number,
  tagIncrement: number,
): readonly SymmetryCopy[] {
  return Object.freeze(Array.from({ length: order }, (_, index) => Object.freeze({
    index,
    tagOffset: index * tagIncrement,
    transform: Object.freeze({
      kind: "rotate-z" as const,
      angleDeg: index * 360 / order,
    }),
  })));
}

function validateTagRange(
  maximumFundamentalTag: number,
  sectionCount: number,
  tagIncrement: number,
): void {
  const maximumGeneratedTag = BigInt(maximumFundamentalTag)
    + BigInt(sectionCount - 1) * BigInt(tagIncrement);
  if (maximumGeneratedTag > BigInt(INT32_MAX)) {
    invalidSymmetry("Symmetry-generated tags exceed the signed 32-bit range", {
      maximumFundamentalTag,
      sectionCount,
      tagIncrement,
    });
  }
}

/** Validate a public descriptor and derive its exact additive-ABI arguments. */
export function validateGeometrySymmetry(
  value: unknown,
  maximumFundamentalTag: number,
): ValidatedGeometrySymmetry {
  const record = symmetryRecord(value);
  const tagIncrement = positiveInt32(
    record.tagIncrement,
    "symmetry.tagIncrement",
  );

  if (record.kind === "reflection") {
    if (record.axis !== undefined || record.order !== undefined) {
      invalidSymmetry("Reflection symmetry cannot contain rotation fields");
    }
    if (!Array.isArray(record.planes) || record.planes.length === 0) {
      invalidSymmetry("Reflection symmetry requires at least one plane");
    }
    if (record.planes.length > 3) {
      invalidSymmetry("Reflection symmetry contains too many planes");
    }
    const planes = new Set<ReflectionPlane>();
    let mask = 0;
    for (let index = 0; index < record.planes.length; index += 1) {
      const plane: unknown = record.planes[index];
      if (plane !== "x=0" && plane !== "y=0" && plane !== "z=0") {
        invalidSymmetry("Unknown coordinate reflection plane", { index, plane });
      }
      if (planes.has(plane)) {
        invalidSymmetry("Reflection planes must not contain duplicates", {
          plane,
        });
      }
      planes.add(plane);
      mask |= PLANE_BITS[plane];
    }
    const sectionCount = 2 ** planes.size;
    validateTagRange(maximumFundamentalTag, sectionCount, tagIncrement);
    return Object.freeze({
      kind: "reflection",
      nativeKind: 1,
      parameter: mask,
      tagIncrement,
      sectionCount,
      reflectsZ: planes.has("z=0"),
    });
  }

  if (record.kind === "rotational") {
    if (record.planes !== undefined) {
      invalidSymmetry("Rotational symmetry cannot contain reflection fields");
    }
    if (record.axis !== "z") {
      invalidSymmetry("Rotational symmetry supports only the global Z axis", {
        axis: record.axis,
      });
    }
    const order = record.order;
    if (
      typeof order !== "number"
      || !Number.isSafeInteger(order)
      || order < 2
      || order > INT32_MAX
    ) {
      invalidSymmetry(
        `symmetry.order must be an integer from 2 through ${INT32_MAX}`,
        { order },
      );
    }
    validateTagRange(maximumFundamentalTag, order, tagIncrement);
    return Object.freeze({
      kind: "rotational",
      nativeKind: 2,
      parameter: order,
      tagIncrement,
      sectionCount: order,
      reflectsZ: false,
    });
  }

  return invalidSymmetry("Unknown geometry symmetry kind", { kind: record.kind });
}

/** Create the deeply immutable public metadata snapshot for a completed model. */
export function createSymmetryExpansion(
  symmetry: ValidatedGeometrySymmetry,
  fundamentalSegmentCount: number,
  fullSegmentCount: number,
): SymmetryExpansion {
  const copies = symmetry.kind === "reflection"
    ? reflectionCopies(new Set<ReflectionPlane>(
      (["x=0", "y=0", "z=0"] as const).filter(
        (plane) => (symmetry.parameter & PLANE_BITS[plane]) !== 0,
      ),
    ), symmetry.tagIncrement)
    : rotationalCopies(symmetry.sectionCount, symmetry.tagIncrement);
  return Object.freeze({
    kind: symmetry.kind,
    sectionCount: symmetry.sectionCount,
    fundamentalSegmentCount,
    fullSegmentCount,
    copies,
  });
}

/**
 * Validate and brand an N-fold rotational section count for geometry symmetry.
 * The native ABI represents the value as a signed 32-bit integer.
 */
export function rotationalOrder(order: number): RotationalOrder {
  if (!Number.isSafeInteger(order) || order < 2 || order > INT32_MAX) {
    throw new NecInputError(
      "Rotational symmetry order must be an integer from 2 through 2147483647",
      { details: { symmetryFailure: "INVALID_SYMMETRY", order } },
    );
  }
  return order as RotationalOrder;
}
