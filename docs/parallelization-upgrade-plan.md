# NEC2++ native and WebAssembly parallelization upgrade

Status: feasibility report and implementation plan, 2026-08-29

Repository snapshot reviewed: `3c46f684bbe9bd8e2c459b07157389314216b407`

Primary requirement: every recommended numerical optimization must compile and
run in the shipped WebAssembly engine as well as in the native library.

## Executive conclusion

Parallelization is both feasible and worthwhile, but the first target should be
the dense LU factorization, not matrix assembly in isolation.

The existing TypeScript/WASM benchmark shows that `prepare()` consumes 99.3% of
the 2,816-equation cold path and 99.7% of the 4,864-equation cold path. That
method currently combines interaction-matrix assembly and Eigen
`PartialPivLU`. A native diagnostic run on the same array family divides that
work as follows:

| Equations | Matrix fill | LU factor | Fill share | Factor share |
|---:|---:|---:|---:|---:|
| 704 | 45 ms | 106 ms | 29.8% | 70.2% |
| 1,584 | 241 ms | 1,174 ms | 17.0% | 83.0% |
| 2,816 | 889 ms | 6,669 ms | 11.8% | 88.2% |

WASM needs equivalent internal phase instrumentation before these native shares
are treated as WASM shares. The near-cubic growth of the WASM `prepare()` times,
however, also points to LU as the dominant large-system cost.

The most promising design is:

1. Ship separate single-threaded and pthread-enabled WASM artifacts. Emscripten
   explicitly cannot make one pthread binary fall back to non-threaded
   execution.
2. Run the threaded artifact behind the package's existing outer Web Worker,
   using `SharedArrayBuffer` and cross-origin isolation.
3. Enable the bundled Eigen 5.0.1 GEMM thread-pool path. Its blocked
   `PartialPivLU` then parallelizes the large trailing matrix updates while
   retaining the current in-place factorization.
4. Refactor matrix assembly into immutable inputs plus per-thread workspaces,
   then assign disjoint observation-column slabs of the one shared system
   matrix to workers.
5. Reuse one bounded pool for assembly and Eigen. The phases are sequential, so
   there is no reason to create or oversubscribe two pools.
6. Keep the current single-thread artifact for GitHub Pages, non-isolated
   deployments, small models, and explicit fallback.
7. Layer an optional mixed-precision matrix path on the same assembly and
   factorization abstractions: compute electromagnetic interactions in double,
   store and factor the dense matrix as `complex<float>`, compute residuals in
   double, refine, and reject or fall back when conditioning is unsuitable.

A compile-and-run probe confirmed that Eigen's thread-pool path works with the
project's pinned `emscripten/emsdk:4.0.7`; no Eigen or Emscripten upgrade was
needed. A synthetic 2,816 by 2,816 dense complex LU, built with the same
`-O3 -flto -pthread -sALLOW_MEMORY_GROWTH` fundamentals, produced:

| Eigen threads | Factor time | Speed-up | Parallel efficiency |
|---:|---:|---:|---:|
| 1 | 9,814.6 ms | 1.00x | 100% |
| 2 | 5,983.8 ms | 1.64x | 82% |
| 4 | 3,687.2 ms | 2.66x | 67% |
| 8 | 3,077.6 ms | 3.19x | 40% |

This is kernel feasibility evidence, not an end-to-end NEC promise. It does
show that a four-thread implementation has a credible path to much more than a
10% gain. Four total compute threads should be the initial default candidate;
eight should remain opt-in until production matrices and browsers show that its
extra workers and stacks are justified.

Reduced precision has a different value proposition. It cuts the dominant
matrix allocation exactly in half, but an exploratory probe with the pinned
Emscripten/Eigen toolchain did **not** show a dependable large factor-time win:
`complex<float>` ranged from 6% slower to 12% faster than `complex<double>`
depending on thread count and `-msimd128`. Therefore it should initially be a
checked memory-saving mode, not part of the core speed-up claim. A global
`nec_float=float` build is not acceptable because it would also reduce the
precision of geometry, field integrals, Sommerfeld/Norton evaluation, public
results, and convergence thresholds.

There is one much larger conditional optimization: use NEC's existing exact
plane/cylindrical symmetry representation instead of explicitly adding every
copy of a symmetric structure. The current deck engine already implements the
modal factorization, but the stateful TypeScript API cannot request GX/GR-style
geometry generation. On the existing 16 by 16, 11-segment array, two reflection
planes reduced current single-thread WASM cold deck time from 13.19–13.46 s to
1.136–1.150 s (11.47–11.85x), with identical sorted source currents at report
precision. This is workload-specific rather than a general LU improvement, but
for symmetric arrays it is more valuable than all low-level tuning combined.

Matrix assembly is also parallelizable, but it should follow LU. Before LU is
accelerated, fill is only about 12% of the measured 2,816-equation native
preparation. After a 2.66x factorization improvement, that unchanged fill would
be about 26% of preparation, at which point parallel fill can make a material
incremental difference. This ordering avoids spending substantial engineering
effort on an isolated gain near the user's 10% rejection threshold.

## Hard constraints and decision gates

The implementation should use these rules throughout:

- The same C++ numerical path must build on Windows, Linux, and Emscripten.
  Platform-specific scheduling glue is acceptable; a native-only numerical
  implementation is not.
- The threaded browser build may require `Cross-Origin-Opener-Policy` and
  `Cross-Origin-Embedder-Policy`. That is an accepted deployment constraint.
- The package must retain a single-thread build because a pthread-enabled WASM
  binary cannot dynamically degrade to an ordinary WASM binary.
- No work package should ship solely on an expected 10% improvement. Use a 15%
  minimum measured incremental improvement for an already-small follow-on
  phase, and a 1.5x minimum for the core threaded `prepare()` upgrade at 1,584
  equations or larger.
- Thread-count comparisons must use the same code and artifact except for
  runtime thread count. Compare 1, 2, 4, and 8 threads.
- Correctness gates precede performance gates. All supported ground, patch,
  symmetry, load, stateful, deck, worker, and browser paths remain supported.
- Do not trade away the retained-factorization behavior. A repeated excitation
  must still avoid assembly and factorization.
- Avoid full matrix replication per worker. The matrix is already 121 MiB at
  2,816 equations and 361 MiB at 4,864 equations.
- Keep geometry, electromagnetic kernels, residual evaluation, result buffers,
  and the stable C/WASM ABI in binary64. Reduced precision applies only to
  dense matrix storage, factorization, correction solves, and their scratch.
- Do not return an unchecked float solution. Reduced-precision results need a
  system-matrix condition estimate, a double-precision scaled residual, and a
  documented fallback or failure policy.
- Do not ship reduced precision as a performance feature unless production
  browser benchmarks show at least 15% end-to-end improvement after including
  residual evaluation and refinement. The 2x matrix-memory reduction can clear
  a separate memory-capacity gate even when it is not faster.

## What the current benchmarks say

### TypeScript/WASM array benchmark

The source benchmark is
[`packages/necpp-wasm/bench/array-case.mjs`](../packages/necpp-wasm/bench/array-case.mjs)
and its published result is
[`packages/necpp-wasm/bench/RESULTS.md`](../packages/necpp-wasm/bench/RESULTS.md).
The most relevant stateful medians are:

| Equations | Instantiate | Geometry | `prepare()` | First solve | Cold total | `prepare()` share |
|---:|---:|---:|---:|---:|---:|---:|
| 704 | 8.2 ms | 5.7 ms | 274.3 ms | 12.0 ms | 301.2 ms | 91.1% |
| 1,100 | 7.7 ms | 10.7 ms | 830.4 ms | 15.0 ms | 862.0 ms | 96.3% |
| 1,584 | 7.6 ms | 16.7 ms | 2,290.8 ms | 15.9 ms | 2,336.6 ms | 98.0% |
| 2,156 | 9.7 ms | 31.6 ms | 5,722.6 ms | 24.7 ms | 5,789.7 ms | 98.8% |
| 2,816 | 9.1 ms | 46.5 ms | 12,718.3 ms | 35.0 ms | 12,813.7 ms | 99.3% |
| 4,864 | 7.5 ms | 124.1 ms | 63,857.4 ms | 81.5 ms | 64,070.6 ms | 99.7% |

The retained solve is only 17.3 ms at 2,816 equations and 49.9 ms at 4,864
equations. Module loading, TypeScript calls, result copying, report generation,
and a single triangular solve are therefore not the large-system cold-path
bottlenecks. The stateful/deck cold difference also falls below 1% at the
largest cases because both APIs ultimately pay for the same preparation.

The preparation ratios are close to cubic at the upper end: increasing the
equation count from 2,816 to 4,864 multiplies it by 1.73 and increases
preparation time by 5.02x; a pure cubic term would increase by 5.15x. Assembly
is nominally quadratic, while dense LU is cubic. This is evidence that LU is
dominant, though it is not a substitute for direct phase timers.

### Missing WASM measurement

