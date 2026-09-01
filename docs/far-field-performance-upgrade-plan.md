# NEC far-field performance upgrade plan

**Status:** implementation in progress; WP0 through WP2 complete, WP3 next
**Created:** 2026-08-31
**Primary engine baseline:** `necpp` commit `8e55cab124708d2f4daafd2be3080a6d9c1ae21a`
**Primary consumer baseline:** `PhasedArrayVisualizer-NG` commit `adf617081e8b53d08729cce57e2a1f7a3bed561c`

## Purpose

This document is the starting point and handover record for reducing repeated
NEC steering latency in `PhasedArrayVisualizer-NG`. It is deliberately narrower
than [the general parallelization upgrade plan](parallelization-upgrade-plan.md):
the prepared model and retained factorization already make changed-current
solves cheap, while the consumer's measured repeated-steering time is dominated
by far-field production.

The work must optimize the existing full-wave NEC result, not substitute the
array-factor or prescribed-current coupled-dipole result. Every optimization is
conditional on measured end-to-end benefit and preservation of the public
complex-field and power contracts.

The immediate browser target must continue to work without cross-origin
isolation. Emscripten pthreads, `SharedArrayBuffer`, and COOP/COEP deployment are
deferred to a later plan increment. Ordinary module workers and nested workers
that communicate with copied or transferred `ArrayBuffer` objects are in scope.

## Instructions for implementing agents

1. Read this document, [the TypeScript engine plan](ts_engine_plan.md),
   [the WASM API contract](wasm-api.md),
   [the complex far-field contract](wp3-complex-far-field.md), and the relevant
   sections of [the parallelization upgrade plan](parallelization-upgrade-plan.md)
   before changing code.
2. Start only one work package unless its dependencies are already complete.
3. Do not infer a bottleneck from a coarse wall-clock timer. WP0 phase evidence
   is the authority for optimization order.
4. Preserve a runnable single-worker path throughout the work. A failed or
   unsupported optimization must fall back explicitly, not silently change the
   numerical model or angular grid.
5. Store raw benchmark output in a versioned machine-readable schema and record
   exact engine, consumer, toolchain, browser, OS, CPU, artifact hash, and build
   flags. A Markdown summary alone is not evidence.
6. Update the handover block in every completed work package. Include commits,
   commands, raw artifact paths, measured results, deviations, and remaining
   risks so the next agent does not have to reconstruct prior work.
7. Do not mark a work package complete merely because code exists. Its
   Definition of Done and performance decision gate must pass.

## Executive conclusion

The current production path is responsive on the browser main thread but not
parallel within a NEC field request:

```text
outer TypeScript module worker
  -> one single-threaded NEC WASM instance
     -> solveCurrents() using retained factorization
     -> computeFarField()
        -> serial phi loop
           -> serial theta loop
              -> serial loop over every segment and image
        -> NEC gain/polarization/report-derived calculations
        -> native result copy
     -> TypeScript-owned array copies
  -> transferable worker response
  -> visualizer mapper, polarization, powers, metrics, and commit
```

There are four distinct optimization questions which must not be conflated:

1. How much time is spent summing segment contributions in `ffld()`?
2. How much is spent in NEC calculations that the stateful complex-field API
   does not consume, such as gain and polarization-report derivation?
3. How much is spent copying/extracting/transferring field arrays?
4. How much is spent in the visualizer's mapper, integration, metric, and result
   publication stages?

WP0 answers those questions. Later work first removes unnecessary serial work,
then evaluates SIMD and data-layout improvements, and only then distributes the
remaining independent angular samples across lightweight field workers.

## Evidence available before WP0

The following evidence establishes the problem and the missing measurements;
it is not a substitute for WP0.

| Observation | Evidence | Consequence |
|---|---|---|
| A production 8 x 8, 11-segment, 256 x 256 case recorded 4,161.9 ms initial and 3,616.5 ms repeated steering. | `PhasedArrayVisualizer-NG/docs/nec-wp8-benchmarks.json` at the consumer baseline above. | Reusing preparation saves little of the user-visible wall time. |
| The same record reports about 2.2 ms for the native solve and 3,631.4 ms for the field stage, with about 44.8 ms mapping/postprocessing. | Same benchmark record; stage and wall measurements have normal run-to-run variance. | The retained current solve is not the primary repeated-steering target. |
| The 256 x 256 consumer view requests a capped 181 x 360 NEC source field: 65,160 directions. | `PhasedArrayVisualizer-NG/web/src/engine/nec-backend.ts`. | The expensive work is much larger than the final display grid alone suggests. |
| `nec_radiation_pattern::analyze()` loops serially over phi and theta. | [`src/nec_radiation_pattern.cpp`](../src/nec_radiation_pattern.cpp). | Angular samples are not distributed across cores. |
| `nec_context::ffld()` loops over every structure segment for each direction. | [`src/nec_context.cpp`](../src/nec_context.cpp). | The dominant candidate is proportional to samples x segments x ground images. |
| The stateful facade calls `rp_card()` and then copies only complex `E_theta` and `E_phi`. | [`src/nec_stateful_model.cpp`](../src/nec_stateful_model.cpp). | NEC report-oriented per-sample calculations and intermediate result storage may be avoidable. |
| The release WASM flags include `-O3 -flto` but neither `-pthread` nor `-msimd128`. | [`scripts/build_wasm_inner.sh`](../scripts/build_wasm_inner.sh). | The NEC artifact is single-threaded and does not explicitly enable WASM SIMD. |
| The package worker API is asynchronous but serialized. | [`packages/necpp-wasm/src/worker-client.ts`](../packages/necpp-wasm/src/worker-client.ts) and [`packages/necpp-wasm/src/worker-runtime.ts`](../packages/necpp-wasm/src/worker-runtime.ts). | The outer worker prevents UI blocking but does not parallelize one solve or field request. |
| The visualizer's Rust/WASM mapper is built with `simd128`, while the NEC WASM artifact is not. | `PhasedArrayVisualizer-NG/scripts/build-wasm.mjs` and the NEC build script above. | WP0 must attribute native field and consumer postprocessing separately; “WASM uses SIMD” is not true for both artifacts. |
| The current engine array benchmark uses only a 9 x 12 field request and retained iterations time `solveCurrents()` without far-field extraction. | [`packages/necpp-wasm/bench/array-case.mjs`](../packages/necpp-wasm/bench/array-case.mjs). | Existing benchmark results cannot answer the repeated-steering question. |
| The default horizontal dipole reports `UNSUPPORTED_ELEMENT_PATTERN_TRANSFORM` and executes explicitly. | Consumer release diagnostics and the symmetry limitations in [`docs/01_symmetry_support.md`](01_symmetry_support.md). | The primary benchmark must assert explicit representation; it must not accidentally benchmark a different vertical symmetric fixture. |

