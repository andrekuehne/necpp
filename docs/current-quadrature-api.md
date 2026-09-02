# Isolated-element current and prepared quadrature contract

Status: frozen by WP0 (2026-09-02). WP1 implemented the native exact-current
API. C ABI, TypeScript façades, workers, and the prepared evaluator remain
WP2–WP4. This document is the normative public contract for exact NEC current
coefficients, prepared quadrature sampling, isolated-element characterization,
and the visualizer handoff. Existing Z/Y, solves, fields, power, and lifecycle
in [`wasm-api.md`](wasm-api.md) are unchanged. Type sketches live in
[`packages/necpp-wasm/src/types.ts`](../packages/necpp-wasm/src/types.ts).

WP0 exports types only. WP1 adds `nec_stateful_model::get_current_distribution`
and `nec_evaluate_segment_current`. `NecModel` / `NecWorkerModel` methods, C
ABI entry points, and the prepared evaluator are added in later work packages.
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

Public `A`, `B`, `C` are exact copies of NEC `air/aii`, `bir/bii`, `cir/cii`
after `c_geometry::get_current_coefficients()`. Interpolation along a
physical segment is the stored expansion

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
effective weight is \((L/2)\,w\) (`ds * w`). Empty node lists, mismatched
weights, nonfinite values, and oversize jobs are `NecInputError`. Repeated
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
to sample `I(s)`. WP2 quadrature must call `nec_evaluate_segment_current`.

C ABI, `NecModel` methods, and `state-machine.ts` rows wait for WP4.

## Ownership, invalidation, and errors

| Object | Ownership | Invalidation |
|---|---|---|
| `NecCurrentDistribution` | Direct/Node: JS-owned copies. Worker: worker-resident | Latest-solution: next solve, configuration-changing `prepare`, or `dispose`. Unit-current modes: geometry, frequency, and port identity, not the latest consumer excitation |
| `PreparedCurrentQuadrature` | Opaque handle; large SoA never on the UI thread | Geometry generation, frequency, mode set, node/weight rule, image mode, `dispose` |
| `IsolatedElementCharacterization` | Compact metadata plus two transfer handles | Geometry, frequency, ports, ground, quadrature rule, field-grid identity |

Reuse the existing error taxonomy. No new error class.

Reserved lifecycle (not yet in `state-machine.ts`):

| Operation | empty | geometry-building | geometry-complete | prepared | solved | disposed |
|---|---|---|---|---|---|---|
| `getCurrentDistribution({ kind: "latest-solution" })` | — | — | — | — | same | — |
| `getCurrentDistribution({ kind: "unit-current" })` | — | — | — | same | same | — |
| `prepareCurrentQuadrature` | — | — | — | same* | same | — |
| `characterizeIsolatedElement` | — | — | — | same | same | — |

`prepareCurrentQuadrature` with `modes: "latest-solution"` requires `solved`.
Unit-current current capture and characterization preserve a prior consumer
solution and public generations, matching `computeEmbeddedFarFields`.

`abiVersion` stays `1`. New C functions and `necpp_wasm_v1_result_buffer_kind`
values are additive after snapshot kinds 25–37.

## Packed transfer layout

One little-endian `ArrayBuffer`, schema 1, magic `NECQ` (`0x4E454351`):

- Header: magic, schema, flags (bit 0 = images, bit 1 = hasWeights),
  `nSegments`, `nSamplesPerSegment`, `nModes`, `nImagePlanes` (1 or 2),
  `frequencyMHz`, `wavelengthM`, model and solution generations.
- Geometry SoA, length `nSegments * nImagePlanes`:
  `x,y,z,tx,ty,tz,radiusM,lengthM,dsWeight` as `Float64`.
- Identity, physical plane only: `tag`, `segment`, `nativeIndex` as `Int32`.
- Currents: mode-major then sample-major, separate `iReal` / `iImag` `Float64`
  planes. Sample index is `segmentIndex * nNodes + nodeIndex`. Physical plane
  then optional image plane.
- Embedded-field handle reuses existing basis-major `eTheta`/`ePhi` real/imag
  plus grid axes. Do not invent a second field packing.

No JSON for numeric planes. Worker protocol later adds
`getCurrentDistribution`, `prepareCurrentQuadrature`, and
`characterizeIsolatedElement` with the same `transferredBufferCount` pattern
as far-field arrays. The package worker may transfer the bundle to a consumer
worker without cloning through main-thread application state.

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

## Additive ABI sketch

Do not bump `abiVersion`. WP1+ append after kind 37. Indicative names:

```text
necpp_wasm_v1_get_current_distribution(model, mode)
necpp_wasm_v1_prepare_current_quadrature(model, ...)
necpp_wasm_v1_characterize_isolated_element(model, ...)
NECPP_WASM_V1_CURRENT_* buffer kinds starting at 38
```

Borrowed result buffers remain copy-immediately, matching existing ABI
comments.

## Reserved worker operations

```text
getCurrentDistribution
prepareCurrentQuadrature
characterizeIsolatedElement
```

These are not in `NecWorkerOperation` until WP1–WP4 implement them.