[`misc.cpp`](../src/misc.cpp) implements `secnds()` as an Emscripten stub that
always returns zero. Consequently, the legacy `MATRIX TIMING` report says
`FILL=0` and `FACTOR=0` in WASM even though
[`structure_segment_loading()`](../src/nec_context.cpp) already brackets those
phases.

The first implementation work package must replace this diagnostic blind spot
with `std::chrono::steady_clock` or `emscripten_get_now()`-backed internal
metrics. Do not infer the production WASM fill/factor split solely from native
measurements or a polynomial fit.

### Native phase diagnostic

The table in the executive conclusion came from the current optimized Windows
native executable on 8x8, 12x12, and 16x16 versions of the same 11-segment
array. It is valuable for prioritization but not directly comparable in
absolute time to WASM because native Eigen uses a different instruction set and
compiler backend.

The data also explains why both LU and assembly matter over the full operating
range:

- At 704 equations, fill is already 30% of matrix preparation.
- At 2,816 equations, cubic LU has grown to 88%.
- Speeding up LU raises the relative importance of the remaining quadratic
  fill, so assembly becomes the second stage rather than an irrelevant stage.

### Amdahl scenarios, not forecasts

Using the measured 2,816-equation native shares only as an illustration:

- A 2.66x LU speed-up with serial fill would give about 2.22x preparation
  speed-up: `1 / (0.118 + 0.882 / 2.66)`.
- Combining that with a 3x fill speed-up would give about 2.70x:
  `1 / (0.118 / 3 + 0.882 / 2.66)`.

The actual WASM shares and browser thread performance must replace these inputs
before release claims are made.

## Highest conditional gain: exact NEC geometry symmetry

The biggest additional opportunity is not a faster LU kernel. It is giving LU
a set of much smaller independent mode matrices when the physical structure is
exactly symmetric.

NEC's GX reflection and GR cylindrical-generation paths already preserve a
fundamental section and transform the interaction system into symmetry modes.
For a total system of `n` equations made from `s` identical symmetry sections,
the current representation stores approximately `n^2/s` complex entries and
factors `s` matrices of order `n/s`:

```text
storage and fill  ~ n^2 / s
factor work       ~ s * (n/s)^3 = n^3 / s^2
```

For one, two, and three independent reflection planes, `s` is 2, 4, and 8.
The NEC-2 Part III manual explicitly gives the corresponding theoretical factor
times as `n^3/4`, `n^3/16`, and `n^3/64`, and storage/fill as `n^2/2`, `n^2/4`,
and `n^2/8`. This is an exact modal decomposition, not a reduced-accuracy
approximation.

### Direct measurement on the current WASM array

The published benchmark creates every dipole independently. Its 16 by 16 array
is centered on the origin, contains no element on either X/Y reflection plane,
uses identical vertical elements, has no loads, and drives every center port
equally. It can therefore be generated from one 8 by 8 quadrant followed by
two plane reflections.

Using the current shipped single-thread WASM artifact and deck path:

| Representation | Full equations | Stored fundamental equations | Cold deck time, run 1 | Cold deck time, run 2 |
|---|---:|---:|---:|---:|
| 256 explicit dipoles | 2,816 | 2,816 | 13,188 ms | 13,462 ms |
| 64 dipoles + `GX ... 110` | 2,816 | 704 | 1,150 ms | 1,136 ms |

The observed speed-up was 11.47–11.85x. Sorting the 256 reported source
currents to account for generated tag order gave zero relative difference at
the report's printed precision. The theoretical matrix allocation falls from
121.0 MiB to about 30.25 MiB, and factor arithmetic falls by 16x. Threaded LU,
parallel fill, and checked float storage can then operate on top of those
smaller mode matrices.

Keep the explicit full-array case as the general no-symmetry engine benchmark;
add the symmetry-aware representation as an application-level benchmark. It
would be misleading to replace the former and claim an 11x general solver
improvement.

### Applicability and constraints

This optimization is conditional but less restrictive than the excitation may
suggest. The NEC manual states that placement of sources and nonradiating
networks does not affect structural symmetry, so arbitrary generated ports can
still use the modal solve. The geometry, environment, and loading must remain
compatible:

- segments cannot lie in or cross a plane used to generate their image, though
  they may end on it;
- adding or modifying geometry after symmetry generation can destroy symmetry;
- unsymmetric lumped loads invalidate the corresponding modes;
- a ground plane destroys reflection symmetry parallel to that ground plane,
  while perpendicular reflection planes may remain usable; and
- tag increments and generated segment ordering must remain deterministic so
  ports and loads can address the intended copies.

Consequently, the even-sided benchmark arrays are excellent candidates, while
an odd-sided array with center-line elements is not automatically expressible
with the same GX construction.

### Missing stateful/WASM surface

The deck parser reaches the existing `c_geometry::reflect()` machinery, but
`NecModel` exposes only individual `addWire()` calls followed by
`completeGeometry()`. Add explicit pre-completion operations such as:

- reflect the current fundamental section in selected coordinate planes with a
  documented tag increment; and
- generate a requested number of cylindrical copies with a tag increment.

Do not silently auto-detect symmetry from floating-point coordinates. An
explicit operation preserves NEC's exact construction, tag semantics, and
failure rules. A higher-level array helper can calculate the fundamental
quadrant/sector and generated port mapping for users.

For `s > 1`, improve the existing `factrs()` loop as a follow-on:

1. Store each transformed mode in a contiguous mode-major matrix instead of an
   `OuterStride` view interleaved with every other mode.
2. On a shared pool, either factor independent modes concurrently with one
   Eigen thread each or factor them serially with multithreaded Eigen. Benchmark
   both policies; do not nest them.
3. Prefer outer mode concurrency when several similarly sized modes fit the
   available core count, because it removes repeated GEMM barriers and improves
   locality.

This complete path is native/WASM portable and uses the same pthread artifact.
It needs no new numerical dependency and should precede custom BLAS research
for applications that can express symmetry.

## Current call path and serialization points

For the stateful API, the relevant call chain is:

```text
TypeScript model.prepare()
  -> necpp_wasm_v1_prepare()
  -> nec_stateful_model::prepare()
  -> nec_context::stateful_prepare_frequency()
  -> nec_context::structure_segment_loading()
       -> cmset()                         interaction-matrix assembly
       -> factrs()
          -> lu_decompose()               transpose + Eigen PartialPivLU
```

The principal files are:

- [`packages/necpp-wasm/src/model.ts`](../packages/necpp-wasm/src/model.ts)
- [`src/necpp_wasm_v1.cpp`](../src/necpp_wasm_v1.cpp)
- [`src/nec_stateful_model.cpp`](../src/nec_stateful_model.cpp)
- [`src/nec_context.cpp`](../src/nec_context.cpp)
- [`src/matrix_algebra.cpp`](../src/matrix_algebra.cpp)
- [`src/CMakeLists.txt`](../src/CMakeLists.txt)
- [`scripts/build_wasm_inner.sh`](../scripts/build_wasm_inner.sh)

The current WASM target is completely single-threaded. It has no `-pthread`,
no worker pool, and no Eigen parallel definition. The existing TypeScript
Web Worker described in [`docs/wp6-web-worker.md`](wp6-web-worker.md) moves a
whole single-threaded module off the UI thread; it does not parallelize a solve.

The current release build also does not pass `-msimd128`. SIMD is a separate
baseline experiment worth measuring, especially in the quadratic field
kernels, but it is not a replacement for threading.

## Can Eigen use multiple threads in WASM?

Yes.

Eigen documents `PartialPivLU` as implicitly multithreaded through parallel
dense matrix-matrix products. The bundled Eigen 5.0.1 additionally contains a
GEMM thread-pool route selected by `EIGEN_GEMM_THREADPOOL`, alongside its
OpenMP route. Its blocked LU performs serial panel/pivot work and updates the
large trailing block with matrix multiplication. The trailing updates are the
part that scale through the pool; serial panels and memory bandwidth explain
the diminishing return between four and eight threads.

The recommended route is the bundled Eigen thread pool:

```cpp
// Compile definition must be visible before every Eigen include.
#define EIGEN_GEMM_THREADPOOL
#include <Eigen/Dense>
#include <Eigen/ThreadPool>

Eigen::ThreadPool pool(worker_count);
Eigen::setGemmThreadPool(&pool);
Eigen::setNbThreads(active_thread_count);
```

The production implementation should set the macro as a target compile
definition, not in one source file. It should own the pool in a NEC parallel
runtime object whose lifetime exceeds every factorization.

### Why not OpenMP first?

Eigen's public multithreading documentation presents OpenMP as the normal
activation mechanism. That is a good native option, but it is not available in
this project's pinned WASM toolchain: inspection of the installed
`emscripten/emsdk:4.0.7` image found neither `omp.h` nor the OpenMP runtime.

Newer Emscripten sources contain an OpenMP runtime, so an SDK upgrade plus
`-fopenmp` is a plausible fallback experiment. It is not the first choice
because:

- the Eigen thread-pool path already compiles, runs, and scales on 4.0.7;
- a major SDK upgrade expands the regression surface for exceptions, ES module
  output, pthread workers, memory growth, Node, and browsers; and
- OpenMP would still use Emscripten pthreads and require the same browser
  headers and dual artifacts.

If the Eigen pool proves unstable in full NEC testing, compare a current pinned
SDK with OpenMP in a branch. Adopt it only if its end-to-end result clearly
beats the pool path and the full packaging/browser suite passes.

### Thread-pool ownership and nested parallelism

Eigen's pool registration and maximum-thread setting are process/module global.
Do not change them concurrently from models. A WASM `createNecModel()` call
currently creates an isolated module, and worker requests are serialized, so
one runtime per module fits the existing architecture.

On native platforms, expose process-level parallel configuration and document
that it must be set before concurrent solves begin. The first release should
not promise concurrent mutation of separate `nec_context` objects in one
process; the current code explicitly supports sequential interleaving only.

Assembly and factorization are sequential phases. Use the same pool for both,
and ensure that Eigen does not recursively parallelize while a task is already
executing inside that pool. Batch-level parallelism must likewise choose
between multiple single-thread models and one internally threaded model rather
than multiplying both thread counts.

## Can matrix assembly be distributed?

Yes, but the safe partition is more specific than splitting the current outer
source loop among threads.

### Why the current functions are not thread-safe

`cmset()` loops over source segments. For each source it calls
`c_geometry::trio()`, which mutates geometry-owned connection scratch:
`jsno`, `jco`, `ax`, `bx`, and `cx`. Then `cmww()` and `efld()` use and mutate
many `nec_context` members holding source coordinates, field components,
integration state, and ground scratch.

Other items in the thread-safety audit include:

- mutable process-wide electromagnetic constants and derived caches in
  [`electromag.cpp`](../src/electromag.cpp);
- function-static mutable temporaries in `c_evlcom::evlua()`;
- lazily initialized Bessel and Hankel tables in
  [`c_evlcom.cpp`](../src/c_evlcom.cpp); and
- per-instance Sommerfeld interpolation caches, which are already correctly
  owned by `c_ggrid` but must remain per workspace/context.

Calling current assembly functions concurrently on one `nec_context` would
race. Calling them on cloned contexts avoids much of the instance state but
does not resolve the process-wide statics inside a pthread-shared WASM module.

### Why source-segment partitioning can race

Wire basis functions span connected segments. `cmww()` uses `+=` to accumulate
a source segment's field into rows selected by `jco`. Different source
segments can therefore contribute to the same matrix element around
connections and junctions. Assigning source ranges to threads while writing one
matrix would need private accumulators or locks, either of which damages memory
or performance.

### Recommended partition: observation columns

In the current transposed NEC storage, one observation index maps to one
contiguous matrix column. A worker should own a disjoint observation range and
iterate over all source segments for that range:

```text
worker 0: observations [0, c1)       -> final matrix columns [0, c1)
worker 1: observations [c1, c2)      -> final matrix columns [c1, c2)
worker 2: observations [c2, c3)      -> final matrix columns [c2, c3)
worker 3: observations [c3, n)       -> final matrix columns [c3, n)
```

No two workers then write the same cell. They can write directly into the one
final `cm` allocation in shared WASM memory, so there is no merge copy and no
additional O(n²) matrix.

Each worker repeats `trio(j)` or consumes precomputed immutable basis metadata
for every source. That O(threads x n) work is small beside O(n²) field
evaluation. Start with repeated per-workspace `trio()` for clarity; precompute
only if phase metrics show it matters.

Use small dynamic tiles rather than one static slab per worker. Free-space
wire-wire interactions are fairly uniform, but self terms, junctions,
patches, and Sommerfeld/Norton ground can have different costs. An atomic tile
counter with roughly 8 to 32 observation columns per task should balance them
without per-element scheduling overhead. Tune the tile size empirically.

### Required assembly refactor

Introduce two internal types:

```text
assembly_input
  immutable geometry arrays
  immutable connectivity
  immutable loads and ground parameters
  frequency/wavelength and kernel options
  dimensions, symmetry metadata, and output layout

assembly_workspace
  trio connection coefficients
  source-segment coordinates and direction
  efld output components
  integration scratch
  per-thread ground interpolation/evaluation state
  first-error/cancellation status
```

Move hot-kernel scratch out of `nec_context` and `c_geometry` members or pass a
workspace explicitly through `cmww`, `cmws`, `cmsw`, `compute_matrix_ss`,
`efld`, and the integration helpers. This refactor should first preserve the
serial loop and demonstrate identical matrices. Parallel scheduling is a
separate commit after that baseline is green.

For a fast proof of concept, each thread may own a lightweight geometry clone
and workspace while all clones read the same immutable coordinate arrays. Do
not clone a complete `nec_context` with a full `cm` allocation. Geometry is
O(n) and cheap to duplicate if necessary; the system matrix is O(n²) and is
not.

### Other assembly stages

The full assembly pipeline also needs an ownership decision for:

- matrix zeroing;
- wire-wire, wire-surface, surface-wire, and surface-surface interactions;
- load terms;
- symmetry-mode combination;
- the in-place un-transpose currently at the start of `lu_decompose()`; and
- exception/cancellation propagation.

Parallel zeroing is easy but unlikely to matter alone. Symmetry combination is
independent by output column and can use the same tiles. The O(n²) transpose
can be tiled, or preferably removed after proving that assembly can directly
produce the orientation expected by Eigen. Removing it is cleaner, but it is a
layout-sensitive numerical change and should not be mixed into the first
parallel assembly commit.

Loads should be applied by the worker that owns the affected observation
column, or serially if their measured share is negligible. Patches and all
ground methods require explicit tests; do not silently claim general threaded
assembly based only on the wire-only free-space benchmark.

Workers catch errors locally, publish the first failure, request cancellation,
join at the phase barrier, and leave the model unprepared. No exception should
cross a raw pthread entry point.

## Why independent full WASM workers are not the primary design

The user's proposed model—give each worker the geometry and ask it to form a
different submatrix—is conceptually correct. The efficient realization is
pthreads sharing one WASM memory, not isolated Emscripten modules with full
matrices.

With isolated modules:

- each module has a separate `WebAssembly.Memory`;
- a full 2,816-equation complex matrix is 121 MiB, so four full private
  matrices consume about 484 MiB before the coordinator's factorization
  storage;
- the 4,864-equation case would use about 1.44 GiB for four matrices;
- even slab-only workers must transfer 121 or 361 MiB in total to the module
  that performs LU; and
- transferring an `ArrayBuffer` avoids one JavaScript clone but the receiving
  module still has to copy it into its WASM heap.

An externally created `SharedArrayBuffer` could avoid those transfers, but
wiring it into a shared Emscripten memory is effectively rebuilding the
pthreads/shared-memory solution with more custom JavaScript.

Independent workers remain excellent for coarse-grained independent jobs:

- different frequencies that each require a different matrix;
- parameter sweeps and optimizers;
- unrelated models; and
- Monte Carlo or tolerance studies.

That can be a later TypeScript batch API. It does not accelerate one dense
factorization, and its scheduler must prevent outer-worker count multiplied by
inner Eigen count from oversubscribing the machine.

## WASM build and package architecture

### Dual artifacts

Emscripten documents that pthread and non-pthread modes require separate
builds. Add two explicit CMake targets or configurations:

```text
single-thread:
  nec2pp.generated.js
  nec2pp.wasm

threaded:
  nec2pp.threaded.generated.js
  nec2pp.threaded.wasm
  generated pthread worker/helper asset(s)
```

Exact helper filenames should be discovered from the pinned build rather than
hard-coded in this plan. The package assembler and packed-tarball tests must
enumerate every generated threaded asset.

Suggested CMake options:

```cmake
option(NECPP_ENABLE_PARALLEL "Enable the NEC shared thread pool" OFF)
option(NECPP_BUILD_WASM_THREADS "Build the pthread WASM variant" OFF)
set(NECPP_MAX_THREADS 8 CACHE STRING "Maximum NEC worker count")
set(NECPP_WASM_PTHREAD_POOL_SIZE 8 CACHE STRING "Prewarmed pthread workers")
```

For the pthread target, apply `-pthread` when compiling every source and when
linking. Add a bounded `PTHREAD_POOL_SIZE`, and use
`PTHREAD_POOL_SIZE_STRICT=2` in tests so pool exhaustion fails rather than
deadlocking. Retain `ALLOW_MEMORY_GROWTH`, but measure it: Emscripten warns that
pthreads plus growth can slow JavaScript heap access even though WASM itself
runs at full speed.

The current 4 MiB `STACK_SIZE` would also become the default pthread stack size
unless `DEFAULT_PTHREAD_STACK_SIZE` is specified separately. Eight 4 MiB worker
stacks add roughly 32 MiB. Measure worker-kernel stack high-water marks and set
an explicit pthread stack value with headroom rather than inheriting it
accidentally.

