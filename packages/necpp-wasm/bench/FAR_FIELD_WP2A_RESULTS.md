# Far-field WP2A reordered-kernel results

WP2A is complete. Reassociating the binary64 wire-field reduction is
numerically harmless on the frozen workload, but it does not meet the 10%
primary-kernel selection gate. The shipping default therefore remains WP2's
`SELECTED` scalar configuration. The reordered implementations remain
available as non-default build experiments.

## Implementations and method

All candidates keep the WP2 direction cache and output reuse, use Emscripten
4.0.7 with `-O3 -DNDEBUG -flto -fexceptions`, and leave global fast-math and
f32 disabled. `ACCUM4_RELAXED` alone adds `-ffast-math` to
`nec_far_field.cpp`. The common `ifar < 2` wire path is specialized outside
the segment loop. Segments are processed in consecutive groups of N; lane `j`
receives group element `j`, and the tail uses lanes `0..tail-1`.

| Build mode | Accumulation and final reduction |
|---|---|
| `WIRE_SPECIALIZED` | One complex x/y/z chain; original segment order |
| `ACCUM2` | Two chains; `lane0 + lane1` |
| `ACCUM4_LINEAR` | Four chains; `((lane0 + lane1) + lane2) + lane3` |
| `ACCUM4_TREE` | Four chains; `(lane0 + lane1) + (lane2 + lane3)` |
| `ACCUM8_TREE` | Eight chains; `((0+1)+(2+3)) + ((4+5)+(6+7))` |
| `ACCUM4_SPLIT_TREE` | Four-chain tree with separate real/imaginary arrays |
| `ACCUM4_RELAXED` | Four-chain tree plus TU-scoped `-ffast-math` |

The full matrix used one warmup plus three fresh balanced measured processes
per variant/grid, all ten frozen steering states, and the 181 x 360 primary
and 69 x 272 secondary grids. The driver dumped temporary component-major f64
fields and recorded separate E-theta/E-phi relative-L2 and scaled-maximum
errors, finiteness, peak, null, and integrated-power differences. Temporary
field dumps were deleted after comparisons; the metrics and raw timing cases
are versioned under `bench/evidence/far-field-wp2a/`.

The initial six-variant matrix and an extended WP2/split/relaxed matrix each
used the complete method above. Their non-baseline totals are 300 and 120
comparisons respectively.

## Performance

Times below are repeated-field min / median / p90 / max in milliseconds. The
speed-up uses the raw-accumulation median relative to the fresh WP2 artifact.

| Variant | Primary field ms | Primary raw speed-up | Secondary field ms | Secondary raw speed-up | WASM bytes |
|---|---:|---:|---:|---:|---:|
| WP2 | 3507.11 / 3557.15 / 3855.46 / 5058.44 | 1.000x | 981.81 / 1017.86 / 1043.92 / 1064.28 | 1.000x | 737,227 |
| Wire specialization | 3415.28 / 3443.78 / 3704.82 / 3950.85 | 1.033x | 968.15 / 1009.56 / 1040.81 / 1079.70 | 1.008x | 738,934 |
| Two chains | 3440.99 / 3511.92 / 4857.06 / 21,931,978.24 | 1.013x | 965.29 / 1011.38 / 1350.08 / 1780.57 | 1.006x | 739,116 |
| Four chains, linear | 3385.80 / 3457.80 / 4222.65 / 4805.51 | 1.029x | 967.46 / 1030.08 / 1065.67 / 1144.22 | 0.988x | 739,273 |
| Four chains, tree | 3390.28 / 3427.78 / 3528.56 / 3567.15 | **1.038x** | 955.86 / 990.43 / 1149.95 / 1314.59 | **1.028x** | 739,273 |
| Eight chains, tree | 3402.60 / 3446.60 / 3509.06 / 3565.23 | 1.032x | 980.40 / 1034.44 / 1113.36 / 1145.58 | 0.984x | 739,989 |
| Four split chains, tree | 3335.16 / 3459.36 / 4091.85 / 4525.74 | 1.018x | 938.66 / 978.54 / 1014.67 / 1024.70 | 1.034x | 739,312 |
| Four chains, TU relaxed | 3429.34 / 3503.43 / 4252.93 / 4888.98 | 1.005x | 970.50 / 1016.92 / 1044.44 / 1062.22 | 0.995x | 735,976 |

The two-chain maximum contains a host-suspension event in primary round 3,
negative-u: complete field wall time was 21,931,978 ms while sampled native
raw time was 10,285.60 ms. It is retained in raw evidence and the table. The
median decision is unaffected, but the event makes that candidate's maximum
and p90 unsuitable for microarchitectural interpretation.

Median module creation ranged from 5.76 to 7.85 ms without a monotonic
candidate penalty. Repeated output allocations remained zero. Logical bounded
accumulator scratch is 48 bytes per chain (three complex binary64 components):
48, 96, 192, and 384 bytes for 1, 2, 4, and 8 chains respectively; there are no
heap scratch allocations.

## Accuracy

All 420 non-baseline variant/grid/round/steering comparisons passed both
`1e-7` gates and contained finite values. The worst result across every
candidate was:

| Metric | E-theta | E-phi |
|---|---:|---:|
| Relative L2 | 1.1693e-15 | 9.8474e-16 |
| Scaled maximum complex sample | 2.6974e-15 | 2.3794e-15 |

The largest peak relative difference was 1.4018e-15, the largest absolute
deep-null magnitude difference was 5.2697e-25 V/m, and the largest integrated
power relative difference was 6.6521e-16. `WIRE_SPECIALIZED` remained
bitwise-identical to WP2; only the multi-chain variants changed addition order.

## SIMD and rejected experiments

Scalar and `-msimd128` four-chain-tree artifacts were disassembled and traced
from `_necpp_wasm_v1_compute_far_field`. The scalar artifact has no SIMD. The
SIMD artifact has 4,432 SIMD instruction lines module-wide, but its reachable
eight-function far-field graph contains only two SIMD lines,
`v128.load`/`v128.store`, and no vector arithmetic. In a short balanced pair it
was 1.015x faster on primary and 0.983x on secondary, added 3,141 bytes, and was
bitwise-identical. It is rejected because the hot loop was not vectorized and
the secondary result regressed.

An explicit paired sine/cosine source experiment produced byte-for-byte the
same WASM as ordinary adjacent `std::sin`/`std::cos` calls for both the one- and
four-chain forms. LLVM already performs the supported pairing, so duplicate
build modes were removed. The translation-unit-scoped `-ffast-math` experiment
reduced the artifact by 1,251 bytes relative to WP2, but improved the primary
raw median by only 0.5% and regressed secondary by 0.5%. Its numerical errors
remained at approximately 1e-15, so it demonstrates no useful speed/accuracy
trade rather than an accuracy failure.

## Decision and verification

No candidate meets the required 1.10x primary raw-kernel speed-up. WP2
`SELECTED` therefore remains the production and WP3 serial baseline. The best
reordered experiment, `ACCUM4_TREE`, is retained only for reproducibility; it
is not enabled by default.

- Full native candidate CTest: 8/8 partitions passed.
- Candidate WASM/package: 77 runtime tests and type checking passed.
- Clean packed consumers: 5/5 passed after rerunning outside the filesystem
  sandbox required by npm's cache.
- Initial sandboxed pack attempts failed only with npm-cache `EPERM`; the same
  pack tests passed with normal cache access.
- Standalone direct, worker, and example browser integrations passed against a
  retained tarball of the restored scalar WP2 fallback; the clean Vite
  consumer build also passed.
