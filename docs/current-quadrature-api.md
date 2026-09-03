# Isolated-element current and prepared quadrature contract

Status: frozen by WP0 (2026-09-02). WP1 implemented the native exact-current
API. WP2 implemented the native prepared-quadrature evaluator and packed NECQ
layout. WP3 implements native isolated-element characterization. WP4 implements
the additive C/WASM ABI, `NecModel` / `NecWorkerModel` methods, worker
transfer, and the visualizer MessagePort handoff. WP5 publishes versioned
fixtures and numerical/consumer validation. WP6 records performance evidence,
docs, and the pin-ready `@necpp-engine/wasm@0.5.0` pack. This document is
the normative public contract for exact NEC current coefficients, prepared
quadrature sampling, isolated-element characterization, and the visualizer
handoff. Existing Z/Y, solves, fields, power, and lifecycle in
[`wasm-api.md`](wasm-api.md) are unchanged. Type sketches live in
[`packages/necpp-wasm/src/types.ts`](../packages/necpp-wasm/src/types.ts).

WP0 exports types only. WP1 adds `nec_stateful_model::get_current_distribution`
and `nec_evaluate_segment_current`. WP2 adds
`nec_stateful_model::prepare_current_quadrature` and the packed NECQ buffer.
WP3 adds `nec_stateful_model::characterize_isolated_element`.
WP4 adds C ABI entry points, TypeScript façades, packed NECF, and handoff.
WP5 publishes versioned NECQ/NECF fixtures and validates native internals,
direct/worker/handoff agreement, and Rust bind-once ingestion.
WP6 records characterization/transfer/bind evidence and the 0.5.0 pack pin.
Names below are frozen; later WPs must not weaken the semantics.

The work tracker is
[`public-current-quadrature-api-plan.md`](public-current-quadrature-api-plan.md).

## Goal

From public APIs, a consumer characterizes one isolated NEC antenna at one
frequency and obtains isolated Z/Y, exact unit-current segment-current modes,
immutable currents at caller-defined quadrature nodes, and matching NEC-native
embedded complex patterns. Large immutable data moves once between compute
workers or WASM memories. It does not pass through UI TypeScript or React
state.

## Numerical conventions

All [`wasm-api.md`](wasm-api.md) conventions apply: \(e^{+j\omega t}\),
outgoing \(e^{-jkR}/R\), metres, MHz, peak-amplitude phasors, port current
positive into the antenna, \(P=\tfrac12\operatorname{Re}(VI^*)\).

Public current geometry is in metres. Do not publish the internal far-field
snapshot units. That snapshot stores wavelength-normalized centres and
`segment_half_lengths = π L_wavelength` for `ffld()`. WP1 converts to metres
as `wavelength_m` times those scaled arrays.

## Coefficient formula

Public `A`, `B`, `C` are ampere-valued physical current coefficients. NEC's
native `air/aii`, `bir/bii`, `cir/cii` arrays are coefficients in its
wavelength-normalized coordinate system and scale as A/m; capture multiplies
all three coefficient pairs by `wavelength_m` before exposing them. This is
the same conversion used by legacy structure-current reporting. Interpolation
along a physical segment is the stored expansion

```text
I(s) = A + B sin(k s) + C cos(k s)
```

with \(A=\mathrm{air}+j\,\mathrm{aii}\), \(B=\mathrm{bir}+j\,\mathrm{bii}\),
\(C=\mathrm{cir}+j\,\mathrm{cii}\), \(k=2\pi/\lambda\), and \(s\) the signed
distance in metres from the segment centre along unit tangent
\((\mathrm{cab},\mathrm{sab},\mathrm{salp})\) (wire start toward wire end).
The centre current is \(I(0)=A+C\), matching `curx[i] = A+C`. Equivalent form:

```text
I(s) = (A+C) + B sin(k s) + C (cos(k s) - 1)
```

The public current evaluator and the internal field evaluator must share this
formula. Surface patches are out of the first public current API.

This conversion fixes values under the existing schema-1 contract; it does
not change the C++ layout, C/WASM ABI, TypeScript shape, NECQ byte layout, or
NECF byte layout. Direct current distributions and NECQ receive the corrected
ampere-valued A/B/C samples from the same producer. NECF is generated directly
from the corresponding native unit-current solve and is not rescaled from
NECQ; scale-property tests therefore gate both products together and verify
the far-zone law `E * wavelength_m = constant` when observation radius is held
constant in wavelengths.

