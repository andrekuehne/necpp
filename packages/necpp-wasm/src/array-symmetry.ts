import { NecGeometryError, NecInputError } from "./errors.js";
import {
  createSymmetryExpansion,
  validateGeometrySymmetry,
} from "./symmetry.js";
import type {
  ArrayBuildPlan,
  ArrayElementId,
  ArrayElementMapping,
  CanonicalArrayElement,
  ElementWirePattern,
  FullArrayDescription,
  GeometrySymmetry,
  PositionedArrayElement,
  PositionCanonicalization,
  RotationalOrder,
  SymmetrizationReason,
  SymmetrizationReasonCode,
  SymmetrizerDiagnostics,
  SymmetrizerOptions,
  SymmetryCandidateDiagnostics,
  SymmetryCopyTransform,
} from "./types.js";

const INT32_MAX = 2_147_483_647;
const AUTO_ROTATION_ORDER_CAP = 64;

type Point2 = readonly [number, number];

interface ValidatedDescription {
  readonly description: FullArrayDescription;
  readonly patterns: ReadonlyMap<string, ElementWirePattern>;
  readonly callerPortStarts: readonly number[];
}

interface CandidateSpec {
  readonly symmetry: GeometrySymmetry;
  readonly centerM: Point2;
  readonly transforms: readonly SymmetryCopyTransform[];
  readonly ordinal: number;
}

interface MatchedCandidate {
  readonly spec: CandidateSpec;
  readonly mappingsByCopy: readonly (readonly number[])[];
}

interface CanonicalOrbit {
  readonly representativeIndex: number;
  readonly canonicalBase: Point2;
  readonly targetsByCopy: readonly number[];
  readonly canonicalByCaller: ReadonlyMap<number, Point2>;
}

interface AcceptedCandidate {
  readonly plan: Extract<ArrayBuildPlan, { readonly kind: "symmetric" }>;
  readonly ordinal: number;
}

function inputError(message: string, details: Readonly<Record<string, unknown>> = {}): never {
  throw new NecInputError(message, { details });
}

function point(x: number, y: number): Point2 {
  return Object.freeze([x, y] as [number, number]);
}

function finite(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    inputError(`${name} must be finite`, { name, value });
  }
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    inputError(`${name} must be a positive safe integer`, { name, value });
  }
  return value as number;
}

function reason(
  code: SymmetrizationReasonCode,
  message: string,
  callerElementIndex?: number,
  patternId?: string,
): SymmetrizationReason {
  return Object.freeze({
    code,
    message,
    ...(callerElementIndex === undefined ? {} : { callerElementIndex }),
    ...(patternId === undefined ? {} : { patternId }),
  });
}

function validateGround(description: FullArrayDescription): void {
  const connection = description.groundConnection ?? "none";
  if (connection !== "none"
    && connection !== "interpolate"
    && connection !== "zero-current") {
    inputError("description.groundConnection is unknown", { connection });
  }
  const ground = description.ground as unknown;
  if (typeof ground !== "object" || ground === null || Array.isArray(ground)) {
    inputError("description.ground must be an object");
  }
  const record = ground as Readonly<Record<string, unknown>>;
  if (record.kind === "free-space") {
    if (connection !== "none") {
      inputError("A non-none groundConnection requires a ground model", {
        connection,
      });
    }
    return;
  }
  if (record.kind === "perfect") {
    return;
  }
  if (record.kind !== "finite") {
    inputError("description.ground has an unknown kind", { kind: record.kind });
  }
  if (
    record.method !== "reflection-coefficient"
    && record.method !== "sommerfeld-norton"
  ) {
    inputError("description.ground has an unknown finite-ground method", {
      method: record.method,
    });
  }
  if (finite(record.relativePermittivity, "ground.relativePermittivity") <= 0) {
    inputError("ground.relativePermittivity must be positive");
  }
  if (finite(record.conductivitySPerM, "ground.conductivitySPerM") <= 0) {
    inputError("ground.conductivitySPerM must be positive");
  }
}

