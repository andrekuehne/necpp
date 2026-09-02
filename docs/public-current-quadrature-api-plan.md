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
| 1 | Public exact current distributions | 0 | Complete |
| 2 | Static prepared quadrature evaluator | 1 | Complete |
| 3 | Isolated-element characterization | 1, 2 | Complete |
| 4 | WASM, worker, and Rust/WASM handoff | 2, 3 | Complete |
| 5 | Numerical and consumer validation | 4 | Complete |
| 6 | Performance, documentation, release | 5 | Complete |

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

- **Status / implementer / date:** complete / WP1 implementation / 2026-09-02
- **Commit(s):** uncommitted WP1 tree on this branch; pin after the user
  commits.
- **Commands and results:**
  - `cmake --build build-wp0 --config Release --target nec2++_tests --parallel`
  - `build-wp0\tests\Release\nec2++_tests.exe "[wp1_current]" --reporter compact`
    — 9 test cases, 4564 assertions, all passed.
  - `build-wp0\tests\Release\nec2++_tests.exe "~[wp1]~[wp2]~[wp3]~[wp4]~[wp_s2]~[wp_s3]" --reporter compact`
    — 98 test cases, 5913 assertions, all passed (includes WP0 and WP1 current
    tags; excludes the older WASM-API stress tags).
- **Artifacts:**
  - [`src/nec_current_distribution.h`](../src/nec_current_distribution.h)
  - [`src/nec_current_distribution.cpp`](../src/nec_current_distribution.cpp)
  - [`src/current_quadrature_wp1_tb.cpp`](../src/current_quadrature_wp1_tb.cpp)
  - Native names recorded in [`docs/current-quadrature-api.md`](current-quadrature-api.md)
- **Decisions / deviations:**
  - Native C++ only. `NecModel` methods, C ABI, and worker rows wait for WP4.
  - Public metres are `wavelength_m` times frequency-scaled NEC arrays. A 150 MHz
    dipole locks this: \(c/f \approx 1.9986\,\mathrm{m}\), not exactly 2 m.
  - `I(0)=A+C` versus unit-current \(1+j0\) is not a 1e-4 gate. Port current is
    the network unknown; A/B/C are the interpolated expansion (WP0). Unit-current
    planes must match latest-solution after the same unit drive at 1e-12.
    Voltage-drive feed \(I(0)\) versus achieved port current keeps 1e-4/1e-3.
  - `nec_evaluate_segment_current` is the shared scalar formula. The far-field
    kernel was not rewritten to sample \(I(s)\); it still integrates the same
    coefficient arrays.
  - `apply_unit_current_basis` is shared with `compute_embedded_far_fields`.
    Currents and fields are not captured from one solve yet (WP3).
- **Known risks / next WP:**
  - WP2 must call `nec_evaluate_segment_current` and precompute \(s\),
    \(\sin(ks)\), \(\cos(ks)\), and `ds * weight` at construction.
  - Junction decode lives in `nec_decode_segment_end`; keep native `icon`
    integers out of public order.
  - Characterization must reuse the unit-current basis loop and capture
    currents plus fields from the same solve.
  - Next: WP2 static prepared quadrature evaluator.

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

- **Status / implementer / date:** complete / WP2 implementation / 2026-09-02
- **Commit(s):** uncommitted WP2 tree on this branch; pin after the user
  commits.
- **Commands and results:**
  - `cmake --build build-wp0 --config Release --target nec2++_tests --parallel`
  - `build-wp0\tests\Release\nec2++_tests.exe "[wp2_current]" --reporter compact`
    — 8 test cases, 6777 assertions, all passed.
  - `build-wp0\tests\Release\nec2++_tests.exe "~[wp1]~[wp2]~[wp3]~[wp4]~[wp_s2]~[wp_s3]" --reporter compact`
    — 106 test cases, 12690 assertions, all passed (includes WP0–WP2 current
    tags; excludes the older WASM-API stress tags).
- **Artifacts:**
  - [`src/nec_prepared_current_quadrature.h`](../src/nec_prepared_current_quadrature.h)
  - [`src/nec_prepared_current_quadrature.cpp`](../src/nec_prepared_current_quadrature.cpp)
  - [`src/current_quadrature_wp2_tb.cpp`](../src/current_quadrature_wp2_tb.cpp)
  - [`packages/necpp-wasm/bench/evidence/current-quadrature-wp2/native-baseline.json`](../packages/necpp-wasm/bench/evidence/current-quadrature-wp2/native-baseline.json)
  - Exact packed offsets in [`docs/current-quadrature-api.md`](current-quadrature-api.md)
- **Decisions / deviations:**
  - Native C++ only. `NecModel` methods, C ABI, and worker rows wait for WP4.
  - Tests use `[wp2_current]`, not `[wp2]`, so they do not collide with the
    older port-quantity suite.
  - Geometry SoA is per sample (`9 * nSeg * nNodes * nImagePlanes * 8`). WP0
    prose that said `nSegments * nImagePlanes` was corrected.
  - Magic is ASCII bytes `NECQ` at offset 0. Header is 64 bytes. Identity is
    followed by 0–4 pad bytes to 8-byte alignment.
  - Omitted weights store `dsWeight = L/2` (`w_i = 1`). `sum(dsWeight)` equals
    `(L/2) * sum(w)`, which is `L` only for a rule with `sum(w) = 2`.
  - Free-space and finite-ground image requests fail. Rooted monopoles remain
    physical-only unless images are requested; the image plane is the geometric
    PEC transform, not NEC’s internal image basis.
  - 4-node physical dipole packed size is 4072 B (64 header + 132 identity +
    4 pad + 3168 geometry + 704 currents). Retrieve is ~0.016 µs vs prepare
    0.057 ms (dipole) / 0.16 ms (insulated turnstile) on this host.
