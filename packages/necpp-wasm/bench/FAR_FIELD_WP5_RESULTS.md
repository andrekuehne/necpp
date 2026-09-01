# Far-field WP5 embedded-cache decision

WP5 is complete. The package does not ship an embedded-field cache for normal
steering. The current unit-current basis is numerically valid, but its serial
basis warm-up and retained memory do not justify adding cache lifecycle,
progress, cancellation, memory-policy, and invalidation surface to the
production array solver.

## Reproduction

From `packages/necpp-wasm`, using the release WASM artifacts:

```text
npm run build
npm run bench:far-field-wp5
```

The second command runs with `--expose-gc` and writes the versioned raw record
to
`bench/evidence/far-field-wp5/node/far-field-wp5-amortization.json`. It runs
the 4-, 16-, and 64-port square horizontal-dipole arrays serially across the
65,160-sample primary grid and the consumer-derived 18,768-sample secondary
grid. Every basis is explicitly `{ kind: "unit-current", valueA: 1 }`; every
cached field uses the achieved `solution.currents` from a retained native
`solveCurrents()`.

The reference run used Node 24.14.1 on Windows 10.0.26200 x64, an AMD Ryzen 7
PRO 7840HS (16 logical CPUs), package 0.3.0, and engine 2.5.0. The JSON records
the exact commit, dirty-worktree list, artifact sizes and SHA-256 hashes, CPU,
OS, memory, grid, steering checksums, per-state timings, backend diagnostics,
and gates.

## Amortization

Times below are milliseconds. `Direct/state` and `resident/state` include the
retained native solve. Break-even is the first integer state count at which
the measured basis setup plus resident combination is no slower than the WP4
four-worker direct field. It uses the median of five measured steering states;
the basis setup itself is measured once because repeating the 64-port primary
basis would add almost four minutes per repetition.

| Ports | Grid / samples | Basis warm-up | Direct/state | Resident/state | Break-even |
|---:|---|---:|---:|---:|---:|
| 4 | primary / 65,160 | 923.19 | 58.52 | 4.41 | 18 |
| 4 | secondary / 18,768 | 278.44 | 19.30 | 2.07 | 17 |
| 16 | primary / 65,160 | 14,346.75 | 249.19 | 5.18 | 59 |
| 16 | secondary / 18,768 | 4,045.05 | 77.51 | 3.06 | 55 |
| 64 | primary / 65,160 | 224,623.57 | 1,066.89 | 22.36 | 216 |
| 64 | secondary / 18,768 | 67,033.27 | 326.23 | 8.07 | 211 |

The required 1/4/16/64/256 horizons are stored in the raw artifact as a linear
amortization model built from those measured medians. At 256 states, the
resident-to-direct total ratios are 0.137/0.164 for 4 ports, 0.246/0.243 for
16 ports, and only 0.843/0.827 for 64 ports (primary/secondary). Thus the
production 64-port case pays a 224.6-second primary startup stall and does not
recover it until state 216; even at state 256 its modeled saving is only 15.7%.

## Memory

`Basis` is the exact four-f64-array public basis allocation. `Native + basis`
adds the same-size native retained result and is the minimum steady-state
cost before axes, outputs, WASM capacity, worker runtimes, and allocator
overhead. Peak RSS is the absolute process peak sampled at stage boundaries;
the delta is relative to that sequential case's starting RSS. Later cases may
reuse allocator/WASM capacity left by earlier cases, so the exact allocation
columns are the portable comparison and the RSS columns are host observations.

| Ports | Grid | Basis MiB | Native + basis MiB | Peak RSS MiB | Case RSS delta MiB |
|---:|---|---:|---:|---:|---:|
| 4 | primary | 7.95 | 15.91 | 213.70 | 151.60 |
| 4 | secondary | 2.29 | 4.58 | 176.60 | 13.90 |
| 16 | primary | 31.82 | 63.63 | 285.30 | 144.80 |
| 16 | secondary | 9.16 | 18.33 | 204.40 | 6.30 |
| 64 | primary | 127.27 | 254.53 | 783.60 | 629.40 |
| 64 | secondary | 36.66 | 73.31 | 402.50 | 0.00 |

The zero final delta is not a zero-memory claim: that case began after the
64-port primary case with 402.5 MiB resident and peaked at the same value.

## Correctness and ownership comparison

- Direct WP4 fields versus transferred unit-current superposition have maximum
  scaled complex differences of `5.16e-11` for E-theta and `6.20e-11` for
  E-phi across all six cases, below the existing `1e-8` contract gate.
- The benchmark-local worker-resident combination is bitwise identical to the
  main-thread transferred-basis combination in all measured states.
- Peak magnitude and integrated squared magnitude agree within `3.74e-12` and
  `1.25e-11` relative error. Exact peak indices can differ where symmetric
  equal-height samples are tied; this is recorded rather than mistaken for a
  metric failure.
- Every steering state still calls `solveCurrents()`. Factorization remains at
  generation one, the consumer solve is restored across basis generation,
  caller port order is unchanged, and summed port powers close to the native
  input-power budget.
- Existing package coverage supplies explicit/symmetric basis equivalence,
  translated-field rephasing, ground/fallback, caller-order, disposal, and
  public transferred-result ownership checks. No consumer mapper is present in
  this repository; WP6 remains responsible for production mapper and visualizer
  metric regression against these equal source fields.

## Decision

No port/grid case enables caching by default or as a current opt-in:

- 4 ports: never for normal interactive steering in this package. A future
  explicit long batch/sweep API may reconsider it after state 18/17, but the
  uncached absolute latency is already 59/19 ms.
- 16 ports: never for normal interactive steering. Reconsider only for a
  caller-declared batch longer than 59/55 states after native parallel basis
  generation exists.
- 64 ports: never with the current implementation. The 224.6/67.0-second
  warm-up, 216/211-state break-even, 127.3/36.7 MiB transferred basis, native
  duplicate, and 783.6 MiB observed primary peak make it unsuitable for the
  production visualizer.

The public transferred-basis design remains unchanged for callers that
explicitly request `computeEmbeddedFarFields()`. The benchmark-only resident
worker proves that moving an already-built basis costs less than 1 ms and keeps
later requests compact, but it cannot fix basis-generation time or native
duplication. It is not production code and has no package export.

If a later batch API revives caching, its identity must include geometry,
caller port order, loads, ground/connection, prepared frequency,
normalization, and source grid/radius. Steering, taper, enabled elements,
source power, matching, target grid, view, and polarization do not invalidate
a unit-current source-field basis. That later API must add a memory budget,
progress, cancellation between basis ports/tiles, explicit release, rejection
and direct fallback tests before it can ship.

## Deviations and follow-up

The 1/4/16/64/256 totals and exact integer break-even use a measured-median
linear model rather than executing 256 complete direct fields for every case;
the raw artifact labels this method. Basis generation is not parallelized
through WP4 because its private native basis solves do not expose immutable
current snapshots. Adding such a native batch/snapshot contract solely for a
cache that fails the production decision would expand scope without changing
the result. The recommended next work package is WP6 visualizer integration.
