# WASM large-array failure: findings and remediation plan

## Status

**Open investigation.** On 2026-08-28, benchmarking the public direct-mode
TypeScript API exposed deterministic WebAssembly traps for array models larger
than the fixtures currently covered by CI. The requested 2 x 2 through 8 x 8
benchmark cannot yet be completed honestly against the release artifact.

This document records the evidence gathered so far and divides the work needed
to identify, fix, validate, and prevent a recurrence of the failure. Observed
facts are separated from hypotheses throughout.

## Impact

The `@necpp-engine/wasm` 0.1.0 artifact can prepare and solve small arrays, but
larger, otherwise valid wire models can terminate with a raw WebAssembly
`RuntimeError: memory access out of bounds`. Depending on the equation count,
the trap occurs either while factoring the interaction matrix in `prepare()` or
while applying the retained factorization in `solveVoltages()`.

This is more severe than a normal solver failure:

- it prevents the requested 4 x 4 through 8 x 8 workloads;
- it escapes the stable C ABI error taxonomy as a WASM runtime trap;
- it affects direct mode and is expected to terminate a worker in worker mode;
- it makes the current package's documented memory-growth support insufficient
  for practically sized array models; and
- existing release tests do not exercise enough equations to catch it.

The native engine has previously completed an 8 x 8, 1,216-segment dipole
benchmark, so the current evidence points to a WASM-specific limit or a code
path whose failure is exposed more reliably by WASM bounds checking. That is a
useful lead, not proof of the root cause.

## Reproduction model

Unless a workpackage explicitly varies one parameter, use this model:

- frequency: 300 MHz;
- free space;
- wavelength: `299792458 / 300e6 = 0.9993081933333333 m`;
- square planar array in X/Y, centred at the origin;
- Z-directed dipoles;
- total dipole tip-to-tip length: lambda/4, or
  `0.24982704833333333 m`;
- centre-to-centre spacing in X and Y: lambda/2, or
  `0.49965409666666666 m`;
- wire radius: lambda/1000, or `0.0009993081933333333 m`;
- an odd, uniform segment count per dipole;
- centre-segment ports; and
- simultaneous voltage excitation of `1 + j0 V` at every port.

The original performance comparison in [the changelog](../CHANGELOG.md) used
19 segments per dipole, giving 1,216 equations for an 8 x 8 wire array. The
TypeScript examples and most package fixtures use 11 segments per dipole. Both
discretizations are useful here:

- 11 segments keeps the regression gate less expensive and matches the public
  package examples;
- 19 segments reproduces the established large native workload and should be
  the final performance benchmark.

"Lambda/4 dipole" means total tip-to-tip length lambda/4 in this plan. If a
future benchmark intends lambda/4 arms, and therefore a lambda/2 total dipole,
it must say so explicitly and record that as a separate fixture.

## Environment of the initial observation

| Component | Value |
|---|---|
| Repository commit | `a44b5ba` (`wasm-v0.1.0`) |
| npm package version | `0.1.0` |
| embedded engine version | `2.3.4` |
| Node.js | `v24.14.1` |
| Operating system | Windows x64, build `10.0.26200` |
| CPU | AMD Ryzen 7 PRO 7840HS, 16 logical CPUs |
| Physical memory | 30.7 GiB |
| API | direct `createNecModel()` facade |
| Drive | all defined ports at `1 + j0 V` unless noted |

The engine version is expected to remain `2.3.4` in package 0.1.0; it does not
by itself prove that the committed WASM binary is stale.

## Findings to date

### Successful timing samples

The table below used 11 segments per dipole, five fresh models per size, and
100 retained-factorization solves per fresh model. Values are medians. "Ready
to first solution" includes geometry construction, `prepare()`, and the first
`solveVoltages()` call, but excludes WASM module instantiation, which was about
5 ms.

