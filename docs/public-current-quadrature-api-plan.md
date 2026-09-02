# Public NEC current and isolated-element characterization plan

**Status:** proposed

**Created:** 2026-09-02

**Engine baseline:** `necpp` `18f2342`

**Consumer:** `PhasedArrayVisualizer-NG`

## Goal

Expose NEC-resolved isolated-element current modes and embedded patterns so the
visualizer can:

1. compute mutual impedance between translated frozen-current modes in Rust/WASM;
2. solve the resulting array port network; and
3. combine NEC element factors with array factors.

NEC remains authoritative for isolated Z/Y, wire currents, and embedded complex
`E_theta/E_phi`. The visualizer owns mutual-coupling integration, matching,
array factors, grid interpolation, polarization, power integration, and metrics.

## Implementation rules

1. Read this document, `docs/wasm-api.md`, `packages/necpp-wasm/src/types.ts`,
   `packages/necpp-wasm/src/model.ts`, `packages/necpp-wasm/src/worker-*.ts`,
   `src/nec_stateful_model.*`, `src/necpp_wasm_v1.*`,
   `src/c_geometry.cpp`, and `src/nec_far_field.*` before editing.
2. Implement one WP at a time after its dependencies pass.
3. Use public APIs only in consumer tests. Do not parse NEC reports.
4. Preserve existing solves, Z/Y, fields, ordering, power, and lifecycle.
5. Keep electromagnetic loops and large static data below the UI TypeScript
   layer. TypeScript validates requests and manages handles/transfers only.
6. Do not mark a WP complete until its DoD and handover are filled.

## Current baseline

Available now:

- direct and worker-backed stateful models;
- voltage/current port solves and Z/Y;
- NEC combined and unit-current embedded far fields;
- an internal far-field snapshot containing segment geometry and complex
  `A/B/C` current-coefficient planes.

Missing:

- a stable public segment-current contract;
- caller-defined prepared quadrature sampling;
- combined isolated-element current/pattern characterization;
- an efficient handoff into the visualizer Rust/WASM data plane.

## Frozen scope

In scope:

- free-space, above-ground, and ground-connected wire antennas;
- all supported ground-connection modes, including rooted monopoles;
- straight, bent, multiwire, junction, and multiport antennas;
- an insulated two-port crossed-dipole/turnstile fixture;
- latest-solution and unit-current port-mode currents;
- NEC-native embedded patterns for each isolated port mode;
- fixed-frequency, fixed-geometry prepared quadrature data.

Out of scope:

- array mutual-impedance calculation inside NEC;
- array-factor, matching, visualization, or pattern metrics;
- current or field interpolation across frequency;
- persistence/artifact formats;
- TypeScript electromagnetic or per-sample numerical loops.

## Data-plane contract

### Conventions

- NEC phasors use `exp(+j omega t)` and outgoing `exp(-jkr)` fields.
- Public current modes are normalized to a requested 1 A peak port current.
- Current is positive into the antenna using existing port polarity.
- Segment geometry is returned in metres in caller-stable wire/segment order.
- Embedded fields retain existing units, origin, spherical basis, and sample order.
- Physical segments are authoritative. Perfect-ground image samples are an
  explicit prepared-output option, never silently mixed with physical samples.

WP0 may refine names and layouts but may not weaken these semantics.

### Static prepared quadrature layout

A prepared evaluator owns one fixed geometry, frequency, current-mode set, and
quadrature rule. Creation should precompute:

- logical-to-native segment mapping;
- sample positions, tangents, radii, segment lengths, and local coordinates;
- `ds * quadrature_weight` when weights are supplied;
- all NEC sine/cosine interpolation terms;
- fixed complex current samples for every retained mode;
- optional PEC mirror positions and transformed current vectors;
- final basis-major SoA/SIMD-friendly packing and buffer sizes.

Repeated retrieval must be a bounded cached read/transfer. It must not repeat
geometry traversal, trigonometry, current interpolation, or growing allocation.

### WASM/worker boundary

- Main/UI TypeScript receives compact metadata and opaque handles, not large
  coefficient, quadrature, or field arrays during normal operation.