function validateDescription(description: FullArrayDescription): ValidatedDescription {
  if (typeof description !== "object" || description === null) {
    inputError("Array description must be an object");
  }
  if (!Array.isArray(description.elements) || description.elements.length === 0) {
    inputError("Array description requires at least one element");
  }
  if (!Array.isArray(description.patterns) || description.patterns.length === 0) {
    inputError("Array description requires at least one element pattern");
  }
  validateGround(description);

  const patterns = new Map<string, ElementWirePattern>();
  for (let patternIndex = 0; patternIndex < description.patterns.length; patternIndex += 1) {
    const pattern = description.patterns[patternIndex]!;
    if (typeof pattern !== "object" || pattern === null) {
      inputError(`patterns[${patternIndex}] must be an object`);
    }
    if (typeof pattern.id !== "string" || pattern.id.length === 0) {
      inputError(`patterns[${patternIndex}].id must be a nonempty string`);
    }
    if (patterns.has(pattern.id)) {
      inputError("Pattern IDs must be unique", { patternId: pattern.id });
    }
    if (!Array.isArray(pattern.wires) || pattern.wires.length === 0) {
      inputError(`patterns[${patternIndex}].wires must be nonempty`);
    }
    if (!Array.isArray(pattern.ports) || pattern.ports.length === 0) {
      inputError(`patterns[${patternIndex}].ports must be nonempty`);
    }
    const wireIds = new Map<string, number>();
    for (let wireIndex = 0; wireIndex < pattern.wires.length; wireIndex += 1) {
      const wire = pattern.wires[wireIndex]!;
      if (typeof wire.id !== "string" || wire.id.length === 0 || wireIds.has(wire.id)) {
        inputError("Pattern wire IDs must be nonempty and unique", {
          patternId: pattern.id,
          wireId: wire.id,
        });
      }
      wireIds.set(wire.id, wireIndex);
      positiveInteger(wire.segments, `patterns[${patternIndex}].wires[${wireIndex}].segments`);
      if (!Array.isArray(wire.startM) || wire.startM.length !== 3
        || !Array.isArray(wire.endM) || wire.endM.length !== 3) {
        inputError("Pattern wire endpoints must contain three coordinates", {
          patternId: pattern.id,
          wireId: wire.id,
        });
      }
      for (let coordinate = 0; coordinate < 3; coordinate += 1) {
        finite(
          wire.startM[coordinate],
          `patterns[${patternIndex}].wires[${wireIndex}].startM[${coordinate}]`,
        );
        finite(
          wire.endM[coordinate],
          `patterns[${patternIndex}].wires[${wireIndex}].endM[${coordinate}]`,
        );
      }
      if (finite(wire.radiusM, `patterns[${patternIndex}].wires[${wireIndex}].radiusM`) <= 0) {
        inputError("Pattern wire radius must be positive", { patternId: pattern.id });
      }
    }
    for (let portIndex = 0; portIndex < pattern.ports.length; portIndex += 1) {
      const port = pattern.ports[portIndex]!;
      const wireIndex = wireIds.get(port.wireId);
      if (wireIndex === undefined) {
        inputError("Pattern port references an unknown wire", {
          patternId: pattern.id,
          wireId: port.wireId,
        });
      }
      const segment = positiveInteger(
        port.segment,
        `patterns[${patternIndex}].ports[${portIndex}].segment`,
      );
      if (segment > pattern.wires[wireIndex]!.segments) {
        inputError("Pattern port segment exceeds its wire segment count", {
          patternId: pattern.id,
          wireId: port.wireId,
          segment,
        });
      }
      if (port.name !== undefined && typeof port.name !== "string") {
        inputError("Pattern port name must be a string", { patternId: pattern.id });
      }
    }
    for (const load of pattern.loads ?? []) {
      if (wireIds.get(load.target.wireId) === undefined) {
        inputError("Pattern load references an unknown wire", {
          patternId: pattern.id,
          wireId: load.target.wireId,
        });
      }
    }
    patterns.set(pattern.id, pattern);
  }

  const ids = new Set<ArrayElementId>();
  const callerPortStarts: number[] = [];
  let portCount = 0;
  for (let index = 0; index < description.elements.length; index += 1) {
    const element = description.elements[index]!;
    if ((typeof element.id !== "string" && typeof element.id !== "number")
      || (typeof element.id === "number" && !Number.isFinite(element.id))) {
      inputError(`elements[${index}].id must be a string or finite number`);
    }
    if (ids.has(element.id)) {
      inputError("Element IDs must be unique", { elementId: element.id });
    }
    ids.add(element.id);
    if (!Array.isArray(element.positionM) || element.positionM.length !== 2) {
      inputError(`elements[${index}].positionM must contain two coordinates`);
    }
    finite(element.positionM[0], `elements[${index}].positionM[0]`);
    finite(element.positionM[1], `elements[${index}].positionM[1]`);
    const pattern = patterns.get(element.patternId);
    if (pattern === undefined) {
      inputError("Element references an unknown pattern", {
        callerElementIndex: index,
        patternId: element.patternId,
      });
    }
    if (element.rotationDeg !== undefined) {
      finite(element.rotationDeg, `elements[${index}].rotationDeg`);
    }
    callerPortStarts.push(portCount);
    portCount += pattern.ports.length;
  }
  return Object.freeze({
    description,
    patterns,
    callerPortStarts: Object.freeze(callerPortStarts),
  });
}