## Scope and settled decisions

### In scope

- Exact complex far fields for the latest simultaneous NEC solution.
- The `createNecArraySolver()` worker-backed consumer path.
- The visualizer's production 8 x 8 horizontal-dipole case.
- Native phase attribution, ABI/TypeScript extraction, worker messaging, and
  visualizer postprocessing attribution.
- Removal of work not required by the stateful complex-field API.
- Allocation reuse, layout cleanup, trigonometric/precomputation experiments,
  explicit `-msimd128` experiments, and justified kernel specialization.
- A no-shared-memory lightweight field-worker design that does not replicate
  the interaction matrix or factorization.
- Bounded worker counts, prewarming, cancellation between tiles, newest-request
  coalescing, disposal, and fallback.
- A measured decision on worker-resident embedded-field caching after the direct
  combined path has been optimized.
- Node and browser package paths, with production-browser results authoritative
  for visualizer interaction.

### Out of scope for this plan

- Emscripten pthread builds, `SharedArrayBuffer`, COOP/COEP, or any deployment
  requirement for cross-origin isolation.
- Parallel matrix assembly or Eigen factorization; those remain owned by the
  general parallelization plan.
- Multiple complete `NecArraySolver` replicas for one field request. They would
  duplicate geometry, LU factors, matrices, and memory.
- Lowering angular resolution while reporting the result as equivalent quality.
  A separately labelled interactive-preview mode may be considered by the
  consumer, but it is not a field-kernel optimization.
- `-ffast-math`, relaxed numerical semantics, or an unconditional f32 field
  kernel. Any reduced-precision experiment requires a separate contract and
  explicit error/fallback policy.
- WebGPU as the first implementation. It may be reconsidered after the exact CPU
  path is exhausted and an f32 error budget exists.
- Replacing a simultaneous NEC field with an array factor or isolated-element
  approximation.

## Frozen representative benchmark fixture

WP0 must encode this fixture in the engine benchmark rather than depend on a
sibling checkout at runtime. It reproduces the visualizer's production default:

| Property | Value |
|---|---|
| Array | Rectangular 8 x 8, 64 ordered elements/ports |
| Position | `(x, y) = ((ix - 3.5) * 0.5 lambda0, (iy - 3.5) * 0.5 lambda0)` |
| Design frequency | 10 GHz |
| Metre conversion | `lambda0 = 299792458 / 10e9` |
| Element | X-directed straight centre-fed dipole |
| Length / radius / centre height | `0.47 / 0.001 / 0.25 lambda0` |
| Segmentation | 11 segments, feed at segment 6 |
| Ground | Infinite perfect ground, `groundConnection: "none"` |
| Structural/port loss | Zero in the NEC structure; retain consumer network accounting separately |
| Representation | Full caller description with `symmetry: "auto"`; assert explicit fallback `UNSUPPORTED_ELEMENT_PATTERN_TRANSFORM` |
| Primary source grid | theta 0..90 degrees, 181 points at 0.5 degrees; phi 0..359 degrees, 360 points at 1 degree; radius 1 m |
| Secondary source grid | The exact grid selected by the consumer's 32 x 32 display policy; record the derived counts rather than hard-code an assumption |
| Display mapping | 256 x 256 primary and 32 x 32 secondary, using the consumer's production mapper |

Use a checked-in deterministic sequence of at least ten valid `(u, v)` steering
points, beginning at broadside and covering positive/negative axis, diagonal,
and near-edge steering. The fixture must emit the sequence and a checksum of
every requested and achieved current vector. It must keep taper, quantization,
enabled elements, reference settings, and source power fixed unless a named
secondary case deliberately varies them.

The engine-level benchmark may drive deterministic current vectors directly.
The consumer benchmark must use its real port-network drive and peak-phasor
conversion. The two harnesses need not have identical source-plane inputs, but
they must use the same geometry, frequency, field grids, steering sequence, and
ordered ports, and they must record achieved-current checksums.

## Measurement model

WP0 must report at least the following non-overlapping or reconcilable phases.
If a boundary cannot be measured directly, report the residual calculation and
its uncertainty rather than assigning it to a convenient stage.

### Native engine phases

- Field request validation and axis/result allocation.
- Per-direction segment/image accumulation in the raw far-field kernel.
- NEC per-sample derived gain, polarization, normalization, or report work.
- Native intermediate-result and stateful-result copying.
- C ABI result-buffer preparation.
- Deallocation/result replacement attributable to the request.
- Counts: directions, segments, ground images, and total segment-direction
  contributions.

### TypeScript worker/package phases

- Native WASM call duration.
- WASM-buffer-to-TypeScript-owned-array extraction.
- Worker result serialization/transfer preparation.
- Worker round trip observed by the client.
- Result byte count and transferred versus copied buffers.

### Visualizer phases

- Port-network drive and peak-current preparation.
- `solveCurrents()` worker round trip.
- Far-field worker round trip.
- Mapper `set_source` copy/conversion.
- Source-to-target mapping.
- Quantity/polarization fill.
- Polarized-power integration and closure.
- Pattern metrics.
- Result commit/cache publication.
- End-to-end wall time and main-thread long tasks.

The existing consumer `mappingPost` bucket is too coarse for WP0 and must be
split for the benchmark build. Production diagnostics may later expose a
smaller stable subset.

## Performance and correctness decision rules

- WP0 freezes medians and dispersion before optimized code is merged.
- Report warm-up separately. Use at least one untimed warm-up sequence and five
  measured sequences in fresh pages/processes unless WP0 justifies another
  count from observed variance.
- Report median, minimum, maximum, and p90 for repeated steering. Never select
  only the fastest run.
- Run benchmark variants serially on the host. Do not benchmark competing cases
  concurrently.
- Reconcile detailed stages to their enclosing wall time within 5% at the native
  and package boundary and within 10% end to end. Explain larger residuals.
- Measure timing-instrumentation overhead against an uninstrumented build. Keep
  it below 3% or use separate calibrated phase probes.
