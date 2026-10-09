# Full NEC audit evidence

Raw outputs behind `docs/full-nec-performance-audit.md`. Host: Intel Xeon @ 2.10 GHz
(cloud container), 4 logical CPUs, Linux, Node 22.22.0 (V8 12.4), Emscripten 4.0.7,
g++ 13, Chromium 1194 (Playwright).

| File | Content |
|---|---|
| `node-scalar.ndjson` / `.log` | full 12-case matrix, scalar dist, `fieldWorkers: "auto"` (profiling jobs shared the host for some cases) |
| `node-scalar-quiet.ndjson` / `.log` | quiet-host reruns of the headline cases (label `clean`) |
| `node-simd.ndjson` / `.log` | `-msimd128` dist subset |
| `node-probe.ndjson` / `.log`, `node-probe.ndjson.probe.<case>.stderr.txt` | scalar dist with `-DNECPP_AUDIT_PROBE`; the stderr files carry the `NECPP_PROBE` stage lines (fill, factor, port solves, inversion, embedded loops, heap) |
| `node-serial.ndjson` / `.log` | `fieldWorkers: 1` comparison |
| `chromium.ndjson` | headless Chromium runs (scalar and simd dists) |
| `chromium-flag-and-worker-tests.ndjson` | Chromium with V8 tiering flags, `fieldWorkers` 1 / 2 / 4 |
| `native-probe-quiet.txt` | native driver (C ABI) stage split on a quiet host |
| `native-probe-dipole-64-128-256.txt` | first native probe run (host shared with the sweep; superseded by the quiet file) |
| `microbench-quiet.txt` | LU / solve / inversion / GEMM micro-benchmarks, native and WASM, quiet host |
| `lu-microbench-*.txt`, `port-inverse-native.txt`, `gemm-microbench.txt` | first micro-benchmark runs (shared host) |
| `callgrind-native-fill64.txt`, `callgrind-native-field64.txt` | callgrind inclusive/self summaries, 64 dipoles |
| `cpuprofile-direct64-simd.txt`, `cpuprofile-direct256-simd.txt` | V8 CPU profile summaries of the in-process path with function names |
| `run-chain.sh` | the exact sweep commands |

Regenerate the tables with
`node packages/necpp-wasm/bench/full-nec-audit-report.mjs <ndjson...>` (the probe
table reads the `node-probe.ndjson.probe.<case>.stderr.txt` files next to
`node-probe.ndjson`, which is where `bench/full-nec-audit.mjs` writes them).