- A package worker produces an owned transferable binary/typed-array bundle.
- The bundle is transferred directly to the visualizer compute worker, or both
  WASM modules run in one compute worker with one bounded inter-memory copy.
- The visualizer uploads static data into Rust/WASM once and retains it there.
- No JSON encoding, per-sample TypeScript loops, repeated structured clones, or
  round trips through React state are allowed.
- Separate WASM memories make a bounded initial copy acceptable; repeated
  copies on steering, view, polarization, or metric changes are not.

Indicative public concepts; final names are frozen by WP0:

```ts
interface NecCurrentDistribution { /* metadata + exact A/B/C planes */ }
interface PreparedCurrentQuadrature { /* opaque owned handle */ }
interface IsolatedElementCharacterization {
  readonly impedance: ComplexMatrix;
  readonly admittance: ComplexMatrix;
  readonly quadrature: PreparedTransferHandle;
  readonly embeddedField: PreparedTransferHandle;
}
```

## Tracking

| WP | Work | Depends on | Status |
|---|---|---|---|
| 0 | Contract and baselines | - | Complete |
| 1 | Public exact current distributions | 0 | Not started |
| 2 | Static prepared quadrature evaluator | 1 | Not started |
| 3 | Isolated-element characterization | 1, 2 | Not started |
| 4 | WASM, worker, and Rust/WASM handoff | 2, 3 | Not started |
| 5 | Numerical and consumer validation | 4 | Not started |
| 6 | Performance, documentation, release | 5 | Not started |

## WP0 - Freeze contracts and baselines

### Work

- Freeze native, C ABI, TypeScript, worker, and transfer layouts.
- Freeze coefficient meaning, normalization, units, ordering, image policy,
  junction mapping, ownership, invalidation, and errors.
- Define direct, worker, and visualizer-consumer fixtures and tolerances.
- Benchmark existing embedded-field basis solves and internal snapshot costs.

### Definition of Done

- Public API and binary layout sketches are reviewed.
- No consumer needs package-internal imports or NEC report parsing.
- Tests cover dipole, grounded monopole, multiwire, and turnstile contracts.
- Commands, raw baselines, tolerances, and memory budgets are recorded.

### Handover

- **Status / implementer / date:** complete / WP0 implementation / 2026-09-02
- **Commit(s):** uncommitted WP0 tree on this branch; pin after the user
  commits.
- **Commands and results:**
  - `cmake --build build-wp0 --config Release --target nec2++_tests --parallel`
  - `build-wp0\tests\Release\nec2++_tests.exe "[wp0_current]" --reporter compact`
    — 7 test cases, 305 assertions, all passed.
  - `npm --prefix packages/necpp-wasm run typecheck` — passed.
  - Package Node/WASM contract tests are present and skip until `nec2pp.wasm`
    is staged. WASM baseline command:
    `npm --prefix packages/necpp-wasm run bench:current-quadrature -- --output-directory packages/necpp-wasm/bench/evidence/current-quadrature-wp0 --module-directory packages/necpp-wasm/dist`
- **Artifacts:**
  - [`docs/current-quadrature-api.md`](current-quadrature-api.md)
  - [`packages/necpp-wasm/bench/evidence/current-quadrature-wp0/native-baseline.json`](../packages/necpp-wasm/bench/evidence/current-quadrature-wp0/native-baseline.json)
- **Decisions / deviations:**
  - Connected turnstile is four half-wires meeting at the origin. Two
    through-crossing dipoles in one plane fail NEC overlap checking.
  - Insulated turnstile z-offset is ±0.001 m. Orthogonal insulated dipoles
    have vanishing Z_01; the connected hub does not.
  - Feed I(0)=A+C versus port current uses `1e-4` (straight) / `1e-3`
    (junction), not `1e-12`. Port current is the network unknown; A/B/C are
    the interpolated expansion.
  - Types are exported; `NecModel` methods, C ABI entry points, and
    `state-machine.ts` rows wait for WP1–WP4.
  - WASM package artifacts were not present on this host, so the Node
    benchmark was not executed. Native snapshot/embedded timings and byte
    formulas are recorded.