- **Known risks / next WP:**
  - WP3 must capture currents and embedded fields from one unit-current basis
    loop. WP2 may call `get_current_distribution` and therefore solve, which
    is allowed until WP3.
  - Junction `icon` integers stay out of packed identity; only
    `tag`/`segment`/`nativeIndex`.
  - Image plane must never be mixed into plane 0.
  - Next: WP3 isolated-element characterization.

## WP3 - Isolated-element characterization

Native C++ only, matching WP1/WP2. C ABI, `NecModel` methods, worker rows, and
transfer handles wait for WP4. Frozen names and layouts live in
[`docs/current-quadrature-api.md`](current-quadrature-api.md).

### Work

- Add one operation that returns isolated Z/Y, prepared current modes, and
  NEC-native embedded patterns for a fixed model/frequency.
- Share the existing unit-current embedded-field basis-solve loop.
- Capture currents and fields from the same basis solve; avoid duplicate solves.
- Preserve basis-major caller port order and prior public solution state.

### Native API

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

Put the request/result structs in a new
`src/nec_isolated_element_characterization.h` so the public header list stays
aligned with WP1/WP2. Implementation stays in `nec_stateful_model.cpp`.

Rules:

- Allowed from `prepared` or `solved`. From `prepared`, the model stays
  prepared. From `solved`, restore the prior consumer solution and public
  `solve_generation`, matching `compute_embedded_far_fields`.
- `quadrature.modes` must be `unit_current`. `latest_solution` fails with
  `CHARACTERIZE ISOLATED ELEMENT: CURRENT MODES MUST BE UNIT-CURRENT`.
- `embedded_field.normalization` is always `unit_current`. Ports, sample
  order, units, and spherical basis match `compute_embedded_far_fields`.
- Return an owned value. Do not retain characterization on the model. WP4
  will retain ABI buffers.
- Z/Y come from the existing cached `compute_impedance_matrix()`. That may
  perform unit-voltage column solves when the cache is cold. Those are not
  unit-current basis solves.
- Pack quadrature with `nec_prepare_current_quadrature` from the currents
  captured in the same loop. Do not call `get_current_distribution` or
  `prepare_current_quadrature` from characterization.
- Do not call `compute_embedded_far_fields` from characterization. Fields
  are captured in the same per-port solve as the coefficients.
- Reuse existing validation: quadrature nodes/weights/images, far-field
  grid, perfect-ground image capability. No new error class.
- Export `IsolatedElementRequest` from `packages/necpp-wasm/src/types.ts`
  (`quadrature` + `field: FarFieldRequest`). Do not add `NecModel` methods.

### Shared basis-solve loop

Today `get_current_distribution(unit_current)` and
`compute_embedded_far_fields(unit_current)` each loop ports, call
`apply_unit_current_basis`, then capture only coefficients or only fields.
Independent callers may still do that. Characterization must not.

Extract one private helper used by all three:

```cpp
void run_unit_current_basis_loop(
  nec_current_distribution* currents_out,          // nullable
  nec_embedded_far_field_result* fields_out,       // nullable
  const nec_far_field_grid* grid);                 // required if fields_out
```

Behaviour:

1. Require `prepared` or `solved`.
2. Take `compute_impedance_matrix().impedance` (cached after first use).
3. Save consumer solution; restore in success and failure paths with the
   existing `restore_after_internal_solves` try/catch pattern.
4. Fill geometry once if `currents_out != nullptr`.
5. For each port in `definePorts()` order: `apply_unit_current_basis`,
   optionally copy A/B/C, optionally `calculate_far_field` into that port’s
   basis-major slice.
6. Do not increment public `solve_generation`.

`get_current_distribution(unit_current)` passes currents only.
`compute_embedded_far_fields(unit_current)` passes fields only.
Characterization passes both, then packs the NECQ buffer from
`currents_out`. Unit-voltage embedded fields stay on their own path.

### Solve accounting

`unit_current_basis_solve_count()` increments only inside
`apply_unit_current_basis`. Restoration, unit-voltage Y columns, consumer
solves, and far-field evaluation do not increment it.

DoD gate: after a warm Z/Y cache, one characterization increases the
counter by `nPorts`, not `2 * nPorts`. No WP0 fallback is recorded, so do
not add a second unit-current pass.

### Cache identity

WP3 does not add an internal characterization cache. The owned result is a
pure function of geometry/`factorization_generation`, frequency, ports,
ground, quadrature rule, and field-grid identity. Packed NECQ already
stores `modelGeneration`. Tests must show:

- the same request on the same prepared model matches Z/Y, packed
  quadrature, and fields within WP0 tolerances;
- changing nodes/weights/images changes quadrature and not field identity;
- changing the field grid changes fields and not packed current samples;
- a new frequency or geometry invalidates by producing a different
  `factorization_generation` and different numeric planes.

WP4 may key a worker cache on those identities. Do not invent a second
field packing; the native `nec_embedded_far_field_result` is the WP3
object. WP4 maps it onto existing basis-major `eTheta`/`ePhi` buffers.

### Tests

New file `src/current_quadrature_wp3_tb.cpp`, tagged
`[wasm_api][current_quadrature][wp3_current]`. Do not use `[wp3]`; that tag
belongs to the older far-field suite in `nec_stateful_model_wp3_tb.cpp`.