The complete normalization path is: the port solver chooses a voltage that
produces 1 A at the requested feed; NEC stores the resulting basis
coefficients in wavelength-normalized form; `copy_current_coefficient_mode`
converts those coefficients to amperes; segment-centre reconstruction and
caller-node interpolation consume the converted planes; NECQ serializes those
samples; and the direct and worker characterization APIs transfer the same
packed values. The latest-solution and prepared unit-current distribution APIs
also share this producer. NECF instead evaluates the native solved mode before
packing its embedded fields, so it neither consumes nor duplicates the NECQ
conversion.

Before the correction, the new 30 MHz scale regression reproduced a
feed-centre value of `0.10006816720511469 A` for a requested 1 A mode, equal to
`1 / wavelength_m`. The pre-existing 300 MHz fixture hid the same error with
`1.000681672051142 A` because its wavelength is close to one metre. After the
correction, scale-property tests at 30, 300, 1000, 1379, and 10000 MHz preserve
the 1 A feed, current shape, impedance, power, and wavelength-scaled far field;
direct and worker NECQ/NECF results are also checked together. Two-by-two and
four-by-four dipole-array tests additionally hold the full complex mutual-
impedance matrix, reciprocity, and passivity invariant between scaled models.

## Ordering, identity, and junctions

Physical segments only, in caller `addWire` order, then 1-based
segment-within-tag (same addressing as ports). Each segment carries:

- `tag`, `segment` (1-based in tag), `nativeIndex` (0-based NEC);
- centre, start, and end in metres;
- unit tangent, radius, length;
- decoded start and end connections.

Native `icon1`/`icon2` integers are not a public key. Decode them:

| Native `icon` | Meaning |
|---|---|
| `0` | Free end |
| Equal to this segment’s 1-based index | Perfect-ground interpolating image (`GE +1`) |
| `> 0` | Connected to that 1-based native segment |
| `< 0` | Connected to `abs(icon)`, opposite end of that segment |

For `icon1` (this start): positive means the other segment’s **end**; negative
means the other segment’s **start**. For `icon2` (this end): positive means the
other segment’s **start**; negative means the other segment’s **end**.
`PCHCON` patch connections are rejected as unsupported.

The logical-to-native map is first-class metadata. Tests fail if native order
is treated as public order.

## Normalization and polarity

- **Latest-solution** currents are the current consumer solve, unmodified.
- **Unit-current** modes: one mode per `definePorts()` entry in that order.
  Requested \(I_p=1+j0\) A at the selected port and zero at every other port.
  Achieved port current is 1 A within the unit-current tolerance below.
- Positive current is into the antenna along existing port polarity.
- Characterization and unit-current current capture share the existing
  embedded-field basis-solve loop. WP3 must perform exactly one unit-current
  basis solve per port unless this document records a justified fallback.

## Image policy

Default prepared output is **physical samples only**. Perfect-ground images
are an explicit request and occupy a second plane. They are never mixed into
the physical plane.

Image of a physical sample (PEC):

```text
(x, y, z)  -> (x, y, -z)
(tx, ty, tz) -> (tx, ty, -tz)
I' = -I
```

so \(I_x\) and \(I_y\) reverse and \(I_z\) stays. Finite-ground and
surface-patch image modes are capability-rejected, matching
`nec_far_field_snapshot_capability`. Rooted monopoles
(`groundConnection: "interpolate"`) still return only physical wires unless
images are requested. NEC’s internal image basis is not a second public
segment list.

## Quadrature request

WP2 implements this request. Nodes \(\xi\in[-1,1]\) on every physical
segment: \(-1\) start, \(0\) centre, \(+1\) end. Local arc length is
\(s=\xi L/2\) metres. Optional weights \(w\) have the same length. The stored
effective weight is \((L/2)\,w\) (`ds * w`). Omitted weights mean \(w_i=1\),
so `dsWeight = L/2` and `hasWeights` is clear. Empty node lists, mismatched
weights, nonfinite values, \(\xi\) outside \([-1,1]\), free-space or finite-
ground image requests, and oversize jobs are `NecInputError`. Repeated
retrieval is a cached read of the packed buffer: no geometry walk,
trigonometry, interpolation, or capacity-growing allocation.

## Public TypeScript names

Methods are not on `NecModel` in WP0. Types are exported from
`@necpp-engine/wasm`.

