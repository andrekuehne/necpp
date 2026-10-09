# Full NEC (NEC MoM) performance audit for `@necpp-engine/wasm`

Status: audit report, 2026-10-09. No public API or default numerics were
changed. Everything measured here was run from this repository at the commit
this document ships in, with `@necpp-engine/wasm` 0.8.0 sources (engine
2.5.0, ABI 1), built with the pinned Emscripten 4.0.7.

The engine is the backend of the "NEC MoM / Full NEC" analysis mode of
PhasedArrayVisualizer-NG. The visualizer's own large-array rework
(its issue #112 and PR #143) explicitly left this engine out of scope. This
document is the engine-side audit: where Full NEC time and memory go, which
accelerations are correct and worth doing, and the first work packages.

Companion artifacts added by this audit:

| Path | Purpose |
|---|---|
| `packages/necpp-wasm/bench/full-nec-audit-case.mjs` | One case in one process through the public array-solver API (worker-backed `createNecArraySolver`, or `--backend direct` for the in-process `NecModel`). Emits NDJSON. |
| `packages/necpp-wasm/bench/full-nec-audit.mjs` | Matrix driver: the case list of this audit, one fresh process per case. |
| `packages/necpp-wasm/bench/full-nec-audit-browser.mjs` | The same sequence in headless Chromium over loopback HTTP without COOP/COEP. |
| `packages/necpp-wasm/bench/full-nec-audit-report.mjs` | NDJSON to the markdown tables below plus the fitted exponents. |
| `bench/full-nec-audit/native-driver.cpp` | Native driver over the stable C ABI (same code path as WASM) for callgrind. |
| `bench/full-nec-audit/lu-microbench.cpp` | Prototype: Eigen LU in double / float / float + fp64 refinement, single-RHS vs blocked-RHS solves, fp32 fill + fp64 LU, on the real dumped interaction matrices. |
| `bench/full-nec-audit/port-inverse-microbench.cpp` | Prototype: Jacobi SVD (as shipped) vs LU inverse vs BDC SVD for the port matrix. |
| `bench/full-nec-audit/gemm-microbench.cpp` | Prototype: complex GEMM micro-kernel, Eigen vs split-layout scalar vs split-layout `f64x2`. |
| `bench/full-nec-audit/audit-probe.patch` | Scratch-only timing probe (`-DNECPP_AUDIT_PROBE`) that splits `prepare` into fill and factor and times the port solves, the port-matrix inversion and the embedded loops. Not applied to the release build. |
| `bench/full-nec-audit/evidence/` | Raw NDJSON, logs, profile summaries and micro-benchmark outputs behind every number in this document. |

## 1. Summary

1. **At the app's upper sizes the solve chain, not the far field, dominates.**
   For 256 dipoles (2,816 unknowns, 256 ports) in scalar WASM on the audit
   host, `prepare` takes 18.4 s (3.2 s fill, 16.2 s LU) and
   `computeImpedanceMatrix` 11.2 s (8.4 s of single-vector port solves, 4.2 s
   of SVD). One steered far field on the app's 187x742 auto grid takes 20 s
   with the exact evaluator on two workers and 2.9 s with the ring evaluator;
   a `solveCurrents` is 32 ms. The fitted exponents over 704 to 2,816 unknowns
   are N^2.6 for `prepare` (fill N^2 plus LU N^3), N^2.9 for the Z extraction
   and N^0.9 per far-field sample.
2. **Half of the Z extraction is avoidable overhead.** The port admittance
   is built from P separate single-vector triangular solves (BLAS-2, 43 % of
   the 256-dipole WASM profile; 8.4 s of the 11.2 s), each followed by a
   `stringstream` report (3.4 %), and Z = Y^-1 goes through a full Jacobi SVD
   (4.2 s in WASM, 2.3 s natively at P = 256, against 25 ms for an LU inverse
   that matches to 7e-14 and carries its own condition estimate). A blocked multi-RHS solve measured 1.4x to 2.5x faster
   per right-hand side. Together this is a 2x to 3x cut of
   `computeImpedanceMatrix` with no change in numerics beyond 1e-12.
3. **The LU is already near the scalar WASM ceiling.** Eigen's
   `complex<double>` LU runs at about 4.9 GFLOP/s in WASM against 12.6
   GFLOP/s natively on the same core. `-msimd128` does nothing for it (Eigen
   has no WASM SIMD backend) and `complex<float>` is only 1.1-1.2x faster in
   WASM. A hand-written `f64x2` split-layout kernel prototyped here reached
   1.1x over Eigen; the theoretical lane ceiling is 2x. Mixed precision is a
   memory feature, not a speed feature, in WASM.
4. **fp32 is not safe for the fill or the factorization without
   refinement.** The real interaction matrices have `rcond` 1.7e-4 to 5e-5.
   Rounding the matrix to fp32 before an fp64 LU gives 5e-5 to 1e-4 relative
   error in the currents; a float LU gives the same. Two fp64 refinement
   steps bring it to 3e-13 but cost as much as the double LU for P
   right-hand sides. The app's current-precision budget is 1e-5.
5. **The fill is one quarter near-pair Romberg integrals and three quarters
   far-pair lumped evaluations with a `sincos` per pair**, plus a source-only
   `sin(pi s)` recomputed for every pair. Perfect ground doubles it. Hoisting
   the per-source trig and vectorising the far-pair loop are low-risk; a
   distance-tiered quadrature adds little because far pairs already use the
   lumped kernel beyond `rkh` = 1 wavelength.
6. **Embedded far fields on a grid are impractical as a steering basis for
   Full NEC.** On the 64-dipole auto grid (93x366) the 64-port basis took
   182 s in WASM; at 256 ports and the 256-element grid (187x742) the result alone would
   be 1.1 GB in f64. The app does not do this today: it re-solves and
   re-evaluates one field per steer, and requests embedded fields only at a
   single direction. The retained voltage-field basis makes that single
   direction cheap (23 ms at 128 ports), but its 64 MiB cap excludes exactly
   the 256-dipole case (limit 248 ports), which then costs 256 solves, 8.6 s,
   per look direction.
7. **The far-field kernel is transcendental-bound.** 56 % of its WASM time is
   `sin`/`cos` with 9 % in `__rem_pio2` argument reduction because the phase
   argument is not reduced. The ring evaluator already removes most of it on
   periodic grids (3x to 7x measured here, error 1e-15 to 1e-11 of peak).
8. **In headless Chromium the evaluator pool is slower than the serial
   path.** Every in-engine stage (`prepare`, Z, embedded, serial fields)
   matches Node within 10 %, but each dedicated evaluator worker runs at
   about one third of its Node throughput (6.4 M versus 19.5 M contributions
   per second per worker), so two workers (1.8 s for a 64-dipole 91x181
   exact field) lose to the serial engine kernel (1.3 s) and only four
   workers (0.9 s) beat it. V8 tiering flags do not change it and the pool
   scales linearly with workers, so the cause is inside the evaluator
   workers themselves. The `auto` policy needs a runtime check on real
   browsers before it is trusted on 4-core hosts.
9. **Nothing between tiles is cancellable.** `prepare`, `computeImpedanceMatrix`,
   the embedded loops and every serial field run as one synchronous WASM
   call. The only lever is `terminate()`, which discards the factorization.
   The fill and the per-port loops can be made cooperative cheaply; the LU
   cannot without owning the factorization.

Recommended first work packages (Section 8): WP-A port-matrix extraction
(blocked solves, LU inverse, no per-solve report), WP-B retained basis cap
and single-direction embedded path for 256 ports, WP-C cooperative progress
and cancellation for fill and the port loops plus the fill hoists.

## 2. Premises checked against the visualizer

Three statements in the audit brief do not match the visualizer code (checked
on the `ccr-2f7b5f31-8qjxjv` checkout, which is the merge of PR #111, and on
the PR #143 branch `feat/perf-large-arrays`, `web/src/engine/nec-session.ts`):

- **Steering re-solves.** A new excitation calls `solveCurrents` (reusing the
  factorization) and then a full `computeFarField` on the source grid. There
  is no app-side weighted sum of per-port embedded patterns for Full NEC.
  `computeEmbeddedFarFields` is called only on the conjugate/current steering
  path, once per look direction, with a 1x1 grid, unit current, always
  with the exact evaluator (`nec-session.ts:1724-1740` on the PR branch).
- **Source grids depend on the aperture, not the display.** The step is
  `min(5 deg, 0.886 / (aperture_lambda * 8))`, theta covers 0..90 deg
  inclusive, phi covers 0..360 deg exclusive (periodic), capped at 262,144
  samples (`nec-backend.ts:141-178`, `auto-grid.ts:26-50`). With the
  element extent included the auto grids reproduced here are 93x366 for 64
  dipoles (34k samples), 134x529 for 128 (71k) and 187x742 for 256 (139k);
  the minimum is 19x72.
  Display sizes up to 513^2 are a separate raster.
- **Symmetry is on by default.** The app passes `symmetry: 'auto'` with
  `positionEpsilonM: 0`; a centred rectangular lattice is therefore solved
  on a quarter model. Per the brief, every number below uses `symmetry:
  "off"` (explicit model) so that it applies to arbitrary positions. One
  rectangular case with `auto` is included for reference.

Everything else matches: `fieldWorkers: "auto"`, `farFieldEvaluator`
`"exact"` by default or opt-in `"ring"` per request, calibration always
exact, perfect ground `z = 0` for every element type, at most 256 elements
and 3,000 segments, f64 planes ingested by `from_nec_peak`.

## 3. Method

### Builds

| Variant | Flags | Use |
|---|---|---|
| `scalar` | repository `scripts/build_wasm_inner.sh` defaults: `-O3 -flto -fexceptions`, `ALLOW_MEMORY_GROWTH`, 4 MiB stack, JS exceptions | the shipped configuration; all baseline tables |
| `simd` | same plus `-msimd128` | SIMD comparison |
| `probe` | `scalar` plus `-DNECPP_AUDIT_PROBE` (scratch patch) | fill / factor / port-solve / inversion / embedded split and WASM heap size |
| `simd-prof` | `simd` plus `--profiling-funcs` | V8 CPU profiles with C++ names |
| native | g++ 13, `-O3`, bundled Eigen, `-DNECPP_AUDIT_PROBE -g` | callgrind, matrix dumps, micro-benchmarks |

### Host

Intel Xeon @ 2.10 GHz (cloud container), 4 logical CPUs, 15 GiB, Linux
6.18, Node 22.22.0 (V8 12.4), Chromium 1194 from Playwright. With 4 logical
CPUs `fieldWorkers: "auto"` selects 2 evaluator workers; the visualizer's
previous evidence was taken on a 16-thread Ryzen (4 workers). Absolute times
here are therefore slower than on a developer workstation, but every
comparison in this document was run on the same host under the same
conditions. Background builds and profiles ran at `nice 19` while the sweeps
ran, so field-stage times carry a few percent of noise; single-threaded
stages were not affected.

### Models

All at 10 GHz over perfect ground unless stated (the app's defaults):

| Element | Segments | Ports | Geometry |
|---|---:|---:|---|
| dipole | 11 | 1 | X-directed, 0.47 lambda long, 0.001 lambda radius, 0.25 lambda high, feed segment 6 |
| crossed dipole | 22 | 2 | two orthogonal 0.47 lambda wires, 0.005 lambda apart in z |
| helix | 51 | 1 | visualizer preset 1 (D 0.27056, pitch 0.18067, 5 turns, feed 0.04 lambda, 10 chords/turn), `groundConnection: "interpolate"` |

Layouts: sunflower (golden-angle spiral, mean spacing 0.5 lambda, 0.6 lambda
for helices) and rectangular lattice at 0.5 lambda. Steering states are
uniform-amplitude progressive phases at (u, v) = (0, 0), (0.25, 0),
(0.25, 0.25).

The job sequence per case is the visualizer's: create (worker start plus
geometry round trips), `prepare`, `computeImpedanceMatrix`, three
`solveCurrents`, `getCurrentDistribution`, `computeFarField` per grid and
evaluator twice (first call includes pool warm-up and snapshot broadcast),
`computeEmbeddedFarFields` (unit current and unit voltage) per embedded
grid, `dispose`.

Reproduce:

```sh
# build scalar and simd dists (see scripts/build_wasm_inner.sh), then
node bench/full-nec-audit.mjs --module-directory <dist> --output out.ndjson --label scalar
node bench/full-nec-audit-report.mjs out.ndjson
node bench/full-nec-audit-browser.mjs --module-directory <dist> --count 64 --grids 19x72,91x181
```

<!-- BASELINE_TABLES -->
## 4. Measured baseline

All times are wall-clock milliseconds measured around the public API call from the calling thread (worker round trip included). `r0` is the first far-field call of a grid/evaluator pair (includes evaluator-pool warm-up and snapshot broadcast); `r1` is the repeat. Raw NDJSON: `bench/full-nec-audit/evidence/*.ndjson`.


### 4.1 Headline cases, quiet host (scalar dist, nothing else running) (Intel(R) Xeon(R) Processor @ 2.10GHz, 4 logical CPUs, Node v22.22.0, package 0.8.0, engine 2.5.0)

| Case | N | P | create | prepare | Z | solve (median) | currents | embedded 1×1 uc | dispose | peak RSS MiB |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| dipole sunflower 64 perfect | 704 | 64 | 168.8 | 514.2 | 216.2 | 4.2 | 9.0 | 10.1 | 3.9 | 623 |
| dipole sunflower 128 perfect | 1408 | 128 | 192.2 | 2863.7 | 1413.2 | 8.9 | 12.4 | 23.2 | 4.1 | 222 |
| dipole sunflower 256 perfect | 2816 | 256 | 210.7 | 18404.5 | 11176.6 | 31.5 | 22.6 | 8591.8 | 3.5 | 348 |
| crossed sunflower 136 perfect | 2992 | 272 | 192.8 | 21331.8 | 13162.7 | 37.7 | 28.5 | 10700.3 | 3.4 | 361 |
| dipole rect 256 perfect | 2816 | 256 | 198.6 | 19314.3 | 11674.9 | 33.8 | 23.3 | 7799.7 | 2.4 | 334 |
| dipole sunflower 64 free | 704 | 64 | 140.7 | 342.1 | 186.0 | 3.4 | 6.9 | 6.1 | 3.3 | 152 |
| dipole sunflower 256 free | 2816 | 256 | 192.1 | 16619.2 | 10227.3 | 32.2 | 22.5 | 7248.7 | 2.5 | 364 |
| helix sunflower 32 perfect | 1632 | 32 | 256.0 | 4165.4 | 313.5 | 9.3 | 15.4 | 10.2 | 5.9 | 178 |

#### Far fields (ms; r0 = first call incl. pool warm-up/snapshot, r1 = repeat)

| Case | Grid | Samples | exact r0 | exact r1 | ring r0 | ring r1 | ring exec | ring rel err | workers | contributions |
|---|---|---:|---:|---:|---:|---:|---|---:|---:|---:|
| dipole sunflower 64 perfect | 19x72 | 1368 | 143.0 | 61.4 | 71.1 | 74.2 | mixed (no-sample-reduction) | 9.1e-16 | 2 | 1.9M |
| dipole sunflower 64 perfect | 91x181 | 16471 | 717.7 | 593.6 | 285.9 | 234.7 | ring | 1.2e-15 | 2 | 23.2M |
| dipole sunflower 64 perfect | 93x366 | 34038 | 1228.8 | 1217.4 | 282.0 | 375.5 | ring | 1.7e-15 | 2 | 47.9M |
| dipole sunflower 64 perfect | 181x360 | 65160 | 2592.5 | 2686.4 | 693.0 | 466.6 | ring | 1.4e-15 | 2 | 91.7M |
| dipole sunflower 128 perfect | 19x72 | 1368 | 334.5 | 163.3 | 150.3 | 170.2 | mixed (no-sample-reduction) | 1.3e-15 | 2 | 3.9M |
| dipole sunflower 128 perfect | 91x181 | 16471 | 1364.1 | 1197.8 | 689.9 | 643.0 | ring | 1.4e-15 | 2 | 46.4M |
| dipole sunflower 128 perfect | 134x529 | 70886 | 5561.2 | 5529.0 | 840.5 | 1155.5 | ring | 2.2e-15 | 2 | 199.6M |
| dipole sunflower 128 perfect | 181x360 | 65160 | 4768.4 | 5193.0 | 1389.2 | 1359.0 | ring | 1.7e-15 | 2 | 183.5M |
| dipole sunflower 256 perfect | 19x72 | 1368 | 545.7 | 226.5 | 218.8 | 282.2 | mixed (no-sample-reduction) | 1.3e-15 | 2 | 7.7M |
| dipole sunflower 256 perfect | 91x181 | 16471 | 2868.2 | 2639.9 | 1405.2 | 1490.3 | ring | 2.1e-15 | 2 | 92.8M |
| dipole sunflower 256 perfect | 187x742 | 138754 | 22692.8 | 20123.4 | 2597.2 | 2881.4 | ring | 2.4e-15 | 2 | 781.5M |
| dipole sunflower 256 perfect | 181x360 | 65160 | 10067.8 | 9350.3 | 2691.9 | 3027.7 | ring | 2.3e-15 | 2 | 367.0M |
| crossed sunflower 136 perfect | 19x72 | 1368 | 642.2 | 256.0 | 204.7 | 254.2 | mixed (no-sample-reduction) | 1.2e-15 | 2 | 8.2M |
| crossed sunflower 136 perfect | 135x535 | 72225 | 10897.6 | 11112.1 | 1741.7 | 1969.5 | ring | 2.0e-15 | 2 | 432.2M |
| dipole rect 256 perfect | 19x72 | 1368 | 606.0 | 241.3 | 230.7 | 252.2 | mixed (no-sample-reduction) | 5.5e-16 | 2 | 7.7M |
| dipole rect 256 perfect | 159x629 | 100011 | 14612.9 | 14107.6 | 2587.3 | 2688.9 | ring | 2.3e-15 | 2 | 563.3M |
| dipole sunflower 64 free | 19x72 | 1368 | 99.2 | 29.1 | 30.2 | 27.3 | mixed (no-sample-reduction) | 1.2e-15 | 2 | 1.0M |
| dipole sunflower 64 free | 93x366 | 34038 | 580.3 | 586.3 | 166.9 | 146.0 | ring | 2.0e-15 | 2 | 24.0M |
| dipole sunflower 256 free | 19x72 | 1368 | 292.5 | 118.5 | 123.3 | 115.3 | mixed (no-sample-reduction) | 2.3e-15 | 2 | 3.9M |
| dipole sunflower 256 free | 187x742 | 138754 | 9778.4 | 9665.7 | 1341.4 | 1323.9 | ring | 3.3e-15 | 2 | 390.7M |
| helix sunflower 32 perfect | 19x72 | 1368 | 429.0 | 140.1 | 146.7 | 154.7 | mixed (no-sample-reduction) | 2.0e-15 | 2 | 4.5M |
| helix sunflower 32 perfect | 73x288 | 21024 | 1732.1 | 1972.3 | 457.9 | 408.5 | ring | 3.0e-15 | 2 | 68.6M |

#### Embedded far fields (ms)

| Case | Grid | Samples/port | Ports | unit-current | unit-voltage | result MiB |
|---|---|---:|---:|---:|---:|---:|
| dipole sunflower 64 perfect | 1x1 | 1 | 64 | 10.1 | 5.2 | 0.0 |
| dipole sunflower 64 perfect | 19x72 | 1368 | 64 | 7632.2 | 7201.0 | 2.7 |
| dipole sunflower 64 perfect | 93x366 | 34038 | 64 | 181765.3 | 190736.9 | 66.5 |
| dipole sunflower 128 perfect | 1x1 | 1 | 128 | 23.2 | 18.4 | 0.0 |
| dipole sunflower 128 perfect | 19x72 | 1368 | 128 | 29488.9 | 28797.4 | 5.3 |
| dipole sunflower 256 perfect | 1x1 | 1 | 256 | 8591.8 | 8401.9 | 0.0 |
| dipole sunflower 256 perfect | 19x72 | 1368 | 256 | 128016.5 | 124960.2 | 10.7 |
| crossed sunflower 136 perfect | 1x1 | 1 | 272 | 10700.3 | 9827.2 | 0.0 |
| crossed sunflower 136 perfect | 19x72 | 1368 | 272 | 137185.2 | 136032.4 | 11.4 |
| dipole rect 256 perfect | 1x1 | 1 | 256 | 7799.7 | 7055.0 | 0.0 |
| dipole rect 256 perfect | 19x72 | 1368 | 256 | 121907.0 | 117873.1 | 10.7 |
| dipole sunflower 64 free | 1x1 | 1 | 64 | 6.1 | 3.2 | 0.0 |
| dipole sunflower 64 free | 19x72 | 1368 | 64 | 3483.8 | 3336.6 | 2.7 |
| dipole sunflower 256 free | 1x1 | 1 | 256 | 7248.7 | 7074.9 | 0.0 |
| dipole sunflower 256 free | 19x72 | 1368 | 256 | 64596.4 | 64659.9 | 10.7 |
| helix sunflower 32 perfect | 1x1 | 1 | 32 | 10.2 | 5.6 | 0.0 |
| helix sunflower 32 perfect | 19x72 | 1368 | 32 | 8101.9 | 8605.5 | 1.3 |

#### Fitted exponents (dipole sunflower, perfect ground; y = a·N^b over N = segments)

| Stage | N=704 | N=1408 | N=2816 | exponent b |
|---|---:|---:|---:|---:|
| prepare (fill+LU) | 514.2 | 2863.7 | 18404.5 | 2.58 |
| computeImpedanceMatrix | 216.2 | 1413.2 | 11176.6 | 2.85 |
| solveCurrents (median) | 4.2 | 8.9 | 31.5 | 1.46 |
| getCurrentDistribution | 9.0 | 12.4 | 22.6 | 0.67 |
| embedded 1x1 unit-current | 10.1 | 23.2 | 8591.8 | 4.87 |
| embedded 19x72 unit-current | 7632.2 | 29488.9 | 128016.5 | 2.03 |
| far field exact 19x72 r1 | 61.4 | 163.3 | 226.5 | 0.94 |
| far field exact 181x360 r1 | 2686.4 | 5193.0 | 9350.3 | 0.90 |
| far field ring 181x360 r1 | 466.6 | 1359.0 | 3027.7 | 1.35 |


### 4.2 Full case matrix (scalar dist; the 64..128 sunflower and rectangular rows ran while profiling jobs shared the host, see 4.1 for quiet numbers) (Intel(R) Xeon(R) Processor @ 2.10GHz, 4 logical CPUs, Node v22.22.0, package 0.8.0, engine 2.5.0)

| Case | N | P | create | prepare | Z | solve (median) | currents | embedded 1×1 uc | dispose | peak RSS MiB |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| dipole sunflower 64 perfect | 704 | 64 | 137.1 | 448.4 | 188.5 | 3.2 | 7.3 | 11.5 | 3.0 | 638 |
| dipole sunflower 128 perfect | 1408 | 128 | 161.7 | 2845.2 | 1250.5 | 8.5 | 20.2 | 41.2 | 2.7 | 220 |
| dipole sunflower 256 perfect | 2816 | 256 | 209.5 | 18837.9 | 11354.2 | 35.4 | 35.8 | 6880.4 | 3.0 | 357 |
| dipole rect 64 perfect | 704 | 64 | 135.0 | 450.0 | 249.9 | 4.3 | 8.9 | 8.7 | 3.9 | 154 |
| dipole rect 128 perfect | 1408 | 128 | 171.4 | 2950.5 | 1281.5 | 8.5 | 14.0 | 22.3 | 4.1 | 219 |
| dipole rect 256 perfect | 2816 | 256 | 250.7 | 18977.9 | 12425.7 | 43.2 | 36.8 | 8162.1 | 3.1 | 336 |
| dipole sunflower 64 free | 704 | 64 | 131.1 | 460.8 | 219.3 | 3.9 | 8.5 | 8.4 | 2.6 | 155 |
| dipole sunflower 128 free | 1408 | 128 | 145.1 | 3073.6 | 1649.1 | 8.9 | 11.6 | 16.3 | 3.7 | 227 |
| dipole sunflower 256 free | 2816 | 256 | 239.3 | 19205.6 | 11977.2 | 50.2 | 32.0 | 8366.6 | 5.7 | 346 |
| crossed sunflower 128 perfect | 2816 | 256 | 201.4 | 18917.8 | 10765.2 | 37.3 | 25.1 | 8060.2 | 2.8 | 333 |
| crossed sunflower 136 perfect | 2992 | 272 | 219.1 | 22339.5 | 12766.4 | 35.7 | 24.3 | 9747.7 | 2.9 | 357 |
| helix sunflower 32 perfect | 1632 | 32 | 296.2 | 3903.5 | 260.3 | 9.2 | 16.4 | 11.5 | 3.6 | 177 |

#### Far fields (ms; r0 = first call incl. pool warm-up/snapshot, r1 = repeat)

| Case | Grid | Samples | exact r0 | exact r1 | ring r0 | ring r1 | ring exec | ring rel err | workers | contributions |
|---|---|---:|---:|---:|---:|---:|---|---:|---:|---:|
| dipole sunflower 64 perfect | 19x72 | 1368 | 251.4 | 57.5 | 59.8 | 58.4 | mixed (no-sample-reduction) | 9.1e-16 | 2 | 1.9M |
| dipole sunflower 64 perfect | 91x181 | 16471 | 742.9 | 551.2 | 237.6 | 273.1 | ring | 1.2e-15 | 2 | 23.2M |
| dipole sunflower 64 perfect | 93x366 | 34038 | 1515.2 | 1276.7 | 247.8 | 267.8 | ring | 1.7e-15 | 2 | 47.9M |
| dipole sunflower 64 perfect | 181x360 | 65160 | 2375.9 | 2373.1 | 479.9 | 502.0 | ring | 1.4e-15 | 2 | 91.7M |
| dipole sunflower 128 perfect | 19x72 | 1368 | 380.8 | 122.6 | 115.1 | 110.7 | mixed (no-sample-reduction) | 1.3e-15 | 2 | 3.9M |
| dipole sunflower 128 perfect | 91x181 | 16471 | 1346.7 | 1318.1 | 690.5 | 558.3 | ring | 1.4e-15 | 2 | 46.4M |
| dipole sunflower 128 perfect | 134x529 | 70886 | 5514.6 | 5473.2 | 912.0 | 950.9 | ring | 2.2e-15 | 2 | 199.6M |
| dipole sunflower 128 perfect | 181x360 | 65160 | 5019.4 | 5113.5 | 1112.8 | 1144.9 | ring | 1.7e-15 | 2 | 183.5M |
| dipole sunflower 256 perfect | 19x72 | 1368 | 521.9 | 226.2 | 208.7 | 231.4 | mixed (no-sample-reduction) | 1.3e-15 | 2 | 7.7M |
| dipole sunflower 256 perfect | 91x181 | 16471 | 4195.9 | 4802.1 | 2267.5 | 2614.0 | ring | 2.1e-15 | 2 | 92.8M |
| dipole sunflower 256 perfect | 187x742 | 138754 | 33237.4 | 33159.3 | 5164.4 | 5521.1 | ring | 2.4e-15 | 2 | 781.5M |
| dipole sunflower 256 perfect | 181x360 | 65160 | 17523.8 | 20198.8 | 4839.0 | 4895.7 | ring | 2.3e-15 | 2 | 367.0M |
| dipole rect 64 perfect | 19x72 | 1368 | 207.3 | 56.4 | 59.9 | 58.8 | mixed (no-sample-reduction) | 9.6e-16 | 2 | 1.9M |
| dipole rect 64 perfect | 78x308 | 24024 | 953.5 | 864.4 | 246.5 | 230.5 | ring | 1.3e-15 | 2 | 33.8M |
| dipole rect 128 perfect | 19x72 | 1368 | 263.5 | 146.5 | 127.0 | 146.3 | mixed (no-sample-reduction) | 9.0e-16 | 2 | 3.9M |
| dipole rect 128 perfect | 114x449 | 51186 | 3844.0 | 4125.9 | 864.9 | 914.4 | ring | 1.8e-15 | 2 | 144.1M |
| dipole rect 256 perfect | 19x72 | 1368 | 632.6 | 213.1 | 203.1 | 181.6 | mixed (no-sample-reduction) | 5.5e-16 | 2 | 7.7M |
| dipole rect 256 perfect | 159x629 | 100011 | 15049.8 | 15127.6 | 3131.9 | 2718.9 | ring | 2.3e-15 | 2 | 563.3M |
| dipole sunflower 64 free | 19x72 | 1368 | 105.4 | 30.3 | 32.8 | 32.2 | mixed (no-sample-reduction) | 1.2e-15 | 2 | 1.0M |
| dipole sunflower 64 free | 93x366 | 34038 | 857.6 | 764.0 | 150.4 | 199.2 | ring | 2.0e-15 | 2 | 24.0M |
| dipole sunflower 128 free | 19x72 | 1368 | 180.0 | 66.6 | 61.9 | 53.5 | mixed (no-sample-reduction) | 1.5e-15 | 2 | 1.9M |
| dipole sunflower 128 free | 134x529 | 70886 | 2943.1 | 2798.9 | 625.4 | 665.3 | ring | 2.8e-15 | 2 | 99.8M |
| dipole sunflower 256 free | 19x72 | 1368 | 357.1 | 118.7 | 111.9 | 99.9 | mixed (no-sample-reduction) | 2.3e-15 | 2 | 3.9M |
| dipole sunflower 256 free | 187x742 | 138754 | 10398.8 | 11003.7 | 1679.9 | 1625.5 | ring | 3.3e-15 | 2 | 390.7M |
| crossed sunflower 128 perfect | 19x72 | 1368 | 627.5 | 238.3 | 219.7 | 195.2 | mixed (no-sample-reduction) | 9.6e-16 | 2 | 7.7M |
| crossed sunflower 128 perfect | 134x529 | 70886 | 10432.9 | 10714.5 | 1646.7 | 1534.6 | ring | 2.4e-15 | 2 | 399.2M |
| crossed sunflower 136 perfect | 19x72 | 1368 | 658.1 | 239.3 | 211.3 | 201.9 | mixed (no-sample-reduction) | 1.2e-15 | 2 | 8.2M |
| crossed sunflower 136 perfect | 135x535 | 72225 | 11304.9 | 10891.1 | 1891.6 | 1735.8 | ring | 2.0e-15 | 2 | 432.2M |
| helix sunflower 32 perfect | 19x72 | 1368 | 334.4 | 128.1 | 104.8 | 101.5 | mixed (no-sample-reduction) | 2.0e-15 | 2 | 4.5M |
| helix sunflower 32 perfect | 73x288 | 21024 | 1857.9 | 1813.6 | 400.0 | 398.7 | ring | 3.0e-15 | 2 | 68.6M |

#### Embedded far fields (ms)

| Case | Grid | Samples/port | Ports | unit-current | unit-voltage | result MiB |
|---|---|---:|---:|---:|---:|---:|
| dipole sunflower 64 perfect | 1x1 | 1 | 64 | 11.5 | 9.8 | 0.0 |
| dipole sunflower 64 perfect | 19x72 | 1368 | 64 | 7569.2 | 6922.6 | 2.7 |
| dipole sunflower 64 perfect | 93x366 | 34038 | 64 | 178054.3 | 175391.2 | 66.5 |
| dipole sunflower 128 perfect | 1x1 | 1 | 128 | 41.2 | 29.9 | 0.0 |
| dipole sunflower 128 perfect | 19x72 | 1368 | 128 | 31890.9 | 29114.9 | 5.3 |
| dipole sunflower 256 perfect | 1x1 | 1 | 256 | 6880.4 | 8219.4 | 0.0 |
| dipole sunflower 256 perfect | 19x72 | 1368 | 256 | 126846.6 | 130542.8 | 10.7 |
| dipole rect 64 perfect | 1x1 | 1 | 64 | 8.7 | 5.2 | 0.0 |
| dipole rect 64 perfect | 19x72 | 1368 | 64 | 7634.1 | 8010.3 | 2.7 |
| dipole rect 128 perfect | 1x1 | 1 | 128 | 22.3 | 19.2 | 0.0 |
| dipole rect 128 perfect | 19x72 | 1368 | 128 | 30392.2 | 28143.5 | 5.3 |
| dipole rect 256 perfect | 1x1 | 1 | 256 | 8162.1 | 7675.5 | 0.0 |
| dipole rect 256 perfect | 19x72 | 1368 | 256 | 123823.4 | 126240.8 | 10.7 |
| dipole sunflower 64 free | 1x1 | 1 | 64 | 8.4 | 3.8 | 0.0 |
| dipole sunflower 64 free | 19x72 | 1368 | 64 | 4185.3 | 4295.0 | 2.7 |
| dipole sunflower 128 free | 1x1 | 1 | 128 | 16.3 | 12.1 | 0.0 |
| dipole sunflower 128 free | 19x72 | 1368 | 128 | 16563.0 | 14188.7 | 5.3 |
| dipole sunflower 256 free | 1x1 | 1 | 256 | 8366.6 | 9054.9 | 0.0 |
| dipole sunflower 256 free | 19x72 | 1368 | 256 | 70733.2 | 67594.8 | 10.7 |
| crossed sunflower 128 perfect | 1x1 | 1 | 256 | 8060.2 | 7712.7 | 0.0 |
| crossed sunflower 128 perfect | 19x72 | 1368 | 256 | 122739.8 | 123846.3 | 10.7 |
| crossed sunflower 136 perfect | 1x1 | 1 | 272 | 9747.7 | 10511.8 | 0.0 |
| crossed sunflower 136 perfect | 19x72 | 1368 | 272 | 137407.8 | 136231.7 | 11.4 |
| helix sunflower 32 perfect | 1x1 | 1 | 32 | 11.5 | 10.0 | 0.0 |
| helix sunflower 32 perfect | 19x72 | 1368 | 32 | 9219.8 | 8092.5 | 1.3 |

#### Fitted exponents (dipole sunflower, perfect ground; y = a·N^b over N = segments)

| Stage | N=704 | N=1408 | N=2816 | exponent b |
|---|---:|---:|---:|---:|
| prepare (fill+LU) | 448.4 | 2845.2 | 18837.9 | 2.70 |
| computeImpedanceMatrix | 188.5 | 1250.5 | 11354.2 | 2.96 |
| solveCurrents (median) | 3.2 | 8.5 | 35.4 | 1.74 |
| getCurrentDistribution | 7.3 | 20.2 | 35.8 | 1.14 |
| embedded 1x1 unit-current | 11.5 | 41.2 | 6880.4 | 4.61 |
| embedded 19x72 unit-current | 7569.2 | 31890.9 | 126846.6 | 2.03 |
| far field exact 19x72 r1 | 57.5 | 122.6 | 226.2 | 0.99 |
| far field exact 181x360 r1 | 2373.1 | 5113.5 | 20198.8 | 1.54 |
| far field ring 181x360 r1 | 502.0 | 1144.9 | 4895.7 | 1.64 |

### 4.3 WASM stage split (probe build: scalar + `NECPP_AUDIT_PROBE`; `antenna_env` is the ground/Sommerfeld setup, zero for PEC and free space)

| Case | N | P | antenna_env | fill | factor | fill share | Y solves (P) | per solve | Z = Y^-1 | heap after prepare MiB | embedded 19x72 uc: solves / fields | uv: solves / fields |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| dipole sunflower 64 perfect | 704 | 64 | 0.0 | 165.1 | 281.0 | 37 % | 203.7 | 3.2 | 39.4 | 20 | 196.9 / 7888.5 | – |
| dipole sunflower 128 perfect | 1408 | 128 | 0.0 | 701.1 | 1847.8 | 28 % | 835.5 | 6.5 | 513.8 | 60 | 1221.8 / 33539.1 | – |
| dipole sunflower 256 perfect | 2816 | 256 | 0.0 | 3175.7 | 16205.2 | 16 % | 8402.5 | 32.8 | 4237.7 | 224 | 6947.9 / 74.9 | 7624.1 / 78.6 |
| dipole sunflower 256 free | 2816 | 256 | 0.0 | 2138.5 | 15304.1 | 12 % | 7760.8 | 30.3 | 3680.4 | 224 | 8343.5 / 44.5 | 7957.5 / 39.5 |
| crossed sunflower 136 perfect | 2992 | 272 | 0.0 | 3583.7 | 17532.2 | 17 % | 9863.9 | 36.3 | 3778.2 | 252 | 9231.9 / 86.2 | 9528.3 / 88.2 |
| helix sunflower 32 perfect | 1632 | 32 | 0.0 | 1014.0 | 2804.1 | 27 % | 261.5 | 8.2 | 6.0 | 79 | 345.7 / 8212.1 | – |

### 4.4 simd128 vs scalar (same cases, ratio simd / quiet-host scalar; 1.00x = no change)

Repeated runs of the same dist on this host vary by up to about 20 %
between sweeps (compare Sections 4.1 and 4.2), so ratios between 0.8x and
1.25x are noise. Nothing in the table is outside that band in a consistent
direction: `-msimd128` does not change any stage.

| Case | prepare | Z | solve | exact field (largest grid, r1) | ring field (largest grid, r1) | embedded 19x72 uc |
|---|---:|---:|---:|---:|---:|---:|
| dipole sunflower 64 perfect | 0.79x | 1.00x | 0.91x | 0.82x | 1.14x | 0.86x |
| dipole sunflower 128 perfect | 0.85x | 0.85x | 0.82x | 0.96x | 0.74x | 1.02x |
| dipole sunflower 256 perfect | 1.03x | 1.03x | 1.41x | 0.99x | 1.05x | 0.98x |
| crossed sunflower 136 perfect | 1.05x | 1.05x | 0.89x | 0.91x | 0.91x | 1.02x |
| helix sunflower 32 perfect | 0.91x | 1.06x | 1.14x | 1.10x | 1.13x | 1.06x |

### 4.5 Serial field path (`fieldWorkers: 1`) vs the auto pool (2 workers on this host; pool numbers from the quiet-host rerun)

| Case | Grid | serial exact r1 | pool exact r1 | speed-up | serial ring r1 | pool ring r1 | speed-up | pool workers |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| dipole sunflower 64 perfect | 19x72 | 116.6 | 61.4 | 1.90x | 84.9 | 74.2 | 1.15x | 2 |
| dipole sunflower 64 perfect | 91x181 | 1387.6 | 593.6 | 2.34x | 463.1 | 234.7 | 1.97x | 2 |
| dipole sunflower 64 perfect | 93x366 | 2708.3 | 1217.4 | 2.22x | 451.9 | 375.5 | 1.20x | 2 |
| dipole sunflower 64 perfect | 181x360 | 5538.8 | 2686.4 | 2.06x | 1093.1 | 466.6 | 2.34x | 2 |
| dipole sunflower 256 perfect | 19x72 | 448.0 | 226.5 | 1.98x | 443.8 | 282.2 | 1.57x | 2 |
| dipole sunflower 256 perfect | 91x181 | 5408.6 | 2639.9 | 2.05x | 2631.4 | 1490.3 | 1.77x | 2 |
| dipole sunflower 256 perfect | 187x742 | 46112.0 | 20123.4 | 2.29x | 5457.4 | 2881.4 | 1.89x | 2 |
| dipole sunflower 256 perfect | 181x360 | 22198.7 | 9350.3 | 2.37x | 5068.2 | 3027.7 | 1.67x | 2 |

### 4.6 Headless Chromium (loopback HTTP without COOP/COEP; `crossOriginIsolated` reported per row)

| Case | dist | isolated | cores | create | prepare | Z | solve (median) | currents | fields (grid: exact r1 / ring r1, workers) | embedded 1x1 uc / uv | embedded 19x72 uc / uv |
|---|---|---|---:|---:|---:|---:|---:|---:|---|---|---|
| dipole sunflower 64 perfect | dist-scalar | false | 4 | 100.0 | 448.0 | 221.6 | 3.4 | 7.5 | 19x72: 171.2 / 129.0 (2w); 91x181: 1720.7 / 696.0 (2w) | 9.4 / 6.9 | 6683.2 / 6259.9 |
| dipole sunflower 256 perfect | dist-scalar | false | 4 | 175.9 | 20819.3 | 10750.3 | 36.1 | 33.5 | 19x72: 681.2 / 652.4 (2w); 91x181: 8491.7 / 4678.9 (2w) | 8446.8 / 7596.5 | 118687.9 / 118320.7 |
| dipole sunflower 64 perfect | dist-simd | false | 4 | 100.6 | 470.9 | 217.8 | 3.6 | 9.3 | 19x72: 124.2 / 113.9 (2w); 91x181: 1900.9 / 739.1 (2w) | 15.1 / 8.7 | – / – |

## 5. Where the time goes

### 5.1 `prepare`: fill and factorization

Native probe (g++ -O3, same code path as WASM through the C ABI):

| Case | N | P | fill | factor | fill share | Y (P solves) | per solve | Z = Y^-1 (SVD) | 19x72 exact field | ring |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 64 dipoles PEC | 704 | 64 | 0.11 s | 0.10 s | 52 % | 0.06 s | 0.9 ms | 0.02 s | 74 ms | 65 ms |
| 64 dipoles free space | 704 | 64 | 0.08 s | 0.11 s | 41 % | 0.07 s | 1.1 ms | 0.02 s | 38 ms | 34 ms |
| 128 dipoles PEC | 1,408 | 128 | 0.59 s | 0.85 s | 41 % | 0.38 s | 3.0 ms | 0.15 s | 146 ms | 136 ms |
| 128 dipoles free space | 1,408 | 128 | 0.30 s | 0.90 s | 25 % | 0.39 s | 3.1 ms | 0.23 s | 105 ms | 68 ms |
| 256 dipoles PEC | 2,816 | 256 | 2.31 s | 5.71 s | 29 % | 3.77 s | 14.7 ms | 1.80 s | 323 ms | 351 ms |
| 256 dipoles free space | 2,816 | 256 | 1.38 s | 5.69 s | 20 % | 3.69 s | 14.4 ms | 1.71 s | 159 ms | 145 ms |
| 136 crossed PEC | 2,992 | 272 | 2.35 s | 7.00 s | 25 % | 5.35 s | 19.7 ms | 1.69 s | 317 ms | 308 ms |
| 32 helices PEC | 1,632 | 32 | 0.72 s | 1.04 s | 41 % | 0.13 s | 4.1 ms | 0.00 s | 222 ms | 179 ms |

(`bench/full-nec-audit/evidence/native-probe-quiet.txt`; the 19x72 field
is too small for the ring evaluator to pay off, as the WASM tables show.)

The WASM split from the probe build is in Section 4.3: at 2,816 unknowns
the fill is 3.2 s and the LU 16.2 s (16 % fill), at 704 unknowns 0.17 s and
0.28 s (37 %). The ratio has the same shape natively: the fill is N^2 with a
large constant and the factorization is N^3, so the crossover is near 700
unknowns in WASM and the LU owns `prepare` at the app's maximum. Free space
removes the image half of the fill (2.1 s instead of 3.2 s at 2,816) and
nothing else. The 51-segment helices (1,632 unknowns, 32 ports) fill in 1.0 s
and factor in 2.8 s, the same per-unknown cost as dipoles.

**Fill, instruction level** (callgrind, 64 dipoles, 991,232 pair evaluations
including the perfect-ground images; `src/nec_context.cpp`):

| Part | Share of `cmset` | Notes |
|---|---:|---|
| `efld_compute` self plus `sincos` (far pairs, `r >= rkh` = 1 lambda) | ~48 % | one `sincos(k r)` plus `sin(pi s)` per pair; `sin(pi s)` depends on the source only (`:2914-2974`) |
| `eksc` subtree (near pairs, `r < rkh`) | 26 % | 137,906 calls (14 % of pairs); each does `sin/cos(shk)` (source-only), 2x `gx` (sqrt, sin, cos) and the adaptive Romberg `intx` (`:4314-4476`) with 707,450 `gf` calls, i.e. 5.1 kernel evaluations (sqrt, sin, cos) per near pair |
| `efld` self (image combination, ground scaling) | 15 % | `:2982-3180` |
| `cmww` / `cmset` loop overhead, strided writes | ~10 % | writes stride by `nrow` (`:2772-2775`); `lu_decompose` then does an O(N^2) strided in-place transpose (`matrix_algebra.cpp:229-238`) |

This near/far split and the Romberg integrator are the engine's own
(`efld_compute` `:2945` and `:2965`, `rkh` defaulting to 1 wavelength at
`:160` and only changed by a KH card at `:1016`), on the exact call chain the
package uses: `necpp_wasm_v1_prepare` -> `nec_stateful_model::prepare` ->
`stateful_prepare_frequency` -> `structure_segment_loading` -> `cmset` ->
`cmww` -> `efld` -> `efld_compute`. The counts above were taken with the
native driver over that C ABI. The visualizer's hybrid coupling kernel lives
in its Rust crates and is not involved.

Perfect ground calls `efld_compute` twice per pair (direct and image,
`:3021`), so the fill is 2x free space. No reciprocity is used; the NEC
point-matched three-term basis does not give a symmetric matrix, so none is
available. `pi()` and friends are function-local statics (`math_util.h`)
with a guard load per call in the hot loops.

**Factorization, instruction level** (WASM, 256 dipoles, V8 profile of the
`simd-prof` build): `Eigen::internal::gebp_kernel<complex<double>>` is
32 % of the whole session's samples, i.e. essentially all of the LU. Eigen's
blocked right-looking LU (block size `clamp((n/8)/16*16, 8, 256)`) is cache
friendly already; the kernel is scalar `f64` in WASM. Measured on the dumped
matrices (quiet host): 2,816 unknowns 14.5 s in WASM versus 5.8 s natively
(2.5x), 1,408 unknowns 2.0 s versus 0.94 s (2.1x), 704 unknowns 0.22 s
versus 0.12 s (1.8x). Eigen's complex GEMM runs at 4.9 GFLOP/s in scalar
WASM and 12.6 GFLOP/s natively on the same core; compiled with `-msimd128`
it drops to 3.5-4.4 GFLOP/s.

### 5.2 `computeImpedanceMatrix`

Per the WASM profile at 256 dipoles (48 s sampled; `prepare`, Z, 2 solves,
one 19x72 field, embedded 1x1 unit-current and unit-voltage):

| Function | Self share | What it is |
|---|---:|---|
| `general_matrix_vector_product<complex<double>>` | 43.4 % | the BLAS-2 triangular solves: one vector at a time in `solve()` (`matrix_algebra.cpp:271-295`); ~770 solves in this run at about 32 ms each |
| `gebp_kernel` | 32.4 % | LU |
| `JacobiSVD` plus `apply_rotation_in_the_plane` | 8.2 % | `nec_invert_port_matrix` (`nec_port_matrix.cpp`): full-U/V Jacobi SVD of the 256x256 Y; 4.2 s by the probe, 0.5 s at 128 ports |
| `nec_antenna_input::write_to_file` plus `ostream<<double` | 5.8 % | `netwk_compute_inputs` formats a report into a `stringstream` on every solve (`nec_context.cpp:5223-5225`) |
| `efld_compute`, `efld`, `structure_segment_loading` self | 6 % | fill |
| `triangular_solve_matrix` | 2.7 % | the solves done through `solves()` |

Each port solve also rebuilds the `PermutationMatrix` (heap allocation),
runs `etmns`, `calculate_network_data`, `netwk`, `compute_structure_power_loss`
and `print_power_budget` (`nec_context.cpp:1759-1875`), and copies six
N-length coefficient planes into the retained basis.

Micro-benchmark on the dumped real matrices (quiet host, Eigen,
`bench/full-nec-audit/evidence/microbench-quiet.txt`):

| N | native single-RHS, per RHS | native blocked, per RHS | speed-up | WASM single-RHS | WASM blocked | speed-up |
|---:|---:|---:|---:|---:|---:|---:|
| 704 | 0.66 ms | 0.40 ms | 1.62x | 1.20 ms | 1.14 ms | 1.05x |
| 1,408 | 3.16 ms | 1.74 ms | 1.81x | 4.80 ms | 3.24 ms | 1.48x |
| 2,816 | 11.8 ms | 5.5 ms | 2.16x | 24.0 ms | 13.6 ms | 1.76x |

The engine's own per-solve cost in WASM (32.8 ms at 2,816, probe) is 1.4x
the bare Eigen single-RHS solve because of the permutation rebuild,
`etmns`, `netwk`, the report and the six plane copies around it.

Port-matrix inversion (native, quiet host, synthetic symmetric P x P;
`port-inverse-microbench.cpp`):

| P | Jacobi SVD (shipped) | LU inverse + `rcond` | BDC SVD | max diff / max Z |
|---:|---:|---:|---:|---:|
| 64 | 19.7 ms | 0.7 ms | 3.7 ms | 1.1e-14 |
| 128 | 217 ms | 4.6 ms | 21 ms | 2.5e-14 |
| 256 | 2,172 ms | 24.3 ms | 104 ms | 7.3e-14 |
| 272 | 1,845 ms | 28.7 ms | 121 ms | 1.4e-13 |

On the engine's real Y the WASM probe measured 4.2 s at 256 ports and
3.8 s at 272, matching the synthetic Jacobi SVD cost scaled by the 2-2.5x
WASM factor.

### 5.3 Far field (exact evaluator)

Callgrind, native, 64 dipoles, embedded 19x72 (the kernel is the same for
ordinary and embedded fields, `src/nec_far_field.cpp:283-526`):

| Part | Share of kernel |
|---|---:|
| `sin`, `sincos` (libm) | 51 % |
| `nec_evaluate_far_field_sample` self (dot products, divides, complex MACs) | 36 % |
| `safe_array` and `complex` operator overhead (inlined indexing) | 13 % |

The WASM profile of the same case gives 56 % in `sin`/`cos` with 9 % in
`__rem_pio2`: the phase argument `k * (x sin th cos ph + ...)` reaches tens
of radians at 256 elements and the musl `sin` takes the slow reduction path.
Per (segment, direction) the kernel does 4 `sin`, 1 `cos`, 3 divides and a
complex multiply-accumulate; perfect ground reruns the loop with the image.
There are no SIMD intrinsics and `-msimd128` produced no vector arithmetic
(confirmed again here: `simd` is within noise of `scalar` on every field,
Section 4.5).

The ring evaluator (`src/nec_ring_field.h`) replaces the per-phi direct
evaluation with M = 2L+1 samples per theta ring, an O(M^2) DFT and a
recurrence synthesis. Measured here on the quiet host with two workers: 64
dipoles at 181x360, 2,686 ms exact versus 467 ms ring (5.8x); 256 dipoles at
181x360, 9,350 ms versus 3,028 ms (3.1x), and at the 187x742 auto grid
20,123 ms versus 2,881 ms (7.0x); max error 1e-15 to 2e-15 of peak. The
exact kernel sustains about 17 million segment-direction-image contributions
per second per worker in WASM (46 s serial for the 781 M contributions of
the 256-dipole auto grid).

### 5.4 Embedded far fields

Per port the engine does one solve (unless the retained basis applies) and
one full field evaluation over all N segments. Field evaluation dominates
for every grid above 1x1: on 64 dipoles at 19x72 the 64 solves are 0.2 s
and the 64 field evaluations 7.9 s (WASM probe). Cost is P x S x N x images,
i.e. N^2 x S for arrays of fixed-size elements (fitted exponent 2.03): 7.6 s
at 64 dipoles, 29 s at 128 and 128 s at 256 for the 19x72 grid, and 182 s at
64 dipoles on its 93x366 auto grid. The embedded path never uses the
evaluator pool, and uses the ring evaluator only when asked
(`computeEmbeddedFarFields` with `evaluator: "ring"` exists but the app's
calibration policy forces exact).

The unit-current path on any grid larger than 1x1 runs
`run_unit_current_basis_loop` (`nec_stateful_model.cpp:1359-1444`): P
solves with V = Z[:, p] plus a restore solve, even when the basis is
retained. The unit-voltage path uses the retained basis when it fits the
64 MiB cap (`:232-256`, 2/3 of 64 MiB at 64 B per segment per port): 248
ports at 2,816 segments, so the 256-dipole case misses it and pays 256 solves
(6.9 to 8.6 s in WASM, 23 ms with the basis at 128 ports) for every embedded
request, including the app's 1x1 steering responses.

Result copies: native `e_theta`/`e_phi` (2 x P x S complex), the ABI split
copy (4 x P x S doubles, allocated fresh each call), the JS `HEAPF64.slice`
(4 x), `gatherEmbeddedBasis` (4 x) and `rephaseArrays` (4 x), with a
redundant `sin`/`cos` per basis x sample in the rephase loop
(`packages/necpp-wasm/src/array-solver.ts:495-523`).

### 5.5 Workers, transfers and copies

- `create` (outer worker start, WASM compile, one round trip per wire and
  port) is 170 to 210 ms in Node for 64 to 256 dipoles and 100 to 176 ms in
  Chromium; the evaluator pool warm-up is 31 to 70 ms and is lazy (first
  eligible field). Both are paid once per solver.
- In headless Chromium the pooled kernels ran 2 to 3x slower than in Node
  (64 dipoles, 91x181 exact: 1,721 to 2,013 ms versus 594 ms with two
  workers each; 256 dipoles: 8,492 versus 2,640 ms), with `kernelMs`
  accounting for the whole difference and `prepare`/Z within 5 % of Node.
  The serial path in Chromium (`fieldWorkers: 1`, engine kernel in the outer
  worker) took 1,286 ms for the same field, i.e. Node speed, and four
  evaluator workers took 903 ms, so the workers do run in parallel but each
  one is about 3x slower than in Node. `--js-flags=--no-liftoff` and
  `--no-wasm-lazy-compilation --no-wasm-dynamic-tiering` changed nothing.
  The dedicated evaluator module (43 KB, `-fno-exceptions`, 64 KB stack,
  nested workers spawned from the outer worker) is the suspect; this is an
  open item (Section 9) and, until resolved, the pool policy should compare
  its own measured per-contribution rate against the serial rate at runtime
  rather than trust `hardwareConcurrency`.
- Snapshot capture is 0.1 to 0.6 ms and the broadcast 0 to 2 ms (13 N-length
  planes on geometry change, 6 on solve change, nothing otherwise).
- Every result array is a fresh `HEAPF64.slice` copy, then transferred
  zero-copy to the main thread, then copied again by `gather*` and
  `rephaseFarField` (`array-solver.ts:312-352, 495-501`) even for the
  explicit representation at the origin. For a 187x742 field that is 4 x
  1.1 MB x 3 copies, about 10 ms; for an embedded 256 x 1,368 basis it is
  4 x 2.8 MB x 5 copies.
- `getCurrentDistribution` builds three arrays of N JS objects and
  structured-clones them (~53 WASM calls): 7 ms at 704 and 36 ms at 2,816
  segments.
- Construction does one awaited round trip per wire and per port, about
  200 ms for 256 elements; negligible against `prepare`.

### 5.6 Memory

For N segments and P ports, in the WASM heap:

| Item | Bytes | 2,816 seg / 256 ports | 2,992 seg / 272 ports |
|---|---|---:|---:|
| interaction matrix (`cm`), LU in place | 16 N^2, reserved at 1.5x by `safe_array::resize` (`src/safe_array.h:112-113`) | 127 MiB (190 MiB reserved) | 143 MiB (215 MiB reserved) |
| retained voltage-field basis | 64 N P (1.5x reserved), capped at 64 MiB | 44 MiB, not retained (cap) | 49 MiB, not retained |
| Y, Z, second Y copy, ABI split copies | ~6 x 16 P^2 | 6 MiB | 7 MiB |
| far-field double buffer plus ABI copy | ~3 x 32 S | 13 MiB at 187x742 | |
| embedded result (native plus ABI copy) | 2 x 32 P S | 22 MiB at 19x72, 2.1 GB at 187x742 | |

The probe build reported a 195 MiB heap after the fill and 224 MiB after the
LU at 2,816 unknowns (the 1.5x reservation plus about 39 MiB of Eigen GEMM
packing temporaries during the factorization; 252 MiB at 2,992 unknowns), and
the Node process peaked at 348 MiB RSS for that case. 4 GiB is the
Emscripten growth ceiling with the current flags. The dense ceiling inside a 32-bit heap is therefore about
N = 9,000 without the 1.5x reservation and about N = 7,300 with it, well
above the app's 3,000-segment limit; memory is not the binding constraint
at the app's sizes, time is.

## 6. Acceleration paths

Scale key for the tables: gain is for the 256-dipole case (2,816 unknowns,
256 ports) unless stated; effort is S (days), M (1-2 weeks), L (more).

### 6.1 Fill

| Path | Applicability | Expected gain | Error bound and test | Effort | API |
|---|---|---|---|---|---|
| Hoist per-source terms (`sin(pi s)`, `sin/cos(shk)`), replace `pi()` statics by constants, write the matrix in Eigen's layout and drop the O(N^2) transpose | all | 10-20 % of fill, 3-6 % of `prepare` at 256 | bit-identical or 1 ulp; `necpp_unit`, `necpp_wp2`, symmetry equivalence 1e-8 | S | none |
| Vectorise the far-pair loop (`r >= rkh`): batch observation segments, `f64x2` `sincos` polynomial with explicit range reduction | all; 86 % of pairs at 0.5 lambda spacing | 1.5-2x of the far-pair part, i.e. 1.3x fill, ~8 % of `prepare` at 256; more at 64-128 dipoles where fill is 40-75 % | polynomial `sincos` to 1 ulp over the reduced range; new oracle `max dZ / max Z <= 1e-12` against the scalar fill | M | none |
| Reuse interactions between identical elements under translation | only when element patterns are identical and the model has no ground-dependent asymmetry; the pair kernel depends on the relative vector only, so Z(i,j) for element pair (a,b) equals Z for (c,d) when `r_b - r_a == r_d - r_c` | lattices: a 16x16 lattice has only 960 distinct displacement vectors among 65,280 ordered element pairs (68x reuse), so the fill becomes O(N_el x segments^2) plus a lookup; sunflower and jittered layouts have no repeated displacements (checked: 0 repeats within 1e-6 of a spacing among the 65,280 pairs of the 256 sunflower), so no gain | exact (same floating-point path) when displacements match to the last bit; with an epsilon, bound by the kernel's Lipschitz constant times epsilon, which is the lattice-symmetry trick the brief excludes | M | none, but only helps lattices, so excluded by the brief |
| Distance-tiered quadrature for far pairs | pairs with `r < rkh` only use the adaptive Romberg; those beyond already use the lumped kernel | near pairs are 26 % of fill, with 5.1 kernel evaluations each; a fixed 3-point Gauss rule would save at most ~40 % of that, about 10 % of fill | would need `max dZ / max Z <= 1e-5` (the app's hybrid envelope) checked per tier; the Romberg tolerance is already 1e-4 relative on the integral | M | opt-in flag or none |
| Lower `rkh` (the lumped threshold) | all | more pairs lumped; NEC's default 1 lambda is the accuracy choice | would change default numerics; out of scope | S | input change |
| fp32 fill with fp64 LU | all | at most the memory bandwidth of the fill, which is compute bound; measured 1.0x | **rejected**: 4.8e-5 to 9.7e-5 relative error in the currents on the dumped matrices (rcond 1.7e-4 to 5e-5), above the 1e-5 budget | - | - |
| Cooperative progress and cancel in `cmset` | all | none in time; makes `prepare` cancellable at source-segment granularity | none | S | additive ABI: progress callback or polled flag |

### 6.2 Factorization

| Path | Applicability | Expected gain | Error bound and test | Effort | API |
|---|---|---|---|---|---|
| Blocked, cache-friendly LU with SIMD | all | Eigen is already blocked; the only missing piece is a `f64x2` micro-kernel. Prototype split-layout kernel: 5.2 vs 4.8 GFLOP/s against scalar Eigen (1.1x; 1.2x against Eigen built with `-msimd128`); a packed, register-blocked kernel with relaxed-SIMD FMA could approach the 2-lane ceiling, realistically 1.4-1.7x on the LU, 1.3-1.5x on `prepare` | identical algorithm; backward error `||A x - b|| / ||b|| <= 1e-13` on the dumped matrices; `matrix_algebra_tb` | L | none |
| Mixed precision: fp32 LU plus fp64 iterative refinement | all, with an `rcond` screen | WASM float LU is 1.10-1.22x faster than double at 1,408-2,816 unknowns (0.6-1.1x at 704; no SIMD in Eigen for either; natively it is 2.0-2.6x); refinement needs the fp64 residual `Z x` per RHS, 2 steps measured, which for P right-hand sides costs as much as the double solves. Net in WASM: 1.0x or slower in time; halves the matrix memory | converges to 3e-13 to 2e-12 on the real matrices (rcond >= 5e-5); risk: near-resonant arrays with rcond < 1e-5 would not converge, so screen on `rcond` and fall back to double | M | opt-in `precision` option |
| Parallel factorization across message-passing workers (no `SharedArrayBuffer`) | all | each worker needs the panel plus its trailing block; a 2D block-cyclic LU over 2-4 workers moves O(N^2) bytes per panel step, N/blocksize steps: 2,816 unknowns, 128-block, 22 steps x 127 MiB of partial transfers; structured clone or transferables cost about 1 GB/s, so the transfer time alone (3-6 s) is of the order of the LU itself. Not worth it without shared memory | n/a | L | none |
| Cross-origin isolation plus pthreads (`EIGEN_GEMM_THREADPOOL`) | requires COOP/COEP on GitHub Pages and the Cloudflare preview, a second (threaded) artifact and a non-threaded fallback | earlier synthetic probe: 14.1 s to 6.9 s at 4 threads (2.0x) on a 2,816 matrix; here with 2-4 cores available 1.6-2.5x on `prepare` | none numerically | L (deployment plus two artifacts) | packaging |
| Reuse across frequencies or steering | steering already reuses the factorization (35 ms per solve at 256); across frequencies there is no reuse: the kernel is frequency dependent | none beyond what exists | - | - | - |
| Drop the 1.5x `safe_array` reservation for `cm` | all | memory only: 190 to 127 MiB at 2,816 | none | S | none |

### 6.3 Port matrix extraction (`computeImpedanceMatrix`)

| Path | Expected gain (256 ports) | Error bound and test | Effort | API |
|---|---|---|---|---|
| Batched multi-RHS solve for Y: one `solveInPlace` on an N x P block (P x 16 N bytes = 11.5 MiB), skipping `netwk`, `etmns`, the per-solve `stringstream` report and the permutation rebuild | solves 4.1 s to about 1.6 s natively (2.5x), WASM 11 s to about 6 s; plus the 1.7 s of report formatting | identical factors, blocked triangular solve: `max |Y_new - Y_old| / max |Y| <= 1e-13`; `necpp_wp2` reciprocity and Y-predicts-solve tests; symmetry equivalence 1e-8 | S-M | none |
| LU inverse with `rcond` instead of Jacobi SVD for Z = Y^-1 | 2.3 s to 25 ms natively; 3.9 s to <0.1 s in WASM | `max |Z_lu - Z_svd| / max |Z| <= 1e-12` (measured 7e-14); condition estimate semantics change from `sigma_max / sigma_min` to `1 / rcond` (1-norm), both reported; keep SVD as a fallback when `rcond` is below the limit | S | `conditionEstimate` meaning documented; same field |
| Retain the basis in a contiguous P x N block instead of P x 6 planes | enables the batched field evaluation below; no time change by itself | none | S | none |

### 6.4 Embedded far fields

| Path | Applicability | Expected gain | Error bound and test | Effort | API |
|---|---|---|---|---|---|
| Per-port cost today | - | S x N x images per port; 256 ports x 19x72: ~130 s WASM | - | - | - |
| Batched multi-RHS evaluation: evaluate the P port bases as one pass over (segment, direction) with the P-wide coefficient block, so the trig per (segment, direction) is shared across ports | all | the trig is 56 % of the kernel and becomes 1/P of it; the remaining complex MACs are P x the current cost but SIMD-able: about 2x at 64 ports, limited by the MAC bandwidth; memory P x S x 32 B | identical arithmetic per port; `max dE / peak <= 1e-12` against the per-port loop; `necpp_wp3` embedded superposition | M | none |
| Use the retained basis for unit current on any grid (`Z[:, p]` combination of the retained unit-voltage modes) | when the basis fits | removes the P solves (8 s at 256 ports in WASM) | linear combination of the same modes: `<= 1e-12` versus the solve path (the wp3 "retained basis matches direct fields" test) | S | none |
| Raise or size the 64 MiB basis cap to the matrix size | 256-dipole case | 1x1 steering responses from 8 s to ~40 ms; grid embedded fields lose the P solves | none | S | none, or an option |
| Ring evaluator for embedded fields | periodic phi grids, free space or PEC, already supported (`computeEmbeddedFarFieldsRing`) | 3-6x of the field part, as for ordinary fields; the app's 1x1 requests cannot use it | 1e-7 of peak gate (measured 5.4e-10) | - | exists |
| NUFFT or FFT over phi rows | periodic grids; the ring evaluator already does the band-limited DFT per theta ring with an O(M^2) DFT and O(M x phiCount) synthesis; an FFT would cut the O(M^2) term, which is 10-30 % of ring time at M ~ 400 | 1.1-1.3x on ring fields, nothing on the per-segment sampling | same truncation bound; FFT roundoff 1e-15 | M | none |
| f32 result planes | all | halves transfer and copy bytes (4 x 1.1 MB per 187x742 field, about 20 ms end to end today); enables the app's `from_nec_peak` f32 ingestion without a JS-side downcast | relative rounding 6e-8 per component, below the app's 1e-5 precision budget; measured path keeps f64 accumulation and casts on output; `max |E_f32 - E_f64| / peak <= 1.2e-7` oracle | S | additive: `resultPrecision: "f32" \| "f64"` on field requests, Float32Array planes |

### 6.5 Far field (`computeFarField`)

| Path | Expected gain | Error bound and test | Effort | API |
|---|---|---|---|---|
| Reduce the phase argument before `sin`/`cos` (or use `sincos` with the segment phase accumulated per phi via rotation) | removes `__rem_pio2` (9 %) and halves the trig calls: 1.2-1.4x on exact fields | 1 ulp; serial-vs-pool checksum 1e-10; `necpp_wp3` | S | none |
| `f64x2` kernel with a vectorised `sincos` across two directions or two segments | up to 2x on the exact kernel; needs the polynomial `sincos` from 6.1 | 1e-15 of peak | M | none |
| Ring evaluator as the default for periodic grids | 3-6x measured; already opt-in and gated by an analytic bound | 1e-7 of peak gate | S (policy) | default change: excluded from this task, recommended for the app's policy |

### 6.6 Workers

| Item | Finding | Recommendation |
|---|---|---|
| `fieldWorkers: "auto"` | 4 workers at >= 8 cores, 2 at >= 4, else 1, capped by `ceil(samples/512)`, serial below 250,000 contributions. In Node on the 4-core host 2 workers gave 2.0-2.5x on exact fields over serial (Section 4.5); in headless Chromium the same 2 workers were slower than serial and 4 workers were needed to win (Section 5.5) | make the policy adaptive: measure the serial and pooled per-contribution rates on the first two fields and keep whichever is faster; above 8 cores consider `hardwareConcurrency - 1`, since the outer worker is idle during pooled fields |
| Startup amortisation | pool warm-up 40-70 ms once per solver; outer worker 25-80 ms | fine; a shared compiled `WebAssembly.Module` across solvers would save the compile on each `NecSession` |
| Transferables vs structured clone | results are transferred; inputs are cloned twice (`scatter` + `cloneComplexVector`); `getCurrentDistribution` clones N objects | pack the current distribution into typed arrays; drop the redundant `gather`/`rephase` copies for identity plans |
| Cancellation granularity | tiles of 512 samples for pooled exact fields and one theta ring for ring fields; nothing else is interruptible | WP-C below: cooperative flag polled per source segment in `cmset`, per port in the Y and embedded loops, per theta row in serial fields; the LU stays atomic (5-6 s at 256 in WASM) unless the factorization is reimplemented in blocks that poll |
| Progress | none from the engine for `prepare`, Z, embedded | same flag mechanism reports fraction done; the app shows coarse stages today |

### 6.7 Ranked list

| Rank | Path | Gain at 256 dipoles (scalar WASM) | Risk | Effort | API change |
|---:|---|---|---|---|---|
| 1 | Z extraction: blocked multi-RHS Y, LU inverse, no per-solve report (6.3) | `computeImpedanceMatrix` 11.2 s to 4-6 s | low; 1e-12 oracles | S-M | none (condition estimate semantics) |
| 2 | Retained basis cap and unit-current from the basis (6.4) | 1x1 steering responses 8.6 s to ~25 ms at 256 ports; embedded grids lose 8.5 s | low | S | none |
| 3 | Cooperative cancel and progress for fill, port loops and serial fields (6.6) | none in time; long jobs stop in < 100 ms instead of losing state | low | S-M | additive progress/cancel |
| 4 | Fill hoists, no transpose, far-pair `sincos` batching (6.1) | `prepare` 18.4 s to about 17 s; 64-128 dipoles: 10-25 % of `prepare` | low | S-M | none |
| 5 | Far-field phase reduction and batched embedded evaluation (6.4, 6.5) | exact fields 1.3x; embedded grids ~2x | low | M | none |
| 6 | f32 result planes (6.4) | copies/transfer only; unblocks the app's f32 ingestion | low | S | additive option |
| 7 | `f64x2` LU micro-kernel (6.2) | `prepare` 1.3-1.5x | medium (own kernel) | L | none |
| 8 | Cross-origin isolation plus pthreads (6.2) | `prepare` 1.6-2.5x on 4 cores | deployment risk, two artifacts | L | packaging |
| 9 | Mixed-precision LU (6.2) | memory only in WASM | conditioning | M | opt-in |
| - | fp32 fill, message-passing parallel LU, translation reuse, distance-tiered quadrature | rejected or excluded, see 6.1/6.2 | | | |

## 7. Correctness gates

Existing tests that pin each proposed change:

| Change | Native (CTest) | Package (`npm test`) |
|---|---|---|
| Fill hoists, transpose removal, far-pair batching | `necpp_unit` (Example 1, voltage and plane-wave excitation in `nec_context_tb.cpp`), `necpp_wp2` (one-port Z vs legacy deck), `necpp_wp_s2/s3` (symmetric vs explicit Z), `testharness/` 52 decks vs nec2c | `symmetry-equivalence` (Z, Y, currents, fields at 1e-8), `array-solver.integration`, `current-quadrature-validation` (golden dipole Z = 83.8476 + j47.771 at 1e-15 absolute) |
| Blocked Y solves, LU inverse | `matrix_algebra_tb` (LU, `factrs`/`solves`), `necpp_wp2` (Y/Z reciprocal inverses, Y predicts simultaneous solves, current drive = ZI in one solve, power budgets), `necpp_wp1` 1,000-solve stress | `worker-integration` (direct vs worker Z, Y at 1e-12), `facade-runtime` power at 1e-12, pack consumer test (Z at 1e-9) |
| Retained basis changes, embedded paths | `necpp_wp3` (embedded fields superpose to the direct field, retained basis matches direct fields, both normalizations, ground cases, snapshots) | `ring-field` (embedded ring vs exact 1e-7, superposition), `current-quadrature-validation` (NECF vs `computeEmbeddedFarFields` 1e-7) |
| Far-field kernel changes | `necpp_wp3` far-field order and phase, power matches field flux; `nec_ring_field_tb` | `field-worker-production` (serial vs pool 1e-10), `far-field-worker-poc` (1e-10), `ring-field` |
| f32 planes | none today | none today |
| Cancellation and progress | none today | `array-solver.integration` cancel/terminate lifecycle, `field-worker-production` cancellation |

New oracle tests needed:

1. **Matrix oracle**: dump the explicit interaction matrix before
   factorization (as the audit probe does) for the 4x4 symmetry fixture and
   a 64-dipole sunflower, and assert `max |Z_new - Z_ref| / max |Z_ref| <=
   1e-12` for any fill change, 1e-14 for pure hoists.
2. **Port-network oracle**: `max |Y_new - Y_ref| / max |Y_ref| <= 1e-12`,
   `max |Z_new - Z_ref| / max |Z_ref| <= 1e-12`, `|| Y Z - I ||_max <=
   1e-10`, and passivity of the symmetric part of Z (all eigenvalues of
   `Re(Z)` >= -1e-9 x max) on the 64- and 256-dipole sunflowers over perfect
   ground and in free space.
3. **Current oracle**: `max |I_new - I_ref| / max |I_ref| <= 1e-10` for the
   three steering states (this is where fp32 fill failed at 1e-4).
4. **Field oracle**: `max(|dE_theta|, |dE_phi|) / max_grid sqrt(|E_theta|^2
   + |E_phi|^2) <= 1e-12` for kernel refactors, 1e-7 for approximations
   (the existing ring gate), 1.2e-7 for f32 planes; plus radiated-power
   closure to 1e-9 relative.
5. **Cancellation oracle**: a cancelled `prepare` returns within 100 ms
   with the model back in `geometry-complete` state, and a subsequent
   `prepare` produces the reference Z.
6. **Conditioning oracle**: the LU inverse path must report
   `conditionEstimate` within 10x of the SVD value on the fixtures and fall
   back to SVD (or fail with `NEC_CONDITIONING`) when `rcond` is below the
   limit.
7. **Memory oracle**: assert the WASM heap after `prepare` at 2,816 unknowns
   stays under 200 MiB once the 1.5x reservation is removed (today 342
   MiB), using the probe or `emscripten_get_heap_size` through a diagnostic
   export.

## 8. Recommended work packages

### WP-A: Port-matrix extraction without per-solve overhead

Part of the Full NEC engine audit.

**Summary.** `computeImpedanceMatrix` spends 43 % of the 256-dipole WASM
profile in single-vector triangular solves, 8 % in a Jacobi SVD inverse and
6 % formatting a text report nobody reads. Replace the P sequential
`execute_voltage_solve` calls by one blocked multi-RHS triangular solve on
the retained factors, invert Y with a partial-pivot LU plus `rcond`, and skip
the network/report bookkeeping for internal basis solves.

**Where.**
- `src/nec_stateful_model.cpp:738-799` `compute_admittance_matrix` (the loop
  over `column`, `execute_voltage_solve`, the retained basis copies).
- `src/nec_context.cpp:1759-1875` `excitation_process_inner`, `:5029-5039`
  `netwk_compute_currents`, `:5223-5225` `netwk_compute_inputs` (the
  `stringstream`).
- `src/matrix_algebra.cpp:271-295` `solve` (permutation rebuilt per call),
  `:339-491` `solves` (callers always pass `nrh = 1`).
- `src/nec_port_matrix.cpp` `nec_invert_port_matrix` (JacobiSVD, full U/V).
- `src/nec_stateful_model.h:368-371, 423` retained basis layout.

**Proposal.**
1. Add `nec_context::stateful_solve_unit_voltage_block(ports)` that builds
   the N x P excitation block (one unit at each port's segment), applies the
   stored permutation once and runs `triangularView<UnitLower>` and
   `<Upper>` `solveInPlace` on the block (Eigen's blocked `triangular_solve_matrix`).
   Extract `achieved_currents` per column from the port segments; keep
   `get_current_coefficients` per column for the retained basis, writing
   into a contiguous P x 6 x N block.
2. Keep `execute_voltage_solve` for consumer solves (the report and power
   budget are part of its contract) but add a flag that skips
   `netwk_compute_inputs` formatting and `print_power_budget` for internal
   basis solves.
3. In `nec_invert_port_matrix`, factor Y with `PartialPivLU`, take `rcond()`
   and `inverse()`; report `conditionEstimate = 1 / rcond`; when `rcond <
   1 / maximum_condition_estimate` fall back to the existing SVD path so the
   `NEC_CONDITIONING` behaviour is unchanged.
4. Cache the permutation as an `Eigen::PermutationMatrix` next to `ip` so
   single solves stop allocating.

**Expected gain.** Native: Y from 4.1 s to about 1.6 s and the inverse from
2.3 s to 25 ms at 256 ports. WASM: `computeImpedanceMatrix` from 11.2 s to
4-6 s (8.4 s of solves at the measured 1.4-2.5x blocked gain, the 4.2 s SVD
to under 0.1 s, the 1.7 s of report formatting removed). Steering solves also
drop the report cost (32 ms to ~25 ms).

**Acceptance.**
- Port-network oracle (Section 7, item 2) on the 4x4 fixture, 64-dipole
  sunflower and 256-dipole sunflower, PEC and free space: 1e-12 on Y and Z,
  `|| Y Z - I ||_max <= 1e-10`, passivity.
- `conditionEstimate` within 10x of the SVD value on every fixture;
  conditioning failure still raised for a singular Y.
- All CTest groups and `npm test` green; `symmetry-equivalence` at 1e-8
  unchanged.
- `bench/full-nec-audit.mjs` `dipole-sunflower-256-perfect`:
  `impedance.wallMs` <= 0.45x the baseline in this document on the same host.

**Tests.** New `src/nec_stateful_model_wp_audit_tb.cpp` with the oracle;
extend `test/array-solver.integration.test.mjs` with a 64-dipole Z/Y check
against the committed baseline checksum; keep `necpp_wp2` as the legacy
anchor.

### WP-B: Retained basis for every port count and unit-current from the basis

Part of the Full NEC engine audit.

**Summary.** The retained voltage-field basis makes the app's 1x1 steering
responses and grid embedded fields free of solves, but its 64 MiB cap drops
it at 249+ ports with 11-segment elements, which is exactly the 256-element
limit, and the unit-current path only uses it for 1x1 non-ring grids.

**Where.**
- `src/nec_stateful_model.cpp:232-256` `can_retain_voltage_field_basis`
  (64 MiB budget, 2/3 factor, 1.5x reservation accounting).
- `:1216-1225` the unit-current gate (`!grid.ring && samples_per_port == 1`).
- `:1299-1357` `compute_embedded_from_retained_basis` (the P x P x S triple
  loop forming `L Z`).
- `:1359-1444` `run_unit_current_basis_loop`.
- `src/safe_array.h:112-113` the 1.5x reservation.

**Proposal.**
1. Size the budget relative to the interaction matrix: retain when
   `64 N P <= 0.5 x 16 N^2`, i.e. `P <= N / 8`, which holds for every
   element type in the app (11-segment dipoles give N/11, crossed N/11,
   helices N/51), with an absolute ceiling of 256 MiB; store the basis as
   one contiguous `6 x P x N` block without the 1.5x reservation.
2. Use the retained basis for unit current on any grid: evaluate the P
   unit-voltage mode fields once (as the unit-voltage path does) and form
   the unit-current fields as `E_uc = E_uv Z` per sample (P x P per sample,
   already implemented for 1x1 in `:1345-1354`); add the ring variant.
3. Report through `getDiagnostics()` whether the basis is retained and its
   bytes.

**Expected gain.** 256 dipoles: embedded 1x1 unit-current from 8.6 s to the
retained-path cost (23 ms measured at 128 ports where the basis fits); grid
embedded fields lose the 256 solves (8.5 s) and the restore solve. No
change below 249 ports except unit-current grids, which lose P solves.

**Acceptance.**
- `necpp_wp3` "retained basis matches direct fields" extended to 256 ports
  and to unit current on 19x72 and ring grids at 1e-12 of peak.
- `bench/full-nec-audit.mjs` `dipole-sunflower-256-perfect`: embedded 1x1
  unit-current `wallMs` < 200 ms.
- Heap after `computeImpedanceMatrix` at 2,816 unknowns and 256 ports
  increases by at most 44 MiB over `prepare`.

**Tests.** Extend `src/nec_stateful_model_wp3_tb.cpp`; add a 256-port
embedded 1x1 case to `test/large-system.test.mjs` with the solve-path result
as the oracle.

### WP-C: Cooperative progress and cancellation for `prepare` and the port loops, plus the fill hoists

Part of the Full NEC engine audit.

**Summary.** A 256-dipole `prepare` is 19 s of one synchronous WASM call;
`computeImpedanceMatrix` 11 s; a 19x72 embedded basis 130 s. The app can only
`terminate()` the worker, losing everything. Add a polled cancel/progress
flag at the natural loop boundaries, and take the cheap fill improvements in
the same pass over `cmset`/`cmww`.

**Where.**
- `src/nec_context.cpp:2214-2340` `cmset` (outer loop over source
  segments), `:2651-2791` `cmww`, `:2914-2974` `efld_compute` (the per-pair
  `sin(pi * m_s)`), `:3188-3237` `eksc` (`sin/cos(shk)`), `src/math_util.h:72-73`
  (`pi()` statics).
- `src/matrix_algebra.cpp:229-238` the un-transpose before Eigen.
- `src/nec_stateful_model.cpp:738-799, 1244-1296, 1359-1444` the port loops.
- `src/necpp_wasm_v1.cpp` `invoke()` wrapper (`:343-378`) for the new
  status code; `packages/necpp-wasm/src/worker-entry.ts:95-98` where
  `cancel-field` is handled out of band.

**Proposal.**
1. Add to the ABI (additive, v1-compatible): `necpp_wasm_v1_set_cancel_flag(model, const int32_t* address)`
   and `necpp_wasm_v1_progress(model)` returning a fraction. The engine polls
   the flag once per source segment in `cmset` (N polls), once per port in
   the Y, unit-voltage and unit-current loops, and once per theta row in
   `calculate_far_field`. On cancel it throws a dedicated
   `nec_cancelled_exception` mapped to a new status `NECPP_WASM_V1_CANCELLED`
   and leaves the model in `geometry-complete` (prepare) or `prepared`
   (loops) state with no partial results exposed.
2. Without `SharedArrayBuffer` the flag cannot be set from the main thread
   while the worker is inside a synchronous call. Therefore split the long
   calls into resumable chunks driven from the worker's event loop:
   `prepare` becomes "fill rows [a, b)" steps of about 50 ms plus one
   atomic `factrs`; the port loops become "ports [a, b)" steps. The worker
   runtime (`worker-runtime.ts`) sequences the steps and checks the pending
   cancel message between them. The LU remains atomic.
3. In the same pass: hoist `sin(pi * m_s)` and `sin/cos(shk)` into the
   per-source setup in `cmww`, replace `pi()`/`two_pi()` calls in the hot
   loops by `constexpr` constants (keeping the legacy value), and write
   `cm` in Eigen's layout so `lu_decompose` drops the O(N^2) transpose.
4. Expose per-stage timings (fill, factor, Y, inverse) and the heap size in
   `getDiagnostics()` so the next audit does not need a probe build.

**Expected gain.** Cancellation latency for `prepare` from 18 s (never) to
the LU duration (16 s at 256 dipoles in WASM, so chunking the factorization
itself remains the long-term answer) and under 100 ms for everything else; progress for the app's "preparing"/"matrix" stages. Fill: 10-20 %
(3-6 % of `prepare` at 256, more at 64-128 dipoles). No numerical change
beyond 1 ulp from the hoists.

**Acceptance.**
- Cancellation oracle (Section 7, item 5) on 128 dipoles for `prepare`,
  `computeImpedanceMatrix` and an embedded 19x72 basis: returns within
  100 ms after the LU (prepare) or immediately (loops), state restored, the
  next call produces the reference result.
- Matrix oracle at 1e-14 for the hoists on the 4x4 fixture and the
  64-dipole sunflower.
- `bench/full-nec-audit.mjs` `dipole-sunflower-64-perfect` `prepare.wallMs`
  <= 0.85x baseline; `dipole-sunflower-256-perfect` <= 0.95x.
- `npm test` with a new `test/array-solver.cancellation.test.mjs`
  (prepare cancelled mid-fill, state and factorization generation checked),
  `test:field-worker-browser` unchanged.

**Tests.** New Catch2 cases in `src/nec_stateful_model_wp_audit_tb.cpp`
driving the flag from a second thread natively; package tests through the
worker client.

## 9. Open items and limits of this audit

- The host has 4 logical CPUs; the pool measurements use 2 workers. The
  visualizer's previous evidence used 4 workers on 16 threads.
- Finite ground (Sommerfeld) was not measured; the app uses perfect ground
  for every element type. The Sommerfeld path is more expensive per pair
  (`rom2`/`sflds` interpolation) and disables the ring evaluator and the
  worker pool.
- The `f64x2` GEMM prototype is a naive 4x4 register block without packing;
  it bounds the easy gain, not the ceiling.
- The cross-origin-isolation option was costed from the existing synthetic
  thread probe, not re-measured here, since the app is not isolated today.
- The headless-Chromium evaluator-worker slowdown (Section 5.5) is
  unexplained. It was reproduced three times, is independent of V8 tiering
  flags, scales with the worker count, and does not affect the engine module
  in the outer worker. Reproduce on a real Chrome and Firefox session with
  `bench/full-nec-audit-browser.mjs --field-workers 1|2|4` before changing
  the pool policy; if it holds, the evaluator worker (not the kernel) is the
  thing to profile with the browser's own profiler.
