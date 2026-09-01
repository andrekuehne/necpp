# Far-field WP4 production package results

WP4 promotes the WP3 proof into the supported `createNecArraySolver()` path.
The selected backend is four lazy-prewarmed ordinary evaluator workers with
dynamic 512-sample tiles and a dedicated 19,367-byte evaluator WASM artifact.
It requires neither shared memory nor cross-origin isolation.

## Reproduction

```powershell
npm --prefix packages/necpp-wasm run build
npm --prefix packages/necpp-wasm run bench:far-field-wp4
npm --prefix packages/necpp-wasm test
npm --prefix packages/necpp-wasm run test:field-worker-browser
npm --prefix packages/necpp-wasm run test:pack
```

The versioned raw record is
[`evidence/far-field-wp4/node/far-field-wp4-production.json`](evidence/far-field-wp4/node/far-field-wp4-production.json).
It records the frozen fixture and grids, five measured states, every public
backend diagnostic, environment, memory samples, checksums, and artifact
hashes.

## Performance decision

The reference host was an AMD Ryzen 7 PRO 7840HS with 16 logical CPUs, Windows
10.0.26200 x64, and Node 24.14.1. Results are package round trips from the
solver-owning outer worker:

| Case | `fieldWorkers: 1` median / p90 | `fieldWorkers: 4` median / p90 | Decision |
|---|---:|---:|---:|
| Primary field, 181 x 360 | 5,321.07 / 5,553.84 ms | 1,583.15 / 2,258.04 ms | 3.361x; passes 2x |
| Primary solve + field | 5,326.01 / 5,558.26 ms | 1,585.60 / 2,261.47 ms | 3.359x; passes 1.75x |
| Secondary field, 69 x 272 | 1,461.32 / 1,569.22 ms | 467.54 / 485.53 ms | 0.320 parallel/serial ratio; no regression |

Four-worker startup was 114.47 ms and its first full snapshot broadcast was
2.03 ms. Repeated steering sent 33,792 current bytes per worker; a second grid
after the same solve sent no snapshot arrays. The primary result contains
2,089,448 bytes including axes, and each worker retains a 73,216-byte snapshot.
Observed process peak-RSS deltas were 53.2 MB for the serial run and 79.8 MB for
the four-worker run; the latter was measured second in the same process and is
therefore a conservative process-level comparison rather than an allocation
inventory.

Scaled maximum differences from the serial facade were `5.16e-11` E-theta and
`3.08e-11` E-phi on the primary grid, and `5.15e-11` E-theta on the secondary
grid. All are below the existing `1e-10` package tolerance.

## Lifecycle, failure, and packaging evidence

- Rapid 181 x 360 replacement rejects the obsolete promise with typed
  `details.reason = "superseded"`, stops new tile assignment, and publishes
  only the complete newest generation. After replacement at 40 ms, the record
  reports one cancelled job and all 128 stale tiles cancelled; at most the four
  already-issued tiles can still be running when the signal arrives.
- A failed evaluator is restarted from the retained complete snapshot. Missing
  evaluator assets, finite ground, and other unsupported snapshot modes report
  an explicit serial fallback; `fieldWorkers: 1` never creates children.
- `dispose()` is idempotent and terminates every child. A Chromium target-level
  probe also closes a page during an active pooled field and observes every
  outer/evaluator worker target disappear. Replacing a symmetric model during
  explicit fallback disposes the old pool with its outer worker.
- The tarball contains the nested worker, runtime, generated loader, and both
  WASM artifacts. A clean packed Vite consumer emits content-hashed evaluator
  assets under `/nested/`, serves WASM MIME correctly, and runs in Chromium
  with `crossOriginIsolated === false`.
- The Node/package suite passes 89 tests. The production browser smoke and the
  packed Node/README/CDN/Vite/Chromium tests pass.

`"auto"` is enabled by default for the array facade. It selects no more than
four workers from the logical-core hint and uses the serial backend below the
documented contribution/tile crossover. Direct `createNecModel()` and the
low-level worker facade remain serial.