- Preserve complex fields at the existing public tolerances. Require bitwise
  equality where operation order is intentionally unchanged.
- Preserve port order, theta-fast sample order, phasor convention, range phase,
  power budget, and factorization/solve generations.
- A proposed optimization with less than 10% isolated field-stage improvement
  is not automatically shipped. Retain it only if it enables a later measured
  win, simplifies the hot path without regression, or has another recorded
  justification.
- The production worker pool must provide at least a 2x median improvement for
  the primary repeated-field stage with four field workers on the reference
  host, and at least a 1.75x end-to-end repeated-steering improvement. WP0 may
  raise these gates if the measured parallel fraction supports it; lowering a
  gate requires a written decision record.
- No optimization may increase peak memory by more than its documented geometry,
  current-snapshot, worker-runtime, output-tile, and code-instance costs.

# Work packages

## WP0 - Reproducible end-to-end far-field baseline and phase attribution

### Goal

Produce the first benchmark that measures the actual 8 x 8, 11-segment
visualizer workflow across multiple steering updates, including far-field
extraction and all consumer postprocessing. Determine what is expensive before
selecting an implementation.

### Work

1. Add a versioned benchmark fixture matching the frozen geometry above. Do not
   reuse the current vertical symmetry fixture.
2. Extend or add a package benchmark that performs:
   - module/worker creation;
   - geometry and port construction;
   - preparation and optional Z extraction;
   - an initial current solve and full primary far field;
   - at least nine additional `solveCurrents()` plus `computeFarField()` pairs;
   - a second field-grid request after one solve to confirm solve reuse; and
   - disposal and memory observation.
3. Run direct Node mode to isolate native/TypeScript cost and worker Node mode
   to measure the worker boundary.
4. Add native phase diagnostics capable of separating raw segment-field work
   from derived RP work and native result copying. Avoid a clock call inside
   every segment iteration. If timing each direction is necessary, calibrate its
   overhead against a phase-probe build.
5. Extend the consumer browser benchmark to run the identical fixture and
   steering sequence through the production `WasmEngine`, port network,
   package worker, field mapper, powers, metrics, and commit path.
6. Split consumer mapping/postprocessing timers as specified in the measurement
   model.
7. Capture CPU utilization or per-process/thread CPU time where supported so a
   single saturated core is distinguishable from message waiting.
8. Record output checksums, representative complex samples, factorization and
   solve generations, worker counts, memory, and artifact hashes.
9. Produce a flame graph or sampling profile for at least the direct native/WASM
   field call and a browser performance trace for one repeated steering.
10. Publish raw JSON/NDJSON plus a concise Markdown findings report that ranks
    the phases and computes the observed parallel fraction and Amdahl ceilings
    for two, four, and eight field workers. Label those ceilings as scenarios,
    not forecasts.

### Required benchmark comparisons

- Primary 181 x 360 source grid versus the consumer-derived 32 x 32 source grid.
- Initial versus every repeated steering, not only one selected steering.
- Direct facade versus worker facade.
- Existing full `RP` path versus any benchmark-only raw-field phase probe.
- NEC WASM scalar release build versus an otherwise identical `-msimd128` build
  as a measurement only; no SIMD release decision occurs in WP0.
- Consumer mapper SIMD artifact unchanged, with its contribution reported
  separately.

### Definition of Done

- One documented command reproduces the engine benchmark from a clean checkout.
- One documented command reproduces the production-browser consumer benchmark.
- Raw results contain all environment, version, artifact, fixture, generation,
  checksum, timing, memory, and worker metadata required above.
- At least ten field-producing steering states are measured.
- Detailed phase totals reconcile to enclosing wall clocks within the stated
  limits or contain an explicit residual explanation.
- Instrumentation overhead is measured and acceptable.
- The findings state, with percentages and absolute milliseconds, how much time
  belongs to raw segment accumulation, NEC derived work, native/ABI/TS copies,
  worker transport, consumer mapping, power integration, metrics, and other
  residual work.
- The benchmark fails if retained steering recreates/refactors the solver or
  omits far-field extraction.
- No performance optimization beyond measurement-enabling refactoring is mixed
  into the frozen baseline commit.

### WP0 handover - fill before marking complete

- **Status:** complete; handed to WP1
- **Implementer / date:** Codex / 2026-08-31 to 2026-09-01
- **Engine commit(s):** commit containing this handover, based on `8e55cab124708d2f4daafd2be3080a6d9c1ae21a`
- **Consumer commit(s):** no consumer changes; browser evidence rerun at clean commit `cfba3bab4d6aa7090015bfab634faeb2a0e52635`
- **Commands:** full commands and build flags are recorded in `packages/necpp-wasm/bench/FAR_FIELD_WP0_RESULTS.md` and each JSON summary; verification used instrumented scalar, uninstrumented scalar, and instrumented `-msimd128` Docker builds plus `npm run bench:nec --prefix C:\Users\andre\VSCode_Projects\PhasedArrayVisualizer-NG\web`
- **Raw artifact paths:** `packages/necpp-wasm/bench/evidence/far-field-wp0/{scalar,simd,paired,profiles,consumer}`
- **Reference environment:** AMD Ryzen 7 PRO 7840HS, 16 logical CPUs, Windows 10.0.26200 x64, Node 24.14.1, Emscripten 4.0.7, package 0.3.0, engine 2.5.0, ABI 1, Headless Chrome 151.0.7922.34
- **Baseline headline results:** scalar direct repeated median/p90: primary 4835.0/8042.9 ms and secondary 1329.5/2299.1 ms; repeated solve medians 2.58/1.82 ms; consumer primary repeated total 3773.2 ms with 3756.8 ms field and 11.6 ms coarse mapping/post; all direct/worker and all 200 scalar/SIMD field hashes matched bitwise
- **Phase ranking and Amdahl scenarios:** primary/direct median per-call shares: raw accumulation 89.87% (4344.3 ms at median native total), RP-derived work 10.12% (489.0 ms), native copy 0.0031%; raw-only Amdahl ceilings are 1.82x/3.07x/4.68x for 2/4/8 workers; all-direction-work ceilings are 2.00x/4.00x/7.99x and are explicitly scenarios, not forecasts
- **Instrumentation overhead:** the rejected per-direction-clock probe inflated median time about 96%; the accepted 1/256 sampled probe measured 4226.1 ms versus 4229.5 ms uninstrumented in six balanced pairs, median delta -0.02%, with exact hashes
- **Decisions made:** hand WP1 a scalar reference; remove the measured approximately 10% report-only RP work and intermediate copies before changing raw-kernel order; retain SIMD as a later experiment because six balanced pairs showed only -1.53% median with -6.17% to +5.30% dispersion; preserve fixture/checksum/generation gates
- **Deviations from this plan:** by owner decision on 2026-09-01, the unchanged production 8 x 8, 11-segment, full-resolution browser run is accepted as equivalent consumer-side evidence. Its schema has one repeated steering and one coarse `mappingPost` bucket rather than the frozen ten-state sequence and requested mapper/fill/power/metric/commit split. Those consumer extensions are waived for WP0 because the measured repeated total is 99.57% package far-field time and the engine benchmark already supplies the multi-steering phase attribution needed to select WP1 work.
- **Remaining risks / next recommended WP:** begin WP1 with a dedicated serial complex-field path, preserving exact scalar operation order and hashes. Consumer subphase data remains unavailable, so later consumer optimization priorities must be justified by new measurement rather than inferred from the coarse `mappingPost` bucket.

