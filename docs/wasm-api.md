# `@necpp-engine/wasm` API and numerical contract

Status: normative specification, updated through the parallel far-field release
on 2026-09-01. The
stateful native layer, versioned C/WASM ABI, handwritten TypeScript facade,
optional Web Worker entry point, and packable npm package are implemented.
The committed TypeScript surface is in [`packages/necpp-wasm/src`](../packages/necpp-wasm/src).

The symmetry names, metadata, lifecycle shape, and fixture mappings below are
implemented by the native engine, additive ABI, direct facade, and worker
facade. Non-symmetric completion returns an empty, immutable
`GeometryCompletionResult`; symmetric completion returns immutable copy and
segment-count metadata in both execution modes.

Isolated-element current coefficients, prepared quadrature sampling, and
characterization are specified in
[`current-quadrature-api.md`](current-quadrature-api.md). Those methods are on
`NecModel` / `NecWorkerModel`. Packed `NECQ`/`NECF` fixtures ship with the
package as `@necpp-engine/wasm/fixtures/current-quadrature-v1/*`.

## Package and runtime boundary

The final npm package name is **`@necpp-engine/wasm`**. The unscoped name
`necpp-wasm` is already occupied by a separately published distribution,
while the scoped name identifies this repository and leaves room for future
`@necpp-engine/*` packages. Publication requires control of the `necpp-engine`
npm scope, but the API name will not change if the package is initially
distributed as a tarball.
The package is ESM-only and requires Node 24 or later for Node consumers.
The isolated-element current-quadrature release package identity is `0.5.0`;
it embeds NEC2++ `2.5.0` while preserving WASM ABI version `1`. The prior
parallel far-field release was `0.4.0`.

The packed package exports three version identifiers that can be imported
without constructing a model:

- `packageVersion` — npm version of this TypeScript API
- `engineVersion` — NEC2++ version compiled into the shipped WASM
- `abiVersion` — stable C ABI (`necpp_wasm_v1`), currently `1`

The facade refuses to instantiate a binary whose ABI or engine version does
not match those constants.

`createNecModel()` asynchronously initializes the Emscripten module and
returns a stateful `NecModel`. After creation, those model methods are
synchronous. Large browser calculations should use `createNecWorkerModel()`
from `@necpp-engine/wasm/worker`; its methods are asynchronous, serialized per model,
and otherwise observe this contract. `runDeck()` is an asynchronous
compatibility escape hatch for a complete NEC text deck. It is not part of a
`NecModel` lifecycle and returns a `DeckResult` containing the formatted
report and engine version.

The JavaScript facade owns the native handle and is solely responsible for
destroying it. A consumer never receives a pointer, heap view, generated
Emscripten type, `ccall`, or `cwrap` function.

## Numerical conventions

These conventions apply to every public method and returned value.

- Phasors use \(e^{+j\omega t}\). An outgoing spherical wave therefore has
  propagation factor \(e^{-jkR}/R\), with
  \(k=2\pi f/c_0\) and the NEC-2 value
  \(c_0=1/\sqrt{(4\pi\,10^{-7})(8.854\,10^{-12})}
  \approx299{,}795{,}637.69321626\ \mathrm{m/s}\).
- Geometry, radii, ranges, and all other public distances are in metres.
  Frequency is in MHz at the API boundary.
- Voltages and currents are complex peak-amplitude phasors, not RMS phasors,
  in volts and amperes. Consequently, time-average input power is
  \(P=\tfrac12\operatorname{Re}(V I^*)\) watts.
- Port current is positive from the source **into the modeled antenna**. Thus
  \(V=ZI\), \(I=YV\), passive input resistance gives positive input power,
  and active impedance is \(V_i/I_i\). A port with exactly zero current has
  active impedance `NaN + jNaN` rather than an infinity or exception.
- Impedance is in ohms and admittance is in siemens. Conductivity is in S/m,
  inductance in henries, and capacitance in farads. Per-metre RLC loads state
  that fact explicitly through `perMeter: true`.
- Coordinates are a right-handed Cartesian system. \(\theta\) is the polar
  angle from +Z. \(\phi\) is azimuth in the XY plane from +X toward +Y.
  \(E_\theta\) points in increasing \(\theta\); \(E_\phi\) points in increasing
  \(\phi\).
- Far fields are complex V/m, referenced to the model coordinate origin.
  `radiusM` defaults to 1 m, is always positive, and is always returned. The
  API always includes \(e^{-jkR}/R\); it does not expose the RP-card convention
  in which a zero range omits this factor. Results remain far-field
  approximations even if a small radius is requested.