```ts
type CurrentModeKind = "latest-solution" | "unit-current";

type NecSegmentEnd =
  | { readonly kind: "free" }
  | { readonly kind: "ground" }
  | {
      readonly kind: "segment";
      readonly tag: number;
      readonly segment: number;
      readonly end: "start" | "end";
    };

interface NecSegmentIdentity {
  readonly tag: number;
  readonly segment: number;
  readonly nativeIndex: number;
}

interface NecCurrentDistribution {
  readonly schemaVersion: 1;
  readonly frequencyMHz: number;
  readonly wavelengthM: number;
  readonly modeKind: CurrentModeKind;
  readonly modeCount: number;
  readonly segments: readonly NecSegmentIdentity[];
  readonly startEnds: readonly NecSegmentEnd[];
  readonly endEnds: readonly NecSegmentEnd[];
  readonly centresM: Float64Array;  // 3 * nSegments
  readonly startsM: Float64Array;
  readonly endsM: Float64Array;
  readonly tangents: Float64Array;
  readonly radiiM: Float64Array;
  readonly lengthsM: Float64Array;
  // Mode-major planes: index = modeIndex * nSegments + segmentIndex.
  readonly aReal: Float64Array;
  readonly aImag: Float64Array;
  readonly bReal: Float64Array;
  readonly bImag: Float64Array;
  readonly cReal: Float64Array;
  readonly cImag: Float64Array;
}

interface PreparedQuadratureRequest {
  readonly nodes: Float64Array;
  readonly weights?: Float64Array;
  readonly images: "physical-only" | "perfect-ground-images";
  readonly modes: CurrentModeKind;
}

interface PreparedTransferHandle {
  readonly schemaVersion: 1;
  readonly byteLength: number;
  readonly buffer: ArrayBuffer;
}

interface IsolatedElementRequest {
  readonly quadrature: PreparedQuadratureRequest; // modes must be "unit-current"
  readonly field: FarFieldRequest;
}

interface IsolatedElementCharacterization {
  readonly impedance: ComplexMatrix;
  readonly admittance: ComplexMatrix;
  readonly quadrature: PreparedTransferHandle;
  readonly embeddedField: PreparedTransferHandle;
}
```

`NecCurrentDistribution` is the verification/exact-coefficient object (WP1).
Normal visualizer flow uses transfer handles only (WP4). Direct/Node copies of
`NecCurrentDistribution` are JS-owned, like `FarFieldResult`. Worker clients
receive metadata and handles, not A/B/C arrays, during normal operation.
WP3 exports `IsolatedElementRequest`; `NecModel.characterizeIsolatedElement`
waits for WP4.

## Native WP1 API

Implemented in [`src/nec_current_distribution.h`](../src/nec_current_distribution.h)
and [`src/nec_stateful_model.h`](../src/nec_stateful_model.h). Layout matches
the TypeScript names above, in snake_case.

```cpp
enum class nec_current_mode_kind { latest_solution, unit_current };

nec_complex nec_evaluate_segment_current(
  nec_complex a, nec_complex b, nec_complex c,
  nec_float k, nec_float s);

nec_segment_end nec_decode_segment_end(
  const c_geometry& geometry, int native_index, bool start_end);

void nec_fill_current_geometry(
  const c_geometry& geometry,
  nec_float wavelength_m,
  nec_current_distribution& output);

nec_current_distribution
nec_stateful_model::get_current_distribution(nec_current_mode_kind kind);
```

`get_current_distribution` returns an owned value. `latest_solution` requires
`solved`. `unit_current` is allowed from `prepared` or `solved` and restores a
prior consumer solution and `solve_generation`, matching
`compute_embedded_far_fields`. Geometry is `wavelength_m` times the
frequency-scaled NEC arrays (metres). Surface patches and `PCHCON` connections
fail with `CURRENT DISTRIBUTION: SURFACE PATCHES ARE UNSUPPORTED`.

The field kernel still integrates the same `A/B/C` arrays; it is not rewritten
to sample `I(s)`. WP2 quadrature calls `nec_evaluate_segment_current`.

## Native WP2 API

Implemented in
[`src/nec_prepared_current_quadrature.h`](../src/nec_prepared_current_quadrature.h)
and [`src/nec_stateful_model.h`](../src/nec_stateful_model.h).

```cpp
enum class nec_prepared_quadrature_images {
  physical_only, perfect_ground_images };

struct nec_prepared_quadrature_request {
  std::vector<nec_float> nodes;
  std::vector<nec_float> weights;  // empty = omitted, w_i = 1
  nec_prepared_quadrature_images images;
  nec_current_mode_kind modes;
};

nec_complex nec_evaluate_quadrature_current(
  const nec_current_distribution& distribution,
  size_t mode, size_t segment, nec_float xi);

nec_prepared_current_quadrature nec_prepare_current_quadrature(
  const nec_current_distribution& distribution,
  const nec_prepared_quadrature_request& request,
  uint64_t model_generation, uint64_t solution_generation,
  bool perfect_ground);

nec_prepared_current_quadrature
nec_stateful_model::prepare_current_quadrature(
  const nec_prepared_quadrature_request& request);

nec_prepared_quadrature_view nec_view_prepared_quadrature(
  const nec_prepared_current_quadrature& prepared);
```