## WP1 - Dedicated raw complex far-field kernel and serial data path

### Goal

Separate the field quantity required by the stateful API from legacy NEC report
derivation, eliminate demonstrated intermediate work/copies, and create a
read-only sample kernel suitable for later worker tiling while preserving the
serial result.

### Entry gate

WP0 is complete. Its evidence identifies raw segment accumulation, derived RP
work, copying, or allocation as material phases and supplies frozen output
checksums and timing baselines.

### Work

1. Define an internal immutable far-field evaluation input containing only the
   geometry, solved current coefficients, wavelength, ground/image parameters,
   and other values needed by ordinary far-zone evaluation.
2. Refactor the ordinary `ffld()` calculation into a function that returns one
   complex `E_theta/E_phi` sample without mutating shared request state.
3. Preallocate theta/phi axes and output arrays. Write each result directly to
   its final theta-fast location.
4. Add a stateful raw-complex-grid path that does not calculate unused gain,
   ellipse, normalization, printing, or report arrays.
5. Keep the legacy `RP`/deck behavior and results intact. Reuse the raw kernel
   from `nec_radiation_pattern::analyze()` where practical, followed by its
   existing derived calculations.
6. Remove only copies and allocations shown by WP0 to be redundant. Preserve
   JavaScript-owned returned arrays at the public boundary.
7. Make result ownership, replacement, zero-excitation behavior, and exception
   cleanup explicit.
8. Retain phase counters in a disabled-by-default or low-overhead diagnostics
   form so later WPs can attribute regressions.

### Definition of Done

- Direct combined fields match the frozen serial baseline at existing tolerances
  for free space, perfect ground, finite ground fixtures, symmetric and explicit
  models, zero excitation, translated arrays, and range scaling/phase.
- The legacy deck/RP regression corpus remains unchanged within its existing
  contract.
- The ordinary visualizer path no longer computes any WP0-identified unused RP
  quantity.
- Per-request allocation and copy counts are measured before and after.
- Single-worker primary-grid field time improves by at least 10%, or WP0 proves
  the removed phase was smaller and the refactor is retained specifically as
  the prerequisite for safe tiling with less than 5% serial regression.
- Public TypeScript and stable ABI behavior remains compatible; any additive
  diagnostics are versioned and tested.
- Sanitizer and exception/failure-path tests show no leak or stale result.

### WP1 handover

- **Status:** complete; handed to WP2
- **Implementer / date:** Codex / 2026-09-01
- **Commits:** the commit containing this handover, based on WP0 handover commit `fb573ac`
- **Changed internal/public interfaces:** added the private immutable `nec_far_field_evaluation_input`, read-only `nec_evaluate_far_field_sample()`, and legacy-order range scaler; `nec_context::ffld()` delegates to the raw kernel; no public C, WASM, or TypeScript contract changed
- **Commands and test matrix:** fresh MSVC Release build; canonical native partitions passed: non-WP suite 1,044 assertions/82 cases, WP1 54 assertions/7 cases including stress, WP2 83/8, WP3 228/10, WP4 63/2, WP-S2 10,599/5, WP-S3 12/2; focused numerical-contract 75/3, surface-patch legacy RP 47/1, and WASM ABI 75/4 checks also passed; a fresh diagnostics-enabled build passed the raw-path timing/allocation checks (14 assertions). The Emscripten 4.0.7 release build (`-O3 -DNDEBUG -flto -fexceptions`, diagnostics `ON/256`, SIMD off) passed its smoke check, 77 package tests, typecheck, clean package-consumer tests, Vite/browser bundle checks, and package audit. A native GCC 11 Debug build with AddressSanitizer, UndefinedBehaviorSanitizer, leak detection, and halt-on-error passed all 12,083 assertions in 116 Catch2 cases.
- **Raw before/after artifacts:** before is `packages/necpp-wasm/bench/evidence/far-field-wp0/scalar/`; after is `packages/necpp-wasm/bench/evidence/far-field-wp1/scalar/`. The preserved local release module used for the run is under ignored `packages/necpp-wasm/bench/results/far-field-wp1-final/artifacts/scalar-sampled/`.
- **Field equality results:** native free-space, perfect/finite ground, explicit/symmetric, zero excitation, range phase/scaling, translated-array, embedded-superposition, legacy deck/RP, and surface-patch checks passed at their existing tolerances. The frozen release WASM run compared 200 requested-current, achieved-current, and complex-field checksum triples against WP0 with zero mismatches; direct/worker parity also reported zero failures.
- **Allocation/copy changes:** the old stateful request allocated four final buffers plus 13 RP report matrices and two intermediate complex field buffers (19 backing allocations), then copied both complex fields through the intermediate and final buffers; the raw path allocates only the four final axis/field buffers and reports zero intermediate field buffers and zero complex sample-copy pass
- **Measured speed-up:** repeated-field median before -> after: primary direct 4,834.98 -> 3,547.42 ms (26.63%), primary single-worker 6,015.83 -> 3,562.88 ms (40.77%), secondary direct 1,329.49 -> 1,031.25 ms (22.43%), and secondary single-worker 1,258.00 -> 1,037.48 ms (17.53%). The required primary single-worker improvement therefore exceeds the 10% gate by 30.77 percentage points.
- **Decisions / rejected alternatives:** preserved the scalar contribution order and historical magnitude/phase range transform; retained the legacy RP derivations above the shared sample kernel; rejected keeping stateful fields coupled to `nec_radiation_pattern` or exposing a new public ABI solely for the refactor
- **Deviations:** CTest's 180-second WP1 timeout was unsuitable for the sanitizer configuration and its forced termination caused noisy repeated `AddressSanitizer:DEADLYSIGNAL` lines without a sanitizer stack report. The same WP1 partition and then the complete 116-case suite were run directly from the identical instrumented binary without CTest's timeout; both passed with leak/UB halting enabled.
- **Remaining risks / next recommended WP:** begin WP2 from the archived scalar WP1 artifact and retain the exact checksum gate. Treat the large difference between the noisy WP0 worker median and the tighter WP1 run as an environment/dispersion risk when attributing worker-only gains; the direct primary result independently passes the gate at 26.63%.

