# Symmetry support implementation plan

Status: **working implementation document**  
Target: native NEC2++, stateful C++ model, stable C/WASM ABI,
`@necpp-engine/wasm`, worker API, and a transparent TypeScript array
symmetrizer  
Primary reference: [NEC-2 Part III Program Description](https://www.nec2.org/other/nec2prt3.pdf),
especially the `GX` and `GR` geometry cards

This document is intended to be the starting context for several agents working
sequentially. Each agent should complete one work package, record its evidence
in the status table, and leave the repository and this document in a state that
the next agent can continue without reconstructing design decisions.

## 1. Objective

Expose NEC-2's exact geometry symmetry machinery to the stateful TypeScript
engine and add a conservative intermediary that can recognize eligible
symmetry in a caller's full array description.

The completed feature must support two use modes:

1. **Explicit symmetry:** the caller builds one fundamental section and asks
   the engine to generate the remaining sections by coordinate-plane
   reflection or equal-angle rotation.
2. **Transparent symmetrization:** the caller supplies the complete array as
   element positions in the XY plane. A pure TypeScript planning layer detects
   supported symmetry within an explicit epsilon, creates an exact canonical
   symmetric model, and gathers results back into the caller's original
   element and port order. If it cannot prove eligibility, it builds the full
   explicit model instead.

The first release is deliberately conservative about element patterns. It
accepts only patterns that are pointwise invariant under the selected array
transforms, initially straight Z-directed wire patterns on the element-local Z
axis. Patterns whose wire geometry must itself be reflected or rotated, such as
helices, tilted wires, off-axis wire sets, arcs, or patches, must produce an
explicit fallback or a controlled error. A later extension may accept them
after handedness, endpoint direction, port polarity, and segment mapping are
defined and tested.

## 2. Success criteria at a glance

The feature is complete when all of the following are true:

- one, two, and three coordinate-plane reflections and N-fold rotation about
  the global Z axis are available through the stateful native, WASM, direct
  TypeScript, and worker APIs;
- an even-sided square array can be built from one quadrant while preserving a
  deterministic mapping to every caller element and port;
- a full explicit model and its symmetric equivalent produce the same gathered
  complex Z matrix, requested/achieved port quantities, and complex far fields
  within the tolerances in this document;
- the beam-steering consumer supplies the same full array description and uses
  the same prepare, Z/Y, solve, combined-far-field, and embedded-far-field
  methods whether the internal representation is explicit or symmetric;
- no consumer result exposes fundamental-section size, native copy-major port
  order, generated tags, or a symmetry-specific result variant unless the
  consumer explicitly requests optimization diagnostics;
- the npm-rendered package README describes the supported symmetry capabilities,
  transparent automatic selection, unchanged consumer contract, limitations,
  and diagnostics with validated examples;
- off-broadside current excitations prove that excitation weights need not be
  symmetric for the geometry symmetry optimization to remain valid;
- the transparent symmetrizer either returns a fully explained accepted plan
  or an explicit-model fallback with machine-readable reasons;
- epsilon-based acceptance reports every coordinate canonicalization and never
  silently claims the original coordinates were exact;
- unsupported element-pattern transformations, including a helix reflected
  through a plane, cannot enter the symmetry path;
- the reference 16 x 16 case retains a material preparation-time and memory
  improvement over the full explicit stateful model; and
- all native, ABI, package, worker, packed-consumer, and browser tests remain
  green; and
- only after those gates pass, the final release-identity work package bumps
  the npm package from `0.1.1` to `0.2.0` and the native engine from `2.3.4` to
  `2.4.0`, while the additive ABI remains version `1`.

## 3. Current implementation and gap

The numerical symmetry implementation already exists:

- `c_geometry::reflect()` supports any combination of X, Y, and Z coordinate
  sign changes and records the original segment/patch counts in `np`/`mp`;
- `c_geometry::generate_cylindrical_structure()` and the `GR` parser path
  generate equally spaced rotations about the global Z axis;
- `nec_context::fblock()` builds the plane-symmetry or rotational Fourier
  transform matrix;
- matrix assembly, factorization, and solve paths already use `np`, `mp`,
  `m_ipsym`, and `nop` to operate on symmetry modes; and
- the deck path already accepts `GX` and `GR`.

The missing path is:

```text
nec_stateful_model
  -> additive C/WASM ABI
    -> private WASM module typing
      -> direct TypeScript facade
        -> worker protocol/client/runtime
          -> transparent array planning and result gathering
```

The existing `NecModel` exposes only `addWire()` followed by
`completeGeometry()`. No solver rewrite is required for the first release, but
the public path must preserve native symmetry metadata and enforce conditions
that the deck interface historically leaves to the user.

## 4. Normative terminology

- **Full description:** the caller's complete list of positioned elements,
  ports, loads, and environment before symmetry analysis.
- **Explicit baseline:** a stateful NEC model in which every element from the
  full description is added independently and no geometry symmetry metadata is
  active.
- **Fundamental section:** the wires and patches stored before NEC generates
  symmetry copies.
- **Section count:** total number of identical geometry sections, including the
  original. It is 2, 4, or 8 for one, two, or three reflection planes and is
  the rotational order for `GR`-style symmetry.
- **Generated order:** NEC's native order after geometry expansion. Combined
  plane reflections use Z, then Y, then X passes. Rotations use increasing
  angles `copyIndex * 2*pi/order`.
- **Caller order:** the exact element and port order in the full description.
- **Scatter map:** caller-order port index to generated native port index.
- **Gather map:** generated native result index to caller-order result index.
- **Orbit:** all full-description elements related by the selected symmetry
  group.
- **Canonicalization:** replacement of epsilon-close orbit coordinates by one
  exact set of symmetry-related coordinates. This is a disclosed geometric
  adjustment, not exact equality to the input.
- **Transparent fallback:** selection of the explicit baseline without changing
  the requested electromagnetic model when symmetry is absent, ambiguous, or
  unsupported.

## 5. Supported symmetry contract

### 5.1 Coordinate-plane reflection

The public contract names planes rather than NEC's potentially confusing
"reflection along an axis" terminology:

| Public plane | Coordinate transform | NEC `GX` digit |
|---|---|---:|
| `"x=0"` | `(x,y,z) -> (-x,y,z)` | hundreds |
| `"y=0"` | `(x,y,z) -> (x,-y,z)` | tens |
| `"z=0"` | `(x,y,z) -> (x,y,-z)` | units |

Any nonempty combination is valid in free space when the geometry rules are
met. One, two, and three planes generate 2, 4, and 8 sections respectively.

Required validation:

- a segment may end on a generating plane but may not lie in it or cross it;
- a patch may not lie in a generating plane;
- all generated nonzero tags must be unique for the stateful public API;
- the symmetry operation is the final geometry-generation operation before
  geometry completion;
- a ground plane at `z=0` is incompatible with use of `z=0` as a structural
  reflection plane, while the vertical `x=0` and `y=0` planes remain eligible;
- loads and radiating environment must be invariant under every selected
  transform; and
- sources, requested port currents, requested port voltages, and non-radiating
  networks do not have to be symmetric.

### 5.2 Rotational symmetry

Rotational symmetry means `order` total copies at equal angles around the
global Z axis through the origin:

```text
angle(copyIndex) = copyIndex * 2*pi/order
copyIndex        = 0 .. order-1
```

The public API requires an integer `order >= 2`. The implementation must reject
fixed-axis elements or other geometry that would be duplicated on itself.
Homogeneous free space and homogeneous horizontal ground are invariant under
this rotation.

The first release does not support:

- an arbitrary rotation axis;
- a rotation center other than the origin inside the NEC model;
- screw symmetry or rotation plus translation;
- simultaneous exploitation of a general dihedral group; or
- composing separate plane and rotational operations to claim the product of
  their section counts.

The transparent layer may recenter XY coordinates before model construction,
because free space and a homogeneous horizontal ground are translation
invariant in XY. Section 9 defines the required far-field phase restoration.

### 5.3 Geometry mutations, loads, and ground

No new geometry may be added after symmetry generation. The preferred public
TypeScript shape therefore makes symmetry an option of `completeGeometry()` so
the expansion and completion form one lifecycle operation.

Loads are structural and must repeat over complete orbits. The implementation
must not reject the first of several repeated `addLoad()` calls merely because
the intermediate state is asymmetric. It must instead either:

- offer an atomic helper that expands one caller load over all mapped copies;
  or
- retain load definitions and validate complete load orbits no later than
  `prepare()`.

The transparent builder should use the atomic expansion helper. Direct users
may add every copy explicitly, but `prepare()` must fail with a controlled
geometry/configuration error if a load orbit is incomplete or contains unequal
kind, range, or values.

Special cases that can be recognized as symmetric without expansion include a
load applied identically to every segment. Absolute segment-number loads need
an explicit orbit mapping; they must not be assumed symmetric from a numeric
range alone.

### 5.4 Failure classification

Symmetry failures carry one of the following stable `SymmetryFailureReason`
values. The ordinary package error code remains the primary error taxonomy;
the reason refines it and identifies whether the automatic full-model retry is
permitted.

| Reason | Package error | Representation-eligibility failure | Required behavior |
|---|---|---:|---|
| `INVALID_SYMMETRY` | `NEC_INPUT` | no | Reject malformed planes, orders, axes, tag increments, or mutually inconsistent descriptor fields before mutation. |
| `INCOMPATIBLE_GROUND` | `NEC_GEOMETRY` | yes, only when the unchanged full model is valid | Reject structural `z=0` reflection with ground and other environment/symmetry conflicts; `"auto"` may retry explicit once. |
| `INCOMPLETE_LOAD_ORBIT` | `NEC_GEOMETRY` | yes, only when the unchanged full loads are valid | Detect at `prepare()` after all loads have been supplied; `"auto"` may retry the full explicit load set once. |
| `UNSUPPORTED_ELEMENT_PATTERN_TRANSFORM` | `NEC_GEOMETRY` when configured as an error; otherwise planner fallback | yes | Default to an explained explicit plan; `"require"` or `onUnsupported: "error"` throws without entering native symmetry generation. |

Allocation, cancellation, conditioning, solver, and invalid full-geometry
failures are never representation-eligibility failures and must not be hidden
by an explicit retry. Every throwing implementation attaches the reason as
`details.symmetryFailure`; planner fallback diagnostics use the corresponding
`SymmetrizationReasonCode`.

## 6. Finalized low-level TypeScript symmetry API

The API below is the advanced contract for callers that deliberately
construct a fundamental section. It is not the representation-independent
beam-steering application API; that facade is defined in Section 8.1. WP-S0
finalized these names; later work packages must preserve them.

```ts
export type ReflectionPlane = "x=0" | "y=0" | "z=0";

/** Branded integer constructed by rotationalOrder(); range is 2..INT32_MAX. */
export type RotationalOrder = number & { /* private brand */ };
export function rotationalOrder(order: number): RotationalOrder;

export interface ReflectionSymmetry {
  readonly kind: "reflection";
  readonly planes: readonly [ReflectionPlane, ...ReflectionPlane[]];
  /** Positive offset applied once per generated copy block. */
  readonly tagIncrement: number;
}

export interface RotationalSymmetry {
  readonly kind: "rotational";
  readonly axis: "z";
  /** Total number of sections, including the original. */
  readonly order: RotationalOrder;
  readonly tagIncrement: number;
}

export type GeometrySymmetry =
  | ReflectionSymmetry
  | RotationalSymmetry;

export interface SymmetryCopy {
  readonly index: number;
  readonly tagOffset: number;
  readonly transform:
    | {
        readonly kind: "cartesian-signs";
        readonly signs: readonly [x: 1 | -1, y: 1 | -1, z: 1 | -1];
      }
    | {
        readonly kind: "rotate-z";
        readonly angleDeg: number;
      };
}

export interface SymmetryExpansion {
  readonly kind: GeometrySymmetry["kind"];
  readonly sectionCount: number;
  readonly fundamentalSegmentCount: number;
  readonly fullSegmentCount: number;
  readonly copies: readonly SymmetryCopy[];
}

export interface CompleteGeometryOptions {
  readonly groundConnection?: GroundConnection;
  readonly symmetry?: GeometrySymmetry;
}

export interface GeometryCompletionResult {
  readonly symmetry?: SymmetryExpansion;
}

interface NecModel {
  completeGeometry(options?: CompleteGeometryOptions): GeometryCompletionResult;
}

interface NecWorkerModel {
  completeGeometry(
    options?: CompleteGeometryOptions,
  ): Promise<GeometryCompletionResult>;
}
```

Returning a value from the existing `void` method is source-compatible for
callers that ignore it. The ABI should retain the current non-symmetric
completion call and add a symmetric completion entry point rather than change
an existing C signature.

The brand is intentional: TypeScript cannot express "any integer at least two"
as a structural `number` subtype. `rotationalOrder()` performs the runtime
integer/range check and makes `order: 1` or an unchecked arbitrary number a
compile-time error. Reflection planes use a nonempty tuple, so `planes: []` is
also rejected during type checking. Runtime validation must additionally reject
duplicate planes and invalid or overflowing tag increments.

The returned copy list is data-only and structured-cloneable. Convenience
mapping helpers belong in TypeScript rather than the ABI:

```ts
generatedTag = baseTag + copy.tagOffset;
```

The API must document and test the exact copy order. Consumers must not infer
physical XY row-major order from generated tags.

## 7. Reference array family

All correctness and benchmark implementations must use one shared fixture
generator. Do not duplicate slightly different geometry formulas across C++,
JavaScript, deck, and benchmark files.

For frequency `f`:

```text
lambda                 = c0 / f
dipole total length    = lambda / 3
dipole half length     = lambda / 6
array spacing X and Y  = lambda / 2
element center height  = lambda / 4 above z=0
wire radius            = lambda / 1000
segments per dipole    = 11
feed segment           = 6 (one-based within the tag)
```

Each element is a straight Z-directed wire:

```text
start = (x_i, y_j, lambda/4 - lambda/6) = (x_i, y_j, lambda/12)
end   = (x_i, y_j, lambda/4 + lambda/6) = (x_i, y_j, 5*lambda/12)
```

For an `n x n` array centered at `(centerX, centerY)`:

```text
x_i = centerX + (i - (n - 1)/2) * lambda/2
y_j = centerY + (j - (n - 1)/2) * lambda/2
```

Caller element and port order is row-major with X varying fastest:

```text
callerIndex = yIndex * n + xIndex
```

Primary environment:

- perfect, infinite ground at `z=0`;
- `groundConnection: "none"`, because no wire touches ground; and
- `setGround({ kind: "perfect" })` after geometry completion, following the
  existing stateful lifecycle.

Secondary coverage adds one finite reflection-coefficient ground case with
fixed documented permittivity and conductivity. Sommerfeld/Norton belongs in
the extended/native regression set but need not run in every browser or
benchmark case.

Use 300 MHz as the default executable fixture frequency, but derive every
dimension from the engine's speed-of-light constant rather than treating one
metre as exactly one wavelength.

WP-S0 selected a small language-neutral golden table plus one JavaScript
generator. The executable generator is
`packages/necpp-wasm/test/fixtures/reference-array.mjs`; both array benchmarks
and subsequent TypeScript symmetry tests import it. The cross-language golden
table is `tests/data/symmetry_reference_array_4x4.json`. Native helpers may use
`em::speed_of_light()` and the formulas above, but must check their 4 x 4
coordinates and maps against that table rather than introduce independent
geometry constants. The JavaScript generator derives the same constant from
the engine's vacuum permittivity and permeability values; it does not use the
SI exact value `299792458`.

### 7.1 Explicit baseline construction

The baseline adds all `n*n` wires independently with unique tags and defines
all center-segment ports in caller order. It does not call a symmetry API and
must report one section.

This is the numerical oracle for equivalence. It is not a deck/report oracle;
both baseline and candidate must use unformatted binary64 stateful results.

### 7.2 Manual reflection construction

For even `n`, add the `n/2 x n/2` positive-X/positive-Y quadrant, then request
reflection across `x=0` and `y=0`. The fundamental element count is `n*n/4`
and the section count is four.

When fundamental tags are contiguous `1..q`, use `tagIncrement = q`. The four
tag blocks are then contiguous, but their physical order follows NEC copy
order, not caller row-major order.

For the golden 4 x 4 case, the positive-quadrant fundamental order is increasing
Y with X varying fastest: `(lambda/4,lambda/4)`,
`(3lambda/4,lambda/4)`, `(lambda/4,3lambda/4)`, and
`(3lambda/4,3lambda/4)`. Native copies are fundamental, Y-reflected,
X-reflected, then XY-reflected, with tag offsets `0,4,8,12`. The executable
caller-to-native scatter map is:

```text
[15,14,6,7, 13,12,4,5, 9,8,0,1, 11,10,2,3]
```

Its inverse generated-to-caller gather map is:

```text
[10,11,14,15, 6,7,2,3, 9,8,13,12, 5,4,1,0]
```

### 7.3 Odd-sided arrays

A conventional centered odd-sided grid contains elements on both vertical
symmetry planes and one element on the rotation axis. The full point set is
mathematically symmetric, but NEC's generators would duplicate fixed elements.
The transparent symmetrizer must therefore fall back to the explicit model and
report a fixed-element reason. It must not remove the center element or split
the model into optimized and unoptimized substructures.

## 8. Transparent symmetrizer

### 8.1 Architectural boundary

The symmetrizer is a pure TypeScript planning layer. Symmetry detection must
not be embedded in `NecModel`, C++, or matrix preparation. This keeps
floating-point policy and caller identity mapping outside the numerical core.

Recommended flow:

```text
FullArrayDescription
  -> analyzeArraySymmetry(description, options)
    -> ArrayBuildPlan (symmetric or explicit)
      -> applyArrayBuildPlan(model, plan)
        -> ResultMapping utilities
```

The analysis function must be deterministic and side-effect free. The build
function may have direct and worker overloads or consume a small adapter whose
methods return `void | Promise<void>`.

#### 8.1.1 Representation-independent consumer facade

The beam-steering web application must never consume `ArrayBuildPlan`,
`SymmetryExpansion`, native generated tags, or scatter/gather maps. Those are
implementation and diagnostic types. Its factory input is always the complete
array description, even when the selected implementation ultimately stores
only a fundamental section.

The factory returns one facade for both representations:

```ts
export interface CreateArraySolverOptions {
  /** `"auto"` is the production default. */
  readonly symmetry?: "auto" | "off" | "require";
  readonly symmetrizer?: SymmetrizerOptions;
}

export interface ArraySolverDiagnostics {
  readonly representation: "explicit" | "symmetric";
  readonly planner: SymmetrizerDiagnostics;
  readonly symmetry?: SymmetryExpansion;
}

export interface NecArraySolver {
  readonly state: NecModelState;

  prepare(options: PrepareOptions): Promise<void>;
  computeImpedanceMatrix(): Promise<ImpedanceResult>;
  solveVoltages(voltages: ComplexVector): Promise<PortSolution>;
  solveCurrents(currents: ComplexVector): Promise<PortSolution>;
  computeFarField(request: FarFieldRequest): Promise<FarFieldResult>;
  computeEmbeddedFarFields(
    request: FarFieldRequest,
    normalization?: EmbeddedFieldNormalization,
  ): Promise<EmbeddedFarFieldResult>;
  dispose(): Promise<void>;

  /** Optional observability; numerical consumers do not need to inspect it. */
  getDiagnostics(): ArraySolverDiagnostics;
}

export function createNecArraySolver(
  description: FullArrayDescription,
  options?: CreateArraySolverOptions,
): Promise<NecArraySolver>;
```

A synchronous/direct counterpart may be supplied, but symmetry must not alter
the method names or result types within either the direct or worker family.

Mode behavior:

- `"auto"`: analyze the full description, use symmetry when proven eligible,
  otherwise construct the explicit model;
- `"off"`: construct the explicit model, primarily for debugging, baselines,
  and equivalence tests; and
- `"require"`: fail if the description cannot be represented by supported
  symmetry, intended for advanced validation rather than normal application
  operation.

In `"auto"` mode, a symmetry-specific construction/preflight failure must
dispose the partial native model and retry explicit construction once when the
failure is classified as a representation-eligibility failure. Cancellation,
allocation failure, invalid full geometry, conditioning failure, and general
solver failures must not be hidden by a retry. The retry and reason are exposed
only through diagnostics.

The facade owns all representation conversion:

- `solveVoltages()` and `solveCurrents()` accept caller-order vectors and
  scatter internally;
- `PortSolution.ports`, requested values, voltages, currents, active
  impedances, and powers are returned in caller order;
- `computeImpedanceMatrix()` always returns a full `P x P` Z/Y result for all
  caller ports, never a fundamental-section matrix, with rows and columns
  gathered into caller order;
- `computeFarField()` returns the ordinary `FarFieldResult`, including internal
  recenter phase restoration where required;
- `computeEmbeddedFarFields()` returns all `P` caller port bases in caller
  order, never native copy-major order; and
- lifecycle, factorization-generation, solve-generation, ownership, error, and
  disposal semantics match the existing stateful facade.

The normal numerical result objects must not gain a required `symmetry` field
or discriminated union. `getDiagnostics()` is the sole supported way for the
application to observe whether optimization occurred. Ignoring diagnostics
must be sufficient for correct use.

### 8.2 Finalized planning types

```ts
export type ArrayElementId = string | number;

export interface RelativeWireDefinition {
  readonly id: string;
  readonly segments: number;
  readonly startM: CartesianPointM;
  readonly endM: CartesianPointM;
  readonly radiusM: number;
}

export interface RelativePortDefinition {
  readonly wireId: string;
  readonly segment: number;
  readonly name?: string;
}

export interface RelativeSegmentSelection {
  readonly wireId: string;
  readonly firstSegment?: number;
  readonly lastSegment?: number;
}

type RetargetLoad<T extends LoadDefinition> =
  T extends LoadDefinition
    ? Omit<T, "target"> & { readonly target: RelativeSegmentSelection }
    : never;

export type RelativeLoadDefinition = RetargetLoad<LoadDefinition>;

export interface PositionedArrayElement {
  readonly id: ArrayElementId;
  readonly positionM: readonly [xM: number, yM: number];
  readonly patternId: string;
  /** The first release accepts only zero/omitted rotation. */
  readonly rotationDeg?: number;
}

export interface ElementWirePattern {
  readonly id: string;
  readonly kind: "straight-wire-pattern";
  readonly wires: readonly RelativeWireDefinition[];
  readonly ports: readonly RelativePortDefinition[];
  readonly loads?: readonly RelativeLoadDefinition[];
}

export interface FullArrayDescription {
  readonly elements: readonly PositionedArrayElement[];
  readonly patterns: readonly ElementWirePattern[];
  readonly ground: GroundModel;
}

export interface CanonicalArrayElement {
  readonly id: ArrayElementId;
  readonly positionM: readonly [xM: number, yM: number];
  readonly patternId: string;
  readonly rotationDeg: 0;
}

export interface SymmetrizerOptions {
  /** Required; no implicit geometry tolerance. */
  readonly positionEpsilonM: number;
  readonly center?: "auto" | readonly [xM: number, yM: number];
  readonly allowReflection?: boolean;
  readonly allowRotation?: boolean;
  readonly preferredRotationOrders?: readonly RotationalOrder[];
  readonly onUnsupported?: "explicit-fallback" | "error";
}

export type SymmetrizationReasonCode =
  | "NO_NONTRIVIAL_SYMMETRY"
  | "FIXED_ELEMENT_ON_REFLECTION_PLANE"
  | "FIXED_ELEMENT_ON_ROTATION_AXIS"
  | "POSITION_OUTSIDE_EPSILON"
  | "AMBIGUOUS_POSITION_MATCH"
  | "PATTERN_MISMATCH"
  | "UNSUPPORTED_ELEMENT_PATTERN_TRANSFORM"
  | "UNSYMMETRIC_LOAD"
  | "GROUND_BREAKS_SYMMETRY"
  | "TAG_SPACE_EXHAUSTED";

export interface SymmetrizationReason {
  readonly code: SymmetrizationReasonCode;
  readonly message: string;
  readonly callerElementIndex?: number;
  readonly patternId?: string;
}

export interface PositionCanonicalization {
  readonly callerElementIndex: number;
  readonly originalPositionM: readonly [xM: number, yM: number];
  readonly canonicalPositionM: readonly [xM: number, yM: number];
  readonly adjustmentM: readonly [dxM: number, dyM: number];
  readonly distanceM: number;
}

export interface SymmetryCandidateDiagnostics {
  readonly symmetry: GeometrySymmetry;
  readonly accepted: boolean;
  readonly reasons: readonly SymmetrizationReason[];
}

export interface SymmetrizerDiagnostics {
  readonly representation: "explicit" | "symmetric";
  readonly exact: boolean;
  readonly effectiveCenterM: readonly [xM: number, yM: number];
  readonly maxPositionAdjustmentM: number;
  readonly canonicalizations: readonly PositionCanonicalization[];
  readonly candidates: readonly SymmetryCandidateDiagnostics[];
  readonly reasons: readonly SymmetrizationReason[];
}

export interface ArrayElementMapping {
  readonly callerElementIndex: number;
  readonly callerElementId: ArrayElementId;
  readonly fundamentalElementIndex: number;
  readonly copyIndex: number;
  readonly generatedTag: number;
  /** Parallel to generatedPortIndices. */
  readonly callerPortIndices: readonly number[];
  readonly generatedPortIndices: readonly number[];
  readonly positionAdjustmentM: readonly [dxM: number, dyM: number];
}

export type ArrayBuildPlan =
  | {
      readonly kind: "symmetric";
      readonly centerM: readonly [xM: number, yM: number];
      readonly symmetry: GeometrySymmetry;
      readonly expansion: Omit<
        SymmetryExpansion,
        "fundamentalSegmentCount" | "fullSegmentCount"
      >;
      readonly fundamentalElements: readonly CanonicalArrayElement[];
      readonly mappings: readonly ArrayElementMapping[];
      readonly maxPositionAdjustmentM: number;
      readonly diagnostics: SymmetrizerDiagnostics;
    }
  | {
      readonly kind: "explicit";
      readonly elements: readonly CanonicalArrayElement[];
      readonly reasons: readonly SymmetrizationReason[];
      readonly diagnostics: SymmetrizerDiagnostics;
    };
```

These names and units are final. Caller ports are ordered by caller element,
then by the referenced pattern's `ports` order. Every returned collection and
coordinate tuple is caller-owned immutable data; no plan exposes a native
pointer or borrowed WASM view. Later work may add optional diagnostics but must
not rename these fields or remove caller IDs, indices, copy indices, generated
tags, paired port mappings, adjustment vectors, accepted/rejected candidates,
or reason codes.

### 8.3 Position matching algorithm

The implementation should use the following staged algorithm:

1. Validate finite, unique element IDs and finite XY coordinates.
2. Resolve every `patternId` and reject unsupported pattern capabilities before
   spending time on geometric candidates.
3. Determine a candidate center:
   - use the supplied center when present;
   - for reflection candidates in `auto`, use the bounding-box midpoint;
   - for rotation candidates in `auto`, use the equal-weight centroid; and
   - cross-check candidate centers against the transformed point set.
4. Recenter only XY coordinates. Preserve every physical Z coordinate.
5. Build a spatial hash using cells no larger than `positionEpsilonM`. Search
   adjacent cells as well, so values on a hash boundary are not missed.
6. Test candidate transforms against the complete element set. A match requires
   compatible pattern identity, element parameters, per-element load schema,
   and rotation metadata in addition to coordinate proximity.
7. Require a unique one-to-one permutation. Two candidates within epsilon for
   one transformed point are ambiguous and must reject that candidate.
8. Build complete orbits. Every orbit must have the full section count; fixed
   points are not accepted in the first release.
9. Select one deterministic representative per orbit. Use the lowest caller
   index after validating that representative choice does not alter the group
   mapping.
10. Canonicalize each orbit by inverse-transforming its members into the
    representative frame, averaging their XY positions, and regenerating all
    members by exact symmetry transforms. Record the adjustment of every
    caller element.
11. Reject when any adjustment exceeds `positionEpsilonM` or when generated
    canonical points collide within epsilon.
12. Allocate deterministic unique tags and build scatter/gather mappings.

The averaging in step 10 avoids selecting one noisy quadrant as truth and makes
the canonical model invariant to input permutation. Tests must permute input
order to prove this.

Candidate selection policy:

- prefer the candidate with the largest section count;
- on a tie, prefer coordinate-plane reflection over rotation for a rectangular
  XY array because its copy mapping is simpler and it imposes no rotational
  orientation on future element patterns;
- then prefer candidates in a documented stable plane/order sequence; and
- record every tested candidate and rejection reason in diagnostics.

For rotational auto-detection, test configured orders first. If none are
provided, enumerate divisors of the element count from largest to smallest,
subject to a documented safety cap. Do not infer an unbounded order by fitting
angles to noisy points.

### 8.4 Epsilon policy

`positionEpsilonM` is required, finite, and nonnegative. A zero value requests
exact coordinate matching. The layer must not choose a scale-dependent hidden
default.

Acceptance within epsilon means that the solver uses the canonicalized exact
symmetric geometry, not the original noisy full coordinates. Therefore the
plan must expose:

- `maxPositionAdjustmentM`;
- one adjustment vector per element;
- the effective center and every canonical coordinate; and
- whether the result is exact (`maxPositionAdjustmentM === 0`) or adjusted.

Application code can then log, display, or reject the adjustment. The default
fallback policy remains explicit construction when a candidate is outside
epsilon.

No universal electromagnetic error bound follows solely from coordinate
epsilon. The jitter equivalence tests in Section 11 lock behavior for the
reference array and chosen test epsilon; they are not permission to describe
all epsilon-accepted geometries as numerically identical.

### 8.5 Recentered models and far-field phase

NEC's supported planes and rotation axis pass through the origin. The
transparent layer may subtract `(centerX, centerY,0)` while building the native
model. For a homogeneous horizontal environment:

- the gathered impedance/admittance matrices and port quantities are invariant
  under a common XY translation; and
- the far-zone complex field requires a phase restoration if the public result
  is to match a model built at the caller's original coordinates.

With the repository's `exp(-j*k*R)` propagation convention, translating a
source by `c = (centerX, centerY,0)` multiplies the far field in direction
`u(theta,phi)` by:

```text
phase(theta, phi) = exp(+j * k * dot(u(theta,phi), c))
```

The transparent result helper must multiply both `E_theta` and `E_phi` by this
factor. It must do the same for every basis in an embedded-field result.

This sign must be proven by an executable off-origin explicit-versus-centered
test. Do not rely on the formula alone.

Near fields are not covered by this phase-only translation rule. If a near
field API is added later, its observation coordinates must be translated
instead.

### 8.6 Result scattering and gathering

The transparent layer must preserve caller order even when native generated
tags are copy-major.

For port vectors:

```text
native[scatter[callerIndex]] = caller[callerIndex]
caller[callerIndex]          = native[scatter[callerIndex]]
```

For a native row-major Z matrix:

```text
Zcaller[i,j] = Znative[scatter[i], scatter[j]]
```

Apply the same two-dimensional gather to Y. Copy all outputs into caller-owned
typed arrays; do not return strided views into native-order arrays.

For embedded far fields, gather the outer port/basis dimension while preserving
theta-fast sample order within each basis. The first release has a port
orientation multiplier of `+1` only. Future transformed element patterns may
require a complex or signed port-basis multiplier, which is one reason they are
currently prohibited.

All operations in this section occur behind `NecArraySolver`. The existence of
a gather or rephasing step must not change a consumer method signature, matrix
dimension, field layout, port metadata, or result ownership.

## 9. Element-pattern eligibility and prohibition

### 9.1 Accepted first-release pattern

An element pattern is eligible only when the implementation can prove that the
selected transform leaves its ordered wire and port definition pointwise
unchanged. Initially this means:

- straight round-wire primitives only;
- every wire endpoint has element-local `x=0` and `y=0` within the pattern
  verifier's exact policy;
- no per-element rotation;
- no arc, helix, patch, surface basis, or opaque/custom primitive;
- identical segmentation, radius, relative Z endpoints, port segments, and
  scalar load schema for all elements in an orbit; and
- only `x=0`/`y=0` reflections or Z-axis rotations for the reference over-ground
  array.

This accepts a Z-directed dipole and multi-wire collinear Z-axis patterns while
avoiding endpoint reversal, tangent-frame, or handedness ambiguity.

### 9.2 Required rejection behavior

The following must result in `UNSUPPORTED_ELEMENT_PATTERN_TRANSFORM` and an
explicit fallback by default:

- a helix of either handedness;
- a tilted or horizontal dipole;
- an off-axis wire, even if the full position set contains a plausible partner;
- an element with a nonzero local rotation;
- an arc or patch;
- a pattern whose transformed endpoints match only after swapping endpoint
  order; or
- any pattern lacking enough semantic information to determine transform
  behavior.

The diagnostics must name the pattern and the first unsupported primitive or
rule. It is not sufficient to return only "no symmetry found."

### 9.3 Path to later acceptance

A future pattern-transform workstream may relax the prohibition only after it
implements all of the following:

1. A transform algebra for every exposed primitive, including positions,
   ordered endpoints, tangent frames, patch normals, and local rotations.
2. A semantic orientation descriptor for ports and directed network elements.
3. Segment and port polarity mapping under endpoint reversal.
4. Handedness behavior:
   - proper rotations preserve helix handedness;
   - reflections have determinant `-1` and reverse chirality; and
   - a reflected right-handed helix must match an explicitly described
     left-handed counterpart, not the original pattern by name alone.
5. Canonical transformed-pattern fingerprints and a one-to-one match against
   the full caller description.
6. Full-versus-generated current, Z, power, and complex-field tests for both
   right- and left-handed helices.
7. Explicit review of the existing native reflection code for wire endpoint
   order and patch `psalp`/tangent handling.

Until those conditions have their own DoD, no `unsafeAssumeInvariant` escape
hatch should be added to the public API.

## 10. Native and ABI design

### 10.1 Native stateful descriptor

Add a native descriptor equivalent to:

```cpp
enum class nec_geometry_symmetry_kind {
  none = 0,
  reflection = 1,
  rotational = 2,
};

struct nec_geometry_symmetry {
  nec_geometry_symmetry_kind kind = nec_geometry_symmetry_kind::none;
  uint32_t reflection_plane_mask = 0; // X=1, Y=2, Z=4
  int rotational_order = 1;
  int tag_increment = 0;
};

struct nec_geometry_completion_result {
  nec_geometry_symmetry symmetry;
  int section_count = 1;
  int64_t fundamental_segment_count = 0;
  int64_t full_segment_count = 0;
};
```

WP-S0 added these definitions to `nec_stateful_model.h`, including the stable
`nec_reflection_plane_x/y/z` bit values. The behavior overload remains WP-S1
and WP-S2 work; the data format is no longer provisional.

`nec_stateful_model::complete_geometry()` should accept an optional descriptor,
validate it while still in geometry-building state, call the existing geometry
generator, complete geometry, store immutable completion metadata, and return
that metadata.

Keep the existing overload for native source compatibility.

### 10.2 Preflight and failure safety

The public path must validate before resizing and partially writing generated
arrays wherever practical:

- plane mask/order/tag increment;
- segment/patch fixed-plane and crossing rules;
- rotational fixed-axis collisions;
- integer multiplication and allocation sizes;
- generated tag uniqueness and `int32_t` range; and
- ground-connection incompatibility known at completion time.

Refactor expected validation out of the mutation loop in
`c_geometry::reflect_plane()`. An expected invalid input must not leave half of
the copies written. Geometry-completion failures unrelated to symmetry should
retain the current model's documented failure semantics unless transactional
completion is implemented for all geometry.

### 10.3 C/WASM ABI

Retain `necpp_wasm_v1_complete_geometry(model, ground_connection)` and add an
entry point such as:

```c
int32_t necpp_wasm_v1_complete_geometry_symmetric(
  necpp_wasm_v1_model* model,
  int32_t ground_connection,
  int32_t symmetry_kind,
  int32_t parameter,       /* plane mask or rotational order */
  int32_t tag_increment);
```

Add read-only metadata getters for kind, section count, fundamental segment
count, and full segment count. Copy transforms are deterministic from the
accepted descriptor and need not be stored as ABI arrays.

This is additive to the v1 symbol set. Update:

- the public C header and C++ implementation;
- native C and C++ ABI contract tests;
- Emscripten `EXPORTED_FUNCTIONS`;
- the handwritten private `NecWasmModule` interface;
- smoke tests and generated/module declaration expectations; and
- package manifest/packed artifact tests that enumerate exports.

Do not expose C++ containers, pointers to mutable geometry, or a JSON boundary.

## 11. Equivalence test matrix

Correctness gates precede performance measurements. Every comparison must
first reject NaN/infinity and assert dimensions, order, port metadata,
frequency, and state generations exactly.

### 11.1 Numerical comparison metrics

For a complex vector or matrix `a` and baseline `b`, calculate both:

```text
relativeL2 = ||a-b||2 / max(||b||2, absoluteFloor)
scaledMax  = max_i |a_i-b_i| / max(max_i |b_i|, absoluteFloor)
```

Use the existing repository tolerance policy as the starting point:

- exact-coordinate full-versus-symmetric Z/Y: `relativeL2 <= 1e-8` and
  `scaledMax <= 1e-8`;
- port voltages, currents, active impedance, and powers: `1e-8` scaled;
- exact-coordinate full-versus-symmetric complex far fields: `1e-8` scaled;
- native-to-WASM and direct-to-worker bulk copies: `1e-12`; and
- symmetry metadata, gather maps, axes, array lengths, state, and generation
  counters: exact.

If a fixture requires a looser bound, the test must document the measured
cause and may not exceed the independent NEC golden-value ceiling without a
design review. Never compare only magnitudes when complex values are available.

### 11.2 Required geometry/environment cases

| Case | Size/order | Environment | Purpose |
|---|---:|---|---|
| R1 | 2 x 2, X/Y reflection | perfect ground | smallest four-section smoke case |
| R2 | 4 x 4, X/Y reflection | perfect ground | full Z and beam-steering canonical case |
| R3 | 8 x 8, X/Y reflection | perfect ground | larger gathered-Z scheduled/CI case |
| R4 | 4 x 4, X reflection only | perfect ground | two-section mapping |
| R5 | 2 x 2 fundamental with X/Y/Z reflection | free space only | eight-section native coverage using geometry that does not cross planes |
| T1 | order 2 | perfect ground | rotational transform and mapping smoke case |
| T2 | order 4 square/ring-compatible array | perfect ground | C4 rotational equivalence |
| T3 | order 6 ring | free space and one homogeneous ground case | non-power-of-two Fourier modes |
| G1 | 4 x 4, X/Y reflection | finite reflection-coefficient ground | non-perfect ground equivalence |
| N1 | 3 x 3 | perfect ground | fixed-plane/axis explicit fallback |
| O1 | 4 x 4, nonzero XY center | perfect ground | recenter plus complex far-field rephasing |
| E1 | 4 x 4 with epsilon jitter | perfect ground | disclosed canonicalization |
| P1 | 4 x 4 helix pattern | perfect ground | required unsupported-pattern fallback |

The Z-directed reference dipole is used for R1-R4, G1, N1, O1, and E1. R5
needs a separate octant fixture whose individual segments do not cross any
generating plane. T1-T3 need geometry with complete free orbits and no element
on the rotation axis.

### 11.3 Gathered Z/Y equivalence

For R1, R2, R3, R4, T1-T3, G1, and O1:

1. Build the full explicit baseline with ports in caller order.
2. Build the manual or transparent symmetric candidate.
3. Define candidate native ports in a deliberately non-caller order at least
   once, so the gather test cannot pass trivially.
4. Compute complete complex Z and Y matrices for both models.
5. Gather candidate rows and columns into caller order.
6. Compare every complex entry using both metrics above.
7. Assert `Z*Y` is identity within the existing conditioning tolerance.
8. Assert reciprocity independently where the fixture is reciprocal.
9. Verify a few named mutual-impedance entries whose physical element pairs
   are related by reflection/rotation.
10. Confirm the baseline has section count one and the candidate reports the
    expected fundamental/full segment counts.

R3 may run in a scheduled or performance job if complete 64-port extraction is
too expensive for every pull request. R1 and R2 are mandatory in ordinary CI.

### 11.4 Canonical beam-steering cases

Use `solveCurrents()` so both models realize the same requested port currents.
For a target direction `(theta0, phi0)` and element position `r_n`, use the
repository's `exp(+j*omega*t)` / `exp(-j*k*R)` convention:

```text
I_n = amplitude_n * exp(-j * k * dot(u(theta0,phi0), r_n))
```

Required current-weight cases for the 4 x 4 reference array:

1. uniform amplitude and phase;
2. steer on a `theta=60 deg` azimuth cut toward `phi=0 deg` (+X);
3. steer on the same cut toward `phi=90 deg` (+Y);
4. steer toward `theta=50 deg, phi=45 deg` (diagonal); and
5. one deterministic asymmetric amplitude taper plus progressive phase to
   prove that the excitation itself need not share structural symmetry.

For each case:

- compare required voltages, achieved currents, active impedances, and powers;
- compute a combined far-field grid with theta and phi coverage above ground;
- compare all complex `E_theta` and `E_phi` samples after center rephasing;
- compare total field magnitude derived from the complex components;
- compare normalized cuts, peak sample index, peak magnitude, and phase at the
  intended steering sample;
- require the full and symmetric peak directions to agree to the exact grid
  sample; and
- separately sanity-check that the relevant baseline cut places its main lobe
  at or near the requested azimuth. Lock the allowable grid-cell offset only
  after measuring the baseline, because the element/ground pattern can shift
  an elevation maximum.

Run the same weights through unit-current embedded far fields and JavaScript
superposition. The directly solved field and the superposed basis field must
agree for each model, and the gathered symmetric bases must agree with the
explicit bases in caller port order.

### 11.5 Epsilon and rejection cases

Add pure planner and end-to-end cases for:

- exact coordinates with `epsilon=0`;
- caller input randomly permuted while producing identical canonical geometry
  and mappings by caller ID;
- deterministic XY jitter bounded by `1e-10*lambda`, accepted with every
  adjustment reported;
- original jittered explicit model versus canonical symmetric model, with
  fixture-specific Z/field bounds measured and locked no looser than `1e-7`
  unless evidence justifies otherwise;
- one partner displaced just beyond epsilon, causing explicit fallback;
- two points both within epsilon of one target, causing ambiguous-match
  fallback;
- an even grid with one mismatched pattern ID;
- an odd grid with fixed elements;
- a non-homogeneous or otherwise incompatible environment once such an
  environment exists in the public description;
- an asymmetric load orbit rejected no later than `prepare()`;
- a complete symmetric load orbit accepted; and
- helix, tilted-wire, off-axis-wire, endpoint-swap-only, and rotated-pattern
  prohibitions.

## 12. Benchmark plan

### 12.1 Benchmark representations

Extend the process-isolated WASM array benchmark with three stateful
representations of the same reference array:

- `explicit`: all `n*n` dipoles, no symmetry;
- `manual-reflection`: one quadrant plus explicit X/Y symmetry options; and
- `auto-reflection`: full caller description analyzed by the transparent
  symmetrizer, then built from the accepted plan.

The benchmark must compare numerical checksums or selected full results before
reporting a speedup. A fast wrong model is a failed case.

Keep the existing deck benchmark as historical coverage, but do not use
formatted report values as the oracle for the new binary64 equivalence gate.

### 12.2 Sizes and workloads

Use even sides:

```text
2, 4, 8, 12, 16
```

At 11 segments per dipole the full equation counts are:

```text
44, 176, 704, 1,584, 2,816
```

Measure these phases independently:

- module creation;
- transparent analysis/canonicalization;
- geometry and port construction;
- geometry completion/symmetry expansion;
- `prepare()` allocation, fill, symmetry combination, and factorization when
  phase metrics become available;
- one `solveCurrents()` beam-steering solve;
- retained solves with changed weights;
- combined far-field calculation on a fixed grid;
- complete Z gathering for 2 x 2 and 4 x 4 in the normal benchmark;
- optional/scheduled complete Z gathering for 8 x 8; and
- peak WASM memory or allocated matrix bytes.

Do not make 16 x 16 full-Z extraction a prerequisite for the ordinary
preparation benchmark. A 256-port basis extraction measures a different
workload and can hide the matrix-factorization gain that symmetry is intended
to expose.

### 12.3 Measurement discipline

- Run every representation/size/round in a fresh process.
- Use at least three measured rounds; report median, min, max, and failures.
- Compare representations built from the same package artifact and process
  settings.
- Record OS, CPU, Node, Emscripten, engine/package versions, commit, worktree
  status, frequency, geometry, ground, segment count, grid, and tolerance.
- Emit NDJSON incrementally and an adjacent summary JSON, preserving completed
  cases after a later trap or timeout.
- Separate correctness failure, timeout, WASM trap, allocation failure, and
  numerical-conditioning failure.
- Keep import time outside comparable cold totals, matching the existing
  benchmark convention.
- Report transparent planner time separately and as a percentage of total cold
  time.

### 12.4 Performance gates

Correctness gates are mandatory. Performance gates are same-host ratios, not
absolute wall-clock promises:

- the 16 x 16 manual-reflection median `prepare()` time should be at least 8x
  faster than the explicit median on the reference single-thread WASM artifact;
- `auto-reflection` preparation after planning should be within 5% of
  `manual-reflection` at 8 x 8 and larger;
- transparent planning should remain below 5% of `auto-reflection` cold time at
  8 x 8 and larger and should be reported in milliseconds for small arrays;
- symmetric matrix storage should be close to the theoretical fourfold
  reduction for two reflection planes;
- explicit no-symmetry `prepare()` must not regress by more than 5% versus the
  pre-feature artifact on the same benchmark protocol; and
- if the 8x target is missed while correctness passes, retain the feature but
  do not claim the target: record phase metrics and open a bounded follow-up
  before changing the gate.

The previous free-space 16 x 16 experiment achieved about 11.5x cold-deck
speedup. It is evidence for priority, not a substitute for the new over-ground
stateful benchmark.

## 13. Sequential work packages

### Work package status table

Every agent updates this table and the detailed WP section before handing off.

| WP | State | Owner/agent | Evidence/commit | Notes for next agent |
|---|---|---|---|---|
| WP-S0 Contract and shared fixtures | complete | Codex | Native `[wp_s0]`: 15 assertions; `necpp_unit`: 1/1; npm: 38/38 + typecheck | Preserve the finalized descriptor values, branded rotational order, Z/Y/X copy order, and golden scatter/gather maps. |
| WP-S1 Native geometry safety and metadata | complete | Codex | Native `[wp_s1]`: 291 assertions; aggregate: 1,044; 52/52 legacy decks matched; npm: 38/38 | WP-S2 must call `c_geometry::generate_symmetry()` and consume its immutable result instead of reading geometry arrays. |
| WP-S2 Stateful symmetry and validation | complete | Codex | Native `[wp_s2]`: 10,599 assertions; direct WP1-WP4 regressions and npm 38/38 | WP-S3 should call the symmetric overload, then expose only `geometry_completion()` metadata through additive ABI getters. |
| WP-S3 Additive C/WASM ABI | complete | Codex | Native `[wp_s3]`: 8 assertions/2 cases plus pure-C contract; CTest 8/8; WASM smoke; npm 38/38; pack 5/5; browser 3/3 | WP-S4 should convert the private WASM `bigint` segment counts to checked safe numbers and derive copy transforms from the validated descriptor. |
| WP-S4 Direct and worker TypeScript API | complete | Codex | npm/WASM: 46/46; pack: 5/5; browser: 3/3; native ABI: 8 assertions | WP-S5 may use only the exported descriptors, immutable completion metadata, typed failure details, and direct/worker methods; private ABI `bigint` values never escape. |
| WP-S5 Transparent symmetrizer | complete | Codex | npm/WASM: 60/60; pack: 5/5; browser: 3/3; focused WP-S5: 14/14 | WP-S6 can consume the public facade without plan-kind branches; caller-order tags, ports, vectors, matrices, and field bases are representation-independent. |
| WP-S6 End-to-end equivalence suite | complete | Codex | Focused WP-S6: 8/8; npm/WASM: 68/68 + typecheck; native `[wp_s2]` 10,599 and `[wp_s3]` 8 assertions | WP-S7 should reuse the reference fixture, caller-order checks, complex metrics, and ordinary 8 x 8 R3 gate before reporting performance. |
| WP-S7 Benchmarks and performance gates | complete | Codex | 45/45 isolated current cases; 30/30 binary64 comparisons; 16 x 16 prepare 11.55x; matrix 4.00x | WP-S8 may claim only the measured matrix-scale results; the explicit 2 x 2 pre-feature regression gate remains a documented miss. |
| WP-S8 Public documentation, examples, and release hardening | complete | Codex | npm/WASM 69/69 + typecheck; pack 5/5; browser 3/3; native Release partitions pass | WP-S9 should only assign versions/date, rebuild identities, rerun this checklist, and inspect the final tarball. |
| WP-S9 Final version bump and release identity | complete | Codex | native Release + 8 partitions; npm/WASM 69/69 + pack 5/5; browser 3/3; final tarball inspected | Symmetry support is release-ready at package 0.2.0, engine 2.4.0, and ABI 1; publishing/tagging remains a separately authorized action. |

Allowed states are `not started`, `in progress`, `blocked`, and `complete`.
`complete` requires the WP's DoD, not merely code that compiles.

### WP-S0 — Contract and shared fixtures

Dependencies: none.

Deliverables:

- finalize public names and lifecycle behavior in this document;
- add native and TypeScript symmetry contract types without implementation, if
  the repository's normal interface-first workflow requires it;
- define error/status classification for invalid symmetry, incompatible ground,
  incomplete load orbit, and unsupported pattern transform;
- implement or specify one shared reference-array fixture generator with the
  exact formulas in Section 7;
- define caller order, generated order, scatter/gather conventions, and copy
  transforms as executable data fixtures;
- decide whether shared cross-language fixture data is generated JSON, a small
  language-neutral table, or parallel helpers checked against common golden
  coordinates; and
- update `docs/wasm-api.md` lifecycle and operation tables in draft form.

DoD:

- TypeScript compile-valid and compile-invalid contract tests cover every new
  public discriminant and reject arbitrary axes/empty planes/order < 2;
- a 4 x 4 fixture has exact golden caller coordinates, quadrant coordinates,
  generated transforms, tags, and gather maps;
- the fixture proves lower and upper wire Z coordinates are `lambda/12` and
  `5*lambda/12`;
- no unresolved API naming, units, ownership, or failure-state TODO remains;
- existing public consumers still typecheck when ignoring the new completion
  return value; and
- this WP records exact commands and results in its status row/notes.

Handoff focus: WP-S1 should be able to implement native behavior without
inventing a second metadata format.

Completion evidence (2026-08-30, Windows/MSVC):

- Baseline before edits: `npm --prefix packages/necpp-wasm run typecheck` —
  passed.
- `npm --prefix packages/necpp-wasm test` — passed 38/38 Node tests and the
  strict TypeScript compile-valid/compile-invalid contract suite.
- `npm --prefix packages/necpp-wasm run build` — emitted declarations and
  assembled `dist` successfully (WASM 698667 bytes, loader 77177 bytes).
- The shell did not have `cmake` on `PATH`; the existing build cache identified
  `C:\Users\andre\AppData\Local\Temp\codex-necpp-cmake\cmake\data\bin\cmake.exe`.
  Running that executable with `--build build-wp0 --config Release` completed.
  Existing MSVC conversion/unknown-pragma warnings remained; no new build error
  occurred.
- The paired cached `ctest.exe --test-dir build-wp0 -C Release -R necpp_unit
  --output-on-failure` passed 1/1 tests.
- `build-wp0\tests\Release\nec2++_tests.exe "[wp_s0]"` passed 15 assertions in
  one native contract test.
- `git diff --check` passed; line-ending notices are repository checkout-policy
  warnings, not whitespace errors.

Contract decisions for WP-S1 and later:

- Native kind values are none/reflection/rotational = 0/1/2; reflection plane
  mask bits are X/Y/Z = 1/2/4. The descriptor and completion metadata in
  `nec_stateful_model.h` are the implementation format.
- TypeScript uses `rotationalOrder()` because structural TypeScript cannot
  express an arbitrary integer `>= 2`; raw order numbers are deliberately not
  accepted. Reflection planes are a nonempty tuple.
- Ordinary direct and worker completion now returns `{}` as a
  `GeometryCompletionResult`, so callers that ignore the former `void` result
  remain source-compatible. Passing `symmetry` is intentionally rejected by
  the WP-S0 runtime stub until the native/ABI/facade work packages implement it.
- The 4 x 4 JSON table is the cross-language golden. The JavaScript fixture is
  the single correctness/benchmark generator and uses the engine-derived
  speed of light, positive-Z over-ground wires, and exact Section 7 dimensions.
- Reflection copy order is fixed by NEC passes, not caller plane-list order:
  fundamental, Y, X, XY for the 4 x 4 quadrant. Port/vector scatter is
  caller-to-native; gather is its native-to-caller inverse.

### WP-S1 — Native geometry safety and metadata

Dependencies: WP-S0.

Deliverables:

- add native symmetry descriptor/completion metadata structures;
- refactor plane and rotational preflight validation ahead of mutation;
- expose deterministic copy count/order and fundamental/full segment counts;
- validate size arithmetic, tags, plane crossings/fixed geometry, and rotational
  collisions;
- retain legacy `GX`/`GR` deck semantics and regression outputs;
- add focused `c_geometry` tests for one/two/three planes and rotational orders
  2, 4, and 6; and
- document any native behavior found to differ from the NEC manual before
  changing it.

DoD:

- valid legacy GX/GR decks and the full existing testharness still pass;
- expected invalid reflection/rotation inputs fail before generated array
  mutation is observable;
- one/two/three-plane copy order, coordinates, tags, `np`/`mp`, and `m_ipsym`
  have exact assertions;
- rotational coordinates/tags and Fourier section count have exact assertions
  for a non-power-of-two order;
- integer overflow and allocation-size checks have controlled tests;
- sanitizer/bounds-check builds report no generated-geometry errors; and
- native comments use plane terminology consistently with the public contract.

Handoff focus: WP-S2 consumes native descriptors and must not call private
geometry arrays directly.

Completion evidence (2026-08-30, Windows/MSVC):

- Baseline before edits:
  `build-wp0\tests\Release\nec2++_tests.exe "[symmetry]" --reporter compact`
  passed 47 assertions in four cases.
- A fresh bounds-checked test build was configured with the available CMake
  3.31.6 executable and the already-fetched Catch2 source, then
  `cmake --build build-wps1 --config Release --target nec2++_tests` passed.
- `build-wps1\tests\Release\nec2++_tests.exe "[wp_s1]" --reporter compact`
  passed 291 assertions in four cases. Coverage includes exact one-, two-, and
  three-plane order and metadata; rotational orders 2, 4, and 6; expected
  preflight failures; malformed descriptors; tag collision/overflow; count
  overflow; and allocation-size rejection.
- The bounds-checked aggregate passed 1,044 assertions in 82 cases. Direct
  WP1/WP2/WP3/WP4 runs passed 54/66/206/59 assertions respectively, and the
  executable smoke script found `TOTAL RUN TIME` in a real dipole report.
- The temporary CTest launcher hung on WP1 despite the same Catch binary
  passing all seven WP1 cases in 0.05 seconds when invoked directly. The direct
  per-group commands above are the authoritative results; this was a launcher
  issue rather than a test failure.
- All 52 `testharness/data/*.nec` decks were run through both the committed
  pre-WP-S1 Release binary and the WP-S1 Release binary. Exit statuses matched,
  and `nec2diff` reported zero antenna-input, power-budget, and radiation-input
  differences for every deck, including all GX/GR cases.
- `cmake --build build-wps1 --config Release` passed. Existing MSVC narrowing
  and unknown-GCC-pragma warnings remain; WP-S1 introduced no compiler error.
- `npm --prefix packages/necpp-wasm test` passed 38/38 Node tests and strict
  TypeScript typechecking. `git diff --check` passed.
- No legacy GX/GR field semantics or NEC-manual behavior was deliberately
  changed. Legacy zero tag increments remain accepted; the strict native
  descriptor requires a positive increment and unique generated nonzero tags.

Contract decisions for WP-S2 and later:

- The stable descriptor/result types live in the installed
  `nec_geometry_symmetry.h`; `nec_stateful_model.h` re-exports them by include.
- `c_geometry::generate_symmetry()` is the strict native handoff. It validates
  descriptors, sizes, tags, coordinate-plane conflicts, and rotational
  duplicate elements before changing geometry counts or generated arrays.
- Legacy `reflect()`/GX/GR uses the same geometry and size preflight while
  retaining legacy tag-group semantics and exact numerical output.
- Reflection copies remain ordered by Z, then Y, then X generation passes.
  Rotation copies remain increasing `2*pi/order` about global Z; `np`, `mp`,
  and `m_ipsym` continue to be the solver's Fourier metadata.

### WP-S2 — Stateful symmetry and structural validation

Dependencies: WP-S1.

Deliverables:

- extend `nec_stateful_model::complete_geometry()` with optional symmetry while
  retaining the existing overload;
- store immutable completion metadata and expose read-only accessors;
- enforce geometry-building lifecycle and prohibit post-symmetry additions;
- connect symmetric completion to the existing retained factorization path;
- implement or stage load-orbit storage/validation at `prepare()`;
- reject ground configurations that invalidate the selected structural
  symmetry;
- preserve arbitrary port order and arbitrary simultaneous source weights; and
- add native full-versus-symmetric Z, solve, and far-field tests for the small
  reference cases.

DoD:

- R1, R2, R4, T1, T2, and one finite-ground case pass native equivalence gates;
- an intentionally asymmetric excitation passes equivalence, proving source
  weights are not incorrectly validated as structure;
- incomplete and unequal load orbits fail before matrix results are published;
- complete load orbits and all-segment scalar loads pass;
- `z=0` reflection plus ground fails clearly while X/Y reflection and Z-axis
  rotation over ground remain valid;
- factorization generation and consumer-solution restoration retain existing
  behavior; and
- no formatted report parsing appears in a stateful correctness test.

Completion evidence (2026-08-30, Windows/MSVC):

- A clean bounds-checked test target was rebuilt with
  `cmake --build build-wps1 --config Release --target nec2++_tests
  --clean-first`; the build passed with only the repository's existing MSVC
  conversion and unknown-pragma warnings.
- `build-wps1\tests\Release\nec2++_tests.exe "[wp_s2]" --reporter
  compact` passed 10,599 assertions in five cases. The suite compares gathered
  binary64 Z/Y matrices, asymmetric current solves, all port quantities, and
  complex far fields for R1, R2, R4, T1, T2, and G1. It also covers immutable
  metadata, retry after descriptor preflight failure, post-completion mutation,
  incomplete/unequal/complete/all-segment loads, and ground compatibility.
- The pre-existing stateful partitions passed from the clean binary when run
  directly: WP1 non-stress 49 assertions plus its isolated 1,000-solve stress
  case 5 assertions; WP2 66; WP3 206; and WP4 59. Keeping the WP1 stress case
  in a separate process avoids the Windows CTest accumulated-context launcher
  stall already recorded by WP-S1.
- The focused CTest regression command selecting `necpp_unit`, `necpp_wp_s2`,
  and `necpp_smoke_hertzian_dipole` passed 3/3. Attempts to run every older
  stateful partition in one CTest invocation reproduced the existing Windows
  launcher instability (one accumulated WP1 timeout and, on a later run, a WP2
  process fault); the same Catch cases passed from the clean binary as listed
  above, so no numerical or assertion failure was skipped silently.
- After the clean target, prebuilding `necpp_static` and running
  `cmake --build build-wps1 --config Release` completed the full native build.
  This ordering avoids the existing clean MSVC shared/static import-library
  filename race; incremental full builds also pass.
- `npm --prefix packages/necpp-wasm test` passed all 38 Node tests and strict
  TypeScript typechecking.

Contract decisions for WP-S3 and later:

- The source-compatible `void complete_geometry(connection)` overload remains.
  The new descriptor overload returns a stable const reference, and
  `geometry_completion()` is the sole read-only stateful metadata accessor.
- Symmetric completion calls WP-S1's strict `generate_symmetry()` before the
  ordinary geometry completion path. Expected descriptor and ground-connection
  failures therefore leave the model in geometry-building state and retryable.
- Load definitions are retained and validated at `prepare()` as exact multisets
  on corresponding generated segment orbits. Complete per-copy definitions and
  an all-segment scalar load pass; missing or unequal copy definitions fail
  before factorization or matrix publication.
- Structural `z=0` reflection rejects a non-none ground connection and every
  non-free-space ground model. X/Y reflections and Z-axis rotations retain
  perfect and homogeneous finite-ground support.
- Port definitions, requested source order, and simultaneous complex weights
  are not treated as structural symmetry. The native solver continues to
  preserve arbitrary port order and asymmetric excitations through its retained
  factorization path.

Handoff focus: WP-S3 gets a complete native API with stable result ownership.

### WP-S3 — Additive C/WASM ABI

Dependencies: WP-S2.

Deliverables:

- add the symmetric-completion C function and metadata getters;
- map lifecycle, input, geometry, and solver failures to the existing stable
  status taxonomy;
- update native C and C++ ABI tests;
- update Emscripten exported symbols and the private module declaration;
- update WASM smoke tests and packed-artifact export assertions; and
- verify old consumers calling only the original v1 functions remain valid.

DoD:

- pure C compilation and execution cover valid reflection, valid rotation, and
  each primary error class;
- native C++ ABI tests compare returned metadata with the stateful object;
- WASM smoke tests build a symmetric 2 x 2 reference case and return finite
  results;
- missing/incorrect exports fail an automated manifest or smoke assertion;
- no ABI getter returns a pointer whose lifetime is ambiguous; and
- ABI version policy is documented: additive v1 symbols do not silently change
  existing signatures or enum values.

Completion evidence (2026-08-30, Windows/MSVC and Emscripten 4.0.7):

- A clean bounds-checked native test executable was rebuilt with the Visual
  Studio `nec2++_tests.vcxproj` `Rebuild` target. The initial incremental/LTCG
  binary reproduced the repository's known Windows `SIGILL` behavior in the
  first isolated WP-S2 lifecycle case; the clean rebuild removed it, and the
  isolated lifecycle, load, and ground cases plus the full 10,599-assertion
  `[wp_s2]` partition then passed.
- `build-wps1\tests\Release\nec2++_tests.exe "[wp_s3]" --reporter compact`
  passed eight Catch assertions in two cases. Its separately C-compiled
  contract function returned success after checking valid two-plane reflection,
  valid order-four rotation, ordinary-completion metadata, null/unavailable
  getter sentinels, and controlled lifecycle, input, geometry, incomplete-load,
  and incompatible-ground failures.
- The full serial CTest run passed 8/8 registered tests, including WP1 through
  WP4, WP-S2, the new WP-S3 partition, the aggregate native suite, and the
  command-line smoke test. The full native Release `ALL_BUILD` target also
  completed; its warnings were the existing conversion and unknown-pragma
  warnings.
- `scripts\build_wasm_docker.ps1` rebuilt the module with the pinned
  `emscripten/emsdk:4.0.7` image. `scripts/wasm_smoke_test.mjs` verified every
  additive export and built the shared over-ground 2 x 2 reference array from
  one positive-XY wire; its four-port Z matrix, asymmetric solve, and complex
  far field were finite.
- The Docker build's `npm --prefix packages/necpp-wasm run test:wasm` gate
  passed 38/38 Node tests plus strict typechecking and 5/5 packed-consumer
  tests. The packed loader assertion names every new symbol. A fresh local
  tarball also passed the direct, worker, and example browser integration
  modes. Generated WASM artifacts remain intentionally ignored by source
  control and were not added to the commit.

Contract decisions for WP-S4 and later:

- ABI version remains `1`. The original completion function, all prior
  signatures, status values, and enum values are unchanged; symmetry is
  exposed only through additive v1 symbols.
- Completion metadata uses scalar getters. Segment counts remain signed
  64-bit in C and therefore appear as `bigint` at the private Emscripten
  boundary; WP-S4 must range-check before converting them to public TypeScript
  `number` values. No new getter returns a borrowed pointer.
- The ABI stores a plain copy obtained from the stateful
  `geometry_completion()` accessor. Before successful completion, kind is
  `-1` and the other scalar getters return zero. Copy transforms are not ABI
  arrays; WP-S4 derives them deterministically from the descriptor it already
  validated and supplied.
- Symmetry configuration failures raised while preparing, including incomplete
  or unequal load orbits, have a native geometry-exception classification so
  they map to `NECPP_WASM_V1_GEOMETRY_ERROR` rather than being mislabeled as
  numerical solver failures.

Handoff focus: WP-S4 should only translate/validate data and must not reproduce
native electromagnetic logic.

### WP-S4 — Direct and worker TypeScript API

Dependencies: WP-S3.

Deliverables:

- implement `GeometrySymmetry`, completion result, copy metadata, and validation
  in the direct facade;
- add corresponding worker operation typing, runtime dispatch, client method,
  progress event, structured-clone handling, and result revival;
- update lifecycle transitions and errors;
- snapshot/freeze returned metadata consistently with existing port metadata;
- update root and worker exports plus generated declaration tests; and
- document explicit fundamental-section construction with the 4 x 4 reference
  array.

DoD:

- facade-mapping tests assert every native argument and returned copy transform;
- direct and worker results agree to `1e-12` on R1 including gathered Z and one
  far-field grid;
- invalid plane lists, duplicate planes, unsafe integers, tag overflow, and
  rotational order fail as typed `NecInputError`/`NecGeometryError` cases;
- worker progress and cancellation behavior remain deterministic;
- packed Node consumer and browser integration exercise at least one symmetry
  operation; and
- old direct/worker examples still compile and run while ignoring completion
  metadata.

Handoff focus: WP-S5 may depend only on public TypeScript types/methods, not the
private WASM module.

Completion evidence (2026-08-30, Windows, Node 24.14.1, TypeScript 5.8.3,
Chromium through Playwright, and the WP-S3 Emscripten artifact):

- `npm --prefix packages/necpp-wasm run test:wasm` passed 46/46 Node tests,
  strict declaration/type tests, and 5/5 packed-consumer tests. The mapping
  tests cover every reflection bit, both symmetry kinds, every native argument,
  fixed Z/Y/X copy order, rotational angles, deep freezing, invalid/duplicate
  descriptors, tag overflow, incompatible ground, and checked `bigint` segment
  counts.
- The real-WASM R1 direct/worker test built the shared over-ground 4 x 4 model
  from its positive quadrant. Completion metadata agreed exactly; gathered
  complex Z and an asymmetrically excited complex far-field grid agreed within
  `1e-12`. An incomplete load orbit retained `NEC_GEOMETRY` plus
  `INCOMPLETE_LOAD_ORBIT` through worker serialization.
- Packed direct and worker Node consumers both completed a two-plane reflection
  and observed four sections. Every npm README TypeScript example compiled
  against emitted declarations, while the unchanged ordinary direct/worker
  examples continued to run while ignoring completion metadata.
- `npm --prefix packages/necpp-wasm run test:browser -- direct`, `worker`, and
  `example` passed against the tested tarball. Direct and worker browser modes
  exercised two-plane reflection; existing progress, serialization,
  termination, and cancellation tests remained deterministic.
- `build-wps1\tests\Release\nec2++_tests.exe "[wp_s3]" --reporter compact`
  passed 8 assertions in 2 cases. A full CTest rerun was not required for this
  TypeScript-only WP and the standalone `ctest` command was unavailable in the
  active PowerShell PATH; WP-S3's recorded 8/8 CTest evidence remains the
  native baseline.

Contract decisions for WP-S5 and later:

- Runtime validation occurs before the additive completion call. Reflection
  plane-list order never changes native Z/Y/X copy order, and generated tag
  arithmetic is checked with `bigint` before it can overflow signed 32-bit
  tags.
- Native signed-64-bit segment counts are accepted only when they convert to
  safe public JavaScript integers. Direct metadata and worker-revived metadata
  are deeply frozen, structured-cloneable snapshots containing no native
  pointers or private module values.
- Structural `z=0` reflection/ground conflicts report
  `INCOMPATIBLE_GROUND`; prepare-time asymmetric loads report
  `INCOMPLETE_LOAD_ORBIT`. Invalid descriptors report `INVALID_SYMMETRY`
  without mutating geometry.

### WP-S5 — Transparent symmetrizer

Dependencies: WP-S4.

Deliverables:

- implement pure description validation, center selection, spatial matching,
  candidate enumeration, orbit formation, canonicalization, and diagnostics;
- implement deterministic fundamental representative and tag allocation;
- implement explicit fallback plans;
- implement model/worker plan application adapters;
- implement the representation-independent `NecArraySolver` facade and factory
  so application code never branches on the plan kind;
- implement caller/native port scatter, vector gather, matrix row/column gather,
  embedded-basis gather, and far-field center rephasing;
- implement the conservative pattern capability verifier; and
- add unit/property-style tests for input permutations, epsilon boundaries,
  ambiguity, odd arrays, pattern mismatch, and all required prohibition cases.

DoD:

- exact even 2 x 2, 4 x 4, and 8 x 8 grids select two-plane reflection with the
  expected four-section plan;
- exact odd 3 x 3 and 5 x 5 grids select explicit fallback with fixed-element
  reasons;
- input permutation does not change canonical coordinates or ID-based mapping;
- epsilon jitter acceptance reports every adjustment and rejects the first
  beyond-epsilon/ambiguous case deterministically;
- off-origin field rephasing passes an executable complex-field sign test;
- gathered synthetic vectors/matrices/bases pass exact index tests before any
  solver is involved;
- one compile-time and runtime consumer test executes the same unbranched
  prepare/Z/solve/far-field code with `symmetry: "off"` and `symmetry: "auto"`;
- ordinary Z, solution, combined-field, and embedded-field return objects have
  identical public shapes for explicit and symmetric representations;
- no generated tag, copy index, or fundamental-section port order leaks through
  an ordinary numerical result;
- a helix and every other prohibited pattern can never produce a symmetric
  plan; and
- planner diagnostics are structured-cloneable and contain no functions or
  cyclic objects.

Handoff focus: WP-S6 combines public planner and engine paths and should not
patch around mapping failures in test code.

Completion evidence (2026-08-30, Windows, Node 24.14.1, TypeScript 5.8.3,
Chromium through Playwright, and the WP-S3 Emscripten artifact):

- `npm --prefix packages/necpp-wasm run test:wasm` passed 60/60 Node tests,
  strict declaration/type tests, and 5/5 packed-consumer tests. The 14 focused
  WP-S5 cases cover exact 2 x 2, 4 x 4, and 8 x 8 reflection plans, odd-grid
  fixed-element fallback, exact cardinal rotation, permutation invariance,
  epsilon adjustment reporting, outside-epsilon and ambiguous rejection,
  pattern mismatch, every first-release pattern prohibition, preservation of
  unsupported local rotation in the explicit fallback, synthetic gather maps,
  direct plan application, the unbranched facade, and the off-origin complex-
  field phase-sign proof.
- `npm --prefix packages/necpp-wasm run pack:release -- .pack-work` produced
  `necpp-engine-wasm-0.1.1.tgz`, 327,294 bytes, SHA-256
  `80dbd4c3ffb450cadef9c93909f0e1a99ae513ad14572570806f04c042718afa`.
  With `NECPP_WASM_TARBALL` set to that artifact, `npm --prefix
  packages/necpp-wasm run test:browser -- direct`, `worker`, and `example` all
  passed.
- The first restricted-sandbox pack and browser attempts failed only because
  npm could not write its cache below `%LOCALAPPDATA%`. The unchanged commands
  passed after granting the test processes the required cache/temp access; no
  source or assertion was changed in response.
- Native tests were not rerun because WP-S5 changes only the public TypeScript
  planning/facade layer and consumes the already-tested WP-S4 API. The full
  package run exercised the real WP-S3 WASM binary through direct, worker,
  packed Node, Vite, and browser paths.

Contract decisions for WP-S6 and later:

- `analyzeArraySymmetry()` remains pure and requires an explicit finite,
  nonnegative `positionEpsilonM`. Since `createNecArraySolver()` defaults to
  `"auto"`, callers selecting auto/require must supply symmetrizer options;
  `"off"` needs no tolerance and constructs the unchanged explicit model.
- Automatic rotation enumeration tests divisors from largest to smallest and
  caps inferred order at 64; configured branded orders are tested explicitly.
  Equal-section candidates prefer reflection, then the stable documented
  plane/order sequence.
- Symmetric fundamental XY coordinates are centered model coordinates.
  Ordinary impedance and port results are gathered to caller order, while
  combined and embedded complex fields restore the caller's XY translation
  with the executable positive-sign phase rule.
- Ordinary result ports use the same logical caller-order tags in explicit and
  symmetric representations. Generated tags, copy indices, fundamental port
  order, and scatter maps remain confined to plans, application metadata, and
  diagnostics.
- `applyArrayBuildPlan()` accepts either a direct or worker model. The public
  `NecArraySolver` factory is worker-backed, expands structural loads over all
  native copies, and retries the unchanged explicit description at most once
  for a classified representation-eligibility failure in `"auto"` mode.

### WP-S6 — End-to-end equivalence suite

Dependencies: WP-S5.

Deliverables:

- implement the complete cases and metrics in Section 11;
- build explicit, manual, and transparent models from the same full
  description;
- compare gathered Z/Y and all port quantities;
- implement canonical current-weight generation and far-field comparisons;
- compare direct combined fields with gathered unit-current embedded-field
  superposition;
- run the beam-steering consumer contract suite against explicit, accepted
  symmetric, and automatic-fallback models without representation branches;
- split fast CI, slower native/WASM CI, and scheduled large-matrix cases without
  weakening core coverage; and
- save concise failure diagnostics identifying caller IDs, native indices,
  matrix entries, or field samples.

DoD:

- R1, R2, R4, T1, T2, G1, N1, O1, E1, and P1 pass in their designated test
  tiers;
- R3 and T3 run in at least one automated scheduled/native tier;
- every exact-coordinate matrix and field comparison meets Section 11
  tolerances;
- all five current-weight cases compare direct and embedded fields;
- the deliberately non-caller native port order proves the two-dimensional
  matrix gather;
- explicit 4 x 4, symmetric 4 x 4, and fallback 3 x 3 models expose the same
  consumer method and result types, with full caller port counts throughout;
- off-origin comparison proves the complex translation phase, not just
  magnitude; and
- failure output is sufficient to distinguish geometry mismatch, gather error,
  phase-sign error, and numerical solve error.

Handoff focus: WP-S7 must reuse these fixtures/checks as benchmark correctness
guards.

Completion evidence (2026-08-30, Windows, Node 24.14.1, TypeScript 5.8.3,
and the WP-S3 Emscripten artifact):

- Added `test/symmetry-equivalence.test.mjs`, which builds explicit, manually
  applied, and transparent models from the shared reference description. Its
  eight real-WASM cases cover R1-R4, T1-T3, G1, N1, O1, E1, and P1, plus a
  complete structural load orbit. R3's complete 64-port 8 x 8 Z/Y comparison
  runs in the ordinary tier rather than being deferred to a scheduled job.
- The suite rejects non-finite data and checks dimensions, frequency, port
  metadata, generations, two-dimensional caller-order gathering, Z/Y relative
  L2 and scaled-max error, Z*Y identity, reciprocity, named mutual entries,
  port quantities, and all complex far-field components. Exact
  full-versus-symmetric comparisons retain the `1e-8` gates; the separately
  measured 11-segment explicit reciprocity residual is bounded at `2e-7` for
  4 x 4 and `3e-7` for 8 x 8.
- All five canonical 4 x 4 current cases compare requested/achieved currents,
  voltages, active impedances, powers, complex combined fields, total
  magnitudes, normalized cuts, stable peak samples, and intended-sample phase.
  Gathered unit-current embedded bases reproduce each directly solved field by
  JavaScript complex superposition.
- N1 and P1 execute the same prepare, Z, current-solve, combined-field, and
  embedded-field calls as accepted symmetry while retaining the full caller
  port count and exposing no native tags or copy indices. O1 compares complete
  complex translated fields, and E1 reports every canonicalization before
  applying its locked `1e-7` jittered-input bound.
- `npm --prefix packages/necpp-wasm run build:test` followed by the focused
  Node command passed 8/8 in 2.63 seconds. `npm --prefix packages/necpp-wasm
  test` passed 68/68 tests and strict typechecking. `git diff --check` passed.
- Proportional native regressions from the clean cached Release executable also
  passed: `[wp_s2]` 10,599 assertions in five cases, `[wp_s3]` eight assertions
  in two cases, and the aggregate `[symmetry]` selection 10,945 assertions in
  15 cases. The native WP-S2 run took 175 seconds on this Windows host; it was
  CPU-active throughout and completed without a skipped assertion.

Contract decisions for WP-S7 and later:

- Performance checks must run only after the same caller-order complex Z/Y
  equivalence gates; reporting magnitude-only agreement is insufficient.
- Broadside has physically degenerate azimuth samples. Peak comparison uses the
  first sample within a `1e-10` relative tie band so representation roundoff
  cannot manufacture an azimuth disagreement; steered cases additionally
  check the requested azimuth cut and intended complex sample.
- Exact representation comparisons remain `1e-8`. The looser reciprocity
  limits describe the independently measured explicit pulse/basis baseline and
  must not be reused as full-versus-symmetric tolerances.

### WP-S7 — Benchmarks and performance gates

Dependencies: WP-S6.

Deliverables:

- extend the process-isolated benchmark with explicit, manual, and auto paths;
- use the Section 7 over-ground lambda-scaled geometry;
- emit all Section 12 phase, memory, correctness, and environment metadata;
- add CLI help, README instructions, NDJSON schema/version, and summary ratios;
- capture a clean reference run with at least three rounds; and
- compare explicit pre-feature/no-symmetry behavior to detect regression.

DoD:

- sizes 2, 4, 8, 12, and 16 complete or report classified controlled failures;
- numerical checks pass before speedups are printed;
- 16 x 16 meets the same-host 8x manual-reflection preparation target or the
  documented miss procedure is followed without altering correctness gates;
- auto and manual paths meet the 5% parity target at 8 x 8 and larger;
- planner overhead and matrix allocation reduction are separately visible;
- raw NDJSON and summary JSON are retained outside source control unless the
  repository explicitly tracks a curated result summary; and
- `packages/necpp-wasm/bench/RESULTS.md` or a symmetry-specific results document
  records artifact hash, worktree state, commands, tables, and interpretation.

Handoff focus: WP-S8 uses measured facts, not theoretical estimates, in public
documentation.

Completion evidence (2026-08-30, Windows, Node 24.14.1, Emscripten 4.0.7):

- Replaced the historical stateful/report comparison as the default workload
  with process-isolated `explicit`, `manual-reflection`, and
  `auto-reflection` paths over the shared Section 7 fixture. The `deck` backend
  remains available as historical formatted-report coverage.
- Schema-v2 NDJSON records analysis, module creation, construction, completion,
  port/environment setup, prepare, first and retained changed-current solves,
  combined far field, optional complete Z/Y extraction, sampled RSS, exact
  primary interaction-matrix bytes, artifact/environment identity, classified
  failures, and median/min/max summaries. CLI help and `bench/README.md`
  document every option and record type.
- The three-round current-artifact run completed 45/45 cases at sides 2, 4, 8,
  12, and 16. All 30 manual/automatic comparisons passed requested/achieved
  port quantities, powers, complete complex fields, and the 2 x 2 / 4 x 4
  caller-order complex Z/Y gates at `1e-8`; the largest scaled error was
  `1.13e-13`.
- The pinned artifact SHA-256 was
  `42d427c52b06792471d92e148cb0ed6ece33b4dabf1edabfe355ddcf4b1e0a28`.
  The 16 x 16 manual prepare median was 1,142.14 ms versus 13,196.45 ms
  explicit (11.55x). Auto/manual deltas at 8/12/16 were +2.32%, -1.18%, and
  -0.18%; planner cold shares were 2.10%, 0.77%, and 0.26%. Exact wire-only
  primary matrix allocation fell from 121.00 MiB to 30.25 MiB at 16 x 16,
  with the same 4.00x reduction at every size.
- Built planning-only commit `78bdafe` with the same Docker toolchain and ran
  its explicit facade through the identical protocol. Current explicit prepare
  deltas at 4/8/12/16 were -6.34%, -2.12%, +0.21%, and +0.55%. The unqualified
  5% regression gate remains a transparent miss at 2 x 2: +19.41% in the
  three-round run and +11.48% in a separate 15-round check with overlapping
  ranges. `bench/RESULTS.md` records the bounded fixed-overhead profiling
  follow-up; no numerical or performance tolerance was changed.
- Raw current/baseline NDJSON and summary JSON remain under ignored
  `bench/results/`. `bench/RESULTS.md` records both artifact hashes, exact
  commands, worktree state, tables, interpretations, and the historical deck
  context.
- Final regression validation passed: `npm test` ran 69/69 tests plus strict
  typechecking; packed-consumer tests passed 5/5; browser direct, worker, and
  example integrations passed against one inspected tarball; native `[wp_s2]`
  passed 10,599 assertions and `[wp_s3]` passed eight assertions. JavaScript
  syntax checks, the three focused benchmark tests, the correctness-gated 2 x
  2 CLI smoke run, and `git diff --check` also passed.
- The first sandboxed pack/browser attempts could not write the user npm cache
  (`EPERM`); an unparameterized browser invocation also printed its required
  mode/tarball usage. They were rerun with npm-cache access, explicit
  direct/worker/example modes, and the single inspected tarball with SHA-256
  `80dbd4c3ffb450cadef9c93909f0e1a99ae513ad14572570806f04c042718afa`.
  `ctest` was not on this PowerShell PATH, so the cached Release Catch2 binary
  was invoked directly for the native WP-S2/WP-S3 partitions. No test was
  silently skipped.

Contract decisions for WP-S8 and later:

- Public documentation may state an 11.55x measured 16 x 16 preparation
  speedup and fourfold primary-matrix allocation reduction only with this host,
  model, artifact, and three-round context. It must not turn those measurements
  into an unconditional speedup promise.
- Planner overhead is measured separately from construction and preparation.
  Complete Z/Y extraction remains outside the ordinary 8 x 8 through 16 x 16
  preparation workload unless `--z-matrix-sides` explicitly opts in.
- The 2 x 2 explicit pre-feature regression miss must remain visible until a
  later profiling change passes the same protocol without weakening structural
  symmetry or load validation.

### WP-S8 — Public documentation, examples, and release hardening

Dependencies: WP-S7.

Deliverables:

- update `docs/wasm-api.md` as the detailed API and behavior reference;
- add a self-contained **Symmetric arrays and automatic optimization** section
  to `packages/necpp-wasm/README.md`. This file is explicitly included in the
  npm `files` list and is the documentation rendered on the npm package page;
- add a concise symmetry capability summary and link to the detailed reference
  from the repository root README, if the root README contains the WASM package
  overview at implementation time;
- update benchmark documentation and prepare a draft unreleased changelog entry;
  WP-S9 assigns the final versions and release date;
- add one direct and one worker example using manual symmetry;
- add one transparent full-description example that displays accepted/fallback
  diagnostics and max coordinate adjustment;
- validate every public README code example against the built declarations and
  runtime, rather than maintaining illustrative snippets that can silently rot;
- document even/odd square behavior, tag/copy order, loads, ground, arbitrary
  excitations, recenter phase, and all first-release pattern prohibitions;
- document the deferred helix/handedness acceptance path without implying it is
  implemented;
- run complete native, WASM, package, packed-consumer, and browser validation;
  and
- review release/package contents for every new source and declaration.

The npm README section must be understandable without opening repository-only
documentation. At minimum it contains:

| Topic | Required npm README content |
|---|---|
| Consumer contract | The same full-array description and the same prepare, Z/Y, solve, combined-far-field, and embedded-far-field calls work for explicit and optimized execution. |
| Default/opt-in policy | Exact documented behavior of `symmetry: "auto"`, `"off"`, and `"require"`, including which mode the public factory defaults to. |
| Supported operations | Coordinate-plane reflections, valid combinations, N-fold rotation about global Z, and the first-release restrictions imposed by ground and element patterns. |
| Full NxN input | A runnable square-array example using caller-provided XY positions, lambda-scaled geometry, epsilon, and automatic selection. |
| Result semantics | Z/Y matrices, port quantities, embedded fields, and combined fields remain in full caller element/port order regardless of internal reduction. |
| Diagnostics | How to inspect accepted symmetry, reduction factor, canonicalization distance, warnings, and fallback reason without branching ordinary solver use. |
| Numerical meaning | Epsilon acceptance canonicalizes near-symmetric coordinates; it does not prove the supplied geometry was exactly symmetric. |
| Unsupported patterns | Helices, tilted/off-axis wires, arcs, patches, rotated patterns, and transformations with unresolved handedness, endpoint, or port-polarity semantics fall back or error. |
| Performance | Only measured benchmark results and their hardware/model context; no unconditional speedup claim. |
| Manual escape hatch | Link and minimal example for explicitly constructing a fundamental section when the caller wants direct control. |

Detailed `docs/wasm-api.md` documentation additionally includes the complete
support matrix, TypeScript declarations, lifecycle and ownership, copy/tag/port
mapping rules, mathematical transforms, structured fallback reason catalogue,
tolerances, errors, worker parity, and the future helix-orientation acceptance
requirements. The npm README should summarize these accurately and link with an
absolute repository URL that still resolves when rendered from the packed npm
artifact.

DoD:

- a new consumer can build the 4 x 4 reference array from both a quadrant and a
  full position list without reading native source;
- the packed npm README independently explains how to supply the full NxN XY
  position list and let automatic detection select or reject symmetry;
- the README's auto, off, require, direct, and worker examples compile against
  the emitted declarations, and executable examples pass against the built WASM;
- documentation states that epsilon acceptance canonicalizes coordinates and
  reports the adjustment;
- documentation clearly distinguishes structural symmetry from excitation
  symmetry and from explicit `GM`-style copies;
- helix/transformed-pattern examples fail or fall back exactly as documented;
- `npm pack --dry-run` lists `README.md`, and inspection of the actual tarball
  confirms it contains the updated capability section and working links;
- package description/keywords and documentation do not claim support beyond
  the tested operation/pattern matrix;
- all commands in the release checklist pass from a clean build; and
- the global DoD below is checked and the status table contains complete
  evidence for every WP.

Completion evidence (2026-08-30, Windows, Node 24.14.1):

- Expanded `docs/wasm-api.md` with the complete transparent-facade contract,
  lifecycle/ownership, mode and retry policy, caller/native mappings, exact and
  epsilon matching, canonicalization disclosure, translation phase equation,
  structured reason catalogue, support matrix, tolerances, worker parity, and
  the deferred helix orientation/polarity requirements.
- The npm-rendered README now independently documents full NxN input,
  `"auto"`/`"off"`/`"require"`, accepted/fallback diagnostics, arbitrary
  excitations, ground/loads, copy/tag order, unsupported patterns, and the
  contextual WP-S7 measurements. The root README links the detailed contract;
  the unreleased changelog entry is drafted without preempting WP-S9 versions.
- Converted the downstream Vite beam-steering app to the complete-description
  facade. It displays accepted/fallback reason codes and maximum coordinate
  adjustment while its prepare, Z, current solve, and field flow remains
  representation-independent. Added standalone direct and worker manual
  reflection examples; clean packed consumers execute both.
- `npm run test:wasm` passed 69/69 runtime tests, strict typechecking, five
  packed-consumer tests, every TypeScript block extracted from the installed
  npm README, both manual examples, the quick start, CDN loading, and a clean
  Vite direct/worker bundle. The first sandboxed pack attempt failed with the
  expected npm-cache `EPERM`; the identical command passed with npm-cache
  access. `npm pack --dry-run --json` listed the README, symmetry declarations,
  implementation, worker files, and WASM artifact with no source/debug or
  benchmark output.
- One inspected candidate tarball,
  `necpp-engine-wasm-0.1.1.tgz` (329,889 bytes, SHA-256
  `b94fa05457cd7201754631cd6de06a70a3ad961546722008c49d1f6a8d8037f6`),
  passed Chromium direct, worker, and transparent-example modes. The example
  returned four caller ports, 361 finite field samples, symmetric
  representation, zero exact-coordinate adjustment, and no fallback reasons.
- The cached native Release build completed. CTest passed seven partitions;
  its `[wp1]` aggregate alone exceeded the configured 180-second wrapper limit
  because the 1,000-solve stress case writes extensive diagnostics. Direct
  execution split that partition into `[wp1]~[stress]` (49 assertions in six
  cases) and `[stress]` with output suppressed; both exited zero. No native
  source changed in WP-S8. `git diff --check` passed.

Contract decisions for WP-S9:

- Preserve the README/API behavior and examples; WP-S9 changes only the
  package/native identities, release date, pinned assertions/CDN examples, and
  rebuilt artifacts required by its mechanical version checklist.
- Recreate rather than reuse the WP-S8 candidate tarball after the version
  bump, then run all three browser modes against that one inspected final
  artifact. ABI version and `necpp_wasm_v1_*` names remain `1`.
- Keep the explicit 2 x 2 pre-feature benchmark miss and all first-release
  pattern prohibitions visible; neither is a version-finalization fix.

Handoff focus: WP-S9 is a deliberately mechanical finalization step. Do not
bump a version in WP-S8 merely to make documentation examples appear final.

### WP-S9 — Final version bump and release identity

Dependencies: WP-S8 and completion of every preceding work package.

This is the final implementation work package. The package, native engine, and
ABI versions are independent release identities and must be changed according
to their own compatibility rules:

| Identity | Before | After | Reason |
|---|---:|---:|---|
| `@necpp-engine/wasm` package | `0.1.1` | `0.2.0` | substantial additive public TypeScript/WASM capability in a pre-1.0 package |
| NEC2++ native engine | `2.3.4` | `2.4.0` | additive stateful symmetry and C entry points |
| WASM ABI | `1` | `1` | entry points are additive; no existing v1 signature or buffer contract changes |

The ABI version must not be incremented, and the `necpp_wasm_v1_*` prefix must
not be renamed, unless implementation work discovers an unavoidable breaking
change. Such a discovery blocks WP-S9 and requires an explicit contract review;
it must not be hidden inside the version-bump commit.

Deliverables:

- change the root `CMakeLists.txt` engine version from `2.3.4` to `2.4.0`;
- change the package version from `0.1.1` to `0.2.0` in
  `packages/necpp-wasm/package.json` and every root/package entry in
  `packages/necpp-wasm/package-lock.json`;
- update `packages/necpp-wasm/src/versions.ts` so `packageVersion` is `0.2.0`,
  `engineVersion` is `2.4.0`, and `abiVersion` remains `1`;
- finalize the `0.2.0` changelog section and release date, documenting automatic
  detection/fallback, the representation-independent consumer facade, supported
  symmetries, equivalence coverage, and first-release pattern prohibitions;
- update pinned version assertions and user-facing versioned examples, including
  package README/CDN examples and browser/runtime integration expectations;
- rebuild the native engine and WASM artifact after the bump so embedded runtime
  metadata reports engine `2.4.0`, then rebuild declarations and package output;
- create the final npm tarball, inspect its manifest and contents, and record its
  filename and digest with the release evidence; and
- prepare, but do not create or publish, the release/tag identity unless a user
  separately authorizes the external release action.

DoD:

- repository search finds no stale expected `0.1.1` package or `2.3.4` engine
  identity in active source, tests, generated package metadata, or versioned
  documentation examples; historical changelog text may retain old versions;
- build-time version verification proves `package.json`, lockfile,
  `src/versions.ts`, root CMake metadata, and the embedded WASM engine agree;
- native and WASM runtime version queries report `2.4.0`, package metadata and
  imports report `0.2.0`, and ABI queries still report `1`;
- the complete clean-build release checklist from WP-S8 passes again after the
  bump, including packed-consumer and browser integration tests;
- `npm pack --dry-run` and final tarball inspection contain the intended symmetry
  API declarations, implementation, WASM artifact, documentation, and no
  unintended benchmark output; and
- the version bump is the last planned source change. Any correction caused by
  final validation is followed by rebuilding, retesting, and rechecking every
  release identity before WP-S9 is marked complete.

Completion evidence (2026-08-30, Windows, Node 24.14.1):

- Finalized `@necpp-engine/wasm` as `0.2.0`, NEC2++ as `2.4.0`, and retained
  WASM ABI `1`. Package metadata, both lockfile entries, TypeScript exports,
  CMake metadata, runtime assertions, user-facing versioned examples, and the
  dated changelog section agree. A repository search found no stale expected
  `0.1.1` or `2.3.4` identity in active source, tests, generated package
  metadata, or versioned examples; historical results, changelog entries, and
  before/after planning text remain intentionally unchanged.
- The cached native Release tree regenerated after the CMake change and built
  successfully. The executable reports `nec2++ 2.4.0 [2026-08-30]`; generated
  `config.h` and `necpp.pc` also report `2.4.0`. Seven non-WP1 CTest partitions
  passed. The long-output WP1 partition passed as `[wp1]~[stress]` with 49
  assertions in six cases, and `[stress]` exited zero with output suppressed.
- `scripts/build_wasm_docker.ps1` rebuilt the module with pinned
  `emscripten/emsdk:4.0.7`. The ABI smoke test passed; `test:wasm` passed 69/69
  runtime tests plus strict typechecking and the five packed-package tests.
  These runs exercised embedded engine `2.4.0`, exported package `0.2.0`, and
  unchanged ABI `1` in direct and worker modes.
- The final artifact is `necpp-engine-wasm-0.2.0.tgz` (329,882 bytes, SHA-256
  `a436b7fc831b942be7156a6df5e99d4d4f40bdcc6955ce24527f5779b37c5d15`).
  Its manifest contains 39 intended files, including the README, symmetry
  declarations and implementation, worker entry points, and the 733,440-byte
  WASM artifact, with no source, debug, test, or benchmark output. The exact
  tarball passed four clean Node/README/Vite consumer tests and Chromium direct,
  worker, and transparent-example integration. `npm pack --dry-run --json`
  reported the identical filename, sizes, hashes, and contents.
- CMake/CTest were not on this PowerShell PATH, so the cached CMake 3.31.6 tools
  were invoked by their recorded absolute path. Initial sandboxed Docker and
  final-pack attempts were denied access to the Docker API and user npm cache;
  the identical commands passed with the required access. No test was silently
  skipped. No tag, GitHub release, or npm publication was created.

Final contract decision:

- Package `0.2.0`, engine `2.4.0`, and ABI `1` are the completed symmetry
  release identities. Any later source correction requires rebuilding and
  rerunning the release checklist; external tagging and publication require
  separate user authorization.

## 14. Global Definition of Done

Symmetry support is ready to merge/release only when:

1. **Contract:** public inputs, outputs, units, ownership, lifecycle, copy order,
   errors, and fallback behavior are documented and type-tested.
2. **Native correctness:** GX/GR legacy coverage remains green and stateful
   full-versus-symmetric native tests pass.
3. **ABI stability:** all new functionality crosses additive C/WASM symbols;
   no existing v1 signature, enum value, or result buffer meaning changed.
4. **Direct/worker parity:** direct and worker APIs return the same metadata and
   numerical results, with cancellation and structured-clone behavior tested.
5. **Consumer transparency:** the beam-steering application runs identical,
   unbranched prepare/Z/solve/far-field code for explicit, symmetric, and
   automatic-fallback arrays; all ordinary results use full caller port order
   and existing result types.
6. **Transparent safety:** symmetry is accepted only after one-to-one orbit,
   pattern, load, environment, and epsilon validation; otherwise explicit
   fallback is deterministic and explained.
7. **Pattern prohibition:** helix, tilted/off-axis wire, rotated pattern, arc,
   patch, endpoint-reversal-only, and opaque patterns cannot enter the first
   release symmetry path.
8. **Gathered matrices:** complete complex Z and Y for mandatory small cases
   match the full explicit model in caller order within `1e-8` metrics.
9. **Beam steering:** all canonical current cases match full explicit complex
   fields, port quantities, field cuts, and peak sample; embedded-field
   superposition agrees with direct fields.
10. **Ground:** perfect and finite homogeneous ground coverage passes for valid
   vertical planes/rotations, and incompatible `z=0` structural reflection is
   rejected.
11. **Epsilon disclosure:** exact and jittered cases are distinct; every
    canonical adjustment and the maximum adjustment are observable.
12. **Translation phase:** an off-origin explicit array and a centered symmetric
    array agree in complex far field after the tested `exp(+j*k*u dot c)`
    correction.
13. **Performance:** the process-isolated benchmark records correctness,
    preparation speed, auto-planner overhead, retained solves, fields, and
    memory across 2 through 16 sides, and handles the performance gates as
    specified.
14. **Regression:** native unit/regression tests, stateful WP partitions, C ABI
    tests, WASM smoke, TypeScript tests/typecheck, worker integration,
    packed-consumer tests, and browser integration are green.
15. **Published documentation:** detailed API docs and the README included in
    the npm tarball accurately explain supported symmetries, automatic
    detection/fallback, the unchanged full-array contract, diagnostics,
    canonicalization, limitations, and measured performance; public examples
    are validated against the shipped declarations and runtime.
16. **Version identity:** the final work package sets package `0.2.0`, engine
    `2.4.0`, and ABI `1`; source metadata, lockfile, tests, documentation,
    embedded WASM, and inspected tarball all agree.
17. **Handoff evidence:** every WP status row names its evidence and leaves no
    silent skipped test or unresolved blocker.

## 15. Agent handoff protocol

At the start of each sequential agent's work:

1. Read the repository `AGENTS.md`, this document, and the preceding WP's status
   notes.
2. Run `git status --short` and preserve all unrelated user/agent changes.
3. Inspect the actual current interfaces; do not assume line numbers or the
   initial proposal are unchanged.
4. Mark only the selected WP `in progress`.
5. Run the narrowest existing tests before editing to establish a baseline.

Before handing off:

1. Complete the WP's tests and proportional regression suite.
2. Record exact commands, platform limitations, failures, and results in this
   document or a linked tracked results note.
3. Update the status row to `complete` only if every DoD item is satisfied;
   otherwise use `blocked` and name the concrete blocker.
4. List public/API decisions the next agent must preserve.
5. Do not weaken a numerical or performance gate merely to make a WP green.
6. Leave generated benchmark data out of source control unless explicitly
   curated and documented.

Suggested validation commands should be updated by WP-S0/WP-S8 to match the
active build directories, but the final set must cover at least:

```powershell
cmake --build <native-build-dir> --config Release
ctest --test-dir <native-build-dir> -C Release --output-on-failure
npm --prefix packages/necpp-wasm test
npm --prefix packages/necpp-wasm run test:wasm
npm --prefix packages/necpp-wasm run test:browser
npm --prefix packages/necpp-wasm run bench:array -- <symmetry benchmark options>
```

The authoritative completion evidence is the executed command and artifact,
not the placeholder build-directory text above.