| Array | Dipoles | Equations | `prepare()` | First solve | Ready to first solution | Retained-factor solve |
|---|---:|---:|---:|---:|---:|---:|
| 2 x 2 | 4 | 44 | 6.27 ms | 6.16 ms | 14.08 ms | 0.103 ms |
| 3 x 3 | 9 | 99 | 11.51 ms | 7.35 ms | 20.61 ms | 0.198 ms |

The retained-factor solve distributions were:

| Array | p10 | Median | p90 |
|---|---:|---:|---:|
| 2 x 2 | 0.081 ms | 0.103 ms | 0.315 ms |
| 3 x 3 | 0.163 ms | 0.198 ms | 0.385 ms |

A 2 x 2 array with 19 segments per dipole also completed five rounds. It had
76 equations, a median `prepare()` time of 11.90 ms, a first-solve time of
8.26 ms, and a retained-solve median of 0.171 ms.

These are diagnostic measurements, not final publishable performance numbers:
the run was interrupted by the larger-model defect, machine power state was
not controlled, and no fixed benchmark harness or raw-result artifact has yet
been committed.

### Failure matrix

Each failing size below was launched in a separate Node process so one trap did
not prevent later sizes from being checked.

| Array | Segments per dipole | Equations | Ports | Result |
|---|---:|---:|---:|---|
| 3 x 3 | 15 | 135 | 1 | Prepare and solve succeeded |
| 4 x 4 | 9 | 144 | 1 | Prepare and solve succeeded |
| 3 x 3 | 17 | 153 | 1 | Prepare succeeded; `solveVoltages()` trapped |
| 3 x 3 | 19 | 171 | 1 | `prepare()` trapped |
| 4 x 4 | 11 | 176 | 16 | `prepare()` trapped |
| 5 x 5 | 11 | 275 | 25 | `prepare()` trapped |
| 6 x 6 | 11 | 396 | 36 | `prepare()` trapped |
| 7 x 7 | 11 | 539 | 49 | `prepare()` trapped |
| 8 x 8 | 11 | 704 | 64 | `prepare()` trapped |

Additional controls:

- 3 x 3 with 19 segments also trapped with only one port, ruling out port
  count as a necessary cause;
- 2 x 2 with 33 segments, or 132 equations, prepared and solved; and
- 4 x 4 with 7 and 9 segments, or 112 and 144 equations, prepared and solved.

The last known success is therefore 144 equations. At 153 equations the
factorization can complete but the solve traps; by 171 equations the
factorization itself traps. This is not evidence of a contractual 144-equation
limit. It indicates a resource or memory-safety boundary whose exact location
can depend on call depth, temporary allocations, optimization, and matrix
shape.

### Failure shape

The TypeScript facade reports:

```text
NecRuntimeError: prepare failed at the WASM boundary
  code: NEC_RUNTIME
  cause: RuntimeError: memory access out of bounds
```

For the 153-equation diagnostic, the same raw trap occurred in
`solveVoltages()`. The generated release WASM does not contain enough symbolic
debug information to map the numeric WASM frames to reliable C++ source lines.
The facade is correctly describing a boundary failure, but the C ABI cannot
translate a hardware-style WASM trap into `NEC_SOLVER` after the trap has
already occurred.

## Relevant implementation changes and gaps

The interaction matrix is allocated and the frequency preparation begins in
[`nec_context::stateful_prepare_frequency()`](../src/nec_context.cpp). Matrix
factorization and retained-factor solves use
[`lu_decompose()` and `solve()`](../src/matrix_algebra.cpp).

The current optimized algebra path:

- factors an `Eigen::Map` with `Eigen::PartialPivLU<MapType>` so the factors
  remain in NEC-owned storage;
- rebuilds the permutation for every retained solve;
- applies `rhs = P * rhs`; and
- runs Eigen's blocked `UnitLower` and `Upper` `solveInPlace()` kernels.