- **Known risks / next WP:**
  - WP1 must convert snapshot wavelength units to public metres and share one
    current evaluator with the field kernel.
  - Junction `icon1`/`icon2` decoding must stay in public identity objects so
    native order cannot leak.
  - Characterization must reuse the existing unit-current embedded-field basis
    loop (one solve per port).
  - Next: WP1 public exact current distributions.

## WP1 - Public exact current distributions

### Work

- Add an owned native value for physical segment geometry and exact complex
  NEC `A/B/C` current coefficients.
- Expose latest-solution and unit-current port-basis variants.
- Preserve caller wire, segment, port, junction, and ground-connection identity.
- Support free space, above-ground, rooted-ground, multiwire, and multiport cases.
- Keep the internal field evaluator and public current evaluator on one formula.

### Definition of Done

- Exported coefficients reproduce NEC internal currents at endpoints, centres,
  and off-centre samples within WP0 tolerance.
- Dipole, grounded monopole, bent/multiwire, and two-port turnstile tests pass.
- Turnstile tests cover each unit-port mode and a `+90 deg` combined drive.
- The fixture explicitly models insulated or connected crossing topology.
- Existing Z/Y, solves, fields, powers, state restoration, and errors are unchanged.
- Zero-current and nonfinite/error paths are deterministic.

### Handover

- **Status / implementer / date:**
- **Commit(s):**
- **Commands and results:**
- **Artifacts:**
- **Decisions / deviations:**
- **Known risks / next WP:**

## WP2 - Static prepared quadrature evaluator

### Work

- Add a reusable native evaluator for caller-defined normalized nodes and
  optional weights.
- Perform every geometry-, rule-, coefficient-, and image-dependent operation
  possible at construction.
- Retain immutable packed samples per current mode.
- Provide physical-only and explicit perfect-ground-image output modes.
- Keep a scalar reference implementation for verification.

### Definition of Done

- Prepared samples match the scalar exact-current evaluator within WP0 tolerance.
- Repeated retrieval performs no geometry walk, trigonometry, interpolation,
  or capacity-growing allocation.
- Allocation and expensive-operation counters enforce the hot-path contract.
- Node/weight validation, empty/large jobs, memory growth, invalidation, and
  idempotent disposal are tested.
- Layout is directly ingestible by the visualizer Rust/WASM coupling kernel.
- Preparation and repeated retrieval have separate benchmarks.

### Handover

- **Status / implementer / date:**
- **Commit(s):**
- **Commands and results:**
- **Artifacts:**
- **Decisions / deviations:**
- **Known risks / next WP:**

## WP3 - Isolated-element characterization

### Work

- Add one operation that returns isolated Z/Y, prepared current modes, and
  NEC-native embedded patterns for a fixed model/frequency.
- Share the existing unit-current embedded-field basis-solve loop.
- Capture currents and fields from the same basis solve; avoid duplicate solves.
- Preserve basis-major caller port order and prior public solution state.

### Definition of Done

- Exactly one unit-current basis solve is performed per port unless WP0 records
  a justified fallback.
- Returned current modes have achieved 1 A port normalization within tolerance.
- Embedded complex fields match `computeEmbeddedFarFields()` within its existing
  tolerance and remain NEC-generated.
- Multiport and turnstile phase/polarization relationships pass.
- Characterization is cacheable by geometry, frequency, ports, ground, rule,
  and field-grid identity.

### Handover

- **Status / implementer / date:**
- **Commit(s):**
- **Commands and results:**
- **Artifacts:**
- **Decisions / deviations:**
- **Known risks / next WP:**

## WP4 - Public WASM, worker, and visualizer handoff

### Work

- Add stable C/WASM handles and result metadata.
- Add direct and worker TypeScript façades and array/element façade integration.
- Transfer large immutable bundles without main-thread materialization.
- Define a worker-to-worker `MessagePort` or same-worker integration path for
  `PhasedArrayVisualizer-NG`.