## WP2 - Serial kernel optimization and WASM SIMD decision

### Goal

Reduce the work per segment-direction contribution before adding workers, and
make an evidence-based decision on `-msimd128` for the NEC artifact.

### Entry gate

WP1 has a stable read-only raw sample kernel and WP0/WP1 phase benchmarks.

### Candidate optimizations

Investigate them independently so attribution remains possible:

- Hoist theta/phi conversion and reusable `sin`/`cos` values out of the segment
  loop.
- Precompute immutable segment constants such as `pi * segment_length` and
  orientation/position views where this preserves the calculation.
- Avoid recomputing direction values shared by a theta row or phi column.
- Reuse output, direction, and bounded scratch buffers across steering calls.
- Verify that structure-of-arrays inputs are contiguous and aligned for the
  compiler; remove accessor or layout overhead visible in profiles.
- Compare separate `sin`/`cos` calls with a supported paired implementation
  only when the generated WASM and numerical result justify it.
- Compile the same source with and without `-msimd128`; inspect the artifact to
  prove whether SIMD opcodes and vectorized hot loops are actually present.
- If autovectorization does not reach the hot loop, prototype narrow explicit
  SIMD only after profiles identify a vectorizable subkernel. Keep a scalar
  implementation as the reference.
- Measure code size, instantiation time, field time, and end-to-end time. The
  consumer mapper's existing SIMD must remain a separate measurement.

### Numerical restrictions

- Do not enable `-ffast-math` globally.
- Do not reorder the sum over segments unless an explicit error analysis and
  regression expansion first establish a new accepted contract.
- Do not silently downcast solved currents, geometry, phase, or accumulated
  fields to f32.
- Any non-bitwise optimization must pass the public complex-field tolerances,
  null/peak/phase fixtures, power closure, and embedded-superposition equality.

### Definition of Done

- A checked-in benchmark matrix compares each candidate independently against
  the WP1 baseline on both primary and secondary grids.
- Generated artifact inspection proves whether `-msimd128` affects the hot path.
- Every shipped optimization has an isolated benefit, a correctness result, and
  no more than 5% regression on small grids.
- The selected serial configuration improves the primary raw field kernel by at
  least 15% over WP1, or the handover records why the measured kernel is already
  dominated by operations that current WASM SIMD cannot accelerate.
- If SIMD ships, supported environments, feature detection/fallback if needed,
  artifact identity, package audit, Node, browser, and worker tests are updated.
- Rejected compiler flags or micro-optimizations are recorded with measurements
  so later agents do not repeat them without new evidence.

### WP2 handover

- **Status:** complete; handed to WP3
- **Implementer / date:** Codex / 2026-09-01
- **Commits:** working-tree implementation to be included with this handover,
  based on WP1 `2e5a7c7` and its documentation follow-up `97f3c63`.
- **Candidate matrix and artifacts:** the commands, measurements, artifact
  hashes, and interpretation are in
  [`packages/necpp-wasm/bench/FAR_FIELD_WP2_RESULTS.md`](../packages/necpp-wasm/bench/FAR_FIELD_WP2_RESULTS.md).
  Versioned raw and summary records are under
  `packages/necpp-wasm/bench/evidence/far-field-wp2/`.
- **Selected build flags:** retain the release scalar flags
  `-O3 -DNDEBUG -flto -fexceptions` without `-msimd128`; the default
  `NECPP_FAR_FIELD_OPTIMIZATIONS=SELECTED` enables direction trigonometric
  caching and native/ABI output-buffer reuse. Diagnostics were `ON/256` only
  for the measurement artifacts.
- **Generated-WASM/SIMD evidence:** the selected SIMD artifact contains 4,349
  SIMD instruction lines module-wide, but the eight-function far-field call
  graph reaches only one SIMD function and only `v128.load`/`v128.store`--no
  vector arithmetic in the raw accumulation loop. The scalar artifact reaches
  no SIMD instructions. `-msimd128` is therefore rejected for this artifact.
- **Numerical comparison:** all 60 isolated-candidate variant/state records and
  all 36 final variant/state records were bitwise-identical to their WP1 field
  hashes (48 and 24 non-baseline comparisons respectively), with zero failures.
  Native same-grid reuse, failure-state preservation, ABI, package, clean
  consumer, smoke, and full native regression gates passed.
- **Primary/secondary speed-up:** the final scalar selection reduced the primary
  median raw kernel from 3,565.02 ms to 3,515.25 ms (1.014x, 1.4%). The
  secondary median moved from 989.20 ms to 993.24 ms (0.996x, a 0.4% noise-scale
  regression below the 5% guardrail). Repeated output allocations fell from
  four to zero on both grids.
- **Code-size/startup impact:** selected scalar WASM grew from 736,454 to
  737,227 bytes (+773 bytes, +0.105%). Median instantiation moved from 6.27 to
  6.58 ms on the primary sequence and from 5.93 to 5.83 ms on the secondary;
  this is noise-scale. SIMD added another 2,678 bytes (+0.363%) without a field
  win.
- **Rejected candidates and why:** immutable segment half-length caching
  regressed the primary median by 0.6%; the exploratory combination containing
  it also regressed. `-msimd128` was 0.25% slower than selected scalar on the
  primary median and did not vectorize the hot arithmetic. No explicit SIMD
  prototype was justified because the remaining loop is dominated by scalar
  `sin`/`cos` transcendentals and order-preserving complex accumulation.
