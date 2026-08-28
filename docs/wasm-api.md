# `@necpp/wasm` API and numerical contract

Status: normative specification, updated through WP7 on 2026-08-28. The
stateful native layer, versioned C/WASM ABI, handwritten TypeScript facade,
optional Web Worker entry point, and packable npm package are implemented.
The committed TypeScript surface is in [`packages/necpp-wasm/src`](../packages/necpp-wasm/src).

## Package and runtime boundary

The final npm package name is **`@necpp/wasm`**. The unscoped name
`necpp-wasm` is already occupied by a separately published distribution,
while the scoped name identifies this repository and leaves room for future `@necpp/*`
packages. Publication requires control of the `necpp` npm scope, but the API
name will not change if the package is initially distributed as a tarball.
The package is ESM-only and requires Node 24 or later for Node consumers.

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
from `@necpp/wasm/worker`; its methods are asynchronous, serialized per model,
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
  \(c_0=299{,}800{,}000\ \mathrm{m/s}\).
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

Additional lifecycle rules:

- Geometry can change only before `completeGeometry()` and completion occurs
  exactly once. At least one valid geometry element is required.
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
| `addWire(wire)` | Positive integer tag/count; distinct finite endpoints and positive finite radius, all in m | `void`; copies the definition | `NecInputError` for shape/range errors; `NecGeometryError` for engine geometry limits |
| `completeGeometry(options?)` | Ground connection: `none` (default), `interpolate`, or `zero-current` | `void` | `NecGeometryError` for intersections, invalid junctions, or a ground-incompatible structure |
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
handling. Messages and `details` aid diagnostics but are not a compatibility
surface. Validation failures do not mutate model state. A failed calculation
keeps the last successfully prepared factorization and consumer solution when
the native layer can prove they are intact; otherwise it rolls back to
`geometry-complete` and discards prepared data.

## Worker facade

`createNecWorkerModel()` is imported from `@necpp/wasm/worker`. The package
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
small models. Browser integration of this subpath after bundling is a WP7/WP8
packaging concern; the worker client constructs

```ts
new Worker(new URL("./worker-entry.js", import.meta.url), { type: "module" })
```

so bundlers can rewrite the worker URL without extra consumer configuration.
WP7 packs this subpath. Direct mode needs no bundler config. Vite apps that
import the worker set `worker: { format: "es" }` because the package ships a
module worker. Browser CI for the worker subpath is WP8.

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

The normal limit is `1e-7`. Algebraic identities using results from the same
factorization (for example \(ZY\approx I\)) also use `1e-7`. Exact metadata,
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