### Runtime selection

Add an explicit package option rather than hiding deployment behavior:

```ts
type NecThreadingMode = "auto" | "required" | "disabled";

interface NecParallelOptions {
  readonly threading?: NecThreadingMode;
  readonly maxThreads?: number;
}
```

Recommended semantics:

- `disabled`: use the existing single-thread artifact.
- `auto`: use the threaded artifact only from the worker facade when shared
  memory and cross-origin isolation are available; otherwise fall back.
- `required`: fail creation with a clear diagnostic if the environment cannot
  run the threaded artifact.
- Clamp `maxThreads` to the built pool capacity. Start evaluation with a
  default of four total compute threads, not all logical CPUs.

Expose the selected backend and active thread count in diagnostics so benchmark
results cannot accidentally label a fallback run as threaded.

Emscripten also exposes runtime checks for threading support. In a browser,
test at least `crossOriginIsolated`, `SharedArrayBuffer`, and the generated
module's own pthread startup. `navigator.hardwareConcurrency` is a logical-core
hint, not a physical-core count or a promise that all cores are available.

### Keep threaded computation off the browser main thread

The current direct browser API calls native operations synchronously. A
pthread join or condition wait on the main browser thread can busy-wait, freeze
the UI, or deadlock worker creation. Therefore:

- keep `createNecModel()` single-threaded in browsers for the first release;
- make `createNecWorkerModel()` the supported browser entry for the threaded
  engine;
- prewarm the pthread pool before reporting worker-model creation complete; and
- run integration tests through the actual outer worker plus inner pthread
  workers, not only Node.

Node can use pthreads through worker threads, but the same worker facade is the
least surprising supported route initially.

### Loader and custom assets

The current loader only needs to resolve `nec2pp.wasm`. A threaded Emscripten
module also needs its worker/helper script to resolve correctly through Vite,
the packed npm package, a CDN, and custom `wasmUrl` use.

Extend `locateFile` or add a threaded asset-base option that handles every
generated filename. A custom WASM byte array alone may no longer be sufficient
to relocate the helper script; document and type the asset pair rather than
guessing a sibling URL.

## Browser deployment requirements

Emscripten pthreads use shared WebAssembly memory backed by
`SharedArrayBuffer`. A normal production response should include:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

For same-origin package assets, also use a consistent resource policy such as:

```http
Cross-Origin-Resource-Policy: same-origin
Content-Type: application/wasm
```

If the JS, WASM, or pthread worker is on another origin, configure CORS and a
compatible `Cross-Origin-Resource-Policy` on that asset origin. Every resource
embedded by a `require-corp` page must satisfy the policy, not just the WASM
file.

The browser gate is:

```js
if (!globalThis.crossOriginIsolated) {
  // use the single-thread build or report that threaded mode was required
}
```

GitHub Pages does not provide repository-controlled arbitrary response headers,
so its example should keep using the single-thread artifact. The threaded demo
and benchmark can be hosted on a service that supports response headers. A
service-worker header shim adds lifecycle and caching failure modes and should
not be the supported production story.

Cross-origin isolation can affect popup relationships and third-party
resources. Deployment documentation should call this out so an application
does not enable the headers globally without checking authentication, embeds,
analytics, and CDN assets.

## Memory model

The dense complex system matrix uses approximately `16 * n²` bytes:

| Equations | Matrix only |
|---:|---:|
| 704 | 7.6 MiB |
| 1,584 | 38.3 MiB |
| 2,816 | 121.0 MiB |
| 4,864 | 361.0 MiB |

The current factorization is in place, which is exactly what a threaded build
should preserve. The measured 4,864-equation process RSS increase is about 387
MiB, close to the matrix plus runtime and geometry overhead.

Threading should add only:

- O(n) or bounded per-thread assembly workspace;
- worker stacks;
- Eigen task/panel scratch; and
- generated runtime overhead.

It must not add one matrix per worker. Set an acceptance gate of no more than
15% peak-memory growth beyond explicitly accounted worker stacks and bounded
scratch at the 2,816-equation case.

The default Emscripten growth maximum is 2 GiB. Keep an explicit checked matrix
size calculation before allocation and return a controlled error rather than
approaching a browser-specific out-of-memory trap. Consider a one-time heap
reservation before assembly to avoid several growth steps, but do not set a
huge fixed initial heap for every small model without benchmark evidence.

## Additional parallel opportunities

These are secondary to preparation but some can be valuable for different API
workloads.

### Port admittance and impedance extraction

`compute_admittance_matrix()` currently performs one unit-voltage solve per
port against the same retained LU. For hundreds of ports, this is many O(n²)
triangular solves even though a normal `solveVoltages()` performs only one.

Add a multi-right-hand-side internal solve:

- form several basis right-hand sides as matrix columns;
- apply the retained permutation once per column or in one matrix operation;
- solve lower and upper triangular systems with a dense RHS block; and
- tile RHS columns across the pool if Eigen does not already parallelize the
  chosen triangular matrix solve sufficiently.

This can materially improve `computeImpedanceMatrix()` and embedded basis
fields. It is not represented by the current cold benchmark and must have its
own port-count sweep.

### Batched retained solves

One retained solve is tens of milliseconds even at 4,864 equations, so
threading a single RHS has limited user value. A new batch API could solve
multiple independent drives concurrently using the read-only LU factors and
per-task result vectors. Do not make the existing mutable latest-result object
concurrent.

### Far-field grids

Far-field samples are independent by `(theta, phi)` after currents exist.
Large grids and embedded patterns are natural tiled tasks. This does not help
the current benchmark, which measures no far field, but it can be important for
181x361 patterns or port-basis fields. Give each task private field scratch and
write disjoint result ranges.

### Frequency and model sweeps

Use multiple outer workers for independent matrices. This is near-ideal coarse
parallelism but multiplies O(n²) memory. The scheduler should choose a fixed
total CPU budget and a memory budget:

```text
many independent models -> more outer workers, fewer inner threads each
one large model          -> one outer worker, more inner threads
```

### SIMD

Benchmark `-msimd128` as a separate build-axis experiment. Emscripten documents
that it enables WebAssembly SIMD and LLVM autovectorization. The bundled Eigen
tree has no obvious dedicated WASM packet backend, so do not assume Eigen LU
will receive the same benefit as native SSE/AVX. Assembly's arithmetic loops
may still improve.

The precision probe below did show a large apparent `-msimd128` improvement for
four-thread complex-double LU, but it was one run rather than a release-quality
median and the float advantage remained inconsistent. Add SIMD to the full
factorial benchmark (`precision x thread count x SIMD`) and ship it only after
numerical validation and a material end-to-end gain.

## Single and mixed precision feasibility

### Recommendation

Implement a **mixed-precision matrix path**, after WP4 has produced a clean
matrix-storage/assembly boundary. Keep the physical calculation and observable
contract in double precision:

```text
double geometry + double interaction kernels
                    |
                    v cast once per stored entry
           complex<float> dense matrix
                    |
          float PartialPivLU factors
                    |
       float correction solves, double x
                    |
 double matrix-free residual + iterative refinement
                    |
       accept, fall back to double, or fail clearly
```

Do not change the global `nec_float` typedef. Although its comment suggests
that it can be changed to `float`, it is used across almost the whole engine.
The current code contains double-scale convergence criteria such as `ACCS =
1e-12`, and the stateful regression suite contains tolerances at `1e-10` and
`1e-12`. A global float build would silently alter much more than the linear
solver and cannot satisfy the existing numerical contract.

The initial user-facing policy should be:

- `double`: current behavior and initial default;
- `mixed`: require float matrix storage/factors plus double residual and
  refinement, and return a precision/conditioning error instead of allocating
  a double matrix when the policy cannot be met; and
- `auto`: try the mixed path, but discard it and reassemble/refactor in double
  during `prepare()` if its condition or refinement gates fail.

Do not initially expose an unchecked pure-single mode. It would be hard to
explain alongside the current accuracy contract, and it would make silent
frequency- and geometry-dependent errors possible.

### Memory benefit

`std::complex<double>` occupies 16 bytes and `std::complex<float>` occupies 8
bytes in the relevant Eigen/WASM layouts. For the primary dense matrix alone:

| Equations | Complex double | Complex float | Matrix saving |
|---:|---:|---:|---:|
| 704 | 7.6 MiB | 3.8 MiB | 3.8 MiB |
| 1,584 | 38.3 MiB | 19.1 MiB | 19.1 MiB |
| 2,816 | 121.0 MiB | 60.5 MiB | 60.5 MiB |
| 4,864 | 361.0 MiB | 180.5 MiB | 180.5 MiB |