- **Deviations:** the 15% target was not reached. Artifact inspection explains
  the gate exception: after row/column trigonometry is hoisted, each
  segment-direction contribution still performs scalar `sin` evaluations for
  the segment-current integrals and scalar `sin`/`cos` for phase, while the
  numerical contract forbids reordering the complex sum. Current WASM SIMD does
  not accelerate those operations. The final balanced matrix used three fresh
  measured processes, one warm-up, and two deterministic steering states per
  grid; the full ten-state correctness fixture remains covered by regression
  tests and the WP0/WP1 evidence.
- **Remaining risks / next recommended WP:** proceed to WP3's lightweight
  far-field-worker proof. The serial kernel remains overwhelmingly raw
  accumulation bound, so independent angular tiles are the next material
  source of speed-up. Preserve the scalar selected configuration as its
  single-worker baseline.

## WP3 - Lightweight far-field worker proof of concept

### Goal

Demonstrate multi-core far-field scaling without cross-origin isolation and
without constructing multiple full NEC models.

### Architecture to prove

The solver-owning outer module worker remains authoritative. After a successful
current solve it creates or updates a compact immutable field-evaluation
snapshot:

```text
geometry snapshot, created/replaced with geometry/frequency environment
  x/y/z, direction cosines, segment lengths, ground/image scalars

current snapshot, replaced after every consumer solve
  the six solved current-coefficient arrays used by ffld()

field job
  regular angular-grid metadata, radius/frequency, job generation
```

A prewarmed pool of ordinary child workers receives geometry once, current data
per solve, and disjoint angular tiles per job. Each child owns a single-threaded
stateless field evaluator and returns transferable compact field tiles. It must
not own an interaction matrix, LU factorization, port matrix, or mutable NEC
model.

WP3 must compare two implementation shapes before choosing one:

1. instantiate the existing NEC WASM code in evaluator-only mode; or
2. build a smaller dedicated field-evaluator WASM artifact from the shared raw
   kernel.

The comparison must include packaging complexity, code bytes per worker,
instantiation/warm-up, snapshot copy bytes, and steady-state field time.

### Work

1. Define an internal, versioned snapshot schema with checked lengths, finite
   values, frequency, model/solution generation, and supported ground mode.
2. Prove that the primary explicit perfect-ground fixture needs only O(segments)
   copied state. Report exact bytes and compare them with the retained matrix.
3. Add one-worker evaluator parity before adding concurrency.
4. Benchmark 1, 2, 4, and 8 prewarmed evaluator workers. Cap the default
   candidate at four until evidence supports another value.
5. Benchmark static slabs and bounded tiles. Prefer a design that permits a
   stale generation to stop receiving new tiles, limiting wasted interaction
   work.
6. Preserve theta-fast final ordering independent of completion order.
7. Measure snapshot broadcast, dispatch, compute, result transfer, merge, and
   residual time separately.
8. Demonstrate disposal and recovery from one evaluator-worker failure.
9. For unsupported engine modes, return a typed capability result and use the
   serial field path. The proof may initially optimize the visualizer's ordinary
   perfect-ground far-zone path, but it must not mis-handle other public modes.

### Definition of Done

- One evaluator worker matches the WP2 serial output and generations.
- No evaluator worker contains or receives the interaction matrix, factorization,
  Z/Y matrix, or a complete `NecModel` serialization.
- Four workers improve primary-grid raw field time by at least 2x over the WP2
  single-worker kernel on the reference host.
- Worker startup is measured separately and prewarming removes it from repeated
  steering.
- Snapshot, tile, code-instance, and peak-memory costs are itemized and bounded.
- A superseded job stops dispatching tiles and cannot publish a mixed-generation
  field.
- The prototype runs in Node and a non-cross-origin-isolated Chromium page.
- A decision record chooses the evaluator artifact shape, worker count, and tile
  strategy for WP4.

### WP3 handover - fill before marking complete

- **Status:** not started
- **Implementer / date:**
- **Prototype commit(s):**
- **Snapshot schema and byte counts:**
- **Artifact-shape comparison:**
- **1/2/4/8-worker raw artifacts:**
- **Selected worker/tile design:**
- **Parity and failure tests:**
- **Speed-up and efficiency:**
- **Memory/startup costs:**
- **Unsupported-mode behavior:**
- **Deviations:**
- **Remaining risks / WP4 recommendation:**

## WP4 - Production field-worker pool and package integration

### Goal

Turn the successful WP3 design into a supported package capability used by
`createNecArraySolver()` while retaining a deterministic single-worker fallback.

### Work

1. Implement pool ownership inside the package's existing solver worker or the
   alternative location selected by WP3. Do not put synchronization waits on
   the browser main thread.
2. Add bounded configuration, for example an additive `fieldWorkers` option with
   `"auto"`, `1`, and an explicitly capped integer. Final naming follows the
   package API conventions.
3. Define `"auto"` conservatively from supported environment, logical core
   count, grid size, segment count, and measured dispatch break-even. Small
   fields should stay serial.
4. Prewarm the pool during solver creation or before first eligible field work,
   and expose warm-up separately from field timings.
5. Retain geometry snapshots across steering. Broadcast only changed solved
   current coefficients and job metadata when possible.
6. Add newest-generation cancellation between tiles, complete output validation,
   worker-crash recovery/fallback, and idempotent pool disposal.
7. Package and resolve every evaluator worker/JS/WASM asset through public
   package-relative URLs. Cover Vite base paths, packed consumers, Node workers,
   browsers, MIME types, content hashes, and CDN/custom asset bases.
8. Add diagnostics: selected field backend, active worker count, tile size,
   snapshot bytes, result bytes, fallback reason, warm-up time, dispatch time,
   kernel time, merge time, and cancelled tile count.
9. Keep direct synchronous browser `createNecModel()` serial unless a separate
   nonblocking contract is explicitly designed. The worker facade and array
   facade are the supported parallel browser paths.
10. Run the full package numerical, lifecycle, symmetry, ground, array, worker,
    packed-consumer, and browser suites.

### Definition of Done

- The production package works without `SharedArrayBuffer`, COOP, or COEP.
- The package contains all declared evaluator assets and no consumer copies a
  WASM asset manually.
- `fieldWorkers: 1` is numerically equivalent to the WP2 serial path.
- `auto` chooses the documented backend and exposes the choice in diagnostics.
- Four-worker median primary field time and end-to-end package round trip meet
  the performance gates; p90, small-grid regression, memory, and startup are
  reported.