Reuse `current_quadrature_fixtures.h` and the WP2 four-node rule
`{-1, -1/3, 1/3, 1}`. Use a modest field grid for correctness (the existing
WP3 far-field `5×3` grid is enough). Do not parse NEC reports.

| Case | Assert |
|---|---|
| Dipole, prepared and solved | Z/Y match `compute_impedance_matrix`; packed samples match WP2 scalar evaluator; fields match `compute_embedded_far_fields(..., unit_current)` on a second model at `1e-7`; achieved port current `1+j0` at `1e-7` |
| Rooted monopole | Physical-only default; optional PEC image plane stays out of plane 0; NEC fields remain ground-aware |
| Bent multiwire | Public junction identity in packed tags; no native `icon` integers |
| Insulated turnstile | `\|Z_01\|` vanishes vs `\|Z_00\|`; two unit modes; `E_0 + j E_1` matches a `[1, j]` current-drive far field at `1e-7` |
| Connected turnstile | `\|Z_01\|` is not vanishing; hub junctions; same superposition check |
| Solve counter | Warm Z, characterize insulated turnstile, counter `+= 2` |
| Restore | Pre-existing `solve_generation`, state, and port currents unchanged |
| Cache identity | Same request matches; grid change leaves packed currents; node change leaves field axes/samples-per-port but not current bytes |
| Errors | `latest_solution` modes, invalid grid, empty/mismatched nodes, images without perfect ground, unprepared state |
| Existing suites | `[wp3]` far-field tests and `~[wp1]~[wp2]~[wp3]~[wp4]~[wp_s2]~[wp_s3]` stay green |

Compare characterization against separately solved APIs on a **second**
model. Same-model `get_current_distribution` +
`compute_embedded_far_fields` after characterize would hide the solve-count
gate.

### Files

| Path | Change |
|---|---|
| `src/nec_isolated_element_characterization.h` | Request/result structs |
| `src/nec_stateful_model.h` / `.cpp` | Method, shared loop, solve counter |
| `src/current_quadrature_wp3_tb.cpp` | Native tests |
| `src/CMakeLists.txt`, `tests/CMakeLists.txt` | Header + test source |
| `packages/necpp-wasm/src/types.ts` | Export `IsolatedElementRequest` only |
| `packages/necpp-wasm/test-d/public-api.test.ts` | Type construction |
| `docs/current-quadrature-api.md` | Native WP3 API section |

### Non-goals

- C ABI entry points, result-buffer kinds, `NecModel` /
  `NecWorkerModel` methods, `state-machine.ts` rows (WP4)
- Packing embedded fields into a second `NECQ`-style blob (WP4 uses
  existing embedded buffers)
- Internal result cache or invalidation of previously returned owned
  values
- Array mutual impedance, array factor, or visualizer ingestion (WP4/WP5)
- Changing WP2 `prepare_current_quadrature`; it may still call
  `get_current_distribution` and solve on its own

### Implementation sequence

1. Add the solve counter and extract `run_unit_current_basis_loop`. Prove
   existing `[wp1_current]`, `[wp2_current]`, and `[wp3]` tests still pass.
2. Add `characterize_isolated_element` and the owned result type.
3. Add `[wp3_current]` tests, including the `nPorts` solve-count gate and
   turnstile superposition.
4. Export `IsolatedElementRequest` and record the native API in
   `docs/current-quadrature-api.md`.
5. Fill this handover.

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

- **Status / implementer / date:** complete / WP3 implementation / 2026-09-02
- **Commit(s):** uncommitted WP3 tree on this branch; pin after the user
  commits.
- **Commands and results:**
  - `cmake --build build-wp0 --config Release --target nec2++_tests --parallel`
  - `build-wp0\tests\Release\nec2++_tests.exe "[wp3_current]" --reporter compact`
    — 9 test cases, 2672 assertions, all passed.
  - `build-wp0\tests\Release\nec2++_tests.exe "[wp1_current],[wp2_current],[wp3]" --reporter compact`
    — 29 test cases, 11611 assertions, all passed.
  - `build-wp0\tests\Release\nec2++_tests.exe "~[wp1]~[wp2]~[wp3]~[wp4]~[wp_s2]~[wp_s3]" --reporter compact`
    — 115 test cases, 15362 assertions, all passed (includes WP0–WP3 current
    tags; excludes the older WASM-API stress tags).
  - `npm --prefix packages/necpp-wasm run typecheck` — passed.
- **Artifacts:**
  - [`src/nec_isolated_element_characterization.h`](../src/nec_isolated_element_characterization.h)
  - [`src/current_quadrature_wp3_tb.cpp`](../src/current_quadrature_wp3_tb.cpp)
  - Native names recorded in [`docs/current-quadrature-api.md`](current-quadrature-api.md)
- **Decisions / deviations:**
  - Native C++ only. `NecModel` methods, C ABI, and worker rows wait for WP4.
  - Tests use `[wp3_current]`, not `[wp3]`, so they do not collide with the
    older far-field suite.
  - `run_unit_current_basis_loop` is shared by unit-current current capture,
    unit-current embedded fields, and characterization. Unit-voltage embedded
    fields stay on their own path. WP2 `prepare_current_quadrature` still
    calls `get_current_distribution`.
  - Packed NECQ `solutionGeneration` follows the public `solve_generation`,
    so prepared versus previously-solved models are not bitwise identical.
    Cross-model checks compare views at `1e-12`, not raw bytes.
  - `IsolatedElementRequest` is exported; `NecModel.characterizeIsolatedElement`
    waits for WP4.