The factors overwrite the current matrix in place, so there is no second LU
allocation in the steady state. Process memory will not fall by exactly 50%
because geometry, result buffers, the WASM runtime, pthread stacks, code, and
scratch remain. Nevertheless, saving 180.5 MiB at 4,864 equations is large
enough to move a browser workload from allocation failure or heavy memory
growth into a practical range. This is independently worthwhile even if the
solver is not faster.

Preserving the memory gain constrains the refinement design:

- retaining a double original matrix plus float factors needs 1.5 times the
  current matrix memory at peak and is unacceptable;
- retaining separate float originals and float factors consumes the same bytes
  as the current double in-place path and only validates the rounded matrix;
- recomputing `A*x` in double from immutable geometry, a column tile at a time,
  retains the 2x matrix saving and needs only O(tile width x n) scratch.

The last option is the recommended one. It is also a direct reuse of the
thread-safe, column-tiled assembly work: produce a small tile in double,
accumulate its contribution to the residual, then discard it. One residual is
O(n^2), while factorization is O(n^3), but the extra pass must still be included
in end-to-end benchmarks because threaded LU makes quadratic work more visible.

### Exploratory WASM float/double probe

A compile-and-run probe used the bundled Eigen 5.0.1 and pinned
`emscripten/emsdk:4.0.7`, a 2,816 by 2,816 diagonally dominant dense complex
matrix, in-place `PartialPivLU`, `-O3 -flto -pthread`, an eight-worker pool, and
the production memory-growth/stack fundamentals. Matrix generation was outside
the timed region. This was one run per cell, so the table is feasibility
evidence rather than a stable performance claim.

| Build | Threads | Double LU | Float LU | Float vs double |
|---|---:|---:|---:|---:|
| current scalar | 1 | 14,091.5 ms | 12,335.3 ms | 1.14x faster |
| current scalar | 2 | 9,312.2 ms | 9,813.7 ms | 5% slower |
| current scalar | 4 | 6,916.6 ms | 7,040.7 ms | 2% slower |
| current scalar | 8 | 6,086.0 ms | 6,462.7 ms | 6% slower |
| `-msimd128` | 1 | 11,422.8 ms | 10,261.8 ms | 1.11x faster |
| `-msimd128` | 4 | 3,661.8 ms | 3,743.4 ms | 2% slower |
| `-msimd128` | 8 | 3,129.1 ms | 2,830.4 ms | 1.11x faster |

The float matrix was 60.5 MiB versus 121.0 MiB in every case. The important
result is the lack of a consistent compute advantage. WebAssembly SIMD has
128-bit vectors, which in principle hold twice as many floats as doubles, but
the bundled Eigen tree has no dedicated WASM packet backend and generic complex
LU does not automatically turn that width difference into a 2x speed-up. The
explicit SIMD build and exact production NEC matrices still need repeated
browser medians, but no implementation estimate should currently assume more
than the proven 2x storage reduction.

Assembly will also remain mostly double-compute work: only its final matrix
stores and later matrix traffic become float. It may gain cache/bandwidth
efficiency, but it will not receive a theoretical 2x arithmetic reduction. A
larger native float speed-up would be useful, but it is insufficient for this
project unless the same checked path also clears the WASM gate.

### Conditioning and attainable accuracy

Binary32 has `epsilon = 1.1920929e-7`; binary64 has approximately `2.22e-16`.
A useful first-order warning is that the forward error can grow like
`condition(A) * epsilon`, with additional dependence on pivot growth and
implementation details. Illustratively:

| Estimated condition number | `kappa * epsilon_float` | Pure-float implication |
|---:|---:|---|
| 1e2 | about 1e-5 | Often usable for relaxed engineering output |
| 1e3 | about 1e-4 | Not compatible with the strictest current tests |
| 1e4 | about 1e-3 | Mixed refinement required; pure float is risky |
| 1e6 | about 1e-1 | Very little direct float accuracy remains |
| 1e7 or larger | order one | Reject float factors by default |

These are scale indicators, not acceptance limits. NEC matrices can become
poorly conditioned near resonances and through extreme segmentation, close or
nearly coincident conductors, tiny segments/radii, junctions, patches, loads,
and ground interactions. Conditioning is also frequency-specific, so a choice
cannot be cached for geometry alone.

The existing `conditionEstimate` cannot select this path. It is computed by a
full SVD of the small **port admittance matrix**, after the electromagnetic
matrix has already been factored and solved. The required value is a condition
estimate for the large interaction matrix. Eigen's bundled `PartialPivLU`
provides `rcond()`; its implementation estimates the reciprocal 1-norm
condition number in O(n^2) using the factors. Capture it before the temporary LU
object is destroyed and store it with the factorization diagnostics.

Use `rcond()` as a screen, not as the sole proof. A conservative initial mixed
eligibility threshold is `rcond >= 1e-4` (estimated condition at most 1e4), to
be widened only after the regression corpus and adversarial geometries show
safe convergence. Classical iterative-refinement analysis can permit a wider
range when float factors are combined with double working values and double
residuals, but partial-pivot growth, condition-estimator error, and rounded
matrix entries justify beginning conservatively.

### Checked solve and fallback algorithm

For a candidate mixed preparation:

1. Assemble each interaction in double and cast only the final stored entry to
   `complex<float>`. Accumulate the matrix norm and cast-error norm while the
   double value is available.
2. Factor the float matrix in place with the same Eigen thread pool. Record
   `rcond`, pivot extrema/growth diagnostics where practical, precision, SIMD
   mode, and thread count.
3. Reject nonfinite factors, `rcond == 0`, an excessive condition estimate, or
   a cast-perturbation bound that is already incompatible with the requested
   tolerance.
4. During `prepare()`, solve a small deterministic probe set, recompute `A*x`
   from geometry in double, and require residual contraction. In `auto`, any
   failure discards the float factors and reruns assembly/factorization in
   double before `prepare()` returns.
5. For a real right-hand side, convert `b` to float, solve for the first `x`,
   convert `x` to double, and compute `r = b - A*x` with the matrix-free double
   operator.
6. Solve the correction `A_float*d = float(r)`, update the double `x`, and
   repeat until accepted, stagnating, or a small fixed limit such as three
   refinements is reached.
7. Accept only when the normwise scaled backward error
   `eta = ||r|| / (||A||*||x|| + ||b||)` is finite and the condition-adjusted
   error estimate is below the configured output tolerance. Validate every
   retained RHS even though the matrix-level screen is cached.
8. If an unexpected RHS fails after preparation, never return it silently.
   Either rebuild in double under an explicitly documented `auto` transition,
   or return a precision error in memory-capped `mixed` mode.

Transparent fallback must happen before committing public result state. Free
the float allocation before requesting the double matrix so peak live matrix
memory is not 1.5x, although the browser's linear-memory high-water mark may
not shrink. Report the selected precision and whether fallback occurred.

Carson and Higham's iterative-refinement analysis supports the overall
approach of low-precision factorization with higher-precision residuals, but it
does not replace NEC-specific validation. Production gates must compare port
currents, impedances, fields, power, reciprocity, and residuals across frequency
and geometry—not just random dense matrices.

### C++ and WASM architecture

Do not put `std::variant` or a precision branch inside every matrix-element hot
loop. Introduce a storage/sink abstraction selected outside the loop, then
instantiate the matrix assembly and algebra boundary for
`std::complex<double>` and `std::complex<float>`. The field kernels continue to
return `nec_complex` and the float sink performs one checked cast on store/add.

Template the transpose, symmetry/load finalization, Eigen map/factorization,
and triangular correction solves over the stored scalar. Keep current vectors,
geometry, `nec_context` field scratch, port matrices, far fields, C ABI
parameters/results, `HEAPF64`, and TypeScript `Float64Array` types unchanged.
No public `HEAPF32` dependency is required; the float matrix is internal WASM
linear memory.

Compile both matrix precisions into each single-thread and pthread artifact so
`auto` can fall back without loading a second engine or replaying geometry in
JavaScript. Measure the template-instantiation code-size increase; split a
specialized artifact only if package size grows materially and the operational
cost of cross-module fallback is justified. Precision becomes part of the
factorization cache key and diagnostics, but does not alter the stable result
buffer ABI.

Preserve the existing `necpp_wasm_v1_prepare(model, frequency)` signature and
its double behavior. Add a new enum plus a pre-prepare policy setter (or a new
option-bearing ABI entry point), and new read-only getters for selected
precision, interaction-matrix condition estimate, refinement count, scaled
residual, and fallback reason. Existing consumers then remain ABI-compatible;
the TypeScript `PrepareOptions` can expose the new policy without changing any
input or result array element type.

This design translates directly to WASM: it needs no BLAS, GPU feature, or new
runtime dependency. It reuses the same Eigen, pthread pool, tiled assembly, and
cross-origin-isolated deployment already proposed for the parallel path.

## Other potential computational gains

After exact geometry symmetry and the planned threaded Eigen path, the
remaining opportunities divide into bounded kernel experiments and major
algorithmic research.