function validateOptions(options: SymmetrizerOptions): Required<Pick<
  SymmetrizerOptions,
  "positionEpsilonM" | "allowReflection" | "allowRotation" | "onUnsupported"
>> & SymmetrizerOptions {
  if (typeof options !== "object" || options === null) {
    inputError("Symmetrizer options must be supplied");
  }
  const epsilon = finite(options.positionEpsilonM, "positionEpsilonM");
  if (epsilon < 0) {
    inputError("positionEpsilonM must be nonnegative");
  }
  if (options.center !== undefined && options.center !== "auto") {
    if (!Array.isArray(options.center) || options.center.length !== 2) {
      inputError("symmetrizer.center must be auto or two finite coordinates");
    }
    finite(options.center[0], "symmetrizer.center[0]");
    finite(options.center[1], "symmetrizer.center[1]");
  }
  if (options.allowReflection !== undefined && typeof options.allowReflection !== "boolean") {
    inputError("allowReflection must be boolean");
  }
  if (options.allowRotation !== undefined && typeof options.allowRotation !== "boolean") {
    inputError("allowRotation must be boolean");
  }
  if (options.onUnsupported !== undefined
    && options.onUnsupported !== "explicit-fallback"
    && options.onUnsupported !== "error") {
    inputError("onUnsupported has an unknown value");
  }
  for (const order of options.preferredRotationOrders ?? []) {
    if (!Number.isSafeInteger(order) || order < 2 || order > INT32_MAX) {
      inputError("preferredRotationOrders contains an invalid order", { order });
    }
  }
  return {
    ...options,
    positionEpsilonM: epsilon,
    allowReflection: options.allowReflection ?? true,
    allowRotation: options.allowRotation ?? true,
    onUnsupported: options.onUnsupported ?? "explicit-fallback",
  };
}

function canonicalElement(element: PositionedArrayElement, positionM = element.positionM): CanonicalArrayElement {
  return Object.freeze({
    id: element.id,
    positionM: point(positionM[0], positionM[1]),
    patternId: element.patternId,
    rotationDeg: 0 as const,
  });
}

function zeroCanonicalizations(elements: readonly PositionedArrayElement[]): readonly PositionCanonicalization[] {
  return Object.freeze(elements.map((element, callerElementIndex) => Object.freeze({
    callerElementIndex,
    originalPositionM: point(element.positionM[0], element.positionM[1]),
    canonicalPositionM: point(element.positionM[0], element.positionM[1]),
    adjustmentM: point(0, 0),
    distanceM: 0,
  })));
}

function bboxCenter(elements: readonly PositionedArrayElement[]): Point2 {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const element of elements) {
    minX = Math.min(minX, element.positionM[0]);
    maxX = Math.max(maxX, element.positionM[0]);
    minY = Math.min(minY, element.positionM[1]);
    maxY = Math.max(maxY, element.positionM[1]);
  }
  return point((minX + maxX) / 2, (minY + maxY) / 2);
}

function centroid(elements: readonly PositionedArrayElement[]): Point2 {
  let x = 0;
  let y = 0;
  for (const element of elements) {
    x += element.positionM[0];
    y += element.positionM[1];
  }
  return point(x / elements.length, y / elements.length);
}

function explicitPlan(
  validated: ValidatedDescription,
  centerM: Point2,
  reasons: readonly SymmetrizationReason[],
  candidates: readonly SymmetryCandidateDiagnostics[],
): Extract<ArrayBuildPlan, { readonly kind: "explicit" }> {
  const canonicalizations = zeroCanonicalizations(validated.description.elements);
  const frozenReasons = Object.freeze([...reasons]);
  const diagnostics: SymmetrizerDiagnostics = Object.freeze({
    representation: "explicit",
    exact: true,
    effectiveCenterM: centerM,
    maxPositionAdjustmentM: 0,
    canonicalizations,
    candidates: Object.freeze([...candidates]),
    reasons: frozenReasons,
  });
  return Object.freeze({
    kind: "explicit",
    elements: Object.freeze(validated.description.elements.map((element) => canonicalElement(element))),
    reasons: frozenReasons,
    diagnostics,
  });
}

/** Build an explicit, identity-mapped plan after validating the full description. */
export function createExplicitArrayBuildPlan(
  description: FullArrayDescription,
): Extract<ArrayBuildPlan, { readonly kind: "explicit" }> {
  const validated = validateDescription(description);
  return explicitPlan(validated, bboxCenter(description.elements), Object.freeze([]), Object.freeze([]));
}