Commit `97cd005` introduced the in-place factorization and blocked triangular
solve path as part of a native performance change. It also removed heap churn
from several field-evaluation routines. That commit is a natural bisection
point, but it must not be declared causal until a controlled comparison says
so.

Both [`src/CMakeLists.txt`](../src/CMakeLists.txt) and
[`scripts/build_wasm_inner.sh`](../scripts/build_wasm_inner.sh) enable
`ALLOW_MEMORY_GROWTH`. Neither sets an explicit Emscripten stack size. Heap
growth does not imply that the fixed WASM stack can grow. Existing smoke,
facade, clean-package, worker, and browser tests use one or four small dipoles
and therefore do not approach the observed boundary.

## Ranked hypotheses

### H1: Emscripten stack exhaustion

This is the leading build-configuration hypothesis.

Evidence in favour:

- success changes to a trap over a narrow equation-count range;
- the trap can move from solve to prepare as the model grows;
- the release build does not set `STACK_SIZE` explicitly;
- `ALLOW_MEMORY_GROWTH` only addresses heap growth; and
- Eigen's blocked factorization and triangular solvers may create
  size-dependent or block-sized temporaries and deeper call stacks.

Evidence still needed:

- a build with `STACK_OVERFLOW_CHECK` must identify a stack failure, or
- increasing only `STACK_SIZE` must move or remove the boundary without
  changing numerical code.

### H2: Eigen in-place factorization over a strided `Map`

The `PartialPivLU<MapType>` path is newer and materially different from the
previous allocate-factor-copy-back implementation. A defect could be in the
way the mapped, outer-strided matrix interacts with Eigen's blocked LU kernels,
especially in WASM release builds or at tail block sizes.

Evidence needed:

- current in-place LU fails with ample confirmed stack headroom; and
- the previous `PartialPivLU<MatrixXcd>` copy path succeeds with the same build
  flags and stack size.

### H3: Aliasing or a blocked-kernel defect in the retained solve

The assignment `rhs = P * rhs` aliases its input and output, after which
blocked triangular solvers update the same mapped vector. The 153-equation
case, where prepare succeeds and solve traps, makes the solve path independently
suspect.

Evidence needed:

- replace only the permutation assignment with an explicitly evaluated
  temporary and compare; then
- replace only the Eigen triangular solves with the previous scalar
  forward/back substitution and compare.

### H4: Matrix-fill or general heap corruption before LU

An earlier out-of-bounds write could corrupt state and only become visible in
LU or solve. The varied numeric WASM frames in larger cases prevent ruling
this out.

Evidence needed:

- AddressSanitizer or `SAFE_HEAP` identifies the first invalid access; or
- matrix fill followed by checksum/export succeeds, while factorization alone
  fails in an isolated algebra test.

### H5: memory growth invalidates a borrowed view

The TypeScript facade already recreates typed-array views after native calls,
and the failing matrices are relatively small, so this is lower probability.
It remains worth testing because the package explicitly supports growing WASM
memory and a growth event invalidates JavaScript views.

Evidence needed:

- log memory pages before and after geometry, matrix allocation, fill, LU, and
  solve; and
- force a growth event before preparation and repeat the same model.

## Workpackages

### WP0 - Commit a deterministic reproduction and benchmark harness

Create a Node harness under `packages/necpp-wasm/bench/` or `scripts/` that
uses the built package artifact rather than importing unbuilt TypeScript.

Required capabilities:

1. Generate centred square arrays from side length, segments per dipole,
   frequency, element length, spacing, radius, and port mode.
2. Select one port or all centre-segment ports without changing geometry.
3. Time module instantiation, geometry construction, `prepare()`, first solve,
   retained solves, impedance-matrix formation, and disposal separately.
4. Emit newline-delimited JSON during the run plus one final JSON summary, so
   completed cases survive a later process failure.
5. Record package, engine, ABI, Node, OS, CPU, logical CPU count, memory, git
   commit, build type, Emscripten version, and relevant linker settings.