`prepare_current_quadrature` returns an owned packed NECQ buffer. It calls
`get_current_distribution` once, then packs. `latest_solution` requires
`solved`. `unit_current` is allowed from `prepared` or `solved` and restores a
prior consumer solution. Perfect-ground images require `ground.kind ==
perfect`; free space and finite ground fail with
`PREPARED QUADRATURE: PERFECT-GROUND IMAGES REQUIRE PERFECT GROUND`.
`release()` is idempotent. Retrieval (`data()`, `byte_length()`, view) does
not walk geometry, evaluate trigonometry, interpolate, or grow capacity.

C ABI, `NecModel` methods, and `state-machine.ts` rows wait for WP4.

## Native WP3 API

Implemented in
[`src/nec_isolated_element_characterization.h`](../src/nec_isolated_element_characterization.h)
and [`src/nec_stateful_model.h`](../src/nec_stateful_model.h). The C ABI and
TypeScript methods are in the WP4 sections below.

```cpp
struct nec_isolated_element_request {
  nec_prepared_quadrature_request quadrature;
  nec_far_field_grid grid;
};

struct nec_isolated_element_characterization {
  nec_impedance_result matrices;
  nec_prepared_current_quadrature quadrature;
  nec_embedded_far_field_result embedded_field;
};

nec_isolated_element_characterization
nec_stateful_model::characterize_isolated_element(
  const nec_isolated_element_request& request);

uint64_t nec_stateful_model::unit_current_basis_solve_count() const;
```

Characterization is allowed from `prepared` or `solved` and restores a prior
consumer solution, matching `compute_embedded_far_fields`.
`quadrature.modes` must be `unit_current`. The operation:

1. uses cached `compute_impedance_matrix()` for isolated Z/Y (unit-voltage
   columns when cold; not counted as unit-current basis solves);
2. runs one shared unit-current basis loop per port that captures A/B/C and
   NEC embedded fields from the same solve;
3. packs the NECQ buffer from those captured currents.

Do not call `get_current_distribution`, `prepare_current_quadrature`, or
`compute_embedded_far_fields` from this path. After a warm Z/Y cache the
unit-current basis-solve counter increases by `nPorts`. Returned fields match
`compute_embedded_far_fields(..., unit_current)` at the existing `1e-7`
same-path gate and remain NEC-generated. The result is an owned snapshot,
cacheable by geometry, frequency, ports, ground, quadrature rule, and field
grid; WP3 does not retain it on `nec_stateful_model`. WP4 retains packed NECQ
and NECF on the ABI model until `clear_calculated_results` / `dispose`.

## TypeScript methods

On `NecModel` / `NecWorkerModel` (worker methods return `Promise<…>`). Not on
`NecArraySolver`.

```ts
getCurrentDistribution(options: { kind: CurrentModeKind }): NecCurrentDistribution
prepareCurrentQuadrature(request: PreparedQuadratureRequest): PreparedTransferHandle
characterizeIsolatedElement(request: IsolatedElementRequest): IsolatedElementCharacterization
// worker-only overload:
characterizeIsolatedElement(
  request: IsolatedElementRequest,
  options: { destination: MessagePort },
): IsolatedElementHandoff
```

Direct/Node `NecCurrentDistribution` is a JS-owned copy, like `FarFieldResult`.
Visualizer-normal flow uses transfer handles from prepare/characterize, not
A/B/C planes on the UI thread.

Kind gates stay in the method, not extra state-machine ops:

- `getCurrentDistribution({ kind: "latest-solution" })` and
  `prepareCurrentQuadrature` with `modes: "latest-solution"` require `solved`
  (`NecStateError` otherwise).
- `characterizeIsolatedElement` requires `quadrature.modes === "unit-current"`
  (`NecInputError`).

`IsolatedElementRequest.field` is validated with the existing far-field grid
rules. Quadrature nodes/weights/images/modes are validated in TypeScript
before the native call.

## C ABI (`abiVersion` stays 1)

Declared in [`src/necpp_wasm_v1.h`](../src/necpp_wasm_v1.h). Borrowed pointers
remain copy-immediately. New symbols are listed in
`src/CMakeLists.txt` `EXPORTED_FUNCTIONS`.