| Opportunity | Plausible value | Recommendation |
|---|---|---|
| `-msimd128` production build | Potentially material inside LU; current one-run evidence is noisy | Include in the main repeated browser factorial experiment |
| Parallel/contiguous symmetry modes | Material for GX/GR models | Implement with the stateful symmetry surface |
| WASM complex GEMM/LU backend spike | Could beat Eigen if it supplies a genuinely optimized complex kernel | Benchmark behind a 25% factor-time gate before adding a dependency |
| Direct final matrix layout | Saves one O(n^2) transpose and improves locality | Fold into assembly refactor; do not treat as a standalone project |
| Cache/block-size tuning | About 0–5% in the exploratory probe | Retain as benchmark metadata; no standalone work package |
| Relaxed SIMD | About 0–4% in the exploratory probe | Test with SIMD; ship only as part of a larger proven build win |
| Fixed/pre-reserved WASM memory | Reduces growth/startup disruption, not cubic arithmetic | Capacity/startup tuning, not a solver-speed claim |
| Batched RHS/fields | Large only when many ports/pattern samples are requested | Workload-specific follow-on; cold single solve barely changes |
| Complex-symmetric factorization | Theoretical storage/flop reduction | Research only after proving the primary matrix property on the full corpus |
| Matrix-free iterative/H-matrix/FMM methods | Can change asymptotic scaling | Separate numerical-engine project, not this upgrade |

### SIMD, relaxed SIMD, and cache blocking

The release build currently omits `-msimd128`. Emscripten documents that the
flag enables WebAssembly SIMD and LLVM autovectorization, while
`-mrelaxed-simd` enables relaxed SIMD operations. These flags are credible
because most LU work is in blocked matrix updates, but the bundled Eigen tree
has no dedicated WASM complex packet backend, so compiler results are sensitive
to code shape.

An exploratory 2,816-order, four-thread complex-double LU cache sweep used
explicit SIMD and the same pinned SDK. Eigen cannot query cache sizes through
WASM CPUID and defaults here to 16 KiB L1, 512 KiB L2, and 512 KiB L3. Tested
overrides ranged from 32/256/2,048 KiB to 64/2,048/16,384 KiB. Factor times
ranged from 3.81 to 4.17 seconds, while repeated defaults were 3.93 and 4.05
seconds. Relaxed SIMD produced 3.96 seconds at default cache settings. This is
ordinary run noise/single-digit tuning, not evidence for another project.

Use repeated medians on exact NEC matrices to select a conservative WASM cache
profile if it gives a consistent free improvement. Do not maintain browser-CPU
model tables; JavaScript does not expose reliable cache topology, and a bad
override can regress other devices.

### Dedicated complex GEMM/LU backend

Blocked partial-pivot LU spends most of its cubic work in GEMM-like trailing
updates. A better complex-double microkernel can therefore improve the dominant
phase even after threading. This is the main remaining low-level opportunity.

The latest OpenBLAS repository includes a `WASM128_GENERIC` target, but its
documented optimized list names real `SGEMM`/`DGEMM` and related real kernels,
not complex `CGEMM`/`ZGEMM`. Merely linking generic OpenBLAS/LAPACK is therefore
not enough evidence. Reasonable bounded experiments are:

- compare Eigen GEMM and LU with an Emscripten-built OpenBLAS `zgemm`/`zgetrf`;
- prototype a Wasm SIMD complex-double GEMM microkernel;
- evaluate a 3M complex update built from optimized real DGEMM, including its
  extra packing/additions and numerical differences; and
- tune Eigen's fixed partial-LU panel maximum and GEMM block sizes without
  changing pivot semantics.

Use exact production matrices and the same pool/thread count. Require at least
25% factor-time and 20% end-to-end `prepare()` improvement on 1,584 and 2,816
equations before accepting a new BLAS dependency or maintained kernel. Include
download size, compile time, stack/scratch, pthread interoperability, license,
and browser coverage in the decision. This gate is higher than 15% because a
second dense-linear-algebra stack has substantial long-term cost.

### Remove layout and bookkeeping overhead

The current matrix is assembled in NEC's transposed convention and then
un-transposed in place before Eigen. Directly assemble the final Eigen
column-major orientation and store symmetry modes contiguously. This removes an
O(n^2) full-matrix swap and improves mode locality, but it cannot materially
change an O(n^3) no-symmetry factorization. Treat it as free simplification
inside WP1/WP4, with its own timer, not as a promised large speed-up.

Other avoidable O(n^2) work includes Eigen's unconditional matrix 1-norm scan
inside `PartialPivLU`, pivot export, and row swaps. The norm becomes useful for
the mixed-precision `rcond` path; otherwise these terms are too small to justify
forking Eigen independently.

### Complex symmetry is not yet a usable shortcut

Electromagnetic reciprocity may make some consumer impedance matrices complex
symmetric, but that does not prove the assembled NEC testing/basis interaction
matrix is exactly symmetric for connected-wire basis functions, patches,
extended kernels, loads, and ground models. It is not generally Hermitian, so
Eigen's self-adjoint `LDLT` is not an interchangeable solver.

Before considering a pivoted complex-symmetric `LDL^T` implementation, record
`||A-A^T||/||A||` across every regression family and prove that any diagonal
rescaling needed for symmetry is exact and stable. Even then, a portable
pivoted solver and fallback would be required. This could eventually reduce
storage/flops, but it is a higher-risk numerical change than mixed precision.

### Gains for repeated workloads

The retained factorization already makes changed excitations cheap. Additional
reuse is workload-specific:

- solve many port RHSs as a dense block and parallelize triangular solves;
- parallelize or tile large far-field grids;
- run independent frequencies/models with a memory-aware outer-worker pool;
- for long frequency sweeps, research interpolation/model-order reduction or
  Krylov recycling; and
- for large regular arrays, investigate block-Toeplitz matrix-vector products
  and FFT/preconditioned iteration.

The last two change numerical behavior and need new convergence/error policy.
They can beat dense LU asymptotically, but should be planned as a successor
engine once threading, exact symmetry, and memory limits establish the range
where dense direct LU stops being competitive.

## Approaches not recommended now

### Native BLAS/LAPACK dependency

MKL, Accelerate, and ordinary OpenBLAS can be good native backends, but they do
not satisfy the requirement that the optimization translate to the same WASM
binary. Maintaining a separate native fast solver would split numerical and
test behavior. Revisit only if a WASM-capable BLAS backend is proven and beats
the already working Eigen pool by a large margin.

### WebGPU LU or assembly

Browser GPU support for portable, high-performance complex double precision is
not a dependable basis for this solver. A WebGPU path would require a second
kernel implementation, extensive numerical work, data transfer, and hardware
feature fallbacks. It is not reasonable for the current upgrade.

### Sparse solvers

The NEC Method-of-Moments interaction matrix is dense. Converting it to an
Eigen sparse solver does not create sparsity and would add overhead.

### FMM, hierarchical matrices, or iterative reformulation

These could eventually change the O(n²) storage or O(n³) solve, and at much
larger n they may be more important than threading. They are algorithmic
research projects with new approximation and convergence behavior, not a
parallelization upgrade that can preserve the current numerical contract.

## Implementation work packages

### WP-S — Expose and optimize exact geometry symmetry

This work can proceed independently of pthread infrastructure and has the
highest return for compatible arrays.

Add explicit plane-reflection and cylindrical-generation operations to
`nec_stateful_model`, the additive C ABI, TypeScript `NecModel`, worker
protocol, and documentation. Calls are valid only while geometry is being
built, before `completeGeometry()`. Provide deterministic generated tag/segment
mapping and validate that subsequent loads preserve the declared symmetry.

Add full-versus-fundamental regression pairs for one/two/three plane symmetry
and cylindrical symmetry, including arbitrary port excitations, allowed ground
planes, patches, and symmetric loads. Compare full currents by physical
segment mapping rather than raw generated order.

Then change the symmetry-mode matrix layout to contiguous mode-major storage
and benchmark serial-inner versus parallel-outer factor scheduling on the
shared pool.

Exit criteria:

- the 16 by 16 array's symmetry representation matches full-array currents,
  port quantities, power, and fields within existing tolerances;
- cold single-thread WASM retains at least an 8x improvement on that case;
- measured matrix storage is close to the theoretical 4x reduction;
- the stateful and deck paths agree on generated segment/tag mapping; and
- invalid geometry/load/ground combinations fail clearly rather than silently
  using invalid symmetry.

### WP0 — Phase metrics and reproducible baselines

Add a `prepare_metrics` structure containing at least:

- allocation and zeroing;
- frequency scaling and environment/load setup;
- wire-wire, wire-surface, surface-wire, and surface-surface fill where
  separable;
- load application;
- symmetry combination;
- matrix transpose/layout conversion;
- LU factorization;
- total preparation;
- selected backend and active thread count; and
- peak/allocated WASM memory where observable.

Store the last successful and failed preparation metrics on the stateful model.
Expose read-only C ABI getters and a TypeScript diagnostics result, or build a
benchmark-only ABI if keeping the public API smaller is preferred. Use a real
monotonic wall clock in WASM instead of `secnds()`.