function unsupportedPatternReasons(validated: ValidatedDescription): readonly SymmetrizationReason[] {
  const result: SymmetrizationReason[] = [];
  const reported = new Set<string>();
  for (let index = 0; index < validated.description.elements.length; index += 1) {
    const element = validated.description.elements[index]!;
    const pattern = validated.patterns.get(element.patternId)!;
    let message: string | undefined;
    if ((pattern as { readonly kind?: unknown }).kind !== "straight-wire-pattern") {
      message = `Pattern ${pattern.id} is not a supported straight-wire pattern`;
    } else if (element.rotationDeg !== undefined && element.rotationDeg !== 0) {
      message = `Element ${String(element.id)} has a nonzero local rotation`;
    } else {
      const wire = pattern.wires.find((candidate) =>
        candidate.startM[0] !== 0 || candidate.startM[1] !== 0
        || candidate.endM[0] !== 0 || candidate.endM[1] !== 0);
      if (wire !== undefined) {
        message = `Pattern ${pattern.id} wire ${wire.id} is not pointwise on the local Z axis`;
      }
    }
    if (message !== undefined && !reported.has(`${pattern.id}:${message}`)) {
      reported.add(`${pattern.id}:${message}`);
      result.push(reason(
        "UNSUPPORTED_ELEMENT_PATTERN_TRANSFORM",
        message,
        index,
        pattern.id,
      ));
    }
  }
  return Object.freeze(result);
}

function reflectionTransforms(planes: readonly ("x=0" | "y=0")[]): readonly SymmetryCopyTransform[] {
  const transforms: SymmetryCopyTransform[] = [Object.freeze({
    kind: "cartesian-signs",
    signs: Object.freeze([1, 1, 1] as [1, 1, 1]),
  })];
  for (const plane of ["y=0", "x=0"] as const) {
    if (!planes.includes(plane)) {
      continue;
    }
    const count = transforms.length;
    for (let index = 0; index < count; index += 1) {
      const signs = Array.from(
        (transforms[index]! as { readonly signs: readonly [1 | -1, 1 | -1, 1 | -1] }).signs,
      ) as [1 | -1, 1 | -1, 1 | -1];
      const coordinate = plane === "x=0" ? 0 : 1;
      signs[coordinate] = signs[coordinate] === 1 ? -1 : 1;
      transforms.push(Object.freeze({
        kind: "cartesian-signs",
        signs: Object.freeze(signs),
      }));
    }
  }
  return Object.freeze(transforms);
}

function rotationTransforms(order: number): readonly SymmetryCopyTransform[] {
  return Object.freeze(Array.from({ length: order }, (_, index) => Object.freeze({
    kind: "rotate-z" as const,
    angleDeg: index * 360 / order,
  })));
}

function candidateSpecs(
  validated: ValidatedDescription,
  options: ReturnType<typeof validateOptions>,
): readonly CandidateSpec[] {
  const elements = validated.description.elements;
  const suppliedCenter = options.center !== undefined && options.center !== "auto"
    ? point(options.center[0], options.center[1])
    : undefined;
  const reflectionCenter = suppliedCenter ?? bboxCenter(elements);
  const rotationCenter = suppliedCenter ?? centroid(elements);
  const result: CandidateSpec[] = [];
  let ordinal = 0;
  if (options.allowReflection) {
    for (const planes of [
      ["x=0", "y=0"],
      ["x=0"],
      ["y=0"],
    ] as const) {
      result.push(Object.freeze({
        symmetry: Object.freeze({
          kind: "reflection" as const,
          planes: Object.freeze([...planes]) as unknown as readonly ["x=0" | "y=0", ...(readonly ("x=0" | "y=0")[])],
          tagIncrement: 1,
        }),
        centerM: reflectionCenter,
        transforms: reflectionTransforms(planes),
        ordinal,
      }));
      ordinal += 1;
    }
  }
  if (options.allowRotation) {
    const configured = options.preferredRotationOrders;
    const orders = configured === undefined
      ? Array.from({ length: Math.min(elements.length, AUTO_ROTATION_ORDER_CAP) - 1 }, (_, index) => index + 2)
        .filter((order) => elements.length % order === 0)
        .sort((left, right) => right - left)
      : [...new Set(configured)];
    for (const order of orders) {
      result.push(Object.freeze({
        symmetry: Object.freeze({
          kind: "rotational" as const,
          axis: "z" as const,
          order: order as RotationalOrder,
          tagIncrement: 1,
        }),
        centerM: rotationCenter,
        transforms: rotationTransforms(order),
        ordinal,
      }));
      ordinal += 1;
    }
  }
  return Object.freeze(result);
}