```c
int32_t necpp_wasm_v1_get_current_distribution(model, int32_t mode);
  /* 0 = latest_solution, 1 = unit_current */

int32_t necpp_wasm_v1_prepare_current_quadrature(
  model, const double* nodes, size_t node_count,
  const double* weights, size_t weight_count, /* null/0 = omitted */
  int32_t images, /* 0 physical-only, 1 perfect-ground-images */
  int32_t modes);

int32_t necpp_wasm_v1_characterize_isolated_element(
  model, const double* nodes, size_t node_count,
  const double* weights, size_t weight_count, int32_t images,
  double radius_m,
  double theta_start_deg, int32_t theta_count, double theta_step_deg,
  double phi_start_deg, int32_t phi_count, double phi_step_deg);
  /* modes are always unit-current; no mode argument */
```

Characterization still shares WP3’s one-solve-per-port path. It syncs Z/Y into
existing impedance kinds 0–3 and packs NECF. It does **not** overwrite
embedded kinds 19–24. Get-current does not clear impedance.

### f64 kinds 38–49 (`result_buffer`)

| Kind | Name | Length |
|---|---|---|
| 38–41 | `CURRENT_CENTRES/STARTS/ENDS/TANGENTS` | `3 * nSeg` |
| 42–43 | `CURRENT_RADII/LENGTHS` | `nSeg` |
| 44–49 | `CURRENT_A/B/C_REAL/IMAG` | `nModes * nSeg` |

Scalars: `current_segment_count`, `current_mode_count`, `current_mode_kind`,
`current_frequency_mhz`, `current_wavelength_m`.

### i32 identity buffers

```c
const int32_t* necpp_wasm_v1_int32_result_buffer(model, int32_t kind);
size_t necpp_wasm_v1_int32_result_buffer_length(model, int32_t kind);
```

Kinds start at 0: `CURRENT_TAG`, `CURRENT_SEGMENT`, `CURRENT_NATIVE_INDEX`,
then start/end `KIND/TAG/SEGMENT/END` (8 arrays). End encoding: kind
`0=free`, `1=ground`, `2=segment`; `end` is `0=start`, `1=end`. TypeScript
rebuilds `NecSegmentEnd` objects from these planes.

### Packed byte buffers

```c
enum { PACKED_QUADRATURE = 0, PACKED_EMBEDDED_FIELD = 1 };
const uint8_t* necpp_wasm_v1_packed_buffer(model, int32_t kind);
size_t necpp_wasm_v1_packed_buffer_length(model, int32_t kind);
```

Packed retrieve is a pointer/length read. Native tests are tagged
`[wasm_api][current_quadrature][wp4_current]`, not `[wp4]`.

## Ownership, invalidation, and errors

| Object | Ownership | Invalidation |
|---|---|---|
| `NecCurrentDistribution` | Direct/Node: JS-owned copies. Worker: transferred typed arrays revived on the client | Latest-solution: next solve, configuration-changing `prepare`, or `dispose`. Unit-current modes: geometry, frequency, and port identity, not the latest consumer excitation |
| `PreparedTransferHandle` (NECQ / NECF) | Owned `ArrayBuffer`. Direct: JS copy from WASM HEAP. Worker: transferred. Handoff: transferred to the destination port, not the UI client | Geometry generation, frequency, mode set, node/weight/image rule, field grid (NECF), `dispose` of the producing model (client-owned copies stay) |
| `IsolatedElementCharacterization` | Z/Y plus two transfer handles | Geometry, frequency, ports, ground, quadrature rule, field-grid identity |
| `IsolatedElementHandoff` | Z/Y plus `byteLength`s only; large buffers never materialize on the client | Same identity as characterization |

Reuse the existing error taxonomy. No new error class.

Lifecycle in [`packages/necpp-wasm/src/state-machine.ts`](../packages/necpp-wasm/src/state-machine.ts):

| Operation | empty | geometry-building | geometry-complete | prepared | solved | disposed |
|---|---|---|---|---|---|---|
| `getCurrentDistribution({ kind: "latest-solution" })` | — | — | — | — | same | — |
| `getCurrentDistribution({ kind: "unit-current" })` | — | — | — | same | same | — |
| `prepareCurrentQuadrature` | — | — | — | same* | same | — |
| `characterizeIsolatedElement` | — | — | — | same | same | — |

`prepareCurrentQuadrature` with `modes: "latest-solution"` requires `solved`.
Unit-current current capture and characterization preserve a prior consumer
solution and public generations, matching `computeEmbeddedFarFields`.
In-progress native characterize is not interruptible. `dispose` / `terminate`
drop ABI slots; packed `release` is idempotent.

`abiVersion` stays `1`. New C functions and `necpp_wasm_v1_result_buffer_kind`
values are additive after snapshot kinds 25–37.

