The target should be a versioned, stateful npm package—provisionally `@necpp/wasm`—with a high-level TypeScript API. Consumers should never touch raw WASM pointers, copy artifacts manually, parse NEC reports, or understand Emscripten.

A successful consumer experience would look like:

```ts
import { createNecModel } from "@necpp/wasm";

const model = await createNecModel();

try {
  model.addWire({
    tag: 1,
    segments: 11,
    start: [0, 0, -0.25],
    end: [0, 0, 0.25],
    radiusM: 0.001,
  });

  model.completeGeometry();

  model.definePorts([
    { tag: 1, segment: 6 },
  ]);

  model.prepare({ frequencyMHz: 300 });

  const impedance = model.computeImpedanceMatrix();

  const solution = model.solveCurrents({
    real: new Float64Array([1]),
    imag: new Float64Array([0]),
  });

  const field = model.computeFarField({
    radiusM: 1,
    theta: { startDeg: 0, count: 181, stepDeg: 1 },
    phi: { startDeg: 0, count: 361, stepDeg: 1 },
  });
} finally {
  model.dispose();
}
```

## Public numerical contract

This contract should be fixed before implementation:

- Phasor convention: \(e^{+j\omega t}\), outgoing propagation \(e^{-jkR}\).
- Geometry and distance: metres.
- Frequency: MHz at the public API, converted internally.
- Port voltage: complex volts.
- Port current: complex amperes, positive into the modeled antenna.
- Impedance: complex ohms.
- Far fields: complex V/m.
- Far-field radius: defaults to 1 m but is always retained in returned metadata.
- θ: polar angle from +Z.
- φ: azimuth from +X toward +Y.
- Far-field indexing: `index = phiIndex * thetaCount + thetaIndex`.
- Matrix indexing: documented row-major order, `row * columnCount + column`.
- Port equation:

\[
\mathbf V = \mathbf Z\mathbf I,\qquad
\mathbf I = \mathbf Y\mathbf V
\]

- RP results are far-field approximations even when `radiusM` is small.
- Fields are referenced to the model coordinate origin.
- Returned typed arrays are JS-owned copies and remain valid after subsequent solves or WASM memory growth.