- Rapid steering publishes only the newest generation and demonstrates bounded
  stale work rather than waiting for one complete obsolete 181 x 360 request.
- Worker failure, unsupported mode, asset failure, and explicit one-worker mode
  fall back or fail with typed, tested behavior.
- Every child worker terminates on model disposal, mode replacement, failed
  creation, and page teardown.
- No public numerical or ownership contract regresses.

### WP4 handover - fill before marking complete

- **Status:** not started
- **Implementer / date:**
- **Commits / package version:**
- **Public API additions:**
- **Generated/package assets:**
- **Backend-selection rules:**
- **Benchmark artifacts and gates:**
- **Correctness/lifecycle matrix:**
- **Cancellation evidence:**
- **Fallback evidence:**
- **Memory and startup:**
- **Deviations:**
- **Remaining risks / next recommended WP:**

## WP5 - Embedded-field cache and repeated-steering decision

### Goal

Re-evaluate embedded fields after the direct field path is optimized and
parallel, and ship a cache only where its measured amortized latency and memory
are superior. This is a decision work package; “do not enable” is a valid result
when supported by evidence.

### Background

`computeEmbeddedFarFields()` produces one unit-voltage or unit-current complex
field basis per caller port. With a unit-current basis, a later field is the
complex weighted sum of basis fields using the achieved currents returned by
`solveCurrents()`. The engine already tests equivalence with a direct combined
field. The consumer currently prohibits this path for normal steering.

At 181 x 360 with four f64 component arrays, one basis copy requires about:

| Ports | Basis bytes |
|---:|---:|
| 4 | 7.95 MiB |
| 16 | 31.82 MiB |
| 64 | 127.27 MiB |

The current API also performs one full field calculation per port and may hold
native and JavaScript copies. Enabling it blindly for 64 ports is therefore not
an optimization.

### Work

1. Benchmark the optimized direct combined path against unit-current embedded
   basis warm-up and combination for 4, 16, and 64 ports on both grids.
2. Measure warm-up, basis transfer, resident/peak memory, combination, retained
   `solveCurrents()`, total time after 1/4/16/64/256 steering states, and the
   exact break-even count.
3. Parallelize embedded angular work through the WP4 evaluator pool where
   possible. Do not concurrently mutate the package's latest consumer solution.
4. Compare the current public transferred-basis design with a worker-resident
   basis plus compact weighted-combination operation. The latter should be the
   production candidate if caching is justified.
5. Always retain one native `solveCurrents()` per steering for achieved currents,
   voltages, active impedances, per-port powers, and authoritative power budget.
6. Use `solution.currents` with an explicit unit-current basis. Do not combine a
   default unit-voltage basis with current weights.
7. Define strict cache identities and invalidation for geometry, ports, loads,
   ground, prepared frequency, normalization, and source grid. Steering,
   taper, enable, power, match settings, target grid, view, and polarization do
   not invalidate a valid unit-current source-field basis.
8. If shipped, add a user/app memory budget, progress, cancellation between
   basis ports/tiles, explicit release, diagnostics, and direct-field fallback.
9. Validate power closure, complex field equality, mapping, metrics, and caller
   order across explicit and symmetric fixtures.

### Definition of Done

- A checked-in amortization report gives measured break-even steering counts and
  memory for every required port/grid case after WP4.
- The decision explicitly states which cases, if any, enable embedded caching by
  default, opt-in, or never.
- Any shipped cache remains inside a worker unless evidence shows transferring
  it is harmless under the selected budget.
- Cached steering continues to call `solveCurrents()` and matches the direct
  combined field and power/metric results at existing tolerances.
- Cache invalidation, progress, cancellation, memory rejection, release, and
  fallback are tested.
- A no-ship decision removes prototype code from the production path while
  retaining benchmark evidence and follow-up requirements.

### WP5 handover - fill before marking complete

- **Status:** not started
- **Implementer / date:**
- **Commits:**
- **Amortization artifact:**
- **Break-even table:**
- **Resident/peak memory table:**
- **Direct versus embedded correctness:**
- **Decision by port/grid case:**
- **API/cache policy if shipped:**
- **Rejected designs:**
- **Deviations:**
- **Remaining risks / next recommended WP:**

## WP6 - Visualizer integration, postprocessing optimization, and interaction scheduling

### Goal

Consume the optimized package in `PhasedArrayVisualizer-NG`, optimize only the
consumer stages WP0 proves material, and deliver lower real steering latency
rather than an isolated kernel result.

### Work

1. Pin the released/testable package version and keep all integration through
   public entry points.
2. Expose field backend, worker count, package phase timings, fallback reason,
   cancelled work, and snapshot/tile memory in NEC diagnostics.
3. Update the consumer benchmark to preserve the frozen WP0 fixture and schema,
   allowing before/after comparison without manual transformation.
4. Split and optimize mapper copy, map, fill, integration, metrics, and commit
   only in descending WP0 cost order. The mapper already builds with `simd128`;
   do not claim SIMD as new without generated-code and timing evidence.
5. Remove repeated fills, mappings, metrics, or conversions where identities
   prove results reusable. Fuse stages only when it reduces measured time and
   preserves cache/view behavior.
6. Route generation changes into package field-job cancellation so rapid drag
   stops issuing new obsolete tiles. Keep last-good buffers until the latest
   generation commits atomically.
7. Measure the existing outer scheduler's stale-job behavior before and after.
   Coalescing that merely suppresses publication but still computes a complete
   stale field does not satisfy this work package.
8. Preserve frame-only remapping, quantity/polarization local reuse, network
   diagnostics, and factorization reuse.
9. Optional interaction preview or debounce behavior must be separately labelled
   and measured. It cannot replace the exact settled-steering benchmark.
10. Update user-facing limits and expected latency only from release evidence.

### Definition of Done

- The primary 8 x 8/11/256 repeated-steering median improves by at least 1.75x
  end to end relative to WP0 on the reference host, with the exact same source
  grid and numerical result.
- The package far-field stage meets its WP4 gate and no unexamined consumer stage
  accounts for more than 20% of repeated-steering wall time without a recorded
  follow-up decision.
- The 32 x 32 case has no more than 5% regression unless an explicit absolute
  improvement elsewhere dominates and is documented.
- Rapid multi-edit steering demonstrates bounded stale tiles and latest-only
  publication.
- Main-thread long tasks, memory, worker count, and disposal are reported and
  remain within documented limits.
