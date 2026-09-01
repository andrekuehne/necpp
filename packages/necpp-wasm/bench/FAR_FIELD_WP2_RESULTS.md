# Far-field WP2 results

WP2 is complete. The shipped serial configuration caches direction
trigonometry and reuses native and ABI output storage. It remains a scalar WASM
build: `-msimd128` did not vectorize the raw far-field arithmetic and did not
improve measured field time.

## Method

All artifacts used Emscripten 4.0.7 and
`-O3 -DNDEBUG -flto -fexceptions`, with performance diagnostics sampled once
per 256 directions. The candidate driver runs each variant in a fresh Node
process, balances variant order, warms every grid/variant once, measures both
the frozen 181 x 360 primary grid and 69 x 272 secondary grid, and rejects any
field-hash mismatch.

The isolated and final matrices were run with:

```powershell
npm --prefix packages/necpp-wasm run bench:far-field-candidates -- `
  --variants "WP1=C:\path\WP1,SEGMENT_CACHE=C:\path\SEGMENT_CACHE,DIRECTION_CACHE=C:\path\DIRECTION_CACHE,OUTPUT_REUSE=C:\path\OUTPUT_REUSE,SELECTED=C:\path\SELECTED" `
  --output-directory packages/necpp-wasm/bench/evidence/far-field-wp2/candidates `
  --rounds 3 --steering-limit 2

npm --prefix packages/necpp-wasm run bench:far-field-candidates -- `
  --variants "WP1=C:\path\WP1,SELECTED=C:\path\SELECTED,SELECTED_SIMD=C:\path\SELECTED_SIMD" `
  --output-directory packages/necpp-wasm/bench/evidence/far-field-wp2/final `
  --rounds 3 --steering-limit 2
```

`NECPP_FAR_FIELD_OPTIMIZATIONS` selects `WP1`, `SEGMENT_CACHE`,
`DIRECTION_CACHE`, `OUTPUT_REUSE`, or the default `SELECTED` configuration at
build time. `SELECTED` deliberately contains direction caching and output reuse
only. Diagnostics are not required by production builds.

## Isolated candidates

The table reports median repeated field time and speed-up over the WP1 artifact.
Each entry comprises three fresh measured processes and one repeated steering
sample per process after broadside.

| Variant | Primary ms / speed-up | Secondary ms / speed-up | Repeated output allocations | Decision |
|---|---:|---:|---:|---|
| WP1 | 3,592.27 / 1.000x | 1,013.49 / 1.000x | 4 | Baseline |
| Segment half-length cache | 3,615.33 / 0.994x | 992.18 / 1.021x | 4 | Reject: primary regression |
| Direction trig cache | 3,525.24 / 1.019x | 1,000.53 / 1.013x | 4 | Select |
| Output reuse | 3,544.57 / 1.013x | 1,004.15 / 1.009x | 0 | Select: removes steady-state allocation |
| Exploratory all-candidate combination | 3,612.16 / 0.994x | 986.31 / 1.028x | 0 | Reject; contained segment cache |

All 60 variant/state records matched the WP1 SHA-256 field hash exactly. This
is 48 non-baseline comparisons, with zero failures.

## Final selection and SIMD decision

After removing the rejected segment cache and storing the two theta values in
existing bounded result scratch, the shipping-shape artifacts measured:

| Artifact | Primary raw / field ms | Secondary raw / field ms | Field speed-up vs WP1 | WASM bytes |
|---|---:|---:|---:|---:|
| WP1 scalar | 3,565.02 / 3,565.99 | 989.20 / 989.64 | 1.000x / 1.000x | 736,454 |
| Selected scalar | 3,515.25 / 3,516.21 | 993.24 / 993.64 | 1.014x / 0.996x | 737,227 |
| Selected `-msimd128` | 3,524.17 / 3,525.11 | 992.30 / 992.68 | 1.012x / 0.997x | 739,905 |

The selected scalar result is 1.4% faster on the primary grid and 0.4% slower
on the secondary grid, within the 5% small-grid guardrail. Repeated output
allocations fall from four to zero. The selected artifact grows by 773 bytes
(0.105%). Its median module creation time is 6.58 ms versus 6.27 ms on the
primary sequence and 5.83 ms versus 5.93 ms on the secondary sequence, so no
material startup penalty is visible. All 36 final variant/state records (24
non-baseline comparisons) are bitwise-identical to WP1.

The generated scalar and SIMD modules were converted to WAT, then the public
`_necpp_wasm_v1_compute_far_field` export was mapped through generated JS to
its minified WASM function and its direct call graph inspected with:

```powershell
node packages/necpp-wasm/bench/inspect-far-field-wasm.mjs `
  --generated-js C:\path\nec2pp.js `
  --wat C:\path\nec2pp.wat `
  --output C:\path\inspection.json
```

The scalar module has 916 functions and no SIMD instructions. The SIMD module
has 4,349 SIMD instruction lines across 118 of 915 functions, but the
eight-function far-field call graph reaches only one such function and two
SIMD lines: `v128.load` and `v128.store`. There is no vector arithmetic in the
hot loop. The SIMD artifact was 0.25% slower than selected scalar on the
primary median and added 2,678 bytes, so it is rejected.

The 15% aspirational serial target is waived with generated-artifact evidence.
Once direction values are hoisted, every segment contribution still requires
scalar `sin` calls for the current-integral terms, scalar `sin`/`cos` for phase,
and an order-preserving complex accumulation. Current WASM SIMD does not
accelerate those scalar transcendental operations, and changing accumulation
order would violate WP2's numerical restriction. WP3 angular tiling is the
next material optimization.

## Evidence and verification

- `bench/evidence/far-field-wp2/candidates/`: isolated raw NDJSON and summary.
- `bench/evidence/far-field-wp2/final/`: final scalar/SIMD raw NDJSON, summary,
  and call-graph inspection JSON.
- Native CTest: 8/8 tests passed.
- Native focused stateful far-field suite: 231 assertions in 10 cases passed.
- WASM ABI focused suite: 75 assertions in 4 cases passed.
- Package: 77 runtime tests, TypeScript checking, WASM smoke, and five clean
  package-consumer/browser/audit checks passed.