## Packed transfer layout

Quadrature is one little-endian `ArrayBuffer`, schema 1. Magic is the four
ASCII bytes `N E C Q` at offset 0, not a host-endian integer.

```text
Header (64 bytes, little-endian)
  0  u8[4]  magic ASCII N E C Q
  4  u32    schemaVersion = 1
  8  u32    flags: bit0 = images, bit1 = hasWeights
 12  u32    nSegments
 16  u32    nSamplesPerSegment   // nNodes
 20  u32    nModes
 24  u32    nImagePlanes         // 1 or 2
 28  u32    reserved = 0
 32  f64    frequencyMHz
 40  f64    wavelengthM
 48  u64    modelGeneration      // factorization_generation
 56  u64    solutionGeneration   // 0 if never solved

Identity (physical plane only), then 0–4 pad bytes to 8-byte alignment
  tag[nSeg], segment[nSeg], nativeIndex[nSeg] as i32

Geometry SoA, each plane length N = nSeg * nNodes * nImagePlanes
  x, y, z, tx, ty, tz, radiusM, lengthM, dsWeight   // f64
  index = (plane * nSeg + segment) * nNodes + node
  plane 0 = physical, plane 1 = PEC image

Currents, mode-major then plane then sample
  iReal[nModes * N], iImag[nModes * N]
  index = ((mode * nImagePlanes + plane) * nSeg + segment) * nNodes + node
```

Geometry is **per sample**, matching the memory budget
`9 * nSeg * nNodes * nImagePlanes * 8`. WP0 prose that said
`nSegments * nImagePlanes` was incorrect.

Embedded field is the same `PreparedTransferHandle` type but **must not** use
NECQ magic. Pack existing basis-major planes into one little-endian envelope:

```text
Header (64 bytes)
  0  u8[4]  magic ASCII N E C F
  4  u32    schemaVersion = 1
  8  u32    nPorts
 12  u32    nTheta
 16  u32    nPhi
 20  u32    samplesPerPort
 24  u32    reserved = 0
 28  u32    reserved = 0
 32  f64    frequencyMHz
 40  f64    radiusM
 48  u64    modelGeneration
 56  u64    reserved = 0
Then f64 planes:
  thetaDeg[nTheta], phiDeg[nPhi],
  eThetaReal, eThetaImag, ePhiReal, ePhiImag
  each length nPorts * samplesPerPort, port-major (same as EmbeddedFarFieldResult)
```

This is a transfer envelope of the existing `computeEmbeddedFarFields` layout,
not a new field kernel. Z/Y stay `ComplexMatrix` (tiny; allowed on the client
even in handoff mode).

No JSON for numeric planes. Worker operations `getCurrentDistribution`,
`prepareCurrentQuadrature`, and `characterizeIsolatedElement` use the same
`transferredBufferCount` pattern as far-field arrays. Inbound `nodes` /
`weights` clone+transfer like solve vectors. Results go through
`collectTransferables` / `revivePreparedTransferHandle` /
`reviveIsolatedElementCharacterization`. Inbound `MessagePort` for handoff
sits on the transfer list, not inside structured-clone args.

## Visualizer handoff

Two supported embeddings:

1. **Same-worker (document):** the visualizer compute worker calls
   `createNecModel()` in-process, copies NECQ/NECF once into Rust/WASM, and
   retains them. One bounded inter-memory copy. No MessagePort.
2. **Worker-to-worker:** main creates a `MessageChannel`, transfers `port2` to
   a consumer worker and `port1` into
   `characterizeIsolatedElement(request, { destination })`. The NEC worker
   posts one message and transfers the two large buffers. The client Promise
   resolves to compact metadata only (Z/Y + `byteLength`s). Main never holds
   the current/pattern `ArrayBuffer`s.

Public helper on both package entries:

```ts
transferIsolatedElementCharacterization(
  characterization: IsolatedElementCharacterization,
  destination: MessagePort,
): IsolatedElementHandoff
```

Handoff message (schema 1):

```ts
{
  kind: "isolated-element-characterization",
  schemaVersion: 1,
  impedance, admittance,
  quadrature: PreparedTransferHandle,   // NECQ
  embeddedField: PreparedTransferHandle, // NECF
}
```

The receiver binds once (keeps the buffers). A follow-up “steer” message must
not re-transfer them. Repeat characterize with a new destination is a new bind.

A compilable Rust view sketch is
[`packages/necpp-wasm/rust/necq_view.rs`](../packages/necpp-wasm/rust/necq_view.rs)
with notes in [`necq-rust-binder.md`](necq-rust-binder.md).