function applyTransform(position: Point2, transform: SymmetryCopyTransform): Point2 {
  if (transform.kind === "cartesian-signs") {
    return point(position[0] * transform.signs[0], position[1] * transform.signs[1]);
  }
  const angle = transform.angleDeg * Math.PI / 180;
  const snapUnit = (value: number): number => {
    const nearest = Math.round(value);
    return Math.abs(value - nearest) <= 8 * Number.EPSILON ? nearest : value;
  };
  const cosine = snapUnit(Math.cos(angle));
  const sine = snapUnit(Math.sin(angle));
  return point(
    cosine * position[0] - sine * position[1],
    sine * position[0] + cosine * position[1],
  );
}

function inverseTransform(position: Point2, transform: SymmetryCopyTransform): Point2 {
  if (transform.kind === "cartesian-signs") {
    return applyTransform(position, transform);
  }
  return applyTransform(position, Object.freeze({
    kind: "rotate-z",
    angleDeg: -transform.angleDeg,
  }));
}

function matchCandidate(
  validated: ValidatedDescription,
  spec: CandidateSpec,
  epsilon: number,
): MatchedCandidate | readonly SymmetrizationReason[] {
  const elements = validated.description.elements;
  // Build the hash locally so centered coordinates remain available for exact
  // distance checks without mutating or normalizing caller input.
  const centered = elements.map((element) => point(
    element.positionM[0] - spec.centerM[0],
    element.positionM[1] - spec.centerM[1],
  ));
  const cellSize = epsilon === 0 ? 0 : epsilon;
  const cells = new Map<string, number[]>();
  const key = (position: Point2): string => cellSize === 0
    ? `${Object.is(position[0], -0) ? 0 : position[0]}:${Object.is(position[1], -0) ? 0 : position[1]}`
    : `${Math.floor(position[0] / cellSize)}:${Math.floor(position[1] / cellSize)}`;
  centered.forEach((position, index) => {
    const indices = cells.get(key(position));
    if (indices === undefined) {
      cells.set(key(position), [index]);
    } else {
      indices.push(index);
    }
  });
  const near = (position: Point2): readonly number[] => {
    if (epsilon === 0) {
      return cells.get(key(position)) ?? [];
    }
    const x = Math.floor(position[0] / cellSize);
    const y = Math.floor(position[1] / cellSize);
    const found: number[] = [];
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (const index of cells.get(`${x + dx}:${y + dy}`) ?? []) {
          const deltaX = centered[index]![0] - position[0];
          const deltaY = centered[index]![1] - position[1];
          if (Math.hypot(deltaX, deltaY) <= epsilon) {
            found.push(index);
          }
        }
      }
    }
    return found;
  };

  const mappingsByCopy: number[][] = [];
  for (let copyIndex = 0; copyIndex < spec.transforms.length; copyIndex += 1) {
    const transform = spec.transforms[copyIndex]!;
    const mapping: number[] = [];
    const targets = new Set<number>();
    for (let sourceIndex = 0; sourceIndex < elements.length; sourceIndex += 1) {
      const expected = applyTransform(centered[sourceIndex]!, transform);
      const nearby = near(expected);
      const compatible = nearby.filter((targetIndex) => {
        const source = elements[sourceIndex]!;
        const target = elements[targetIndex]!;
        return source.patternId === target.patternId
          && (source.rotationDeg ?? 0) === (target.rotationDeg ?? 0);
      });
      if (compatible.length === 0) {
        if (nearby.length > 0) {
          return Object.freeze([reason(
            "PATTERN_MISMATCH",
            `Candidate transform maps element ${sourceIndex} only to an incompatible pattern`,
            sourceIndex,
            elements[sourceIndex]!.patternId,
          )]);
        }
        return Object.freeze([reason(
          "POSITION_OUTSIDE_EPSILON",
          `Candidate transform has no unique position match within ${epsilon} metres`,
          sourceIndex,
        )]);
      }
      if (compatible.length > 1) {
        return Object.freeze([reason(
          "AMBIGUOUS_POSITION_MATCH",
          `Candidate transform has ${compatible.length} position matches within epsilon`,
          sourceIndex,
        )]);
      }
      const targetIndex = compatible[0]!;
      if (targets.has(targetIndex)) {
        return Object.freeze([reason(
          "AMBIGUOUS_POSITION_MATCH",
          "Candidate transform is not a one-to-one permutation",
          sourceIndex,
        )]);
      }
      targets.add(targetIndex);
      mapping.push(targetIndex);
    }
    mappingsByCopy.push(mapping);
  }

  for (let sourceIndex = 0; sourceIndex < elements.length; sourceIndex += 1) {
    const orbit = new Set(mappingsByCopy.map((mapping) => mapping[sourceIndex]!));
    if (orbit.size !== spec.transforms.length) {
      const code = spec.symmetry.kind === "reflection"
        ? "FIXED_ELEMENT_ON_REFLECTION_PLANE"
        : "FIXED_ELEMENT_ON_ROTATION_AXIS";
      return Object.freeze([reason(
        code,
        spec.symmetry.kind === "reflection"
          ? "An element is fixed by a generating reflection plane"
          : "An element is fixed by the rotation axis or a lower-order subgroup",
        sourceIndex,
      )]);
    }
  }
  return Object.freeze({
    spec,
    mappingsByCopy: Object.freeze(mappingsByCopy.map((mapping) => Object.freeze(mapping))),
  });
}