6. Validate lifecycle generations and at least one finite current rather than
   treating a returned object as success.
7. Support one-size-per-process execution so an expected trap can be mapped
   without losing the complete sweep.
8. Use command-line arguments or namespaced environment variables; do not
   hard-code diagnostic variants.

Deliverables:

- reproducible harness;
- checked-in expected-failure test for an affected size until the fix lands;
- raw JSON from the release artifact; and
- a short README showing exact invocation commands.

Exit criteria:

- another developer can reproduce the 144-success/153-or-larger-failure
  transition on the release artifact; and
- running the same harness against a fixed artifact requires no source edits.

### WP1 - Map the boundary across backends and build modes

Run a controlled matrix that changes one variable at a time.

Backends:

- native Release;
- native Debug with `NEC_ERROR_CHECK`;
- WASM Release in Node direct mode;
- WASM Release in a Node worker;
- WASM Release in Chromium direct mode;
- WASM Release in a Chromium module worker; and
- instrumented WASM from WP2.

Model variants:

- one long wire with 128 through 192 odd segment counts;
- multiple disconnected wires with the same total equation counts;
- the square dipole arrays above;
- one port versus all ports;
- total equations around 128, 135, 144, 145, 152, 153, 160, 171, 176,
  256, 512, 704, and 1,216; and
- equation counts immediately below, at, and above Eigen block/tail
  boundaries discovered from instrumentation.

The one-wire fixture distinguishes total matrix dimension from array geometry,
junction, and tag effects. Matching equation counts across different wire
partitions distinguishes dimension-dependent failures from geometry-fill
failures.

Deliverables:

- a backend/build/result table with the first failing operation;
- native and WASM numerical checksums immediately before factorization where
  instrumentation permits; and
- a minimal failing model with the fewest equations.

Exit criteria:

- the failure is classified as WASM-only or shared with native code; and
- the smallest reproducer and first failing phase are known.

### WP2 - Produce diagnostic WASM builds

Keep diagnostic flags out of the release artifact. Add a documented build mode
that can independently enable:

- Emscripten assertions;
- maximum stack-overflow checking supported by the pinned Emscripten 4.0.7;
- safe-heap checking;
- source-level debug names or maps sufficient to symbolize a trap;
- AddressSanitizer, if compatible with this exception-enabled build; and
- explicit stack sizes such as 64 KiB, 128 KiB, 256 KiB, 1 MiB, and 4 MiB.

Where available, expose temporary diagnostics from
`emscripten/stack.h`—stack base, end, current pointer, and free space—around:

1. entry to `stateful_prepare_frequency()`;
2. completion of matrix allocation;
3. completion of matrix fill;
4. entry and exit of `lu_decompose()`;
5. entry and exit of `solve()`; and
6. return through the C ABI.

Also record WASM heap pages at the same points. Instrumentation must use a
compile-time diagnostic flag and must not alter the stable v1 ABI or release
output.

Deliverables:

- symbolized first-failure stack;
- stack high-water and heap-page measurements by equation count;
- sanitizer or safe-heap report, if any; and
- confirmation of which diagnostic flags are supported by the pinned SDK.

Exit criteria:

- H1 is confirmed or rejected directly; and
- any memory write preceding the visible LU/solve trap is identified.

### WP3 - Isolate the algebra change

Build a small factorial experiment. Use identical generated matrices and
RHS vectors when possible rather than relying only on full NEC models.

Factorization variants:

1. current `PartialPivLU<MapType>` in-place path;
2. previous `PartialPivLU<MatrixXcd>` allocate-and-copy-back path; and
3. retained Gauss-Doolittle reference `lu_decompose_ge()` for diagnosis.

Solve variants:

1. current aliased permutation plus blocked triangular `solveInPlace()`;
2. explicitly evaluated permutation temporary plus blocked triangular solves;
3. current permutation plus scalar forward/back substitution; and
4. the complete previous solve implementation.