```text
NEC package worker (native WASM -> owned ArrayBuffer)
        | transfer once
visualizer compute worker (Rust/WASM bind, retain)
```

## Canonical fixtures

All fixtures use 300 MHz and radius 0.001 m. No deck parsing. Native builders
live in [`src/current_quadrature_wp0_tb.cpp`](../src/current_quadrature_wp0_tb.cpp).
Package builders live in
[`packages/necpp-wasm/test/fixtures/current-quadrature.mjs`](../packages/necpp-wasm/test/fixtures/current-quadrature.mjs).

Two through-crossing dipoles that occupy the same origin in one plane fail
NEC overlap checking: a segment centre falls inside the other wire without
sharing a node. The connected turnstile is therefore four half-wires that
meet at the origin.

| Id | Geometry | Ground | Ports |
|---|---|---|---|
| `dipole` | Tag 1: `(0,0,-0.25)→(0,0,0.25)`, 11 segments | free space | `(1,6)` |
| `rooted-monopole` | Tag 1: `(0,0,0)→(0,0,0.25)`, 11 segments | perfect + `interpolate` | `(1,1)` |
| `bent-multiwire` | Tag 1: `(-0.25,0,0.25)→(0,0,0)`; tag 2: `(0,0,0)→(0.25,0,0.25)`; 5 segments each | free space | `(1,5)` at the junction |
| `turnstile-insulated` | Tag 1: `(-0.25,0,+0.001)→(0.25,0,+0.001)`; tag 2: `(0,-0.25,-0.001)→(0,0.25,-0.001)`; 11 segments each | free space | `(1,6)`, `(2,6)` |
| `turnstile-connected` | Tag 1: `(-0.25,0,0)→(0,0,0)`; tag 2: `(0,0,0)→(0.25,0,0)`; tag 3: `(0,-0.25,0)→(0,0,0)`; tag 4: `(0,0,0)→(0,0.25,0)`; 5 segments each | free space | `(1,5)`, `(3,5)` |

The insulated turnstile z-offset of \(\pm0.001\,\mathrm{m}\) is electrical
insulation, not a second antenna height. Orthogonal insulated dipoles have
vanishing mutual impedance; the connected hub does not.

## WP5 validation and fixtures

WP5 does not add public solve APIs. It proves public currents and NEC-native
embedded fields against NEC internals, then publishes a small versioned bundle
the visualizer can ingest without a necpp sibling checkout or
`packages/necpp-wasm/src/*` imports.

Schema `current-quadrature-v1` lives in
[`packages/necpp-wasm/fixtures/current-quadrature-v1/`](../packages/necpp-wasm/fixtures/current-quadrature-v1/)
and is packed with `@necpp-engine/wasm`:

```text
@necpp-engine/wasm/fixtures/current-quadrature-v1/manifest.json
@necpp-engine/wasm/fixtures/current-quadrature-v1/dipole.necq
@necpp-engine/wasm/fixtures/current-quadrature-v1/dipole.necf
…
@necpp-engine/wasm/fixtures/current-quadrature-v1/rooted-monopole-images.necq
```

`manifest.json` holds geometry/ground/ports, the 4-node rule, the `5×3` field
grid, isolated Z/Y, SHA-256 checksums, and representative samples. Numeric
planes stay in the NECQ/NECF binaries. The extra
`rooted-monopole-images.necq` file is the same monopole with an explicit PEC
image plane; plane 0 remains physical.

A non-visualizer Rust consumer binds the buffers once with
[`packages/necpp-wasm/rust/necq_view.rs`](../packages/necpp-wasm/rust/necq_view.rs):
decode headers, keep the `ArrayBuffer`s, load little-endian `f64` planes at
the documented indices. NECF sample order matches [`wasm-api.md`](wasm-api.md):

```text
sampleIndex = phiIndex * thetaDeg.length + thetaIndex
embeddedIndex = portIndex * samplesPerPort + sampleIndex
```

Regenerate goldens with:

```text
npm --prefix packages/necpp-wasm run build:test
npm --prefix packages/necpp-wasm run write:current-quadrature-fixtures
```

A package drift test fails if the packed checksums change. Native tests are
tagged `[wp5_current]`.

## WP6 performance and package pin

WP6 does not add public solve APIs. It records characterization, packed
retrieve, worker handoff, and Rust bind-once evidence under
[`packages/necpp-wasm/bench/evidence/current-quadrature-wp6/`](../packages/necpp-wasm/bench/evidence/current-quadrature-wp6/).
Hot-path gates are byte formulas and operation counters, not host
milliseconds.