- **Known risks / next WP:**
  - WP4 must map `IsolatedElementRequest.field` onto `nec_far_field_grid` and
    transfer Z/Y metadata plus the packed NECQ and existing embedded-field
    buffers without a second field packing.
  - Independent `get_current_distribution` + `compute_embedded_far_fields`
    still costs `2 * nPorts` unit-current solves; only characterization
    shares the loop.
  - Next: WP4 public WASM, worker, and visualizer handoff.

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

- **Status / implementer / date:** complete / WP4 implementation / 2026-09-02
- **Commit(s):** uncommitted WP4 tree on this branch; pin after the user
  commits.
- **Commands and results:**
  - `cmake --build build-wp0 --config Release --target nec2++_tests --parallel`
  - `build-wp0\tests\Release\nec2++_tests.exe "[wp4_current]" --reporter compact`
    — 6 test cases, 162 assertions, all passed.
  - `build-wp0\tests\Release\nec2++_tests.exe "[wp4]" --reporter compact`
    — 2 test cases, 63 assertions, all passed (older WASM-API suite; not
    `[wp4_current]`).
  - `build-wp0\tests\Release\nec2++_tests.exe "~[wp1]~[wp2]~[wp3]~[wp4]~[wp_s2]~[wp_s3]" --reporter compact`
    — 121 test cases, 15524 assertions, all passed (includes WP0–WP4 current
    tags; excludes the older WASM-API stress tags).
  - `npm --prefix packages/necpp-wasm run typecheck` — passed.
  - `.\scripts\build_wasm_docker.ps1` with `emscripten/emsdk:4.0.7` — rebuilt
    `nec2pp.wasm` / field-evaluator; smoke test passed.
  - `npm --prefix packages/necpp-wasm test` — 108 tests, all passed, including
    WP4 Node current/quadrature/handoff cases against the new WASM.
  - `npm --prefix packages/necpp-wasm run test:pack` — 5 tests, all passed.
  - `npm --prefix packages/necpp-wasm run test:current-quadrature-browser` —
    Playwright mock-consumer bind-once: main thread has no large buffers;
    consumer received NECQ+NECF once (`quadratureBytes` 4072, `embeddedBytes`
    608).
  - `cargo test --manifest-path packages/necpp-wasm/rust/Cargo.toml` — 4
    header-parse tests passed.
- **Artifacts:**
  - [`src/necpp_wasm_v1.h`](../src/necpp_wasm_v1.h) / [`src/necpp_wasm_v1.cpp`](../src/necpp_wasm_v1.cpp)
  - [`src/current_quadrature_wp4_tb.cpp`](../src/current_quadrature_wp4_tb.cpp)
  - [`packages/necpp-wasm/src/model.ts`](../packages/necpp-wasm/src/model.ts),
    [`worker-*.ts`](../packages/necpp-wasm/src/worker-client.ts),
    [`handoff.ts`](../packages/necpp-wasm/src/handoff.ts)
  - [`packages/necpp-wasm/rust/necq_view.rs`](../packages/necpp-wasm/rust/necq_view.rs)
  - ABI, TS, NECF, worker, and handoff recorded in
    [`docs/current-quadrature-api.md`](current-quadrature-api.md)
  - Rust binder notes in [`docs/necq-rust-binder.md`](necq-rust-binder.md)
- **Decisions / deviations:**
  - `abiVersion` stays 1. New symbols are additive after snapshot kind 37.
  - Tests use `[wp4_current]`, not `[wp4]`, so they do not collide with the
    older ABI suite.
  - Characterization packs NECF and syncs Z/Y kinds 0–3; it does not
    overwrite embedded kinds 19–24.
  - Isolated-element APIs are `NecModel` / `NecWorkerModel` only, not
    `NecArraySolver`.
  - Worker-to-worker handoff puts `MessagePort` on the transfer list and
    returns compact `IsolatedElementHandoff` metadata to the client.
  - Direct `getCurrentDistribution({ kind: "latest-solution" })` from
    `prepared` is a synchronous `NecStateError`; the package test uses
    `assert.throws`, not `assert.rejects`.
- **Known risks / next WP:**
  - WP5: versioned visualizer fixtures, sibling-checkout ingestion, and
    numerical current/pattern checks against NEC internals.
  - Independent `get_current_distribution` + `compute_embedded_far_fields`
    still costs `2 * nPorts` unit-current solves; only characterization
    shares the loop.

## WP5 - Numerical and consumer validation

Native, package, worker, browser, and Rust binder validation. No new public
solve APIs. C ABI, `NecModel` methods, and worker rows stay as WP4 shipped
them. Frozen names and layouts live in
[`docs/current-quadrature-api.md`](current-quadrature-api.md).

Visualizer production ingestion stays WP6. WP5 publishes versioned fixtures
and a bind-once Rust contract the visualizer can pin without a necpp sibling
checkout or package-internal imports.

### Work

- Verify current coefficients and prepared samples against NEC internal
  evaluation (`air`/`aii`/`bir`/`bii`/`cir`/`cii` via the far-field snapshot).
  Do not parse NEC reports.
- Verify embedded patterns against `compute_embedded_far_fields` /
  `computeEmbeddedFarFields`. Do not reconstruct or replace element patterns
  in TypeScript or the visualizer.
- Check normalization, polarity, phase, ordering, junctions, and ground images
  for every canonical fixture across native, direct WASM, worker, and handoff.
- Publish small versioned fixtures: geometry/ground metadata, nodes/weights,
  Z/Y, packed NECQ currents, and packed NECF fields.
- Upgrade the sketch Rust binder to typed little-endian plane loads against
  those fixtures. Optional sibling checkout of `PhasedArrayVisualizer-NG` may
  skip.

### Frozen decisions