Extend the existing benchmark to record these fields in NDJSON. Add 1, 2, 4,
and 8-thread dimensions but never run cases concurrently on the benchmark host.
Add production Chromium and Firefox runs behind a local server that emits the
isolation headers.

Exit criteria:

- native, Node WASM, and browser WASM report nonzero phase times;
- totals reconcile within timer overhead;
- exact commit, artifact hash, browser/Node version, CPU, and thread selection
  are recorded; and
- the serial instrumented build is within 3% of the uninstrumented median at
  1,584 and 2,816 equations.

### WP1 — Thread-safety refactor with serial behavior

Create immutable assembly input and per-thread workspace types. Convert
mutable helper statics to one of:

- true constants/compile-time tables;
- thread-safe one-time immutable initialization; or
- workspace/context-owned values.

In particular, make `c_evlcom::evlua()` temporaries local, make Bessel/Hankel
table initialization race-free, and remove mutable shared electromagnetic
derived caches from parallel hot paths. Move `trio` and field scratch into a
workspace.

Keep one serial workspace and the original loop order at first.

Add ThreadSanitizer tests on Linux that call the refactored kernels and prepare
independent contexts. ThreadSanitizer does not cover WASM, but it is the best
early detector for the portable C++ code.

Exit criteria:

- the pre-factor matrix is bit-identical to the current serial implementation
  for the regression corpus where operation order is preserved;
- final outputs pass all current tolerances;
- no new native ThreadSanitizer report appears; and
- serial performance regression is below 5%.

### WP2 — Dual WASM artifacts and shared runtime

Add the pthread build without changing numerical scheduling yet. Prewarm a
bounded Emscripten worker pool. Package both variants and every helper asset.
Add runtime feature detection, `auto|required|disabled`, selected-backend
diagnostics, and a clear fallback/error path.

Use the package's outer worker for threaded browser calls. Update the Playwright
server to emit COOP/COEP and assert `crossOriginIsolated === true`. Exercise the
packed tarball, Vite build, default URLs, relocated asset URLs, Node worker, and
browser worker.

Exit criteria:

- threaded creation works in Node and at least Chromium and Firefox;
- required mode fails clearly without headers;
- auto mode selects the documented fallback;
- all release artifacts are present in `npm pack`; and
- one-thread pthread numerical results match the single-thread artifact.

### WP3 — Threaded Eigen factorization

Enable `EIGEN_GEMM_THREADPOOL` target-wide, register the shared pool, and allow
runtime active counts of 1, 2, 4, and 8. Preserve the in-place outer-strided
`Eigen::Map` and pivot export. Ensure assembly has completed before Eigen work
starts and no outer NEC task remains in the pool.

Test exact production matrices, not only synthetic LU. Record panel/update
timing if practical. Check stack headroom and tune `DEFAULT_PTHREAD_STACK_SIZE`.

Performance gate:

- at least 1.5x `prepare()` speed-up with four threads on both the 1,584- and
  2,816-equation production WASM cases in a real browser;
- no more than 10% slowdown for explicit one-thread pthread mode versus the
  single-thread artifact after excluding pool startup;
- report eight-thread results, but make eight the default only if it improves
  four threads by at least another 15%; and
- peak memory stays within the explicit stack/scratch budget.

If this gate fails, stop before parallel assembly and diagnose pool startup,
memory growth, stack size, Eigen task scheduling, or browser limits. Evaluate a
newer Emscripten OpenMP build only after the bundled pool path has a concrete
failure or material performance deficit.

### WP4 — Parallel matrix assembly

Implement observation-column tiles that write directly to disjoint ranges of
the final shared matrix. Start with the wire-only free-space benchmark, then
cover:

1. connected wires and multi-wire junctions;
2. loads;
3. perfect and reflection-coefficient ground;
4. Sommerfeld/Norton ground;
5. patches and every mixed interaction path; and
6. rotational/plane symmetry.

Use dynamic tile assignment and record per-worker busy time or tile counts to
show load balance. Keep a serial threshold for small matrices; determine it
from the crossover rather than hard-coding an assumed equation count.

Performance gate:

- fill itself improves by at least 2x at 1,584 and 2,816 equations with four
  threads;
- total preparation improves by at least 15% beyond WP3 at one of those large
  production cases and does not regress the other by more than 3%;
- the serial small-model path does not regress materially; and
- additional memory is O(threads x n) or bounded scratch, not O(threads x n²).

If parallel fill improves total preparation by only about 10%, keep the
thread-safe refactor but do not enable the scheduler in the release default.

### WP5 — Checked mixed-precision matrix path

Build this after the tiled assembly interface exists, because that interface
should serve both float storage and double matrix-free residual evaluation.

Add:

- separate double-compute/double-store and double-compute/float-store matrix
  sinks;
- templated in-place transpose, symmetry/load completion, factorization, and
  correction solve boundaries;
- interaction-matrix norm, cast-error norm, float-LU `rcond`, residual, and
  refinement diagnostics;
- a double matrix-free `A*x` operation that reuses column tiles and the shared
  thread pool without allocating O(n^2) double storage;
- `double`, `mixed`, and `auto` policy plumbing through the stateful model, C
  ABI, TypeScript facade, and worker protocol while retaining Float64 results;
  and
- deterministic preflight probes, double fallback, allocation-failure cleanup,
  and cache-key/result-generation tests.

Correctness gate:

- `auto` must choose double on deliberately ill-conditioned, nonfinite, or
  nonconvergent fixtures and must never publish a failed float result;
- accepted mixed results pass the established current, impedance, power,
  reciprocity, port-matrix, and far-field tolerances;
- scaled backward error and condition-adjusted error are recorded for every
  accepted RHS;
- all legacy decks and every ground/patch/load/symmetry category are covered;
  and
- changing precision invalidates the retained factorization exactly once.

Memory gate:

- at 2,816 and 4,864 equations, live primary-matrix/factor storage is within 5%
  of the theoretical 60.5 MiB and 180.5 MiB float values, excluding explicitly
  itemized bounded tile scratch and worker stacks;
- mixed mode never retains a full double matrix beside float factors; and
- a memory-capped browser workload that cannot prepare in double completes in
  checked mixed mode on at least one representative well-conditioned fixture.

Performance gate:

- report factor-only, residual/refinement, total `prepare()`, first solve, and
  retained-solve medians for float and double at 1, 2, 4, and 8 threads, with
  and without `-msimd128`;
- claim speed only if checked mixed mode is at least 15% faster end to end on
  both 1,584- and 2,816-equation production browser cases; and
- ship it as memory-focused/experimental if it clears correctness and memory
  gates but not the speed gate. Keep `double` as the default until the NEC
  corpus supports an `auto` default without surprising fallback cost.

### WP6 — Multi-RHS, embedded-field, and batch work

After cold preparation is complete, benchmark and optionally implement:

- blocked multi-right-hand-side port admittance extraction;
- batched retained solves with immutable factor access;
- tiled far-field grids and embedded port fields; and
- a memory-aware outer-worker frequency/model pool.

Each feature needs a workload-specific 15% incremental gate. Do not infer its
value from the array cold benchmark.

### WP7 — CI, deployment example, and release evidence

Add CI jobs for:

- native serial and parallel tests;
- native ThreadSanitizer tests;
- single-thread WASM Node/facade/package tests;
- one-thread pthread equivalence tests;
- threaded Node worker tests;
- isolated Chromium and Firefox worker tests;
- double/mixed/auto precision tests in both single-thread and pthread WASM
  artifacts, including forced condition/refinement fallback;
- an allocation-inventory test proving accepted mixed mode does not retain a
  full double interaction matrix;
- a no-header fallback/required-mode failure test;
- packed-tarball asset and Vite resolution tests; and
- a scheduled large benchmark, kept out of ordinary per-commit latency if
  necessary.

Publish a small externally hosted threaded example with documented headers,
while leaving the GitHub Pages-compatible example single-threaded. Release
notes must state the thread default, memory cost, deployment requirement,
fallback behavior, artifact hashes, and measured hardware/browser results.

## Correctness and regression matrix

Every thread-count/backend combination should cover:

- the center-fed dipole, two coupled dipoles, and array fixtures;
- all 52 legacy regression decks;
- free space, perfect ground, reflection-coefficient ground, and
  Sommerfeld/Norton ground;
- wires, patches, and mixed wire/patch models;
- loads and multi-wire junctions;
- no symmetry, rotational symmetry, and plane symmetry;
- stateful voltage/current solves, impedance/admittance extraction, far
  fields, embedded fields, and the full deck path;
- one and many repeated solves with unchanged factorization generation;
- controlled allocation failure and task exception propagation; and
- model disposal after successful and failed threaded preparation.

Every precision mode should additionally cover:

- well-conditioned fixtures accepted by mixed mode and adversarial fixtures
  that force `auto` to double;