- All NEC UI, browser, golden, mapping, power, package-loading, and release audit
  tests pass.
- The consumer documentation no longer describes a single-thread field request
  as parallel merely because it is worker-backed.

### WP6 handover - fill before marking complete

- **Status:** not started
- **Implementer / date:**
- **Consumer commit(s) / package version:**
- **Integration changes:**
- **Postprocessing changes and attribution:**
- **Before/after raw artifacts:**
- **End-to-end median/p90:**
- **Rapid-steering cancellation results:**
- **Main-thread/memory/disposal results:**
- **UI/documentation changes:**
- **Deviations:**
- **Remaining risks / next recommended WP:**

## WP7 - Release hardening, evidence archive, and final handover

### Goal

Make the optimized path reproducible, supportable, and safe to release in both
repositories.

### Work

1. Run the full engine native, ABI, TypeScript, worker, package, browser,
   symmetry, power, ground, field, and failure suites.
2. Run the full visualizer unit, generated-WASM, browser, golden, benchmark,
   production build, asset audit, and license checks.
3. Repeat WP0 on the reference host with release artifacts and identical fixture,
   steering sequence, run count, and reporting schema.
4. Add a second host/browser where available to detect an optimization tuned to
   one CPU or Chromium build.
5. Verify package tarball and production-site asset resolution for every nested
   worker and WASM artifact under non-root Vite base paths.
6. Verify ordinary GitHub Pages-style hosting without cross-origin isolation.
7. Record selected/fallback backend behavior when worker creation, asset loading,
   or capability checks fail.
8. Archive raw baseline and final data, summaries, flame graphs/traces, exact
   commands, artifact hashes, and known variance.
9. Fill every WP handover and the final handover below. Link superseded plans or
   follow-ups instead of leaving ambiguous TODOs.

### Definition of Done

- All required performance gates pass on release artifacts, or the release notes
  explicitly disable the failing optimization by default.
- Complex field, power, port order, generation, grid ordering, lifecycle, and
  error contracts pass the complete regression matrix.
- Every worker and WASM asset is present, content-hashed as expected, served with
  the correct MIME type, and disposed without leaks.
- Baseline and final raw data are checked in or attached at stable documented
  locations with schema versions.
- User and package documentation accurately state worker topology, SIMD status,
  supported modes, fallbacks, memory, and measured reference latency.
- Every handover block is complete enough for a new agent to reproduce the work
  without private context.

### WP7 handover - fill before marking complete

- **Status:** not started
- **Release owner / date:**
- **Engine release commit/tag/package:**
- **Consumer release commit:**
- **Release benchmark artifacts:**
- **Final performance table:**
- **Regression commands/results:**
- **Asset/deployment evidence:**
- **Fallback and compatibility statement:**
- **Known limitations:**
- **Deferred follow-up links:**
- **Release decision:**

## Dependency and execution order

```text
WP0 evidence baseline
  -> WP1 raw serial field path
     -> WP2 serial/SIMD optimization
        -> WP3 lightweight-worker proof
           -> WP4 production package pool
              -> WP6 visualizer integration
        -> WP5 embedded decision (may also consume WP4 worker results)
              -> WP6 if an embedded mode is selected
WP4 + WP5 decision + WP6
  -> WP7 release hardening
```

WP5 may begin its benchmark design after WP0 but must not make a production
decision against the old serial field cost. WP6 may prepare diagnostics and
benchmark schema changes early, but performance acceptance uses the packaged
WP4 result.

## Correctness and regression matrix

Every kernel/backend configuration selected for release must cover:

- explicit one-port, two-port, and 8 x 8 arrays;
- accepted symmetric arrays and explicit symmetry fallbacks;
- broadside and asymmetric complex steering;
- exact zero excitation;
- free space, perfect ground, and the package's supported finite-ground cases;
- translated arrays and array-facade field rephasing;
- radius 1 m and another radius for `1/R` magnitude and `exp(-jkR)` phase;
- theta-fast axis/order and non-square field grids;
- one-point, small, secondary, and primary field grids;
- direct combined versus embedded unit-current superposition;
- native, C ABI, direct TypeScript, outer worker, array facade, and packed
  consumer boundaries;
- one-worker, selected multi-worker, forced fallback, worker failure, stale
  generation, and disposal paths;
- repeated fields after one solve and repeated solves after one preparation;
- power budget, polarized-power closure, mapping, and representative metrics;
- Node plus non-cross-origin-isolated Chromium, and Firefox where the packaged
  worker architecture is supported.

## Deferred cross-origin-isolated follow-up

The general parallelization plan remains the authority for a later pthread
artifact. After this plan is complete, compare the lightweight-worker result
with a shared-memory implementation only if there is material headroom left.
That follow-up must address dual artifacts, pthread pool prewarming, worker
helper assets, shared-memory growth, stack costs, COOP/COEP hosting, and nested
parallelism with Eigen. It must not retroactively become a hidden requirement
for the GitHub Pages-compatible path delivered here.

## Overall Definition of Done

This plan is complete only when:

1. WP0 provides a reproducible, phase-attributed, multi-steering 8 x 8 benchmark
   including full field extraction and consumer postprocessing.
2. The stateful complex-field path no longer performs material report-only work
   or redundant copying identified by WP0.
3. The NEC artifact's SIMD status is measured and accurately documented.
4. The selected no-shared-memory field backend meets the field and end-to-end
   speed gates without duplicating the solver/factorization.
5. Rapid steering cancels or bounds obsolete tile work rather than merely
   suppressing stale publication.
6. Embedded caching has an evidence-backed per-case ship/no-ship decision.
7. Numerical, power, ordering, lifecycle, memory, failure, packaging, and
   non-cross-origin-isolated browser contracts pass.
8. Raw baseline/final evidence and every WP handover are complete.

## Final project handover - fill when the overall plan closes

- **Overall status:** proposed
- **Final owner / date:**
- **Engine baseline -> final:**
- **Consumer baseline -> final:**
- **Published package/version:**
- **Selected serial kernel and SIMD mode:**
- **Selected field-worker architecture/default count:**
- **Embedded-field decision:**
- **Primary initial/repeated/far-field/postprocess before -> after:**
- **Secondary-grid before -> after:**
- **Peak-memory before -> after:**
- **Raw evidence locations:**
- **Full verification commands:**
- **Deployment/fallback statement:**
- **Known limitations:**
- **Deferred pthread/cross-origin follow-up:**