The pin-ready package is `@necpp-engine/wasm@0.5.0`. `abiVersion` stays 1.
Visualizer production ingestion stays in the visualizer; this repository
ships package-only and mock-consumer examples in
[`examples/wasm-current-quadrature/`](../examples/wasm-current-quadrature/).

Commands:

```text
cmake --build build-wp0 --config Release --target nec2++_tests --parallel
build-wp0\tests\Release\nec2++_tests.exe "[wp6_current]" --reporter compact
npm --prefix packages/necpp-wasm run bench:current-quadrature-wp6 -- --output-directory bench/evidence/current-quadrature-wp6 --module-directory dist
npm --prefix packages/necpp-wasm run test:current-quadrature-trace
cargo test --manifest-path packages/necpp-wasm/rust/Cargo.toml
```

Same-worker consumers copy NECQ/NECF once into Rust/WASM and retain them.
Worker-to-worker consumers call
`characterizeIsolatedElement(request, { destination })` and bind the
transferred buffers once. A follow-up steer must not re-transfer them.

## Numerical tolerance policy

This extends [`wasm-api.md`](wasm-api.md); it does not replace it.

| Comparison | Gate |
|---|---|
| Exported A/B/C reconstructed \(I(s)\) versus the shared native evaluator | `1e-12` relative L2 |
| Feed-segment \(I(0)=A+C\) versus achieved port current on a straight isolated feed | `1e-4` relative |
| Feed-segment \(I(0)=A+C\) versus achieved port current at a multiwire junction | `1e-3` relative |
| Direct versus worker integer/order/layout | exact |
| Direct versus worker f64 planes | `1e-12` relative L2 |
| Achieved unit-current port \(I\) versus \(1+j0\) | `1e-7` relative |
| Embedded fields versus `computeEmbeddedFarFields()` | existing same-path `1e-7` |
| Metadata, counts, order, image-plane separation, handle disposal | zero |
| Independent NEC-2 printed currents, if used | `3e-4`, source named beside the assertion |

Prefer internal arrays over reports. Reject NaN or infinity before applying a
tolerance.

## Memory budgets

Formulas, independent of host:

| Bundle | Bytes |
|---|---|
| Exact current coefficient planes | `6 * nSegments * 8` per mode |
| Exact geometry SoA (`centres/starts/ends/tangents` xyz plus radius/length) | `14 * nSegments * 8` |
| Internal far-field snapshot (not public) | `13 * nSegments * 8` |
| Prepared currents | `nModes * nSeg * nNodes * nImagePlanes * 16` |
| Prepared geometry | `9 * nSeg * nNodes * nImagePlanes * 8` |
| Embedded fields | `4 * nPorts * nTheta * nPhi * 8` |

Hot-path cost after one bind follows cached buffer size, not NEC segment
setup. WP6 gates repeated copies.

Native MSVC Release (`build-wp0`, 2026-09-02) for the 19×37 grid, recorded in
[`packages/necpp-wasm/bench/evidence/current-quadrature-wp0/native-baseline.json`](../packages/necpp-wasm/bench/evidence/current-quadrature-wp0/native-baseline.json):

- dipole: snapshot 1144 B, snapshot capture 0.002 ms, unit-current embedded 0.30 ms
- insulated turnstile: snapshot 2288 B, unit-current embedded 0.89 ms

After a WASM package build, remeasure with:

```text
npm --prefix packages/necpp-wasm run bench:current-quadrature -- --output-directory packages/necpp-wasm/bench/evidence/current-quadrature-wp0 --module-directory packages/necpp-wasm/dist
```

Indicative sizes for the frozen fixtures, 4-node quadrature, physical-only,
one mode unless noted:

| Fixture | nSeg | nPorts | Snapshot (B) | Exact coeffs/mode (B) | Prepared 4-node (B) |
|---|---|---|---|---|---|
| `dipole` | 11 | 1 | 1144 | 528 | geometry 3168 + currents 704 |
| `rooted-monopole` | 11 | 1 | 1144 | 528 | same as dipole |
| `bent-multiwire` | 10 | 1 | 1040 | 480 | geometry 2880 + currents 640 |
| `turnstile-insulated` | 22 | 2 | 2288 | 1056 | 2 modes: geometry 6336 + currents 2816 |
| `turnstile-connected` | 20 | 2 | 2080 | 960 | 2 modes: geometry 5760 + currents 2560 |

The C ABI, TypeScript methods, worker operations, and handoff are documented
in the sections above. `abiVersion` stays 1. Rust fixture bind:

```text
cargo test --manifest-path packages/necpp-wasm/rust/Cargo.toml
```