- frequencies on both sides of resonance and sweeps where the selected
  precision changes;
- very fine/short segments, extreme radius ratios, close conductors, junctions,
  patches, lossy loads, and every ground model;
- deterministic probe RHSs plus voltage, current, unit-port, and batched RHSs;
- stagnating refinement, nonfinite float casts/factors, low `rcond`, and
  allocation failure during fallback;
- equivalence of the public Float64 C/WASM/TypeScript result ABI; and
- no retained full double interaction matrix in accepted mixed mode.

Validation layers:

1. Compare the assembled complex matrix before factorization. Disjoint-column
   assembly can preserve each element's accumulation order and should normally
   be bit-identical.
2. Compare LU-derived currents and port matrices with the existing relative
   tolerances. Parallel GEMM may change floating-point reduction order, so
   bitwise final identity is not required.
3. Watch pivot permutations and residuals. A different pivot near a tie can be
   legitimate, but `||Ax-b||`, reciprocity, `ZY≈I`, power, and existing golden
   values must remain within policy.
4. Repeat runs at every thread count to detect nondeterministic races.
5. Run debug builds with stack checks and pthread diagnostics before release
   builds remove assertions.
6. For reduced precision, evaluate the scaled backward residual against the
   double interaction operator and require residual contraction during
   refinement. A small port-matrix `conditionEstimate` is not a substitute.
7. Compare the float-storage matrix, cast back to double before factorization,
   with the ordinary double matrix. Record normwise cast perturbation and the
   matrix rows/columns responsible for the maximum discrepancy.

## Benchmark protocol for release decisions

Use at least the existing 11-segment sweep plus the 4,864-equation 19-segment
endpoint. Add representative ground and patch cases because their assembly
cost differs from free-space wire arrays.

For each selected large case:

- build once and hash the exact artifact;
- run 1, 2, 4, and 8 threads in separate fresh processes/pages;
- use at least five preparation rounds and report median, p10, and p90;
- prewarm module and pthread creation separately, reporting startup both
  included and excluded;
- record phase metrics, wall time, peak memory, worker count, stack settings,
  CPU power mode, and `hardwareConcurrency`;
- do not run competing benchmark cases concurrently;
- validate numerical output in every measured case; and
- retain raw NDJSON with the release evidence.

For the precision experiment, cross the following axes rather than comparing
different ad hoc builds:

- `double`, accepted `mixed`, and `auto` including forced-fallback cases;
- 1, 2, 4, and 8 active Eigen/assembly threads;
- current scalar code and `-msimd128`;
- free-space wire arrays, ground-heavy, patch-heavy, and deliberately
  ill-conditioned fixtures; and
- cold prepare, first checked RHS, retained checked RHS, and a multi-RHS port
  basis.

Publish these headline numbers:

- time to first solution, with and without module/pool startup;
- matrix fill time and speed-up;
- LU time and speed-up;
- total preparation time and speed-up;
- retained single solve and multi-RHS port-matrix time;
- peak memory and matrix-only expected memory;
- artifact byte sizes; and
- fallback behavior without isolation headers.

Also publish selected precision, interaction-matrix `rcond`, refinement count,
scaled residual, fallback reason/cost, and theoretical versus measured live
matrix memory. Separate capacity wins from speed wins in release claims.

Browser results are the release authority for the WASM feature. Node is useful
for rapid iteration but does not prove response headers, worker asset
resolution, or main-thread behavior.

## Risks and mitigations

| Risk | Consequence | Mitigation |
|---|---|---|
| Hidden shared mutable kernel state | Nondeterministic wrong matrices | Workspace refactor, immutable inputs, native ThreadSanitizer, repeated checksums |
| Main-browser-thread waits | Frozen UI or deadlock | Support threaded browser mode only through the outer worker; prewarm pool |
| Pool oversubscription | Eight threads slower than four | Default candidate of four, runtime cap, no nested outer/inner multiplication |
| Pthread stack multiplication | Tens of MiB extra memory or traps | Explicit worker stack size, high-water tests, account it in memory gates |
| Shared memory growth quirks | JS heap-view slowdown or stale views | Keep hot work in WASM, use generated heap views, reserve once, browser benchmark |
| Eigen pool API changes | Upgrade maintenance cost | Small adapter, compile probe in CI, pin Eigen, keep OpenMP fallback research |
| Parallel floating-point order | Small numerical differences or pivot changes | Matrix checks before LU, residual/tolerance gates, multiple fixtures |
| Float factors hide an ill-conditioned system | Plausible but materially wrong currents/fields | Conservative interaction-matrix `rcond`, double matrix-free residuals, refinement, condition-adjusted acceptance, double fallback |
| Mixed refinement loses the memory benefit | Double original matrix remains beside float LU | Recompute `A*x` from geometry in bounded double tiles; assert allocation inventory |
| Float factorization is not faster in WASM | Complexity without latency benefit | Treat 2x storage as a separate gate; require 15% checked end-to-end speed before making a speed claim |
| `auto` pays for both float and double preparation | Worst-case latency exceeds the current path | Conservative preflight, record fallback rate/cost, keep explicit `double` default initially |
| Global float conversion degrades field/integration accuracy | Broad silent numerical regression | Never change global `nec_float`; narrow templates to matrix storage/algebra only |
| Cross-origin isolation side effects | Third-party embeds/auth break | Opt-in deployment, dedicated solver origin/page, document resource policies |
| Threaded helper asset missing | Runtime worker creation failure | Explicit dist manifest, packed-tarball and Vite/CDN tests |
| Assembly change only yields ~10% | Poor engineering return | Implement only after LU, enforce incremental performance gate |

## Recommended immediate sequence

1. Add the explicit stateful symmetry surface and a symmetry-aware version of
   the current array benchmark. This already demonstrated an 11.47–11.85x cold
   WASM gain on the 16 by 16 case.
2. Implement WP0 phase metrics and obtain the real WASM fill/LU split.
3. Land the dual-artifact and isolated-browser test infrastructure without
   numerical parallelism.
4. Integrate the already-proven Eigen thread-pool route and benchmark actual
   NEC matrices at 1, 2, 4, and 8 threads.
5. For symmetric models, benchmark contiguous modes and outer mode concurrency;
   for general models, proceed to the assembly workspace refactor only after
   WP3 clears its 1.5x
   end-to-end gate.
6. Enable observation-column assembly only if it clears the incremental 15%
   gate after threaded LU.
7. Once tiled assembly is stable, prototype the float matrix sink, Eigen
   `rcond`, and double matrix-free residual. Position it as a memory path until
   checked production benchmarks prove a speed benefit.
8. Treat multi-RHS port extraction and large far-field grids as separately
   measured follow-ons.

On the evidence available now, exact geometry symmetry is the first feature to
surface for compatible arrays; its measured current-WASM gain is already an
order of magnitude. Threaded Eigen LU is the best general optimization and is
reasonably likely to be worth shipping. Shared-memory column-tiled assembly is
technically sound and likely worthwhile after LU changes the phase balance.
Mixed precision is reasonably likely to be worth shipping for memory capacity,
but is not yet supported as a speed optimization: the pinned WASM probe showed
only -6% to +12% float-vs-double factor changes and checked refinement adds
O(n^2) work.
Multiple isolated full WASM workers, a native-only BLAS, a global float engine,
and GPU or fast-multipole rewrites are not the right first upgrade.

## External technical references

- [NEC-2 Part III User's Guide: GX/GR geometry symmetry and documented storage/factor reductions](https://www.nec2.org/other/nec2prt3.pdf)
- [Eigen: Eigen and multi-threading](https://libeigen.gitlab.io/eigen/docs-nightly/TopicMultiThreading.html)
- [Eigen: catalogue of dense decompositions](https://libeigen.gitlab.io/eigen/docs-nightly/group__TopicLinearAlgebraDecompositions.html)
- [Eigen: in-place matrix decompositions](https://libeigen.gitlab.io/eigen/docs-nightly/group__InplaceDecomposition.html)
- [Eigen: `PartialPivLU`, including `rcond()`](https://eigen.tuxfamily.org/dox/classEigen_1_1PartialPivLU.html)
- [Emscripten: pthreads support](https://emscripten.org/docs/porting/pthreads.html)
- [Emscripten: compiler settings, including pthread pools, stacks, and memory growth](https://emscripten.org/docs/tools_reference/settings_reference.html)
- [Emscripten: Pthreads versus Wasm Workers](https://emscripten.org/docs/api_reference/wasm_workers.html)
- [Emscripten: using SIMD with WebAssembly](https://emscripten.org/docs/porting/simd.html)
- [Emscripten: modularized output](https://emscripten.org/docs/compiling/Modularized-Output.html)
- [Carson and Higham: iterative refinement in three precisions](https://eprints.maths.manchester.ac.uk/2629/1/cahi18.pdf)
- [OpenBLAS: documented `WASM128_GENERIC` target](https://github.com/OpenMathLib/OpenBLAS#wasm)