- Segment positions in `PortDefinition` and `SegmentSelection` are one-based,
  matching NEC's position within a tag group. JavaScript array indices are
  zero-based.
- All computations use IEEE-754 binary64 values. Inputs must be finite except
  where a result explicitly permits NaN active impedance for zero current.

Every `PortSolution` includes both caller-order `powersW` and an aggregate
native balance:

```ts
interface PowerBudget {
  readonly inputPowerW: number;
  readonly radiatedPowerW: number;
  readonly structureLossW: number;
  readonly networkLossW: number;
  readonly efficiencyPercent: number | null;
}
```

`inputPowerW` agrees with the sum of the simultaneous per-port powers within
numerical tolerance. Individual ports may be negative in a coupled active
array. NEC defines `radiatedPowerW = inputPowerW - structureLossW -
networkLossW`; efficiency is `null` only when captured input is exactly zero.
The object is frozen and remains tied to the surrounding `solveGeneration`
after later solves and worker transfer. Native radiated power is not an
angular quadrature or polarization-resolved measurement. In particular, the
NEC balance has no separate finite-ground-loss field, so upper-hemisphere
flux equality is not asserted for finite lossy ground.

The phase, range, and angle definitions follow the NEC-2 Part 3
[RP card](https://www.nec2.org/part_3/cards/rp.html); voltage-source fields and
tag-relative segment addressing follow the
[EX card](https://www.nec2.org/part_3/cards/ex.html). Load units and targeting
follow the [LD card](https://www.nec2.org/part_3/cards/ld.html).

## Array layout and ownership

`ComplexVector.real` and `.imag` have the same length. A vector supplied to a
method must contain exactly one entry per defined port, in the order passed to
`definePorts()`.

`ComplexMatrix` is dense and row-major:

```text
index(row, column) = row * columns + column
```

For an N-port model, Z and Y are N by N. `Y[row, column]` is the current at
port `row` caused by a unit-voltage excitation at port `column`, with every
other port held at zero volts. `Z` is the inverse mapping. Matrix row and
column order exactly matches `definePorts()`.

`FarFieldResult.thetaDeg` and `.phiDeg` contain the sampled coordinate axes,
not one coordinate per field element. Every field array has
`thetaDeg.length * phiDeg.length` elements:

```text
sampleIndex = phiIndex * thetaDeg.length + thetaIndex
```

Theta varies fastest, matching NEC RP stepping. Embedded fields add an outer
port dimension:

```text
embeddedIndex = portIndex * samplesPerPort + sampleIndex
```

The default embedded normalization is one volt at the selected port with all
other ports held at zero volts. Unit-current normalization means one ampere
into the selected port with zero requested current at every other port.

All input arrays are borrowed only for the duration of the call and are never
mutated. Every returned typed array is a fresh, JavaScript-owned copy. It
remains valid after another solve, native result replacement, WASM memory
growth, or `dispose()`. Returned port definitions are snapshots; mutating the
consumer's original array or its objects cannot alter the model.

## Lifecycle

The initial state is `empty`:

```text
empty -> geometry-building -> geometry-complete -> prepared -> solved
                                                               |
any live state ------------------------------------------------+-> disposed
```

The arrows above show the normal path; the complete transition table is
below. A dash means that the operation throws `NecStateError` without changing
the model. `same` means that the operation preserves the current state.

| Operation | empty | geometry-building | geometry-complete | prepared | solved | disposed |
|---|---|---|---|---|---|---|
| `addWire` | geometry-building | same | — | — | — | — |
| `completeGeometry` | — | geometry-complete | — | — | — | — |
| `definePorts` | — | — | same | — | — | — |
| `addLoad`, `clearLoads`, `setGround` | — | — | same | geometry-complete | geometry-complete | — |
| `prepare`, changed configuration | — | — | prepared | same | prepared | — |
| `prepare`, unchanged configuration | — | — | prepared | same | same | — |
| `computeImpedanceMatrix` | — | — | — | same | same | — |
| `solveVoltages`, `solveCurrents` | — | — | — | solved | same | — |
| `computeFarField` | — | — | — | — | same | — |
| `computeEmbeddedFarFields` | — | — | — | same | same | — |
| `dispose` | disposed | disposed | disposed | disposed | disposed | same |

Current-distribution, prepared-quadrature, and characterization operations are
reserved in [`current-quadrature-api.md`](current-quadrature-api.md). They are
not in the executable `state-machine.ts` table until later work packages
implement them.

Additional lifecycle rules:

- Geometry can change only before `completeGeometry()` and completion occurs
  exactly once. At least one valid geometry element is required.
- `completeGeometry({ symmetry })` makes symmetry generation the final geometry
  mutation and returns immutable copy/count metadata. No wire, patch, or other
  geometry primitive may be added after generation. Plane-list order never
  changes NEC's fixed Z-then-Y-then-X copy order.
- `groundConnection` defaults to `"none"` (`GE 0`). `"interpolate"` maps to
  `GE +1` and interpolates a touching wire end to its image; `"zero-current"`
  maps to signed `GE -1` and leaves the expansion unmodified. Either non-none
  mode requires perfect or finite ground by `prepare()`, rejects wires below
  or lying in `z=0`, and is incompatible with structural reflection through
  `z=0`. The connection flag does not install ground.
- `definePorts()` replaces the complete port list. It requires a nonempty
  list of unique, valid tag/segment pairs and is deliberately frozen before
  preparation so all later results have stable ordering.
- The initial environment is free space with no loads. Changing ground or
  loads after preparation discards factorization, matrices, and the latest
  solution and returns to `geometry-complete`. Calling these mutators is
  conservatively invalidating even if the supplied value equals the old one.
- `prepare()` requires at least one port. A new frequency invalidates the old
  factorization and solution. Repeating the exact same preparation is a true
  no-op: it does not refactor, increment generations, discard a solution, or
  change state.
- Excitation changes increment the solve generation but do not invalidate the
  factorization. Far-field sampling changes neither generation.
- Matrix and embedded-field calculations may perform internal basis solves,
  but they preserve an existing consumer solution and the public state. From
  `prepared`, they leave the model prepared rather than making an arbitrary
  basis excitation the “latest solution.”
- `computeFarField()` always uses the latest consumer solution. A zero
  excitation returns exact zero field components without NaNs.
- `dispose()` is deterministic and idempotent. The `state` getter remains
  readable afterwards; every other method throws `NecStateError`.

The executable counterpart of this table is
[`state-machine.ts`](../packages/necpp-wasm/src/state-machine.ts), and its test
enumerates every operation/state pair plus both `prepare()` branches.

## Method contract

| Method | Inputs and units | Output | Failures beyond illegal state |
|---|---|---|---|
| `createNecModel(options?)` | Optional `wasmUrl` or caller-owned WASM bytes | Promise of an `empty` model | `NecRuntimeError` for load/instantiate/version failure; `NecInputError` if both overrides are supplied |
| `createNecWorkerModel(options?)` | Same loading overrides plus optional `onProgress` | Promise of an `empty` worker model | Same loading failures; `NecRuntimeError` if the worker cannot start or is terminated |
| `createNecArraySolver(description, options?)` | Complete positioned-element description plus `"auto"`, `"off"`, or `"require"` policy | Promise of one worker-backed, representation-independent array solver | Input/planner errors below; ordinary native failures retain their normal taxonomy |
| `addWire(wire)` | Positive integer tag/count; distinct finite endpoints and positive finite radius, all in m | `void`; copies the definition | `NecInputError` for shape/range errors; `NecGeometryError` for engine geometry limits |
| `completeGeometry(options?)` | Ground connection plus optional finalized reflection/rotation descriptor | `GeometryCompletionResult`; `symmetry` is absent for ordinary completion | `NecInputError` for an invalid descriptor; `NecGeometryError` for intersections, invalid junctions, symmetry/ground conflicts, or a ground-incompatible structure |
| `definePorts(ports)` | Nonempty ordered tag and one-based segment pairs | `void`; copies and freezes order | `NecPortError` for missing/duplicate ports or non-source-capable segments; `NecInputError` for malformed integers |
| `addLoad(load)` | Segment target and impedance, RLC, or conductivity values in the units above | `void`; invalidates prepared data | `NecInputError` for invalid values/ranges; `NecGeometryError` when no segment matches |
| `clearLoads()` | None | `void`; removes every load and invalidates prepared data | No non-state failure |
| `setGround(ground)` | Free space, perfect ground, or finite ground with method, relative permittivity, and S/m conductivity | `void`; invalidates prepared data | `NecInputError` for nonphysical values; `NecGeometryError` if inconsistent with geometry completion |
| `prepare({ frequencyMHz })` | One positive finite MHz value | `void`; retains/factors the interaction matrix | `NecInputError` for frequency; `NecPortError` if ports are absent; `NecSolverError` for fill/factorization failure |
| `computeImpedanceMatrix()` | None | Z, Y, optional condition estimate, frequency, factorization generation | `NecConditioningError` if inversion is singular or exceeds the implementation threshold; `NecSolverError` otherwise |
| `solveVoltages(vector)` | N complex volts | `PortSolution` with requested/achieved quantities | `NecInputError` for dimensions/nonfinite values; `NecSolverError` for solve failure |
| `solveCurrents(vector)` | N complex amperes, positive into antenna | `PortSolution`; obtains required voltages through \(V=ZI\) and performs one simultaneous source solve | `NecConditioningError` if Z cannot be formed reliably; otherwise same as voltage solve |
| `computeFarField(request)` | Positive radius in m (default 1), finite angle starts/steps, positive integer counts | Complex V/m for latest solution | `NecInputError` for grid/range/size overflow; `NecSolverError` for field calculation failure |
| `computeEmbeddedFarFields(request, normalization?)` | Same grid plus unit-voltage (default) or unit-current normalization | Basis-major complex V/m arrays | Matrix/conditioning and far-field failures above |
| `cancelFarField()` | Worker and array-solver models only; no input | `void`; idempotently stops assigning tiles for the active pooled field without disposing the model | The active field promise rejects with `NecRuntimeError` and `details.reason === "superseded"`; no failure when no pooled field is active |
| `dispose()` | None | `void`; idempotent | No failure is exposed; cleanup errors are contained |
| `terminate()` | Worker models only | `void`; kills the worker immediately | Outstanding promises reject with `NecRuntimeError` |
| `runDeck(deck, options?)` | Complete UTF-8 deck string; optional pre-start abort signal | Promise of formatted report and engine version | `NecInputError` for empty/invalid deck or pre-abort; `NecSolverError` for execution; `NecRuntimeError` for module failure |

All native exceptions are contained at the C ABI. The TypeScript layer maps a
nonzero native status to one of the errors below and retains the native
message as `message` or `cause`; a raw number or string is never thrown.

## Error taxonomy

| Class | Stable code | Meaning |
|---|---|---|
| `NecStateError` | `NEC_STATE` | Operation is not legal in the current lifecycle state, including use after disposal |
| `NecInputError` | `NEC_INPUT` | JS value, dimension, unit-domain, or deck validation failed |
| `NecGeometryError` | `NEC_GEOMETRY` | Geometry, load target, junction, intersection, or ground compatibility failed |
| `NecPortError` | `NEC_PORT` | Port is missing, duplicated, invalid, or not source-capable |
| `NecConditioningError` | `NEC_CONDITIONING` | Port matrix is singular or too ill-conditioned for the requested operation |
| `NecSolverError` | `NEC_SOLVER` | Matrix fill, factorization, excitation solve, or field computation failed |
| `NecRuntimeError` | `NEC_RUNTIME` | WASM loading, ABI mismatch, allocation, or other runtime-boundary failure |

Every class derives from `NecError`, whose `code` is stable for programmatic
handling. Messages and undocumented `details` aid diagnostics but are not a
compatibility surface; documented discriminants such as
`details.symmetryFailure` are stable. Validation failures do not mutate model state. A failed calculation
keeps the last successfully prepared factorization and consumer solution when
the native layer can prove they are intact; otherwise it rolls back to
`geometry-complete` and discards prepared data.

### Symmetry failure refinement

Symmetry-specific failures refine the ordinary error code through
`details.symmetryFailure` and the exported `SymmetryFailureReason` type:

| Reason | Error code | Automatic explicit retry |
|---|---|---|
| `INVALID_SYMMETRY` | `NEC_INPUT` | Never |
| `INCOMPATIBLE_GROUND` | `NEC_GEOMETRY` | Only when the unchanged full model is valid |
| `INCOMPLETE_LOAD_ORBIT` | `NEC_GEOMETRY` | Only when the unchanged full load set is valid |
| `UNSUPPORTED_ELEMENT_PATTERN_TRANSFORM` | `NEC_GEOMETRY` when configured to throw | Default behavior is an explained planner fallback; `"require"` may throw |

Allocation, cancellation, conditioning, solver, and invalid full-geometry
failures are not representation-eligibility failures and are never hidden by a
retry.

## Geometry symmetry contract

`CompleteGeometryOptions.symmetry` accepts exactly one of:

- `{ kind: "reflection", planes, tagIncrement }`, where `planes` is a nonempty
  tuple containing only `"x=0"`, `"y=0"`, and/or `"z=0"`; or
- `{ kind: "rotational", axis: "z", order, tagIncrement }`, where `order` is
  produced by `rotationalOrder(number)` and represents the total section count.

`rotationalOrder()` accepts signed-32-bit integers from 2 through 2147483647.
The brand makes raw unchecked numbers—including literal `1`—compile-invalid.
The runtime additionally rejects duplicate reflection planes, nonpositive or
overflowing tag increments, fixed/crossing geometry, duplicate generated tags,
and incompatible ground.

`GeometryCompletionResult.symmetry`, when present, contains the symmetry kind,
section count, fundamental/full segment counts, and a structured-cloneable
copy list. Reflection copies use `cartesian-signs`; rotational copies use
`rotate-z` with degrees. Copy index zero is always the fundamental section and
`generatedTag = baseTag + copy.tagOffset`.

For reflections, NEC appends copies in fixed Z, Y, X pass order, independent of
the order of `planes`. For the 4 x 4 positive-X/positive-Y fixture this yields
fundamental, Y-reflected, X-reflected, then XY-reflected blocks with offsets
`0,4,8,12`. Caller row-major order uses X fastest. Its executable maps are:

```text
scatter caller -> native:
[15,14,6,7, 13,12,4,5, 9,8,0,1, 11,10,2,3]

gather native -> caller:
[10,11,14,15, 6,7,2,3, 9,8,13,12, 5,4,1,0]
```

The shared generator is
[`reference-array.mjs`](../packages/necpp-wasm/test/fixtures/reference-array.mjs)
and its language-neutral 4 x 4 golden table is
[`symmetry_reference_array_4x4.json`](../tests/data/symmetry_reference_array_4x4.json).
At frequency `f`, it uses the NEC engine's speed-of-light constant, length
`lambda/3`, Z endpoints `lambda/12` and `5*lambda/12`, spacing `lambda/2`,
height `lambda/4`, radius `lambda/1000`, 11 segments, and feed segment 6. The
primary environment is perfect ground with geometry `groundConnection: "none"`.

The npm-rendered package README contains an executable manual 4 x 4 quadrant
example. Direct and worker callers pass the same descriptor; only the worker's
method call is awaited. Returned metadata is deeply frozen after direct
construction or worker structured-clone revival.

## Transparent symmetric array solver

`createNecArraySolver()` is the application-level boundary for callers that
already have the complete positioned array. Detection is a pure TypeScript
planning step; `NecModel`, native geometry, and matrix preparation never infer
symmetry from floating-point geometry. The factory accepts:

```ts
interface FullArrayDescription {
  readonly elements: readonly {
    readonly id: string | number;
    readonly positionM: readonly [xM: number, yM: number];
    readonly patternId: string;
    readonly rotationDeg?: number;
  }[];
  readonly patterns: readonly ElementWirePattern[];
  readonly ground: GroundModel;
  readonly groundConnection?: "none" | "interpolate" | "zero-current";
}

interface CreateArraySolverOptions {
  readonly symmetry?: "auto" | "off" | "require";
  readonly fieldWorkers?: "auto" | number;
  readonly fieldWorkerAssetBaseUrl?: string | URL;
  readonly symmetrizer?: {
    readonly positionEpsilonM: number;
    readonly center?: "auto" | readonly [xM: number, yM: number];
    readonly allowReflection?: boolean;
    readonly allowRotation?: boolean;
    readonly preferredRotationOrders?: readonly RotationalOrder[];
    readonly onUnsupported?: "explicit-fallback" | "error";
  };
}
```

`fieldWorkers` defaults to `"auto"`, accepts `1` through `8`, and affects only
`createNecArraySolver()`. `1` retains the serial WP2a field path. Values from 2
through 8 request a nested ordinary-worker pool for supported wire-only free-
space and perfect-ground models. `"auto"` uses four workers with at least eight
logical cores, two with at least four cores, and otherwise one; it also reduces
the count to the available 512-sample tiles and stays serial below 250,000
segment-direction-image contributions. Direct `createNecModel()` and the
low-level `createNecWorkerModel()` remain serial.

The evaluator pool is lazy-prewarmed before its first eligible field. Geometry
arrays remain resident, repeated solves transfer only the six changed current
coefficient arrays, and repeated grids after one solve transfer no snapshot
arrays. `FarFieldResult.fieldBackend` and `ArraySolverDiagnostics.field` report
the requested/active backend, tile and cancellation counts, worker restarts,
snapshot/current/result bytes, geometry reuse, fallback reason, and separated
warm-up, snapshot, dispatch, kernel, merge, and total timings.

Newer solve and field calls send an immediate control message to the outer
solver worker. Eligible active fields stop receiving work between 512-sample
tiles; their promises reject as `NecRuntimeError` with
`details.reason === "superseded"`. Model operations remain ordered. A crashed
evaluator is reconstructed from the retained snapshot once; unsupported modes,
startup/asset failure, or unrecoverable evaluator failure use the typed serial
fallback recorded in diagnostics. Disposal is idempotent and terminates the
outer worker plus every evaluator child.

Default evaluator worker, loader, and WASM URLs are package-relative and are
included in the tarball. `fieldWorkerAssetBaseUrl` relocates the complete set;
the directory must contain `field-evaluator-worker.js`, `field-evaluator.js`,
`necpp-field-evaluator.generated.js`, and `necpp-field-evaluator.wasm`.
The packed-consumer test covers Node, a non-root Vite base, content-hashed
assets, correct WASM MIME, and non-cross-origin-isolated Chromium.

The mode defaults to `"auto"`, but automatic analysis deliberately has no
default epsilon: omitting `symmetrizer.positionEpsilonM` is `NEC_INPUT`.
`"off"` builds the exact full description and ignores planner options.
`"require"` analyzes normally and raises `NecGeometryError` with the planner
reasons if it cannot prove an eligible nontrivial symmetry. `"auto"` returns
the same facade after deterministic explicit fallback. It retries an already
selected symmetric build at most once, and only for the representation
eligibility refinements `INCOMPATIBLE_GROUND`, `INCOMPLETE_LOAD_ORBIT`, or
`UNSUPPORTED_ELEMENT_PATTERN_TRANSFORM`. Allocation, cancellation,
conditioning, solver, and invalid full-geometry failures are never hidden.

The omitted array `groundConnection` default is `"none"`. Explicit and
symmetric builders pass the same validated value to geometry completion. A
non-none value with `ground.kind === "free-space"` fails with `NecInputError`
before worker construction. A connection to finite ground is not an accurate
ground-stake model in NEC-2 and can make impedance strongly dependent on the
source-segment length; changing the connection requires reconstructing the
solver.

The returned `NecArraySolver` is worker-backed and asynchronous:

```ts
interface NecArraySolver {
  readonly state: NecModelState;
  prepare(options: PrepareOptions): Promise<void>;
  computeImpedanceMatrix(): Promise<ImpedanceResult>;
  solveVoltages(value: ComplexVector): Promise<PortSolution>;
  solveCurrents(value: ComplexVector): Promise<PortSolution>;
  computeFarField(request: FarFieldRequest): Promise<FarFieldResult>;
  computeEmbeddedFarFields(
    request: FarFieldRequest,
    normalization?: EmbeddedFieldNormalization,
  ): Promise<EmbeddedFarFieldResult>;
  cancelFarField(): void;
  getDiagnostics(): ArraySolverDiagnostics;
  dispose(): Promise<void>;
}
```

Its lifecycle from creation is `geometry-complete -> prepared -> solved`; the
factory owns construction, port definition, structural-load expansion, ground
selection, and any eligible explicit retry. Disposal is deterministic and
idempotent. `cancelFarField()` is also idempotent and keeps the solver reusable;
it bounds stale pooled work at tile boundaries and rejects only the active
field request as superseded. All input arrays are borrowed during their
operation and all returned arrays are caller-owned, exactly as for the low-level
direct and worker models.

### Representation-independent order and transforms

Elements and the ports contributed by each pattern retain the order of
`description.elements`, then `pattern.ports`. The facade scatters caller
excitations into native copy-major order and gathers both dimensions of Z/Y,
all achieved/requested port vectors and powers, and the outer embedded-field
basis dimension back into caller order. Ordinary results intentionally contain
no fundamental count, generated tag, copy index, or symmetry variant.
The aggregate `powerBudget` has no port order and passes through unchanged.

An accepted reflection candidate canonicalizes centered positions with sign
transforms. An accepted rotational candidate uses

```text
angle(copyIndex) = copyIndex * 2*pi/order, copyIndex = 0..order-1
```

and the native rotation center remains global Z through `(0,0)`. The planner
may translate a homogeneous-ground/free-space description by an effective XY
center before construction. Translation does not change Z, Y, port quantities,
or powers. Because fields are referenced to the caller's original origin, the
facade restores every combined and embedded complex field sample with

```text
E_caller(u) = E_centered(u) * exp(+j*k*u dot center)
u           = (sin(theta) cos(phi), sin(theta) sin(phi), cos(theta))
```

which is the required correction under the package's `e^(+j omega t)` and
outgoing `e^(-jkR)` convention.

### Planner acceptance and diagnostics

All element IDs must be unique and every element must reference a known
pattern. Candidate matching is one-to-one: every transformed position must
have exactly one same-pattern counterpart within the caller's epsilon, every
orbit must contain the full section count, and no element may be fixed on a
generating plane or rotation axis. Exact matching is the special
`positionEpsilonM: 0` case; it does not use rounded keys or an implicit
tolerance. Candidate selection is deterministic across caller permutations.

For positive epsilon, an accepted orbit is replaced by exact group-related
coordinates. Every replacement is disclosed as a `PositionCanonicalization`
with caller index, original/canonical coordinates, XY adjustment vector, and
Euclidean distance. `maxPositionAdjustmentM` is the maximum of those distances
and `exact` is false whenever any nonzero adjustment occurs. Canonicalization
must remain one-to-one; a collision or ambiguous match falls back rather than
silently merging elements.

`getDiagnostics()` returns:

```ts
interface ArraySolverDiagnostics {
  readonly representation: "explicit" | "symmetric";
  readonly planner: {
    readonly representation: "explicit" | "symmetric";
    readonly exact: boolean;
    readonly effectiveCenterM: readonly [number, number];
    readonly maxPositionAdjustmentM: number;
    readonly canonicalizations: readonly PositionCanonicalization[];
    readonly candidates: readonly SymmetryCandidateDiagnostics[];
    readonly reasons: readonly SymmetrizationReason[];
  };
  readonly symmetry?: SymmetryExpansion;
}
```

The data is immutable and structured-cloneable. Candidate records include the
descriptor tested, acceptance flag, and reasons. Fallback reasons have stable
codes:

| Code | Meaning |
|---|---|
| `NO_NONTRIVIAL_SYMMETRY` | No supported candidate produced more than one section |
| `FIXED_ELEMENT_ON_REFLECTION_PLANE` | A reflection would duplicate an element on its generating plane |
| `FIXED_ELEMENT_ON_ROTATION_AXIS` | A rotation would duplicate an element on global Z |
| `POSITION_OUTSIDE_EPSILON` | A required counterpart is farther away than the explicit tolerance |
| `AMBIGUOUS_POSITION_MATCH` | A transformed point has zero or multiple admissible one-to-one matches |
| `PATTERN_MISMATCH` | The geometric counterpart uses a different reusable element pattern |
| `UNSUPPORTED_ELEMENT_PATTERN_TRANSFORM` | Pattern geometry/orientation cannot enter the first-release symmetry path |
| `UNSYMMETRIC_LOAD` | Structural loads do not form equal complete orbits |
| `GROUND_BREAKS_SYMMETRY` | The radiating environment is not invariant under the candidate |
| `TAG_SPACE_EXHAUSTED` | Generated positive tags would exceed the native signed-32-bit range |

### Supported pattern and environment matrix

| Feature | Explicit model | Transparent reflection | Transparent rotation |
|---|---:|---:|---:|
| Straight Z wire(s), local X=Y=0 | Yes | Yes | Yes |
| Zero/omitted element rotation | Yes | Required | Required |
| Arbitrary current/voltage weights | Yes | Yes | Yes |
| Pattern-relative equal load orbit | Yes | Yes, expanded atomically | Yes, expanded atomically |
| Free space | Yes | X/Y/Z planes | Global-Z rotation |
| Homogeneous perfect/finite horizontal ground | Yes | X/Y planes only | Global-Z rotation |
| Odd centered square with fixed elements | Yes | Fallback | Fallback |
| Tilted/off-axis wire, rotated pattern, helix, arc, or patch | Yes where low-level geometry supports it | Fallback/error | Fallback/error |

The structural geometry, material/load distribution, and radiating environment
must be invariant. Sources, requested port currents or voltages, and
non-radiating networks do not need to be symmetric. The planner accepts neither
general dihedral composition nor explicit `GM`-style copies as a substitute for
one supported group.

The helix/transform prohibition is intentional. Future acceptance requires an
explicit contract and executable mapping for handedness under reflection,
endpoint direction, segment-number reversal, current/voltage port polarity,
local orientation under rotation, and the gather mapping for every exposed
quantity. Until all of those agree, such patterns stay explicit or fail under
the caller's requested policy.

## Worker facade

`createNecWorkerModel()` is imported from `@necpp-engine/wasm/worker`. The package
supplies the worker script; a consumer does not write a bootstrap file. Each
call creates an isolated worker and Emscripten instance. Methods match
`NecModel` but return promises and are serialized per model. Progress
callbacks fire at coarse `start`/`complete` boundaries, including worker-only
`create`. Large result `ArrayBuffer`s are transferred, not structured-cloned.
Input arrays remain caller-owned.

`terminate()` is the cancellation mechanism: it kills the worker, rejects
outstanding operations with `NecRuntimeError`, and leaves the model
`disposed`. `dispose()` destroys the native handle first, then terminates.
The direct `createNecModel()` entry point is unchanged for Node, tests, and
small models. Browser integration tests exercise direct, worker, and
transparent example paths from the inspected release tarball. The worker client constructs

```ts
new Worker(new URL("./worker-entry.js", import.meta.url), { type: "module" })
```

so bundlers can rewrite the worker URL without extra consumer configuration.
Direct mode needs no bundler config. Vite apps that
import the worker set `worker: { format: "es" }` because the package ships a
module worker.

## Canonical test models

All fixtures use free space, 300 MHz, round PEC wire of radius 0.001 m, 11
segments per element, and a centre port at segment 6. Coordinates are metres.
The exact native builders live in
[`wasm_api_contract_tb.cpp`](../src/wasm_api_contract_tb.cpp).

| Fixture | Wires `(tag: start -> end)` | Ports | Baseline excitation |
|---|---|---|---|
| Centre-fed dipole | `1: (0,0,-0.25) -> (0,0,0.25)` | `(1,6)` | 1 + j0 V |
| Two parallel coupled dipoles | Dipole 1 plus `2: (0.20,0,-0.25) -> (0.20,0,0.25)` | `(1,6)`, `(2,6)` | Port 1: 1 V; port 2: 0 V in future matrix tests. WP0 native baseline drives port 1 only. |
| Four-element linear array | Tags 1..4 at x = `-0.45, -0.15, 0.15, 0.45`, each spanning z = `-0.25..0.25` | Centre segment of tags 1..4 | Simultaneous voltages with progressive phases 0°, 30°, 60°, 90° |

WP0 tests run all three through the existing programmatic native API—without
generating or parsing a deck—before the stateful layer is introduced. The
dipole also locks current direction and the (e^{-jkR}/R) field phase/range
law as executable tests.

## Numerical tolerance policy

Comparisons of complex vectors or matrices produced by two paths use the
scale-aware relative error

\[
  \epsilon(a,b)=
  \frac{\lVert a-b\rVert_2}
       {\max(1,\lVert a\rVert_2,\lVert b\rVert_2)}.
\]

The normal limit is `1e-7`. Full explicit versus manual/automatic symmetric
representations use stricter `1e-8` relative-L2 and scaled-maximum gates for
complete complex Z/Y, requested and achieved port quantities, powers, and
complex fields. Algebraic identities using results from the same
factorization (for example \(ZY\approx I\)) use `1e-7`. Exact metadata,
array sizes/order, generations, state transitions, zero-excitation output,
and ownership behavior have zero tolerance.

Independent NEC-2 golden values may use a fixture-specific tolerance up to
`3e-4` relative or absolute, whichever is larger, because legacy report
values are rounded and implementations differ slightly in constants. Every
such test must state the source and its looser bound next to the assertion.
Reciprocity and geometric symmetry use `1e-8` unless a fixture documents why
segmentation breaks exact symmetry. The radial field law uses `1e-10` for the
magnitude ratio and `1e-10` radians for phase after comparing complex ratios,
because both fields reuse identical currents and differ only by the analytic
range factor. Native-to-WASM bulk arrays use `1e-12`; both execute the same
binary64 code path.

Tests must reject NaN or infinity before applying a tolerance. Phase is
compared as a wrapped complex ratio, never by subtracting printed degree
values across a ±180° branch cut.

Current-coefficient reconstruction, unit-current port normalization, and
prepared-quadrature layout comparisons use the additional gates in
[`current-quadrature-api.md`](current-quadrature-api.md).
