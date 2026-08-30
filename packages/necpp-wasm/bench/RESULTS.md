# Symmetry reference benchmark - 2026-08-30

WP-S7 was measured on an AMD Ryzen 7 PRO 7840HS, Windows 10.0.26200,
Node 24.14.1, and Emscripten 4.0.7. Every representation/size/round used a
fresh process and the Section 7 lambda-scaled array over perfect ground.

The current artifact was rebuilt with the pinned Docker image after the run;
its digest was unchanged:

```text
WASM SHA-256  42d427c52b06792471d92e148cb0ed6ece33b4dabf1edabfe355ddcf4b1e0a28
WASM bytes    733440
engine        2.3.4
package       0.1.1
commit        52194f5118689e7a2b46076150612c36761964de
```

The worktree contained the WP-S7 implementation and status edits plus three
pre-existing unrelated untracked documents. The exact porcelain status is in
the ignored metadata record; no claim of a clean worktree is made. The
artifact itself was a clean pinned-toolchain rebuild of the current native and
TypeScript sources.

## Correctness and performance

All 45 current-artifact cases completed. All 30 manual/automatic comparisons
passed the `1e-8` relative-L2 and scaled-maximum gates for requested currents,
achieved currents, voltages, active impedances, powers, and complete complex
combined far fields. The 2 x 2 and 4 x 4 cases also passed complete
caller-order complex Z and Y comparison. The largest observed scaled error was
`1.13e-13` (16 x 16 powers).

Medians from three rounds:

| Array | Equations | Explicit prepare | Manual prepare | Auto prepare | Manual speedup | Auto planner | Planner / auto cold | Auto vs manual |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2 x 2 | 44 | 7.66 ms | 2.85 ms | 2.87 ms | 2.69x | 1.72 ms | 5.50% | +0.93% |
| 4 x 4 | 176 | 24.33 ms | 11.36 ms | 10.17 ms | 2.14x | 1.92 ms | 3.96% | -10.54% |
| 8 x 8 | 704 | 297.82 ms | 55.43 ms | 56.72 ms | 5.37x | 3.89 ms | 2.10% | +2.32% |
| 12 x 12 | 1,584 | 2,445.98 ms | 282.44 ms | 279.11 ms | 8.66x | 7.71 ms | 0.77% | -1.18% |
| 16 x 16 | 2,816 | 13,196.45 ms | 1,142.14 ms | 1,140.06 ms | 11.55x | 13.30 ms | 0.26% | -0.18% |

The 16 x 16 manual preparation target passes at 11.55x. Auto/manual preparation
parity passes at every gated size (8 x 8 and larger), and planner overhead is
below 5% of auto cold time at those sizes. The ungated 4 x 4 timing has a
10.54% auto/manual difference because both prepare measurements are about
10 ms; no large-array parity claim is derived from it.

The primary interaction matrix uses `n * np` complex-double entries for this
wire-only model. Two reflection planes reduce `np` to `n / 4`, producing the
measured exact fourfold allocation ratio:

| Array | Explicit matrix | Reflected matrix | Reduction |
|---:|---:|---:|---:|
| 2 x 2 | 0.03 MiB | 0.01 MiB | 4.00x |
| 4 x 4 | 0.47 MiB | 0.12 MiB | 4.00x |
| 8 x 8 | 7.56 MiB | 1.89 MiB | 4.00x |
| 12 x 12 | 38.29 MiB | 9.57 MiB | 4.00x |
| 16 x 16 | 121.00 MiB | 30.25 MiB | 4.00x |

RSS samples, every individual phase, retained changed-current solves, and
median/min/max values remain in the ignored summary rather than being rounded
into this document.

## Explicit pre-feature comparison

Commit `78bdafe` is the planning-only revision before WP-S0 through WP-S6. It
was archived into an ignored directory, built with the same Emscripten 4.0.7
Docker image, and run through the exact schema-v2 protocol using its public
explicit stateful API.

```text
pre-feature WASM SHA-256  196fc36329aeae6c3e44d8da2ba560d316f4d4a5f3756b6d72f4212f2af511c3
pre-feature WASM bytes    698667
```

| Array | Current vs pre-feature explicit prepare |
|---:|---:|
| 2 x 2 | +19.41% (+1.25 ms in the three-round medians) |
| 4 x 4 | -6.34% |
| 8 x 8 | -2.12% |
| 12 x 12 | +0.21% |
| 16 x 16 | +0.55% |

The matrix-scale explicit path (8 x 8 through 16 x 16) shows no material
regression. The unqualified 5% gate nevertheless records a **miss** at 2 x 2;
the benchmark does not hide it or turn it into a pass. A separate 15-round
2 x 2 check reproduced a smaller but still over-gate +11.48% median delta
(7.686 ms versus 6.894 ms), while the ranges overlapped. The bounded follow-up
is to profile the fixed explicit `completeGeometry()`/`prepare()` validation
and JS/WASM call overhead at 44 equations; it must preserve every symmetry and
load validation gate and must not delay the large-array feature.

## Commands and retained data

The raw files are ignored by Git:

```text
packages/necpp-wasm/bench/results/symmetry-prefeature-78bdafe-3round-20260830.ndjson
packages/necpp-wasm/bench/results/symmetry-prefeature-78bdafe-3round-20260830.summary.json
packages/necpp-wasm/bench/results/symmetry-current-3round-20260830.ndjson
packages/necpp-wasm/bench/results/symmetry-current-3round-20260830.summary.json
```

Reference commands:

```powershell
npm --prefix packages/necpp-wasm run bench:array -- `
  --sides 2,4,8,12,16 --backends explicit --rounds 3 `
  --retained-solves 10 --z-matrix-sides 2,4 --timeout-seconds 600 `
  --module-directory packages/necpp-wasm/bench/results/pre-feature-78bdafe/packages/necpp-wasm/dist `
  --output packages/necpp-wasm/bench/results/symmetry-prefeature-78bdafe-3round-20260830.ndjson

npm --prefix packages/necpp-wasm run bench:array -- `
  --sides 2,4,8,12,16 `
  --backends explicit,manual-reflection,auto-reflection --rounds 3 `
  --retained-solves 10 --z-matrix-sides 2,4 --timeout-seconds 600 `
  --baseline-summary packages/necpp-wasm/bench/results/symmetry-prefeature-78bdafe-3round-20260830.summary.json `
  --output packages/necpp-wasm/bench/results/symmetry-current-3round-20260830.ndjson
```

## Historical stateful/deck comparison

The 2026-08-29 historical benchmark compared the pre-symmetry free-space
stateful facade with formatted `runDeck()` output. At 16 x 16 and 11 segments,
both paths took about 12.8 seconds because they shared the same full matrix;
a retained stateful solve took 17.3 ms. That result remains useful as evidence
for factorization reuse, but its rounded report currents and different geometry
are not an oracle for the symmetry measurements above.