function representativeForOrbit(
  orbit: readonly number[],
  centered: readonly Point2[],
  spec: CandidateSpec,
  epsilon: number,
): number {
  if (spec.symmetry.kind === "reflection") {
    const planes = new Set(spec.symmetry.planes);
    const inFundamentalSection = orbit.filter((index) =>
      (!planes.has("x=0") || centered[index]![0] > epsilon)
      && (!planes.has("y=0") || centered[index]![1] > epsilon));
    if (inFundamentalSection.length === 1) {
      return inFundamentalSection[0]!;
    }
  } else {
    const step = 2 * Math.PI / spec.symmetry.order;
    const inFundamentalSection = orbit.map((index) => {
      const position = centered[index]!;
      const angle = (Math.atan2(position[1], position[0]) + 2 * Math.PI) % (2 * Math.PI);
      return { index, remainder: angle % step };
    }).sort((left, right) => left.remainder - right.remainder || left.index - right.index);
    return inFundamentalSection[0]!.index;
  }
  return [...orbit].sort((left, right) =>
    centered[right]![1] - centered[left]![1]
    || centered[right]![0] - centered[left]![0]
    || String(spec.symmetry.kind).localeCompare(String(spec.symmetry.kind)))[0]!;
}

function buildAcceptedCandidate(
  validated: ValidatedDescription,
  matched: MatchedCandidate,
  epsilon: number,
): AcceptedCandidate | readonly SymmetrizationReason[] {
  const { spec, mappingsByCopy } = matched;
  const elements = validated.description.elements;
  const centered = elements.map((element) => point(
    element.positionM[0] - spec.centerM[0],
    element.positionM[1] - spec.centerM[1],
  ));
  const visited = new Set<number>();
  const orbits: CanonicalOrbit[] = [];
  for (let seed = 0; seed < elements.length; seed += 1) {
    if (visited.has(seed)) {
      continue;
    }
    const initialOrbit = mappingsByCopy.map((mapping) => mapping[seed]!);
    initialOrbit.forEach((index) => visited.add(index));
    const representativeIndex = representativeForOrbit(initialOrbit, centered, spec, epsilon);
    const targetsByCopy = mappingsByCopy.map((mapping) => mapping[representativeIndex]!);
    let sumX = 0;
    let sumY = 0;
    for (let copyIndex = 0; copyIndex < spec.transforms.length; copyIndex += 1) {
      const inverse = inverseTransform(centered[targetsByCopy[copyIndex]!]!, spec.transforms[copyIndex]!);
      sumX += inverse[0];
      sumY += inverse[1];
    }
    const canonicalBase = point(sumX / spec.transforms.length, sumY / spec.transforms.length);
    const canonicalByCaller = new Map<number, Point2>();
    for (let copyIndex = 0; copyIndex < spec.transforms.length; copyIndex += 1) {
      canonicalByCaller.set(
        targetsByCopy[copyIndex]!,
        applyTransform(canonicalBase, spec.transforms[copyIndex]!),
      );
    }
    orbits.push(Object.freeze({
      representativeIndex,
      canonicalBase,
      targetsByCopy: Object.freeze(targetsByCopy),
      canonicalByCaller,
    }));
  }
  orbits.sort((left, right) =>
    left.canonicalBase[1] - right.canonicalBase[1]
    || left.canonicalBase[0] - right.canonicalBase[0]
    || elements[left.representativeIndex]!.patternId.localeCompare(elements[right.representativeIndex]!.patternId)
    || String(elements[left.representativeIndex]!.id).localeCompare(String(elements[right.representativeIndex]!.id)));

  const canonicalByCaller = new Map<number, Point2>();
  for (const orbit of orbits) {
    for (const [index, position] of orbit.canonicalByCaller) {
      canonicalByCaller.set(index, position);
    }
  }
  const canonicalizations: PositionCanonicalization[] = [];
  let maxAdjustment = 0;
  for (let index = 0; index < elements.length; index += 1) {
    const canonicalRelative = canonicalByCaller.get(index)!;
    const canonicalAbsolute = point(
      canonicalRelative[0] + spec.centerM[0],
      canonicalRelative[1] + spec.centerM[1],
    );
    const original = elements[index]!.positionM;
    const adjustment = point(
      canonicalAbsolute[0] - original[0],
      canonicalAbsolute[1] - original[1],
    );
    const distance = Math.hypot(adjustment[0], adjustment[1]);
    if (distance > epsilon) {
      return Object.freeze([reason(
        "POSITION_OUTSIDE_EPSILON",
        `Canonicalization adjustment ${distance} exceeds ${epsilon} metres`,
        index,
      )]);
    }
    maxAdjustment = Math.max(maxAdjustment, distance);
    canonicalizations.push(Object.freeze({
      callerElementIndex: index,
      originalPositionM: point(original[0], original[1]),
      canonicalPositionM: canonicalAbsolute,
      adjustmentM: adjustment,
      distanceM: distance,
    }));
  }
  for (let left = 0; left < elements.length; left += 1) {
    for (let right = left + 1; right < elements.length; right += 1) {
      const a = canonicalByCaller.get(left)!;
      const b = canonicalByCaller.get(right)!;
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= epsilon) {
        return Object.freeze([reason(
          "AMBIGUOUS_POSITION_MATCH",
          "Canonical symmetric positions collide within epsilon",
          left,
        )]);
      }
    }
  }

  let tagIncrement = 0;
  let fundamentalPortCount = 0;
  const baseTags: number[] = [];
  const basePortIndices: number[] = [];
  for (const orbit of orbits) {
    const pattern = validated.patterns.get(elements[orbit.representativeIndex]!.patternId)!;
    baseTags.push(tagIncrement + 1);
    basePortIndices.push(fundamentalPortCount);
    tagIncrement += pattern.wires.length;
    fundamentalPortCount += pattern.ports.length;
  }
  if (tagIncrement + (spec.transforms.length - 1) * tagIncrement > INT32_MAX) {
    return Object.freeze([reason(
      "TAG_SPACE_EXHAUSTED",
      "Symmetry-generated wire tags exceed the signed 32-bit range",
    )]);
  }
  const symmetry: GeometrySymmetry = spec.symmetry.kind === "reflection"
    ? Object.freeze({
      kind: "reflection",
      planes: spec.symmetry.planes,
      tagIncrement,
    })
    : Object.freeze({
      kind: "rotational",
      axis: "z",
      order: spec.symmetry.order,
      tagIncrement,
    });
  const mappings: ArrayElementMapping[] = new Array(elements.length);
  const fundamentalElements: CanonicalArrayElement[] = [];
  for (let fundamentalElementIndex = 0; fundamentalElementIndex < orbits.length; fundamentalElementIndex += 1) {
    const orbit = orbits[fundamentalElementIndex]!;
    const representative = elements[orbit.representativeIndex]!;
    const pattern = validated.patterns.get(representative.patternId)!;
    fundamentalElements.push(canonicalElement(representative, orbit.canonicalBase));
    for (let copyIndex = 0; copyIndex < orbit.targetsByCopy.length; copyIndex += 1) {
      const callerElementIndex = orbit.targetsByCopy[copyIndex]!;
      const callerPortStart = validated.callerPortStarts[callerElementIndex]!;
      const generatedPortStart = copyIndex * fundamentalPortCount + basePortIndices[fundamentalElementIndex]!;
      mappings[callerElementIndex] = Object.freeze({
        callerElementIndex,
        callerElementId: elements[callerElementIndex]!.id,
        fundamentalElementIndex,
        copyIndex,
        generatedTag: baseTags[fundamentalElementIndex]! + copyIndex * tagIncrement,
        callerPortIndices: Object.freeze(Array.from(
          { length: pattern.ports.length },
          (_, portIndex) => callerPortStart + portIndex,
        )),
        generatedPortIndices: Object.freeze(Array.from(
          { length: pattern.ports.length },
          (_, portIndex) => generatedPortStart + portIndex,
        )),
        positionAdjustmentM: canonicalizations[callerElementIndex]!.adjustmentM,
      });
    }
  }
  const validatedSymmetry = validateGeometrySymmetry(symmetry, tagIncrement);
  const fullExpansion = createSymmetryExpansion(validatedSymmetry, 0, 0);
  const expansion = Object.freeze({
    kind: fullExpansion.kind,
    sectionCount: fullExpansion.sectionCount,
    copies: fullExpansion.copies,
  });
  const diagnostics: SymmetrizerDiagnostics = Object.freeze({
    representation: "symmetric",
    exact: maxAdjustment === 0,
    effectiveCenterM: spec.centerM,
    maxPositionAdjustmentM: maxAdjustment,
    canonicalizations: Object.freeze(canonicalizations),
    candidates: Object.freeze([]),
    reasons: Object.freeze([]),
  });
  return Object.freeze({
    ordinal: spec.ordinal,
    plan: Object.freeze({
      kind: "symmetric",
      centerM: spec.centerM,
      symmetry,
      expansion,
      fundamentalElements: Object.freeze(fundamentalElements),
      mappings: Object.freeze(mappings),
      maxPositionAdjustmentM: maxAdjustment,
      diagnostics,
    }),
  });
}