- Tag `[wp5_current]`, not `[wp5]`.
- Canonical five fixtures from the contract doc, 4-node
  `{-1,-1/3,1/3,1}`, physical-only, package `5×3` field grid
  (`theta` 0/45/5, `phi` 0/90/3). Extra packed file:
  `rooted-monopole-images`.
- Fixtures live in-repo and in the npm pack under
  `fixtures/current-quadrature-v1/`. Numeric planes stay binary; JSON holds
  metadata and small Z/Y only.
- Rust crate stays `publish = false`.
- Test-only helpers may decode packed buffers. Production TypeScript must not
  interpolate `I(s)` or loop samples for electromagnetics.
- No new ABI symbols, result-buffer kinds, or `NecArraySolver` methods.

### Native tests

New file `src/current_quadrature_wp5_tb.cpp`, tagged
`[wasm_api][current_quadrature][wp5_current]`. Reuse
`current_quadrature_fixtures.h`. Use the package `5×3` grid so native
characterization identity matches the published fixtures.

Public `A/B/C` are copies of NEC `air`/`aii`/`bir`/`bii`/`cir`/`cii`. WP1
never asserted that copy against the snapshot arrays. WP5 does, after a
latest-solution solve, at `1e-12`. Public metres are `wavelength_m` times the
snapshot wavelength-normalized geometry.

| Case | Assert |
|---|---|
| All five fixtures, latest-solution | Public `A/B/C` match snapshot `air`/`aii`/… at `1e-12`; `I(0)=A+C` matches snapshot centre current; public metres = `wavelength_m` × snapshot arrays |
| All five fixtures, unit-current | Achieved port `I = 1+j0` at `1e-7`; unit planes match a latest-solution after the same drive at `1e-12`; packed 4-node samples match `nec_evaluate_quadrature_current` at `1e-12` |
| Characterization vs second model | Z/Y match `compute_impedance_matrix`; packed samples match WP2 scalar; fields match `compute_embedded_far_fields(..., unit_current)` at `1e-7` |
| Rooted monopole images | Plane 0 is physical; plane 1 is `(x,y,-z)`, `(tx,ty,-tz)`, `I'=-I`; never mixed |
| Bent multiwire | Packed identity is `tag`/`segment`; no native `icon` integers |
| Insulated turnstile | `\|Z_01\|` vanishes vs `\|Z_00\|`; `E_0 + j E_1` matches a `[1,j]` current-drive far field at `1e-7` |
| Connected turnstile | `\|Z_01\|` is not vanishing; same superposition check |
| Existing suites | `[wp1_current]`, `[wp2_current]`, `[wp3_current]`, `[wp4_current]`, `[wp3]`, and `~[wp1]~[wp2]~[wp3]~[wp4]~[wp_s2]~[wp_s3]` stay green |

Native tests are the authority for NEC internals. Package tests do not poke
WASM HEAP coefficient arrays.

### Versioned fixture bundle

Schema `current-quadrature-v1`, directory
`packages/necpp-wasm/fixtures/current-quadrature-v1/`:

```text
manifest.json
dipole.necq / dipole.necf
rooted-monopole.necq / .necf
rooted-monopole-images.necq
bent-multiwire.necq / .necf
turnstile-insulated.necq / .necf
turnstile-connected.necq / .necf
```

Manifest fields: `schemaVersion: 1`, `abiVersion: 1`, engine/package versions;
per fixture wires, ports, ground, `groundConnection`, `frequencyMHz`,
quadrature nodes/images, field grid; `impedance`/`admittance` as
`ComplexMatrix` JSON; byte lengths and SHA-256 of each binary; representative
samples (feed-segment `I(0)=A+C`, one packed quadrature sample, one
`E_theta`/`E_phi` sample); `imagePolicy` and units (`metres`, `exp(+jωt)`).

Generator `packages/necpp-wasm/scripts/write-current-quadrature-fixtures.mjs`
uses public `createNecModel().characterizeIsolatedElement(...)` only. A
package test fails if regenerated checksums drift.

Publish path: add `fixtures/` to `package.json` `files` and export
`./fixtures/current-quadrature-v1/*`. Update the pack allowlist.

### Package / worker / browser

New `packages/necpp-wasm/test/current-quadrature-validation.test.mjs`. Keep
WP4 contract/handoff tests. For every canonical fixture:

- Direct vs worker: Z/Y at `1e-12`; NECQ/NECF bytes identical
- Characterization `embeddedField` planes match
  `computeEmbeddedFarFields({ kind: "unit-current" })` on a **second** model
  at `1e-7` (decode NECF; do not rebuild patterns)
- Worker handoff: client gets `IsolatedElementHandoff` metadata only;
  consumer receives NECQ/NECF once; a follow-up `steer` does not re-transfer
- Offline bind: load checked-in fixture files (no NEC solve) and assert
  magics, counts, checksums, representative samples

Browser: keep the live dipole handoff and add a fixture-file bind into a mock
consumer worker. Main-thread application state still has no large
current/pattern buffers. Insulated-turnstile superposition lives in the Node
validation file (public APIs only).

### Rust binder

Upgrade `packages/necpp-wasm/rust/necq_view.rs` and `necf_view.rs`:

- Zero-copy views still alias the packed bytes
- Typed little-endian `f64` loads at the documented geometry/current/field
  indices. NECF sample index matches `wasm-api.md`:
  `port * samplesPerPort + phi * nTheta + theta`
- `cargo test` loads real `current-quadrature-v1` binaries
- Bind-once: the view does not allocate a second copy of the planes
- Optional: if `NECPP_VISUALIZER_ROOT` or `../PhasedArrayVisualizer-NG`
  exists, record that fact; do not fail CI when absent