Build variants:

- default versus enlarged confirmed-safe stack;
- `-O0`, `-O2`, and `-O3`;
- LTO on and off; and
- any relevant Eigen vectorization configuration used by WASM.

For every successful cell, compare:

- pivot indices;
- LU factors within an appropriate floating-point tolerance;
- residual norm `||Ax-b|| / (||A|| ||x|| + ||b||)`;
- NEC port currents and voltages; and
- time and peak memory.

Deliverables:

- the smallest code/build delta that changes failure to success;
- a root-cause statement supported by instrumentation; and
- performance and memory costs for viable fixes.

Exit criteria:

- one hypothesis explains both the prepare trap and the solve trap, or they
  are explicitly identified as two separate defects.

### WP4 - Implement the minimal robust fix

Choose the fix from WP2 and WP3 evidence.

If stack exhaustion is the sole cause:

- set an explicit release stack size in one canonical CMake location;
- avoid specifying the same option independently in both CMake and the wrapper
  script;
- document how the chosen size was derived from the 1,216-equation workload;
- retain meaningful headroom for worker and browser runtimes; and
- add a build-time or test-time assertion that the intended stack setting is
  present.

If the in-place LU path is unsafe:

- use the safest Eigen-supported in-place representation proven by tests, or
  restore the allocate-factor-copy-back path for WASM;
- keep the native fast path only if backend-specific behaviour is explicit,
  maintainable, and numerically cross-checked; and
- prefer correctness over the approximately O(n^2) copy saving.

If solve aliasing or a triangular kernel is responsible:

- force explicit evaluation of the permutation before writing to `rhs`;
- use a proven scalar or Eigen solve variant for WASM if needed; and
- retain a focused unit test around the failing tail dimension.

If an earlier matrix-fill write is responsible, fix that write at its source
and do not mask it with a larger stack or heap.

Do not attempt to catch or translate the raw WASM trap as the primary fix.
Memory safety must be restored before control returns through the ABI.

Deliverables:

- production code/build change;
- root-cause comment where future maintainers need it;
- changelog entry describing affected package versions and model sizes; and
- no unrelated numerical or API changes.

Exit criteria:

- every WP1 reproducer completes without a trap; and
- the fix remains effective in optimized Node and Chromium release builds.

### WP5 - Add regression and numerical validation gates

Add layered tests so the issue is caught without making every PR unnecessarily
slow.

Fast PR gates:

- direct Node prepare and solve above the old boundary, preferably a 4 x 4
  array with 11 segments per dipole (176 equations);
- the same fixture through the stable C ABI smoke path;
- retained solve after successful preparation;
- one-port and all-port variants where runtime permits; and
- finite outputs plus lifecycle/factorization/solve generation checks.

WASM/package gates:

- direct and worker models from the exact packed tarball;
- one real Chromium direct solve and one module-worker solve above the old
  boundary; and
- a forced memory-growth case followed by preparation and solve.

Large scheduled or release gate:

- 8 x 8, 19 segments per dipole, 1,216 equations;
- direct and worker Node modes;
- at least one browser mode if CI memory and duration are acceptable; and
- repeated solves against one retained factorization.

Numerical oracles:

- compare native and WASM currents for identical geometry and excitation;
- compare the fixed implementation with the pre-optimization algebra path;
- verify normalized residuals independently of matching implementation
  outputs;
- retain the existing native regression harness; and
- use fixture-specific tolerances consistent with
  [the WASM numerical contract](wasm-api.md), tightening them when both paths
  execute the same binary64 algorithm.

Release checks must also retain the current WASM size guard. A larger stack
reservation should be evaluated for runtime memory impact even if it does not
materially increase the compressed binary.

Exit criteria:

- a deliberate reintroduction of the original defect fails at least one PR
  test; and
- native, direct WASM, worker WASM, and browser results agree within the
  accepted tolerance.