function uniqueReasons(values: readonly SymmetrizationReason[]): readonly SymmetrizationReason[] {
  const seen = new Set<string>();
  const result: SymmetrizationReason[] = [];
  for (const value of values) {
    const key = `${value.code}:${value.callerElementIndex ?? ""}:${value.patternId ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  return Object.freeze(result);
}

/** Analyze a complete positioned array without mutating it or constructing WASM state. */
export function analyzeArraySymmetry(
  description: FullArrayDescription,
  options: SymmetrizerOptions,
): ArrayBuildPlan {
  const validated = validateDescription(description);
  const validatedOptions = validateOptions(options);
  const unsupported = unsupportedPatternReasons(validated);
  const fallbackCenter = validatedOptions.center !== undefined && validatedOptions.center !== "auto"
    ? point(validatedOptions.center[0], validatedOptions.center[1])
    : bboxCenter(description.elements);
  if (unsupported.length > 0) {
    if (validatedOptions.onUnsupported === "error") {
      throw new NecGeometryError(unsupported[0]!.message, {
        details: {
          symmetryFailure: "UNSUPPORTED_ELEMENT_PATTERN_TRANSFORM",
          reason: unsupported[0],
        },
      });
    }
    return explicitPlan(validated, fallbackCenter, unsupported, Object.freeze([]));
  }

  const specs = candidateSpecs(validated, validatedOptions);
  const accepted: AcceptedCandidate[] = [];
  const diagnostics: SymmetryCandidateDiagnostics[] = [];
  const rejectedReasons: SymmetrizationReason[] = [];
  for (const spec of specs) {
    const matched = matchCandidate(validated, spec, validatedOptions.positionEpsilonM);
    if (Array.isArray(matched)) {
      const frozenReasons = Object.freeze([...matched]);
      rejectedReasons.push(...frozenReasons);
      diagnostics.push(Object.freeze({
        symmetry: spec.symmetry,
        accepted: false,
        reasons: frozenReasons,
      }));
      continue;
    }
    const built = buildAcceptedCandidate(
      validated,
      matched as MatchedCandidate,
      validatedOptions.positionEpsilonM,
    );
    if (Array.isArray(built)) {
      const frozenReasons = Object.freeze([...built]);
      rejectedReasons.push(...frozenReasons);
      diagnostics.push(Object.freeze({
        symmetry: spec.symmetry,
        accepted: false,
        reasons: frozenReasons,
      }));
      continue;
    }
    const candidate = built as AcceptedCandidate;
    accepted.push(candidate);
    diagnostics.push(Object.freeze({
      symmetry: candidate.plan.symmetry,
      accepted: true,
      reasons: Object.freeze([]),
    }));
  }
  if (accepted.length === 0) {
    const fixed = rejectedReasons.filter((candidate) =>
      candidate.code === "FIXED_ELEMENT_ON_REFLECTION_PLANE"
      || candidate.code === "FIXED_ELEMENT_ON_ROTATION_AXIS");
    const explanations = uniqueReasons(fixed.length > 0
      ? fixed
      : [
        reason("NO_NONTRIVIAL_SYMMETRY", "No supported nontrivial array symmetry was proven"),
        ...rejectedReasons,
      ]);
    return explicitPlan(
      validated,
      fallbackCenter,
      explanations,
      Object.freeze(diagnostics),
    );
  }
  accepted.sort((left, right) =>
    right.plan.expansion.sectionCount - left.plan.expansion.sectionCount
    || (left.plan.symmetry.kind === right.plan.symmetry.kind
      ? left.ordinal - right.ordinal
      : left.plan.symmetry.kind === "reflection" ? -1 : 1));
  const selected = accepted[0]!.plan;
  const plannerDiagnostics: SymmetrizerDiagnostics = Object.freeze({
    ...selected.diagnostics,
    candidates: Object.freeze(diagnostics),
  });
  return Object.freeze({
    ...selected,
    diagnostics: plannerDiagnostics,
  });
}