Do not implement array mutual-impedance integration.

### Files

| Path | Change |
|---|---|
| `src/current_quadrature_wp5_tb.cpp` | Native NEC-internal and fixture gates |
| `tests/CMakeLists.txt` | Register the test source |
| `packages/necpp-wasm/fixtures/current-quadrature-v1/` | Goldens |
| `packages/necpp-wasm/scripts/write-current-quadrature-fixtures.mjs` | Generator |
| `packages/necpp-wasm/package.json` | `files` + export map |
| `packages/necpp-wasm/test/pack/manifest.test.mjs` | Allow `fixtures/` |
| `packages/necpp-wasm/test/current-quadrature-validation.test.mjs` | Direct/worker/handoff/offline |
| `packages/necpp-wasm/test/browser-current-quadrature-handoff.mjs` | Fixture-bind case |
| `packages/necpp-wasm/rust/necq_view.rs`, `necf_view.rs` | Typed planes + fixture tests |
| `docs/current-quadrature-api.md`, `docs/necq-rust-binder.md` | WP5 fixtures and bind |

### Non-goals

- New ABI symbols, result-buffer kinds, or `NecArraySolver` methods
- Packing a second field kernel; NECF remains an envelope of
  `EmbeddedFarFieldResult`
- Array coupling, array factor, matching, polarization metrics
- Replacing or reconstructing element patterns in TypeScript
- Performance/memory gates and npm publish (WP6)
- Editing `PhasedArrayVisualizer-NG`

### Implementation sequence

1. Expand this WP5 section.
2. Native `[wp5_current]` internals and all-fixture characterization gates.
3. Fixture generator, goldens, pack export, drift test.
4. Typed Rust views and fixture `cargo test`.
5. Node validation and browser fixture-bind.
6. Docs, then fill this handover.

### Definition of Done

- Dipole, rooted monopole, multiwire, multiport, and turnstile matrices pass
  at WP0 tolerances.
- Direct, worker, and transferred-consumer results agree.
- The visualizer consumes fixtures without a sibling checkout or internal
  import.
- Rust/WASM receives positions, tangents, weighted currents, and fields with
  the frozen units, order, polarity, and phase.
- NEC remains the sole element-pattern source.
- Full existing native, package, Node, and browser suites pass.

### Handover

- **Status / implementer / date:** complete / WP5 implementation / 2026-09-02
- **Commit(s):** uncommitted WP5 tree on this branch; pin after the user
  commits.
- **Commands and results:**
  - `cmake --build build-wp0 --config Release --target nec2++_tests --parallel`
  - `build-wp0\tests\Release\nec2++_tests.exe "[wp5_current]" --reporter compact`
    — 7 test cases, 7870 assertions, all passed.
  - `build-wp0\tests\Release\nec2++_tests.exe "~[wp1]~[wp2]~[wp3]~[wp4]~[wp_s2]~[wp_s3]" --reporter compact`
    — 128 test cases, 23394 assertions, all passed (includes WP0–WP5 current
    tags; excludes the older WASM-API stress tags).
  - `npm --prefix packages/necpp-wasm run typecheck` — passed (via `npm test`).
  - `npm --prefix packages/necpp-wasm test` — 129 tests, all passed, including
    WP5 Node validation, drift, direct/worker, handoff, and turnstile
    superposition.
  - `npm --prefix packages/necpp-wasm run test:pack` — 5 tests, all passed
    (tarball includes `fixtures/current-quadrature-v1/`).
  - `npm --prefix packages/necpp-wasm run test:current-quadrature-browser` —
    Playwright live handoff plus published-fixture bind-once: main thread has
    no large buffers; consumer received NECQ+NECF (`quadratureBytes` 4072,
    `embeddedBytes` 608) from both paths.
  - `cargo test --manifest-path packages/necpp-wasm/rust/Cargo.toml` — 8 tests
    passed (header parse plus real fixture bind).
- **Artifacts:**
  - [`src/current_quadrature_wp5_tb.cpp`](../src/current_quadrature_wp5_tb.cpp)
  - [`packages/necpp-wasm/fixtures/current-quadrature-v1/`](../packages/necpp-wasm/fixtures/current-quadrature-v1/)
  - [`packages/necpp-wasm/scripts/write-current-quadrature-fixtures.mjs`](../packages/necpp-wasm/scripts/write-current-quadrature-fixtures.mjs)
  - [`packages/necpp-wasm/test/current-quadrature-validation.test.mjs`](../packages/necpp-wasm/test/current-quadrature-validation.test.mjs)
  - Typed plane loads in
    [`packages/necpp-wasm/rust/necq_view.rs`](../packages/necpp-wasm/rust/necq_view.rs)
  - Fixtures and bind recorded in
    [`docs/current-quadrature-api.md`](current-quadrature-api.md) and
    [`docs/necq-rust-binder.md`](necq-rust-binder.md)
- **Decisions / deviations:**
  - No new public C++/TS solve APIs. Tests use `[wp5_current]`, not `[wp5]`.
  - Native WP5 characterization uses the package `5×3` grid (`theta` 0/45/5,
    `phi` 0/90/3), not the WP3 native 30° grid, so goldens match published
    fixtures.
  - Fixtures are in the npm `files` list and export map. Numeric planes stay
    binary; JSON is metadata plus small Z/Y.
  - NECF sample index is theta-fast (`phi * nTheta + theta`), matching
    `wasm-api.md`. The earlier rust-binder `theta * nPhi + phi` formula was
    wrong and is corrected.
  - Visualizer production ingestion and a sibling checkout remain WP6. The
    optional `NECPP_VISUALIZER_ROOT` check skips when absent.