- Make cancellation, generations, transfer ownership, and disposal explicit.
- Add a minimal Rust decoder/binder contract for the visualizer.

### Definition of Done

- Clean Node and Chromium consumers use only public package imports.
- Direct and worker outputs are byte/layout equivalent within numeric tolerance.
- A browser integration test transfers characterization data to a mock consumer
  worker without placing large arrays in main-thread application state.
- The receiver binds once; repeated steering transfers no current or pattern basis.
- No stale WASM views, double transfers, leaked handles, or unbounded bridge copy.
- Existing package worker serialization and cancellation tests remain green.

### Handover

- **Status / implementer / date:**
- **Commit(s):**
- **Commands and results:**
- **Artifacts:**
- **Decisions / deviations:**
- **Known risks / next WP:**

## WP5 - Numerical and consumer validation

### Work

- Verify current coefficients and prepared samples against NEC internal evaluation.
- Verify embedded patterns against the existing NEC API; do not reconstruct or
  replace element patterns in the visualizer.
- Check normalization, polarity, phase, ordering, junctions, and ground images.
- Publish small versioned fixtures for the visualizer: geometry/ground metadata,
  nodes/weights, currents, Z/Y, and embedded complex fields.
- Add a `PhasedArrayVisualizer-NG` compatibility test for Rust/WASM ingestion.

### Definition of Done

- Dipole, rooted monopole, multiwire, multiport, and turnstile matrices pass.
- Direct, worker, and transferred-consumer results agree.
- The visualizer consumes fixtures without a sibling checkout or internal import.
- Rust/WASM receives positions, tangents, weighted currents, and fields with the
  frozen units, order, polarity, and phase.
- NEC remains the sole element-pattern source.
- Full existing native, package, Node, and browser suites pass.

### Handover

- **Status / implementer / date:**
- **Commit(s):**
- **Commands and results:**
- **Artifacts:**
- **Decisions / deviations:**
- **Known risks / next WP:**

## WP6 - Performance, documentation, and release

### Work

- Benchmark characterization, preparation, transfer, Rust/WASM bind, memory,
  and repeated retrieval for representative element complexities.
- Verify that hot-path cost follows cached buffer size, not NEC segment setup.
- Document current/pattern conventions, layouts, lifetime, and consumer flow.
- Update declarations, README, examples, changelog, package tests, and release audit.

### Definition of Done

- WP0 performance and memory gates pass with raw machine-readable evidence.
- No large-data main-thread or repeated-steering transfer appears in browser traces.
- Package-only and visualizer-consumer examples run from clean checkouts.
- Public docs are sufficient to implement a non-visualizer Rust/WASM consumer.
- A released package version is ready for an exact visualizer dependency pin.

### Handover

- **Status / implementer / date:**
- **Commit(s):**
- **Commands and results:**
- **Artifacts:**
- **Decisions / deviations:**
- **Known risks / release follow-up:**

## Feature Definition of Done

From public APIs, a consumer can characterize an isolated NEC antenna at one
frequency and obtain:

- isolated Z/Y;
- exact unit-current segment-current modes;
- immutable currents at caller-defined quadrature nodes; and
- matching NEC-native embedded complex patterns.

This works for dipoles, ground-connected monopoles, multiwire/multiport models,
and the turnstile fixture. Large immutable data moves once between compute
workers/WASM memories, never through UI state, and is reused for steering,
visualization, polarization, power, and metric changes. All numerical,
lifecycle, memory, performance, public-package, and clean-consumer gates pass.

## Risks to track

| Risk | Required control |
|---|---|
| Coefficient formula drifts from NEC fields | One shared evaluator plus golden tests |
| Ground images are double-counted | Explicit physical/image output mode |
| Junction/native order leaks into public order | Stable mapping metadata and fixtures |
| Basis solve duplicated for currents and patterns | Solve counters and WP3 gate |
| Large arrays cross main TypeScript | Browser trace and mock-consumer transfer test |
| Separate WASM memories force repeated copies | One bounded bind copy, retained Rust state |
| Worker cancellation leaks prepared handles | Generation and disposal stress tests |