The NEC execution model supports reuse of the expensive interaction-matrix factorization when only excitation changes. That behavior is described in the [NEC-2 control-card documentation](https://www.nec2.org/part_3/control.html). RP’s radius and \(e^{-jkR}/R\) convention come from the [RP card definition](https://www.nec2.org/part_3/cards/rp.html).

# Work packages

## WP0 — API and numerical specification

**Status: complete (2026-08-28).**

Deliverables:

- `docs/wasm-api.md` defining lifecycle, units, coordinate systems, phase convention and array layouts.
- Public TypeScript interfaces committed before implementation.
- Error taxonomy and state-transition table.
- Three canonical test models:
  - Center-fed dipole.
  - Two parallel coupled dipoles.
  - Four-element linear array.
- Tolerance policy for numerical tests.
- Decision on final npm name.

Recommended states:

```text
empty → geometry-building → geometry-complete → prepared → solved → disposed
```

Rules:

- Geometry can only change before `completeGeometry()`.
- Frequency, ground, loads or geometry changes invalidate factorization.
- Changing excitation or far-field sampling does not invalidate factorization.
- `prepare()` with an unchanged configuration is idempotent.
- Operations after `dispose()` throw a typed JS error.

Intermediate tests:

- TypeScript contract compiles with `strict: true`.
- State-transition table has a test for every legal and illegal transition.
- Canonical models run through the existing native API before refactoring.

DoD:

- Every public method has defined inputs, outputs, units, ownership and failure behavior.
- Port-current direction and field phase have executable tests, not only prose.
- No unresolved numerical convention remains.

### WP0 progress

- Added [`docs/wasm-api.md`](wasm-api.md) as the normative API and numerical
  specification. It fixes lifecycle behavior, units, coordinates, phasor and
  power conventions, matrix/field layouts, embedded-field normalization,
  ownership, method failures, canonical fixtures, and numerical tolerances.
- Chose `@necpp/wasm` as the final package name. The existing unscoped
  `necpp-wasm` name is occupied by a separately published distribution;
  publication of the scoped package will require control of the `necpp` npm
  scope.
- Added the strict public TypeScript contract under
  `packages/necpp-wasm/src`, including typed errors and an executable lifecycle
  transition table. The package is deliberately `private` at this stage
  because WP5 and WP7 still need to supply the runtime facade and publishable
  package assembly.
- Added TypeScript tests that enumerate all 78 operation/state pairs, exercise
  the conditional idempotent `prepare()` transition, and compile valid plus
  intentionally invalid consumer examples under TypeScript 5.8.3 with
  `strict: true`.
- Added native Catch2 baselines for the center-fed dipole, two coupled
  dipoles, and four-element phased array. These construct and solve through
  `nec_context`/`c_geometry` directly, without generating or parsing a deck.
- Added executable convention locks for current positive into the antenna via
  \(P=\tfrac12\operatorname{Re}(VI^*)\), and for the complex far-field range
  ratio \(e^{-jk\Delta R}R_1/R_2\).
- Validation completed on Windows/MSVC: all 77 native test cases pass (738
  assertions), all 5 new `[wasm_api]` cases pass (44 assertions), the strict
  TypeScript/state tests pass, and the existing deck-based WASM smoke test
  remains green.

The next open package on the critical path is WP1.

---

## WP1 — Stateful native solver layer

**Status: complete (2026-08-28).**

Introduce an explicit stateful C++ layer above `nec_context`. It should not depend on parsing or formatting a NEC deck.

Capabilities:

- Programmatic geometry construction.
- Port registration by tag/segment.
- Frequency and environment configuration.
- Explicit preparation/factorization.
- Repeated excitation solves against a retained factorization.
- Direct access to registered-port currents.
- Replacement of per-solve results rather than indefinite accumulation.
- Factorization-generation counter for deterministic cache tests.

The existing state machine in [nec_context.cpp](C:/Users/andre/VSCode_Projects/necpp/src/nec_context.cpp:1031) already separates memory allocation, structure loading and excitation. The work is to make that lifecycle explicit and safe instead of relying on `iflow` card sequencing.

Also audit mutable global state. In particular, multiple models must either be genuinely isolated or the package must instantiate separate Emscripten modules/workers where global NEC settings could interfere.

Intermediate tests:

- Existing native Catch2 and regression tests remain green.
- Two successive excitations at one frequency increment the solve count but not the factorization count.
- Changing frequency increments the factorization count.
- Changing only the far-field grid does not refactor.
- Invalid or duplicate ports fail cleanly.
- Interleaved operations on two contexts do not contaminate one another.
- Repeated solves do not grow the native result collection.

DoD:

- Geometry is constructed and solved without generating a NEC text deck.
- One prepared model supports at least 1,000 repeated excitation solves without unbounded memory growth.
- Cache invalidation is covered by deterministic unit tests.
- The legacy string/deck API remains operational.

### WP1 progress

- Added the installed native [`nec_stateful_model`](../src/nec_stateful_model.h)
  layer above `nec_context`. It owns geometry, ordered tag-relative ports,
  loads, ground, lifecycle state, preparation, retained factorization, exact
  simultaneous complex voltage solves, latest port currents, and deterministic
  factorization/solve generations without generating or parsing a deck.
- Split matrix fill/factorization from excitation in `nec_context` through a
  narrow stateful hook. The direct excitation hook accepts exact zero volts,
  bypassing the legacy EX-card near-zero substitution while leaving the card
  and deck paths unchanged.
- Added explicit result replacement to `nec_results`. A new consumer solve
  deletes prior input/field results before retaining its replacement; changing
  only the far-field grid replaces just the radiation pattern and preserves
  the latest port solution.
- Configuration mutations conservatively invalidate prepared state. Repeating
  the same preparation is a no-op; frequency, ground, and load changes advance
  the factorization generation; excitation changes advance only the solve
  generation; far-field grid changes advance neither.
- Stored electromagnetic medium parameters per `nec_context` and reactivate
  them at geometry, preparation, solve, and simulation boundaries. This makes
  sequentially interleaved contexts deterministic. The remaining concurrency
  boundary and static-state audit are documented in
  [`wp1-native-engine.md`](wp1-native-engine.md).
- Added seven native Catch2 cases covering deck-free construction/solve,
  exact-zero multi-port excitation, cache invalidation, far-field reuse,
  duplicate/missing ports, interleaved contexts, and 1,000 repeated solves.
  The stress case holds the factorization generation at one, advances the
  solve generation to 1,000, and retains one native result.
- Validation completed on Windows/MSVC: all 77 legacy native cases pass (738
  assertions), all seven WP1 cases pass (54 assertions), the CLI smoke test
  passes, and the strict TypeScript lifecycle/type tests remain green. CTest
  registers the legacy and WP1 partitions independently so each has a bounded
  timeout appropriate to its workload.

WP2 builds on this retained-factorization layer below.

---

## WP2 — Multi-port solving and impedance matrices

**Status: complete (2026-08-28).**

Add a port-oriented numerical engine:

```cpp
prepare(frequency)
solve_port_voltages(V)
compute_admittance_matrix()
compute_impedance_matrix()
solve_port_currents(I)
```

Matrix extraction:

1. Factor the interaction matrix once.
2. Apply a unit voltage to port \(j\).
3. Sample current at every registered port.
4. Store the result as column \(j\) of \(\mathbf Y\).
5. Repeat for all ports.
6. Invert \(\mathbf Y\) to obtain \(\mathbf Z\).

The implementation should bypass the current `ex_card()` behavior that changes an exactly zero source voltage to \(1+0j\) at [nec_context.cpp](C:/Users/andre/VSCode_Projects/necpp/src/nec_context.cpp:588).

Return both matrices when requested:

```ts
interface ComplexMatrix {
  readonly rows: number;
  readonly columns: number;
  readonly order: "row-major";
  readonly real: Float64Array;
  readonly imag: Float64Array;
}

interface ImpedanceResult {
  readonly impedance: ComplexMatrix;
  readonly admittance: ComplexMatrix;
  readonly conditionEstimate?: number;
  readonly frequencyMHz: number;
}
```

For requested currents, calculate:

\[
\mathbf V=\mathbf Z\mathbf I
\]

and execute one simultaneous voltage-source solve. Return requested and achieved currents, required voltages, active impedances and powers.

Intermediate tests:

- One-port matrix agrees with `nec_impedance_real/imag`.
- Two-port reciprocal geometry satisfies \(Z_{12}\approx Z_{21}\).
- \(\mathbf Z\mathbf Y\approx\mathbf I\).
- For random complex \(\mathbf V\), direct NEC currents agree with \(\mathbf Y\mathbf V\).
- For random complex \(\mathbf I\), achieved currents agree with requested currents after applying \(\mathbf Z\mathbf I\).
- Multi-source active impedance \(V_i/I_i\) changes when array weights change.
- Singular or badly conditioned matrices return a controlled diagnostic.

Suggested normal tolerance:

\[
\frac{\lVert a-b\rVert}{\max(1,\lVert a\rVert,\lVert b\rVert)}
\le 10^{-7}
\]

Use fixture-specific looser tolerances for independent NEC-2 golden values.

DoD:

- Full complex \(N\times N\) Z and Y matrices are available without parsing text.
- Matrix computation performs one factorization per model/frequency.
- Arbitrary simultaneous complex voltage and current excitations are supported.
- All returned port quantities have stable ordering matching `definePorts()`.

### WP2 progress

- Extended [`nec_stateful_model`](../src/nec_stateful_model.h) with dense
  row-major port matrices, cached admittance and impedance results, detailed
  voltage-driven solutions, and current-driven solutions using
  \(\mathbf V=\mathbf Z\mathbf I\). The original WP1 current-only voltage
  return remains as a compatibility wrapper.
- Admittance extraction performs one exact unit-voltage back-substitution per
  port and stores the current responses as columns of \(\mathbf Y\). It never
  refactors the NEC interaction matrix. Results are cached until frequency,
  ground, or loads invalidate the prepared configuration.
- Added SVD-based inversion with a two-norm condition estimate and a controlled
  diagnostic for singular matrices or estimates above \(10^{12}\). Both
  \(\mathbf Z\) and \(\mathbf Y\), frequency, and factorization generation are
  retained in the matrix result.
- Internal basis solves preserve the public lifecycle and latest consumer
  solution. If a solution existed, its exact simultaneous voltage excitation
  is restored without advancing the public solve generation; from `prepared`,
  matrix extraction leaves no arbitrary basis result behind.
- Detailed port results contain requested drive values, achieved voltages and
  currents, active impedances, per-port time-average powers, frequency, and
  deterministic generations. An exactly zero achieved current produces the
  specified `NaN + jNaN` active impedance.
- Added seven WP2 Catch2 cases covering one-port legacy impedance agreement,
  two-port reciprocity, \(\mathbf Z\mathbf Y\approx\mathbf I\), arbitrary
  voltage prediction, arbitrary current achievement, weight-dependent active
  impedance, cache/frequency behavior, exact-zero current drive, and controlled
  singular/ill-conditioned inversion.
- Validation completed on Windows/MSVC: the WP2 partition passes all 65
  assertions, all WP1 cases including the 1,000-solve stress test remain green,
  the 77-case legacy/WP0 partition and CLI smoke test pass, all production
  native targets build, and the strict TypeScript tests remain green.

The next open package on the critical path is WP3.

---

## WP3 — Complex far-field API

**Status: complete (2026-08-28).**

Expose bulk far-field results from the most recent current solution:

```ts
interface FarFieldResult {
  readonly radiusM: number;
  readonly frequencyMHz: number;

  readonly thetaDeg: Float64Array;
  readonly phiDeg: Float64Array;

  readonly eThetaReal: Float64Array;
  readonly eThetaImag: Float64Array;
  readonly ePhiReal: Float64Array;
  readonly ePhiImag: Float64Array;
}
```

Use the existing complex arrays in [nec_radiation_pattern.h](C:/Users/andre/VSCode_Projects/necpp/src/nec_radiation_pattern.h:138). Gain and polarization can be added later or derived from complex fields, but the raw fields must remain the primary API.

Add two calculation paths:

- `computeFarField()`: field for the latest combined excitation.
- `computeEmbeddedFarFields()`: one field basis per port, with a clearly defined voltage or current normalization.

Embedded fields allow instant JS-side beamforming:

\[
E_\theta=\sum_n w_n E_{\theta,n},\qquad
E_\phi=\sum_n w_n E_{\phi,n}
\]

Intermediate tests:

- At 1 m and 2 m, magnitude changes by exactly the expected \(1/R\) factor.
- Phase difference follows \(-k\Delta R\), modulo \(2\pi\).
- Direct combined NEC field agrees with the complex sum of basis fields.
- Zero excitation produces zero fields without NaNs.
- θ/φ array ordering agrees with `get_index()`.
- A symmetric dipole has the expected pattern nulls and symmetry.
- Native and WASM far-field arrays agree within tolerance.

DoD:

- Complex \(E_\theta\) and \(E_\phi\) are available at 1 m in V/m.
- Direct combined fields and superposed basis fields agree numerically.
- Returned data contains enough metadata to interpret every sample without external assumptions.
- No formatted NEC report parsing occurs.

### WP3 progress

- Replaced the temporary raw radiation-pattern return from
  [`nec_stateful_model`](../src/nec_stateful_model.h) with copied complex
  far-field results containing radius, frequency, theta/phi axes, and
  theta-fast \(E_\theta\)/\(E_\phi\) vectors in V/m.
- Added voltage- and current-normalized embedded fields in stable port-major
  order. Current bases use columns of the cached impedance matrix, so arbitrary
  current weights superpose directly.
- Internal embedded-field solves preserve a prior consumer solution, public
  lifecycle state, factorization generation, and solve generation. Starting
  from `prepared`, they leave no arbitrary basis result behind.
- Added explicit exact-zero handling so a zero excitation returns finite exact
  zero fields without entering NEC's gain-normalization calculations.
- Added six WP3 Catch2 cases covering copied metadata and indexing, the
  complex radial propagation law, voltage and current basis superposition,
  solution restoration, exact-zero output, and center-fed dipole
  nulls/symmetry, plus deterministic zero output for ground-skipped angles.
- Added [`docs/wp3-complex-far-field.md`](wp3-complex-far-field.md) documenting
  field ownership, layouts, normalizations, lifecycle behavior, and
  beamforming equations. Native-to-WASM equality remains an ABI integration
  assertion for WP4 because the stateful C boundary does not exist yet.
- Validation completed on Windows/MSVC and Linux/GCC: all six WP3 cases pass
  with 206 assertions, the WP0/WP1/WP2 partitions remain green, both native
  production targets build, and the legacy CLI smoke test passes.

The WP4 boundary built on these results is summarized below.

---

## WP4 — Stable C/WASM ABI

Do not expose C++ classes through Embind. Add a small versioned C ABI with opaque handles, for example:

```c
necpp_model_t* necpp_wasm_v1_model_create(void);
void necpp_wasm_v1_model_delete(necpp_model_t*);

int necpp_wasm_v1_add_wire(...);
int necpp_wasm_v1_define_ports(...);
int necpp_wasm_v1_prepare(...);
int necpp_wasm_v1_solve_voltages(...);
int necpp_wasm_v1_compute_impedance(...);
int necpp_wasm_v1_compute_far_field(...);

const char* necpp_wasm_v1_last_error(necpp_model_t*);
```

Boundary rules:

- No exception crosses the ABI.
- Every mutating/calculation function returns a status code.
- Every context retains its own last-error string.
- Inputs use pointer-plus-length arrays.
- Bulk outputs use model-owned contiguous buffers.
- The TypeScript wrapper immediately copies borrowed buffers into JS-owned arrays.
- Export `_malloc`, `_free` and the required typed heap views internally.
- Include ABI and engine-version getters.

Intermediate tests:

- Native C test exercises every ABI function.
- Null pointers, wrong dimensions and illegal state calls return controlled errors.
- Invalid geometry does not trap the WASM runtime.
- Delete is safe after partial initialization.
- Repeated create/prepare/solve/delete cycles do not leak.
- WASM memory growth does not invalidate already returned JS results.

DoD:

- The generated Emscripten module exposes only the documented ABI and necessary runtime memory helpers.
- The public JS layer contains no C++ ownership concepts.
- ABI versioning allows future additions without silently changing existing signatures.

### WP4 progress

- Added the C-compatible
  [`necpp_wasm_v1.h`](../src/necpp_wasm_v1.h) boundary with opaque stateful
  model and complete-deck handles. Every symbol is versioned and ABI/engine
  version getters are available.
- Contained all native exceptions and added stable state, input, geometry,
  port, conditioning, solver, and runtime status categories with a diagnostic
  string retained independently by each handle.
- Added pointer-plus-length port and complex-drive inputs. Matrices, complete
  port solutions, combined complex fields, and embedded complex fields are
  copied into model-owned split binary64 buffers with explicit lengths and
  scalar metadata.
- Restricted the generated Emscripten surface to the versioned ABI,
  `_malloc`/`_free`, and the required `HEAPU8`, `HEAP32`, and `HEAPF64` views.
  The unversioned deck ABI and `ccall`/`cwrap` helpers are no longer exported.
- Added a contract test compiled as C and a native-to-ABI bulk-buffer
  comparison in the `[wp4]` partition. They cover controlled failures,
  lifecycle and invalidation behavior, every result family, both drive and
  embedded normalization modes, deck compatibility, and repeated cleanup.
- Expanded the Docker smoke test to perform real matrix, solve, combined-field,
  embedded-field, and deck operations through direct WASM exports. It also
  forces memory growth after copying a field result.
- Added [`docs/wp4-stable-wasm-abi.md`](wp4-stable-wasm-abi.md) as the ABI,
  ownership, status, and Emscripten export reference.

The next open package on the critical path is WP5.

---

## WP5 — TypeScript facade

**Status: complete (2026-08-28).**

Create a handwritten TypeScript layer that is the actual package API.

Responsibilities:

- Initialize Emscripten asynchronously.
- Locate `nec2pp.wasm`.
- Allocate and copy input arrays.
- Copy result buffers out of WASM.
- Enforce state and array dimensions.
- Convert native status codes into typed errors.
- Hide handles, pointers, `ccall`, `cwrap` and heaps.
- Provide deterministic `dispose()`.
- Retain `runDeck(deck)` as a compatibility escape hatch.

Suggested exports:

```ts
createNecModel()
NecModel
NecError
NecGeometryError
NecSolverError
NecStateError
ComplexVector
ComplexMatrix
PortDefinition
PortSolution
FarFieldRequest
FarFieldResult
```

The current modular ES factory is a sound foundation: Emscripten documents that `MODULARIZE` produces an asynchronous factory and allows isolated module instances. [Emscripten modularized output](https://emscripten.org/docs/compiling/Modularized-Output.html)

Intermediate tests:

- Strict TypeScript compile.
- Public API type tests with both valid and intentionally invalid examples.
- Node ESM runtime tests.
- Consumer never imports generated Emscripten types.
- Returned arrays remain valid after the model is solved again.
- Double-disposal is harmless or produces one documented result.
- Operations after disposal fail predictably.

DoD:

- The normal consumer never sees the generated `MainModule`.
- Quick-start code contains no filesystem paths, `locateFile`, raw memory or glue-module calls.
- Node and browser expose the same public types and numerical behavior.

### WP5 progress

- Implemented the handwritten facade under
  [`packages/necpp-wasm/src`](../packages/necpp-wasm/src). `createNecModel()`
  asynchronously creates an isolated modular Emscripten instance, resolves the
  adjacent `nec2pp.wasm` by default, and accepts mutually exclusive `wasmUrl`
  and copied `wasmBinary` overrides.
- Added runtime validation for geometry, ports, loads, ground, frequency,
  complex-vector dimensions, finite values, and far-field grids. The facade
  enforces the public state machine before crossing the ABI and maps every v1
  status category to its documented `NecError` subclass.
- Added private allocation helpers for split `Int32Array` and `Float64Array`
  inputs. Every matrix, solution, coordinate axis, combined field, and
  embedded field is copied immediately into JavaScript-owned arrays; generated
  Emscripten types and heap views remain private.
- Added idempotent deterministic `dispose()`, frozen port snapshots, and the
  asynchronous `runDeck()` compatibility path with UTF-8 ownership and
  pre-start abort handling.
- Added strict emit/type tests and Node ESM integration tests covering a real
  dipole matrix, repeated solves, copied-result lifetime, combined and embedded
  fields, disposal, default/URL/binary loading, controlled errors, and complete
  deck execution. The pinned Docker WASM build stages its generated artifacts
  privately and runs the full facade suite.

The next open package on the critical path is WP7; WP6 worker support is
complete and can land independently of package assembly.

---

## WP6 — Web Worker entry point

**Status: complete (2026-08-28).**

Browser solves are synchronous and potentially expensive, so include an optional worker facade:

```ts
import { createNecWorkerModel } from "@necpp/wasm/worker";

const model = await createNecWorkerModel();
```

Worker requirements:

- Preserve state across requests.
- Transfer large result `ArrayBuffer`s instead of cloning.
- Serialize operations per model.
- Report progress at coarse operation boundaries.
- Support termination as the cancellation mechanism.
- Keep the direct non-worker entry point for Node, tests and small models.

Intermediate tests:

- A browser heartbeat continues while a worker calculation runs.
- Z matrices and fields match direct-mode results.
- Large arrays are transferred, not duplicated.
- Termination releases the worker and rejects outstanding operations.
- Two worker models run independently.

DoD:

- A browser application can perform realistic solves without blocking its UI thread.
- Worker setup requires only importing the documented subpath.
- No consumer-authored worker bootstrap file is needed.

### WP6 progress

- Added `createNecWorkerModel()` on the `@necpp/wasm/worker` subpath. The
  package ships `worker-entry.ts`; the client constructs
  `new Worker(new URL("./worker-entry.js", import.meta.url), { type: "module" })`
  in browsers and uses `node:worker_threads` in Node. No consumer bootstrap
  file is required.
- Each worker model keeps one isolated Emscripten instance and native handle
  across requests. Client calls are serialized per model. Two worker models
  do not share state.
- Result `ArrayBuffer`s are posted with a transfer list. Input typed arrays
  are copied first so caller buffers are never detached. Port snapshots are
  re-frozen on the client.
- Coarse `start`/`complete` progress events are emitted at operation
  boundaries, including worker-only `create`. `terminate()` kills the worker
  and rejects outstanding work; `dispose()` destroys the native model first.
- Added protocol, loopback-host, and Node ESM tests for transfer (detached
  buffers), heartbeats during outstanding work, queue serialization,
  independent models, typed-error revival, and termination. Real WASM
  integration compares Z matrices and far fields with direct mode at `1e-12`
  when artifacts are present.
- Documented the worker contract in [`docs/wasm-api.md`](wasm-api.md) and
  [`docs/wp6-web-worker.md`](wp6-web-worker.md). Direct `createNecModel()` is
  unchanged.

The next open package on the critical path is WP7; browser CI for the worker
subpath is WP8.

---

## WP7 — npm package assembly

**Status: complete (2026-08-28).**

Recommended layout:

```text
packages/necpp-wasm/
  package.json
  README.md
  COPYING
  src/
    index.ts
    model.ts
    types.ts
    worker-client.ts
    worker-entry.ts
  dist/
    index.js
    index.d.ts
    worker.js
    worker.d.ts
    nec2pp.generated.js
    nec2pp.wasm
```

`package.json` should include:

```json
{
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./worker": {
      "types": "./dist/worker.d.ts",
      "import": "./dist/worker.js"
    }
  },
  "files": [
    "dist",
    "README.md",
    "COPYING"
  ],
  "license": "GPL-2.0-or-later"
}
```

npm recommends `"type": "module"` for ESM packages, while `"exports"` defines and encapsulates the supported entry points. [npm package metadata](https://docs.npmjs.com/files/package.json/)

The wrapper should resolve the WASM using:

```ts
new URL("./nec2pp.wasm", import.meta.url)
```

and still accept optional `wasmUrl` or `wasmBinary` overrides. Emscripten’s supported relocation hook is `locateFile`. [Emscripten Module API](https://emscripten.org/docs/api_reference/module)

Package testing must use the packed tarball:

```text
npm pack
→ install generated .tgz in clean fixture
→ import package by name
→ execute actual solve
```

Never let package tests accidentally import workspace source files.

Intermediate tests:

- `npm pack --dry-run` contains only intended files.
- Clean Node fixture imports the tarball and runs a dipole.
- Clean Vite fixture builds and serves it.
- Browser fixture loads the `.wasm` with the correct URL and MIME type.
- Worker subpath works after bundling.
- Custom `wasmUrl` works for CDN deployments.
- No dependency on the original repository directory exists.

DoD:

- Another repository can run `npm install <package>` followed by a normal ESM import.
- No artifact copying or bundler-specific source changes are necessary.
- Package version, engine version and ABI version are exposed and documented.
- `COPYING` and license metadata are included. Because the engine is GPL-2.0-or-later, downstream distribution implications must be clearly documented and reviewed for the intended product.

### WP7 progress

- Assembled `@necpp/wasm` as an ESM package with `exports` for `.` and
  `./worker`, a `dist/` emit of the handwritten facade, and the generated
  `nec2pp.generated.js` plus `nec2pp.wasm` copied beside it. `prepack` builds
  that tree, copies `COPYING`, and rejects source maps, oversize artifacts,
  and version drift against `package.json` and CMake.
- Exported `packageVersion`, `engineVersion`, and `abiVersion`. Module
  instantiation checks the native ABI and engine strings. HTTP(S) `wasmUrl`
  values are fetched into a copied `wasmBinary` so CDN loading works in Node.
- Added clean-consumer tests that `npm pack`, install the tarball in a
  temporary fixture, import the package by name, solve a dipole in direct and
  worker mode, load WASM from an HTTP URL, and build a Vite app that emits
  the worker and serves `.wasm` as `application/wasm`. Those tests never
  import workspace `src/` or `.test-build`. Direct mode needs no bundler
  config; the Vite worker fixture sets `worker: { format: "es" }` and
  `build.target: "es2022"` because the package ships an ES2022 module worker.
- Documented GPL-2.0-or-later distribution implications in the package
  README and [`docs/wp7-npm-package.md`](wp7-npm-package.md). The package
  remains `private` until the `necpp` npm scope is available.

The next open package on the critical path is WP8.

---

## WP8 — CI and release pipeline

Extend the existing WASM workflow in [.github/workflows/build.yml](C:/Users/andre/VSCode_Projects/necpp/.github/workflows/build.yml:1).

Required CI jobs:

1. Native build and Catch2 tests.
2. Native port/matrix/far-field tests.
3. Reproducible Emscripten build using the pinned SDK.
4. Node WASM ABI tests.
5. TypeScript facade tests.
6. `npm pack` clean-consumer test.
7. Browser direct-mode integration test.
8. Browser worker integration test.
9. Artifact size and checksum reporting.

Keep Emscripten and TypeScript versions pinned. Upgrade them deliberately in isolated changes. Emscripten’s `--emit-tsd` may continue producing internal glue typings, but the handwritten package types remain authoritative. [Emscripten compiler documentation](https://emscripten.org/docs/tools_reference/emcc.html)

Initial accidental-debug-build guards can be generous:

- WASM binary under 1 MiB.
- Generated loader under 200 KiB.
- No source maps or debug symbols in release package unless intentionally published.

Release flow:

- Tag-driven release.
- Run the complete CI matrix.
- Build package once.
- Publish the same tested tarball to npm.
- Attach tarball and checksums to the GitHub release.
- Use semantic versioning for the public TypeScript API.
- Keep engine, package and ABI versions synchronized or explicitly map them.

DoD:

- Published bytes are the same bytes tested in the clean consumer jobs.
- Failed numerical, browser, packaging or licensing checks prevent publication.
- A release can be reproduced from a tagged checkout and pinned toolchain.

---

## WP9 — Documentation and example application

Documentation must include:

- Five-minute installation and dipole example.
- Geometry and port definition.
- Z/Y matrix interpretation.
- Voltage-driven and current-driven arrays.
- Active impedance versus matrix impedance.
- Complex far-field convention at 1 m.
- θ/φ coordinate diagram.
- Array beamforming example using embedded fields.
- Direct mode versus worker mode.
- Model lifecycle and disposal.
- Browser, Node, Vite and CDN loading.
- Error handling.
- Performance and browser-memory guidance.
- GPL licensing notice.

Add a minimal Vite example that:

1. Builds a two- or four-element array.
2. Computes its impedance matrix.
3. Applies complex current weights.
4. Displays port voltage/current values.
5. Plots an azimuth far-field cut.

The example must install the packed package rather than reach into the monorepo.

DoD:

- A fresh checkout of the example can install, build and run using only documented commands.
- Every README code example is compiled or executed in CI.
- The example demonstrates the exact intended downstream integration path.

# Overall release Definition of Done

The package is ready when all of the following are true:

- `npm install` plus `import { createNecModel }` works in a separate repository.
- Geometry, ports and frequency can be configured without generating a text deck.
- Factorization is reused across excitation and far-field requests.
- Full complex Z and Y matrices are returned.
- Arbitrary simultaneous voltage and current excitation is supported.
- Resulting complex port voltages and currents are returned.
- Complex \(E_\theta\) and \(E_\phi\) at 1 m are returned in V/m.
- Direct combined fields agree with embedded-pattern superposition.
- All public numerical conventions are documented and tested.
- Results cross the WASM boundary through bulk typed arrays.
- No raw pointer, heap, `ccall` or generated Emscripten type is public.
- Direct browser, Web Worker and Node ESM consumers pass integration tests.
- Repeated solves and model lifecycles do not leak or accumulate results.
- Existing native and legacy deck behavior remains compatible.
- The exact packed tarball passes clean-consumer tests before publication.
- Versioning, licensing, release artifacts and documentation are complete.

The completed critical path is WP0 → WP1 → WP2 → WP3 → WP4 → WP5 → WP7.
Remaining release work is WP8 (CI and release pipeline) and WP9 (documentation
and example application).