- **Known risks / next WP:**
  - WP6: characterization/transfer/bind benchmarks, docs, changelog, and an
    exact visualizer package pin.
  - Regenerating fixtures on a different engine revision will change packed
    checksums (`modelGeneration` lives in the NECQ/NECF headers).
  - Independent `get_current_distribution` + `compute_embedded_far_fields`
    still costs `2 * nPorts` unit-current solves; only characterization
    shares the loop.

## WP6 - Performance, documentation, and release

No new public solve APIs. C ABI, `NecModel` methods, and worker rows stay as
WP4 shipped them. Frozen names and layouts live in
[`docs/current-quadrature-api.md`](current-quadrature-api.md).

Visualizer production ingestion stays **out of this repo**. WP6 makes
`@necpp-engine/wasm@0.5.0` pin-ready and documents the consumer flow. A sibling
`PhasedArrayVisualizer-NG` checkout, or `NECPP_VISUALIZER_ROOT`, may be
recorded and must not fail CI. Do not implement array mutual impedance, array
factor, matching, or pattern metrics.

### Work

- Benchmark characterization, preparation, transfer, Rust/WASM bind, memory,
  and repeated retrieval for representative element complexities.
- Verify that hot-path cost follows cached buffer size, not NEC segment setup.
- Document current/pattern conventions, layouts, lifetime, and consumer flow.
- Update declarations, README, examples, changelog, package tests, and release audit.

### Frozen decisions

- Tag `[wp6_current]`. There is no existing `[wp6]` Catch tag in this tree;
  still avoid colliding with older far-field/worker “WP6” docs.
- No new ABI symbols, result-buffer kinds, or `NecArraySolver` methods.
  `abiVersion` stays `1`.
- Package version **0.4.0 → 0.5.0**. Fixture **binary** SHA-256s stay locked;
  only JSON `packageVersion` metadata changes. Do not `npm publish` or create
  git tags. `npm run pack:release` must succeed.
- Canonical benches: `dipole` and `turnstile-insulated`, 4-node
  `{-1,-1/3,1/3,1}`, physical-only. Characterization timing uses the WP0
  **19×37** grid. Identity/size locks also cover the published **5×3** fixtures.
- Hot-path gates are **counters, byte formulas, and ratios**, not host
  milliseconds. Record raw ms as evidence; do not fail CI on wall time.
- Test-only helpers may decode packed buffers. Production TypeScript must not
  interpolate `I(s)` or loop samples for electromagnetics.
- Align `pack-release.mjs` with the WP5 pack-test allowlist: `fixtures/` is
  permitted.

### Performance and memory gates

| Gate | Assert |
|---|---|
| Packed size lock | All five published fixtures plus 19×37 characterization match the WP0 formulas (dipole 4-node physical NECQ 4072 B; 5×3 NECF 608 B) |
| Prepare vs retrieve | Native retrieve does not increment `geometry_walks`, trigonometry, interpolations, or `growing_allocations` |
| Characterization solves | After warm Z/Y, one characterize increases `unit_current_basis_solve_count` by `nPorts`, not `2 * nPorts` |
| Characterize vs split APIs | Split path on a second model does `2 * nPorts` unit-current solves; characterize does `nPorts` |
| WASM retrieve | Repeated packed-handle reads do not grow RSS by packed size each time |
| Handoff | Client `IsolatedElementHandoff` has Z/Y + `byteLength`s only; consumer receives NECQ+NECF once; steer transfers 0 current/pattern bytes |
| Bind-once | Rust views alias fixture bytes; a simulated steer does not allocate a second copy |
| Main thread | Browser CDP/Playwright trace of the mock consumer: no large current/pattern `ArrayBuffer`s in main-thread application state |

### Native tests

New file `src/current_quadrature_wp6_tb.cpp`, tagged
`[wasm_api][current_quadrature][wp6_current]`. Reuse
`current_quadrature_fixtures.h`. Do not parse NEC reports.

| Case | Assert |
|---|---|
| Size lock, all five fixtures, 4-node physical | Packed NECQ bytes match `nec_prepared_quadrature_packed_bytes`; 5×3 NECF envelope `64 + (5 + 3 + 4 * nPorts * 15) * 8` |
| Dipole + insulated turnstile, 19×37 characterize | Byte formulas; solve counter `+= nPorts`; retrieve hot path frozen |
| Characterize vs split APIs | Second-model split path does `2 * nPorts` unit-current solves; characterize does `nPorts`; Z/Y and fields still match at existing tolerances |
| Existing suites | `[wp1_current]`…`[wp5_current]`, `[wp3]`, `[wp4]`, and `~[wp1]~[wp2]~[wp3]~[wp4]~[wp_s2]~[wp_s3]` stay green |

Write native JSON evidence to
`packages/necpp-wasm/bench/evidence/current-quadrature-wp6/native-baseline.json`.

### Package / browser / Rust

New Node harness `bench/current-quadrature-wp6.mjs` plus per-process case
script, using public `createNecModel` / `createNecWorkerModel` only. Keep the
WP0 embedded/snapshot baseline. Measure create, construct, warm Z/Y,
characterize, packed sizes, repeated retrieve, worker handoff, mock-consumer
bind, and simulated steer. Script: `bench:current-quadrature-wp6`.

Browser: Playwright/CDP trace around live handoff + fixture bind + steer.
Persist a compact JSON summary. Do not require the far-field visualizer app.

Rust: bind-once + steer timing against published `current-quadrature-v1`
binaries. Views must still alias.

### Files

