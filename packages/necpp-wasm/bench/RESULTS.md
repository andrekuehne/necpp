# Array benchmark results - 2026-08-29

Three fresh-process rounds per backend on an AMD Ryzen 7 PRO 7840HS, Windows
10.0.26200, Node 24.14.1, Emscripten 4.0.7, and the 4 MiB-stack optimized WASM
artifact (`f6b681e1d94b3358ae6ddee0077b1ce40aab6b52dc9978e7a946e8c0c3c4e709`).
The worktree was dirty with the stack fix and benchmark implementation.

Each element is a free-space, centre-fed, Z-directed lambda/4 dipole with 11
segments. Every port is driven simultaneously at 1 + j0 V and 300 MHz.
`Stateful cold` covers module creation, geometry and port construction,
preparation, the first solve, and result copying. `Full deck cold` covers deck
generation, `runDeck()`, the complete formatted report, and source-current
parsing. Values are medians.

| Array | Equations | Stateful cold | Full deck cold | Deck delta | Retained solve |
|---:|---:|---:|---:|---:|---:|
| 2 x 2 | 44 | 20.0 ms | 26.4 ms | 32.0% | 0.23 ms |
| 3 x 3 | 99 | 30.4 ms | 38.5 ms | 27.0% | 0.49 ms |
| 4 x 4 | 176 | 35.8 ms | 46.6 ms | 30.1% | 0.49 ms |
| 5 x 5 | 275 | 55.6 ms | 73.9 ms | 32.9% | 0.53 ms |
| 6 x 6 | 396 | 92.8 ms | 108.1 ms | 16.4% | 0.79 ms |
| 7 x 7 | 539 | 153.5 ms | 174.4 ms | 13.6% | 1.08 ms |
| 8 x 8 | 704 | 301.2 ms | 310.8 ms | 3.2% | 1.56 ms |
| 9 x 9 | 891 | 499.6 ms | 542.2 ms | 8.5% | 2.41 ms |
| 10 x 10 | 1,100 | 862.0 ms | 890.3 ms | 3.3% | 3.33 ms |
| 11 x 11 | 1,331 | 1,447.7 ms | 1,475.5 ms | 1.9% | 4.63 ms |
| 12 x 12 | 1,584 | 2,336.6 ms | 2,364.2 ms | 1.2% | 6.39 ms |
| 13 x 13 | 1,859 | 3,778.9 ms | 3,781.0 ms | 0.1% | 11.20 ms |
| 14 x 14 | 2,156 | 5,789.7 ms | 5,738.1 ms | -0.9% | 11.86 ms |
| 15 x 15 | 2,475 | 8,619.1 ms | 8,697.5 ms | 0.9% | 15.83 ms |
| 16 x 16 | 2,816 | 12,813.7 ms | 12,907.2 ms | 0.7% | 17.30 ms |

All 90 backend cases completed. All 45 stateful/deck pairs passed the
source-current equivalence check. Relative L2 differences ranged from
7.54e-6 to 2.07e-5, consistent with the legacy report's five-digit printed
precision.

At 16 x 16 the interaction matrix itself is 121 MiB. Median process RSS growth
was 138.0 MiB for stateful and 138.8 MiB for the deck path; the returned full
deck report was 640 KiB. Cold-path differences above roughly 700 equations are
small compared with run-to-run noise because both facades spend nearly all of
their time in the same matrix preparation. Stateful mode's material advantage
is reuse: another 256-port drive costs about 17 ms instead of repeating a
roughly 13-second deck execution and factorization.

Command:

```powershell
npm --prefix packages/necpp-wasm run bench:array -- `
  --sides 2-16 --segments 11 --rounds 3 --retained-solves 10 `
  --timeout-seconds 600 `
  --output packages/necpp-wasm/bench/results/array-2-16-11seg-3round-20260829.ndjson
```

The generated NDJSON and summary JSON remain local under `bench/results/`,
which is ignored by Git. This was a scaling comparison rather than a
laboratory-grade performance run: machine power state was not controlled and
backend order was fixed.

## Historical 19-segment endpoint

The earlier NEC++ performance workload used 19 rather than 11 segments per
dipole. A separate fresh-process run exercised that discretization at the
largest array size:

| Array | Equations | Stateful cold | Full deck cold | Deck delta | Retained solve |
|---:|---:|---:|---:|---:|---:|
| 16 x 16 | 4,864 | 64,070.6 ms | 64,492.8 ms | 0.7% | 49.86 ms |

Both paths completed with the 4 MiB stack. The interaction matrix alone is 361
MiB; observed RSS growth was 387.0 MiB stateful and 386.4 MiB for the deck
path. The 1.25 MiB legacy report contained 15,457 lines. Its 256 source
currents agreed with the stateful result to 1.33e-5 relative L2 error.