### WP6 - Run and publish the final scaling benchmark

After WP5 is green, rerun the original request with 19 segments per dipole.
The primary table covers 2 x 2 through 8 x 8 inclusive.

Measure separately:

1. WASM fetch/read, compile, and module instantiation;
2. geometry construction and port definition;
3. `prepare()` matrix fill plus LU factorization;
4. first `solveVoltages()` call;
5. retained-factor `solveVoltages()` latency;
6. `computeImpedanceMatrix()` latency, clearly identified as N internal basis
   solves plus matrix inversion rather than one excitation solve;
7. worker round-trip overhead for the same operations; and
8. peak WASM memory and stack headroom where observable.

Benchmark controls:

- Release WASM built by the pinned Emscripten SDK;
- exact git commit and artifact SHA-256;
- fixed 300 MHz geometry specified above;
- all ports driven at `1 + j0 V` for the solve comparison;
- at least five fresh-model rounds for preparation;
- enough retained solves to exceed one second of aggregate measured time per
  size, with a minimum of 100;
- warm-up excluded and documented;
- median, p10, and p90 rather than only a mean;
- CPU model, OS, Node/browser version, power mode, and competing-load notes;
- raw newline-delimited JSON committed or attached to the release; and
- no parallel execution of benchmark cases on the same machine.

Publish at least these derived values:

- milliseconds to first solution excluding and including module
  instantiation;
- retained solves per second;
- preparation scaling versus equation count;
- peak memory versus the expected dense O(n^2) matrix footprint; and
- regression against the native 1,216-segment baseline where the machines and
  build flags make that comparison meaningful.

Exit criteria:

- valid numbers exist for every size from 2 x 2 through 8 x 8;
- every reported run passes numerical validation; and
- the report identifies the exact fixed artifact, not an uncommitted local
  binary.

### WP7 - Release and user communication

If package 0.1.0 has been published, treat this as a package defect requiring a
patch release. If it has not been published, block initial publication until
WP5 passes.

Required release work:

- record the affected version and symptoms in the changelog;
- build the WASM artifact once in CI and run all consumers against that exact
  artifact as described in [WP8](wp8-ci-release.md);
- verify direct and worker use from the packed tarball;
- attach benchmark JSON and artifact hashes to the release evidence; and
- describe any deliberate memory-footprint change caused by a larger stack.

Exit criteria:

- the fixed package is available through the supported release path; and
- downstream users have a clear upgrade target and reproducible evidence.

## Dependency order

```text
WP0 reproduction
  -> WP1 boundary map
  -> WP2 diagnostics
  -> WP3 algebra isolation
  -> WP4 minimal fix
  -> WP5 regression/numerical gates
  -> WP6 final benchmarks
  -> WP7 release
```

WP1 and WP2 can proceed in parallel after the harness exists. WP3 can begin
with an isolated algebra test while WP2 is gathering full-model diagnostics.
WP4 must wait for evidence: increasing memory and changing numerical code at
the same time would hide the cause and make future regressions harder to
diagnose.

## Definition of done

The investigation is complete only when all of the following are true:

- the first invalid operation has a source-level explanation;
- the fix is minimal and tied to that explanation;
- 2 x 2 through 8 x 8 arrays with 19 segments per dipole prepare and solve in
  release WASM;
- the 8 x 8 case completes with 1,216 equations in Node direct and worker
  modes;
- a browser regression above the former boundary passes;
- native and WASM numerical results agree within documented tolerances;
- retained solves do not refactor and lifecycle generations remain correct;
- the test suite would fail if the original defect were restored;
- peak memory and stack headroom are recorded and acceptable;
- final benchmark results and raw data identify the exact artifact hash; and
- the release notes identify affected and fixed package versions.

Until then, the successful 2 x 2 and 3 x 3 measurements above should be treated
as investigation data rather than a completed array-scaling benchmark.