| Path | Change |
|---|---|
| `src/current_quadrature_wp6_tb.cpp` | Native size/solve/hot-path gates |
| `tests/CMakeLists.txt` | Register the test source |
| `packages/necpp-wasm/bench/current-quadrature-wp6*.mjs` | Public-API harness |
| `packages/necpp-wasm/bench/evidence/current-quadrature-wp6/` | Native + Node + browser evidence |
| `packages/necpp-wasm/scripts/pack-release.mjs` | Allow `fixtures/` |
| `packages/necpp-wasm/test/browser-current-quadrature-trace.mjs` | CDP transfer summary |
| `packages/necpp-wasm/rust/necq_view.rs` | Bind-once/steer timing |
| `examples/wasm-current-quadrature/` | Package-only + mock-consumer examples |
| `packages/necpp-wasm/package.json`, `src/versions.ts` | 0.5.0 |
| `docs/current-quadrature-api.md`, `docs/wasm-api.md`, `docs/necq-rust-binder.md`, README, CHANGELOG | Docs |

### Non-goals

- Editing `PhasedArrayVisualizer-NG`
- `npm publish`, git tags, or changing `abiVersion`
- New ABI / `NecArraySolver` characterization
- Array coupling, array factor, matching, polarization metrics
- Replacing or reconstructing element patterns in TypeScript
- Host-absolute millisecond CI gates
- Changing WP2 `prepare_current_quadrature` solve behavior

### Implementation sequence

1. Expand this WP6 section.
2. Native `[wp6_current]` size/solve/hot-path gates and `native-baseline.json`.
3. Node WP6 bench harness + evidence directory; fix `pack-release.mjs`.
4. Browser trace summary; Rust bind/steer timing.
5. Version bump 0.5.0, README/example/changelog/`wasm-api.md`, pack consumer example.
6. Fill this handover.

### Definition of Done

- WP0 performance and memory gates pass with raw machine-readable evidence.
- No large-data main-thread or repeated-steering transfer appears in browser traces.
- Package-only and visualizer-consumer examples run from clean checkouts.
- Public docs are sufficient to implement a non-visualizer Rust/WASM consumer.
- A released package version is ready for an exact visualizer dependency pin.

The visualizer pin is `@necpp-engine/wasm@0.5.0` once a human publishes. This
WP does not publish it.

### Handover

- **Status / implementer / date:** complete / WP6 implementation / 2026-09-02
- **Commit(s):** uncommitted WP6 tree on this branch; pin after the user
  commits.
- **Commands and results:**
  - `cmake --build build-wp0 --config Release --target nec2++_tests --parallel`
  - `build-wp0\tests\Release\nec2++_tests.exe "[wp6_current]" --reporter compact`
    — 4 test cases, 7879 assertions, all passed.
  - `build-wp0\tests\Release\nec2++_tests.exe "~[wp1]~[wp2]~[wp3]~[wp4]~[wp_s2]~[wp_s3]" --reporter compact`
    — 132 test cases, 31273 assertions, all passed (includes WP0–WP6 current
    tags; excludes the older WASM-API stress tags).
  - `npm --prefix packages/necpp-wasm test` — 130 tests, all passed, including
    WP6 repeated packed retrieve.
  - `npm --prefix packages/necpp-wasm run test:pack` — 6 tests, all passed
    (tarball includes `fixtures/current-quadrature-v1/`; clean-checkout
    current-quadrature examples).
  - `npm --prefix packages/necpp-wasm run test:current-quadrature-trace` —
    Playwright/CDP summary: main thread has no large buffers; steer
    re-transfers 0 current/pattern bytes (`quadratureBytes` 4072,
    `embeddedBytes` 608).
  - `cargo test --manifest-path packages/necpp-wasm/rust/Cargo.toml` — 9 tests
    passed (bind-once/steer does not clone planes).
  - `npm --prefix packages/necpp-wasm run bench:current-quadrature-wp6 -- --output-directory bench/evidence/current-quadrature-wp6 --module-directory dist --rounds 1 --warmups 0 --fixtures dipole,turnstile-insulated --grids published --backends direct,worker`
    — 4 cases recorded.
- **Artifacts:**
  - [`src/current_quadrature_wp6_tb.cpp`](../src/current_quadrature_wp6_tb.cpp)
  - [`examples/wasm-current-quadrature/`](../examples/wasm-current-quadrature/)
  - [`packages/necpp-wasm/bench/evidence/current-quadrature-wp6/`](../packages/necpp-wasm/bench/evidence/current-quadrature-wp6/)
  - Pin-ready package `@necpp-engine/wasm@0.5.0` (`abiVersion` 1)
- **Decisions / deviations:**
  - No new public C++/TS solve APIs. Tests use `[wp6_current]`.
  - Visualizer production ingestion was not edited. Sibling checkout remains
    optional and does not fail CI.
  - `npm publish` and git tags were not performed. `test:pack` is the release
    audit; `pack-release.mjs` now allows `fixtures/`.
  - Hot-path gates are byte formulas and counters. Host milliseconds are
    evidence only.
  - Bench `--module-directory` / `--output-directory` are package-relative
    when invoked with `npm --prefix packages/necpp-wasm`.
- **Known risks / release follow-up:**
  - Publish `@necpp-engine/wasm@0.5.0` and pin it in
    `PhasedArrayVisualizer-NG`.
  - Regenerating fixtures on a different engine revision will change packed
    checksums (`modelGeneration` lives in the NECQ/NECF headers).
  - Independent `get_current_distribution` + `compute_embedded_far_fields`
    still costs `2 * nPorts` unit-current solves; only characterization
    shares the loop.


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
