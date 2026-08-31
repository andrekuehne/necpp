# Far-field WP0 engine baseline

## Decision

The engine evidence is sufficient to hand the native work to WP1. On the
accepted scalar primary/direct run, the raw segment/image accumulation accounts
for a median 89.87% of native field time and legacy RP-derived calculations
account for 10.12%. Copies and JavaScript extraction are individually below
1 ms. WP1 should therefore introduce a dedicated complex-field path that first
removes the approximately 10% report-only work and intermediate RP copying,
while retaining the raw kernel's exact operation order and frozen checksums.

Overall WP0 is not marked complete: the current consumer benchmark was rerun
and traced, but it produces one repeated steering state and a coarse
`mappingPost` bucket. The planned ten-state browser sequence and separate
mapper, fill, power, metric, and commit timers remain consumer work. That gap
does not change the native WP1 ordering established here.

## Reference environment

- Engine baseline: `8e55cab124708d2f4daafd2be3080a6d9c1ae21a` plus the WP0 commit.
- Consumer measured commit: `cfba3bab4d6aa7090015bfab634faeb2a0e52635` (clean checkout).
- CPU: AMD Ryzen 7 PRO 7840HS, 16 logical CPUs.
- OS: Windows 10.0.26200 x64; Node 24.14.1; V8 13.6.233.17-node.44.
- Engine/package/ABI: 2.5.0 / 0.3.0 / 1.
- Emscripten: 4.0.7; release flags `-O3 -DNDEBUG -flto -fexceptions`.
- Browser: Headless Chrome 151.0.7922.34.
- Fixture: 64 X-directed 11-segment dipoles, 704 total segments, perfect
  ground, ten frozen steering states, explicit fallback, 91,745,280
  segment-direction-image contributions per primary field.

Every engine case used one discarded warm-up and five measured fresh processes.
Each measured process performed ten solve/field pairs. Repeated statistics below
exclude the initial state, yielding 45 observations per combination.

## Reproduction commands

The accepted engine matrices used preserved copies of `packages/necpp-wasm/dist`
from three serial Docker builds. Replace the example artifact directories with
the preserved directories on the reproduction host.

```powershell
$env:NECPP_ENABLE_PERFORMANCE_DIAGNOSTICS = "ON"
$env:NECPP_ENABLE_WASM_SIMD = "OFF"
.\scripts\build_wasm_docker.ps1
npm --prefix packages/necpp-wasm run bench:far-field -- `
  --output-directory bench/results/far-field-wp0-final/scalar-sampled `
  --module-directory bench/results/far-field-wp0-final/artifacts/scalar-sampled `
  --rounds 5 --warmups 1 --backends direct,worker `
  --grids primary,secondary --extract-matrix true `
  --variant release-scalar-sampled-instrumented `
  --build-flags "-O3 -DNDEBUG -flto -fexceptions; diagnostics=ON/256; simd=OFF"

$env:NECPP_ENABLE_PERFORMANCE_DIAGNOSTICS = "OFF"
$env:NECPP_ENABLE_WASM_SIMD = "OFF"
.\scripts\build_wasm_docker.ps1

$env:NECPP_ENABLE_PERFORMANCE_DIAGNOSTICS = "ON"
$env:NECPP_ENABLE_WASM_SIMD = "ON"
.\scripts\build_wasm_docker.ps1
npm --prefix packages/necpp-wasm run bench:far-field -- `
  --output-directory bench/results/far-field-wp0-final/simd-sampled `
  --module-directory bench/results/far-field-wp0-final/artifacts/simd-sampled `
  --rounds 5 --warmups 1 --backends direct,worker `
  --grids primary,secondary --extract-matrix true `
  --variant release-simd128-sampled-instrumented `
  --build-flags "-O3 -DNDEBUG -flto -fexceptions -msimd128; diagnostics=ON/256; simd=ON"
```

The balanced controls were:

```powershell
npm --prefix packages/necpp-wasm run bench:far-field-overhead -- `
  --instrumented-directory bench/results/far-field-wp0-final/artifacts/scalar-sampled `
  --uninstrumented-directory bench/results/far-field-wp0-final/artifacts/scalar-uninstrumented `
  --output-directory bench/results/far-field-wp0-final/overhead-paired --rounds 6

npm --prefix packages/necpp-wasm run bench:far-field-simd -- `
  --scalar-directory bench/results/far-field-wp0-final/artifacts/scalar-sampled `
  --simd-directory bench/results/far-field-wp0-final/artifacts/simd-sampled `
  --output-directory bench/results/far-field-wp0-final/simd-paired --rounds 6

npm run bench:nec --prefix C:\Users\andre\VSCode_Projects\PhasedArrayVisualizer-NG\web
npm --prefix packages/necpp-wasm run bench:consumer-trace -- `
  --consumer-web C:\Users\andre\VSCode_Projects\PhasedArrayVisualizer-NG\web `
  --output bench/results/far-field-wp0-final/consumer/consumer-browser-trace.json `
  --quick false
