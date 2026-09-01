# Far-field WP3 proof-of-concept results

WP3 proves the worker architecture and clears its performance gate. It is an
internal prototype; supported package integration remains WP4.

## Decision

- Use the dedicated stateless evaluator WASM artifact. Its complete per-worker
  payload is 45,801 bytes (19,367 bytes WASM), versus 750,317 bytes for the
  full NEC WASM evaluator-only shape. Their one-worker steady-state field times
  were effectively equal: 2,780.64 ms and 2,789.65 ms median respectively.
- Use a default candidate of four prewarmed evaluator workers.
- Use bounded 512-sample tiles in theta-fast order. Four static slabs were
  slightly faster in the single strategy probe (704.63 ms versus 725.94 ms),
  but bounded tiles permit a superseded generation to stop receiving work and
  cap each worker's tile output at 16,384 bytes.

## Reference result

The frozen `pav-ng-8x8-x-dipole-v1` fixture has 704 segments and 65,160 field
directions. On the Ryzen 7 PRO 7840HS reference host, three repeated field runs
produced these medians:

| Workers | Median field time | Speed-up | Parallel efficiency |
| ---: | ---: | ---: | ---: |
| 1 | 2,780.64 ms | 1.000x | 100.0% |
| 2 | 1,477.20 ms | 1.882x | 94.1% |
| 4 | 738.20 ms | 3.767x | 94.2% |
| 8 | 440.79 ms | 6.308x | 78.9% |

Four workers therefore exceed the required 2x raw-field gate. Every worker
count produced the same result hash. Against the frozen serial evaluator, the
scaled-maximum component differences were `1.54e-11` for E-theta and
`2.04e-11` for E-phi.

## State and memory

Snapshot schema v1 contains seven geometry arrays and six solved-current arrays,
all binary64, plus frequency, wavelength, ground mode, and model/solution
generations. The 704-segment snapshot is 73,216 bytes: 39,424 geometry bytes
and 33,792 current bytes. The retained interaction matrix is 7,929,856 bytes,
so no matrix or factorization is copied to evaluators. A repeated solve reuses
geometry and broadcasts only 33,792 bytes per worker.

The merged four-component output is 2,085,120 bytes. With 512-sample tiles,
peak in-flight tile output is bounded to 16,384 bytes per evaluator in addition
to its 73,216-byte snapshot and 45,801-byte artifact payload.

## Correctness and lifecycle coverage

The proof tests one-worker parity for both artifact shapes, current-only updates,
worker failure/restart, stale-generation rejection, disposal, and typed serial
fallback for finite ground. A browser smoke test runs a solver-owning outer
module worker with two evaluator children in non-cross-origin-isolated Chromium.

Raw machine-readable evidence is in
[`evidence/far-field-wp3/node`](evidence/far-field-wp3/node). Reproduce it with:

```powershell
npm --prefix packages/necpp-wasm run bench:far-field-wp3
```