```

## Scalar engine baseline

| Backend/grid | Repeated field median / p90 | Solve median | Native total median | Peak RSS delta median |
|---|---:|---:|---:|---:|
| direct, 181 x 360 | 4,835.0 / 8,042.9 ms | 2.58 ms | 4,833.9 ms | 78.2 MiB |
| worker, 181 x 360 | 6,015.8 / 8,241.8 ms | 3.32 ms | 6,013.4 ms | 108.7 MiB |
| direct, 69 x 272 | 1,329.5 / 2,299.1 ms | 1.82 ms | 1,329.0 ms | 56.1 MiB |
| worker, 69 x 272 | 1,258.0 / 2,327.5 ms | 3.08 ms | 1,255.9 ms | 81.8 MiB |

The host changed between roughly 4 s and 8 s thermal/scheduling regimes during
the long matrices. Direct-versus-worker and scalar-versus-SIMD aggregate
medians are therefore descriptive, not causal comparisons. Balanced paired
probes below control run order for the two build decisions.

### Primary/direct phase ranking

The raw phase samples one `ffld()` call every 256 evaluated directions and
extrapolates within each field. Native total and all enclosing boundaries are
timed exactly. Reporting median per-call shares avoids adding independently
selected phase medians.

| Phase | Median share of native total | Milliseconds at the median native total |
|---|---:|---:|
| Raw segment/image accumulation | 89.87% | 4,344.3 ms |
| NEC derived RP work | 10.12% | 489.0 ms |
| Native result copy | 0.0031% | about 0.15 ms |

The independently reported ABI copy median is 0.483 ms, TypeScript extraction
is 0.673 ms, and the direct facade residual is 0.028 ms. The worker facade
residual is 1.231 ms on the primary grid and transfers six result buffers; it
is negligible compared with native field computation. Across 180 accepted
repeated calls, maximum reconciliation error was effectively zero natively,
0.0044% at the package boundary, and zero at the observed wall boundary.

## Amdahl scenarios

Using the direct-primary median raw share as the distributable fraction gives
ceilings of 1.82x, 3.07x, and 4.68x for 2, 4, and 8 workers. If both raw and
derived per-direction work were distributable, the arithmetic ceilings would
be 2.00x, 4.00x, and 7.99x. These are scenarios, not forecasts: they exclude
snapshot broadcast, dispatch, worker startup, tile merge, cancellation, and
memory costs. After WP1 removes derived RP work, the raw-only scenario is the
more relevant planning bound.

## Instrumentation and SIMD controls

The rejected first probe read the clock around every direction and inflated the
sequential full-run median by approximately 96%. It was replaced by the 1/256
sampled raw timer. In six balanced primary/direct pairs, accepted instrumentation
measured 4,226.1 ms versus 4,229.5 ms uninstrumented, a median paired delta of
-0.02%; all six field hashes matched.

Scalar and `-msimd128` full matrices were bitwise identical for all 200 fields.
In six balanced primary/direct pairs, SIMD measured a 1.53% median improvement,
with individual deltas from -6.17% to +5.30%. This is below the plan's 10%
isolated-field threshold and too noisy to justify changing the WP1 reference
build. WP0 makes no SIMD release decision; scalar remains the reference and
SIMD can be reevaluated after WP1 exposes a simpler kernel/data path.

The direct CPU profile contains 3,556 samples, 93.31% attributed to WASM code.
Release symbols identify WASM function indices rather than C++ names, so the
calibrated native phase diagnostics are the more specific attribution source.

## Consumer browser reference

The unchanged consumer benchmark was built and run from its documented command.
It uses the published scalar NEC package and a SIMD-enabled Rust mapper.

| 64-element case | Repeated total | Field | Solve | Network preparation | Mapping/post |
|---|---:|---:|---:|---:|---:|
| 256 display | 3,773.2 ms | 3,756.8 ms (99.57%) | 2.1 ms | 2.7 ms | 11.6 ms |
| 32 display | 1,094.1 ms | 1,087.2 ms (99.37%) | 2.9 ms | 2.6 ms | 1.4 ms |

The full Chromium trace contains 127,867 events. The renderer main thread has
two nested events at or above 50 ms, both representing the same 54.25 ms task;
the multi-second NEC field request remains in the package worker. The trace is
archived as a ZIP containing Chrome trace JSON.

Consumer limitations are explicit: this harness records only one repeated
steering, does not use the frozen ten-state current sequence, does not include
engine artifact hashes in its JSON, and does not split `mappingPost`. Its
results corroborate that field time dominates end-to-end latency but do not
satisfy the remaining consumer-specific WP0 Definition of Done.

## Evidence archive

- `bench/evidence/far-field-wp0/scalar/`: accepted fixture, raw NDJSON, summary.
- `bench/evidence/far-field-wp0/simd/`: accepted raw NDJSON and summary.
- `bench/evidence/far-field-wp0/paired/`: overhead and SIMD paired raw/summary.
- `bench/evidence/far-field-wp0/profiles/`: direct scalar CPU profile.
- `bench/evidence/far-field-wp0/consumer/`: raw browser JSON and compressed trace.

The raw engine records include artifact hashes, exact build flags, environment,
CPU time, RSS samples, result bytes, generations, representation diagnostics,
requested/achieved-current and field hashes, and representative complex values.
