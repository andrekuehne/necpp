# NEC field backend prerequisite guide

## Status and decision

**Decision: complete a narrow set of features in `necpp` before planning the
third backend in this repository.**

The intended boundary is now deliberately smaller than full feature parity with
the existing coupled-wire solver. The NEC engine is another, higher-fidelity
source of combined complex `E_theta` and `E_phi` fields. It does not need to own
the visualizer's matching, polarization, normalization, or pattern-analysis
layers.

The published `@necpp-engine/wasm` 0.2.0 package already owns geometry,
frequency preparation, retained factorization, Z/Y, voltage/current solves, and
native NEC far-field calculation. Two correctness gaps and one optimization
rule remain:

1. the high-level array facade cannot faithfully request the PEC ground
   connection needed by rooted monopoles;
2. the public field request is limited to regular theta/phi sweeps rather than
   the visualizer's UV, spherical, and Ludwig-3 product grids; and
3. normal integration must use NEC's existing native combined-field path. If a
   reusable embedded-field optimization is added, it must retain and superpose
   the basis inside WASM rather than export it for consumer JavaScript loops.

Those features belong in the NEC backend. After they are published, the
visualizer can perform matching and postprocessing with its existing Rust/WASM
machinery without another NEC request.

This document is therefore the requested prerequisite guide for the other
repository agent, not an implementation plan for this repository.

## Evidence reviewed

The decision follows the requested three-step analysis:

1. **This repository.** `WasmEngine` already separates field production from
   field views. Its `WasmPatternPost` retains one combined complex field and
   derives total/theta/phi/LHCP/RHCP/Ludwig-3 views, phase, EIRP, directivity,
   gain, realized gain, and beam metrics without re-driving the physics backend.
   Matching and power-wave calculations are also already implemented in the
   coupled network layer.
2. **Handoff and npm contract.** The supplied handoff is byte-identical to the
   copy in the adjacent `necpp` repository. npm reported
   `@necpp-engine/wasm` 0.2.0 as `latest` on 2026-08-31, and its published README
   matches the local package README. The handoff was treated as technical
   evidence rather than as instructions overriding this task.
3. **NEC implementation.** The adjacent checkout at
   `C:/Users/andre/VSCode_Projects/necpp` was inspected at commit
   `bd5f96487791a704f027c811b0cdd4961ec24ea5`. The review covered the public
   types, `array-solver.ts`, direct and worker facades, native WASM ABI,
   symmetry tests/benchmarks, large-array investigation, and the proposed
   persisted port-current response model. No clone was needed.

## Final ownership boundary

### NEC package and its WASM instance own

- conversion of a complete array description into explicit or symmetric NEC
  geometry;
- geometry completion, including the requested ground-connection policy;
- frequency preparation and retained factorization;
- Z/Y formation and voltage- or current-driven port solutions;
- display and integration grid directions, masks, axes, and quadrature weights;
- reusable direction state and any optional current/embedded-field response
  cache;
- cache budgeting, tiling, and fallback behavior when such a cache is enabled;
- all per-port/per-sample complex far-field work, whether evaluated directly
  from the latest NEC solution or through a cached response basis; and
- return of the latest combined `E_theta` and `E_phi` arrays in stable caller
  and grid order.

### Visualizer owns

- editable array, element, taper, quantization, and steering configuration;
- conversion from wavelength-relative UI geometry to metres/MHz;
- calculation of a desired current or voltage vector, including matching and
  power-wave/source-network behavior;
- S matrices and matching optimization derived from the returned Z matrix;
- integration/normalization using the returned field quadrature;
- polarization transforms and quantity selection using the existing
  `WasmPatternPost` machinery;
- HPBW, sidelobes, pointing, squint, and other retained-field metrics;
- request coalescing and stale-result rejection; and
- dB mapping, clipping, colors, Plotly layout, and interaction.

### Explicit non-goals for `necpp`

The prerequisite release does **not** need to add:

- common-reference S or power-wave excitation;
- reference-resistance or series-reactance optimization;
- application-specific incident/reflected/accepted power semantics;
- LHCP/RHCP or Ludwig-3 field products;
- EIRP, directivity, gain, or realized gain arrays;
- HPBW, sidelobe, squint, or peak metrics; or
- Plotly-oriented data transforms.

The NEC package should return enough raw complex field information and grid
metadata for the visualizer's existing WASM postprocessor to calculate these
without further NEC work.

## What "inside WASM, not JavaScript" means

TypeScript may validate requests, manage the worker, and marshal typed arrays.
It must not execute the hot electromagnetic loops. In particular:

- no TypeScript loop may combine `ports * samples` embedded responses;
- no full embedded basis is transferred to the visualizer during normal
  steering;
- grid-to-direction expansion and validity masking execute in the NEC WASM
  engine;
- native combined-field evaluation and any cached/tiled response
  superposition execute in the NEC WASM engine; and
- normal results contain only one combined `E_theta/E_phi` field per requested
  grid, plus compact metadata and the port solution.

Postprocessing that is intentionally visualizer-owned should likewise stay out
of ordinary TypeScript loops. The application can bind the returned arrays to
its existing Rust/WASM `WasmPatternPost`; changing polarization or quantity then
does not call NEC again.

## Target public session contract

Names are illustrative. Preserve the current public API and add this behavior
through `NecArraySolver` or a new public facade. Do not require package-internal
imports.

```ts
type NecProductGrid =
  | { kind: "uv"; n1: number; n2: number }
  | {
      kind: "spherical";
      n1: number;
      n2: number;
      domain: "upper-hemisphere" | "full-sphere";
    }
  | { kind: "ludwig3"; n1: number; n2: number };

interface PrepareFieldSessionOptions {
  readonly display: NecProductGrid;
  readonly integration: "auto" | NecIntegrationGridOptions;
  /** Optional acceleration; zero or omission selects the native direct path. */
  readonly responseCacheBudgetBytes?: number;
}

interface PreparedGrid {
  readonly kind: NecProductGrid["kind"];
  readonly n1: number;
  readonly n2: number;
  readonly axis1: Float64Array;
  readonly axis2: Float64Array;
  readonly phiRad: Float64Array;
  readonly valid: Uint8Array;
  /** Empty for a display-only grid; solid-angle weights for integration. */
  readonly solidAngle: Float64Array;
}

interface CombinedField {
  readonly gridGeneration: number;
  readonly solutionGeneration: number;
  readonly eThetaReal: Float64Array;
  readonly eThetaImag: Float64Array;
  readonly ePhiReal: Float64Array;
  readonly ePhiImag: Float64Array;
}

interface NecFieldEvaluation {
  readonly solution: PortSolution;
  readonly display: CombinedField;
  readonly integration: CombinedField;
  readonly cache: NecFieldCacheDiagnostics;
}

interface NecArrayFieldSolver extends NecArraySolver {
  prepareFields(options: PrepareFieldSessionOptions): Promise<{
    display: PreparedGrid;
    integration: PreparedGrid;
  }>;
  evaluateCurrents(currents: ComplexVector): Promise<NecFieldEvaluation>;
  evaluateVoltages(voltages: ComplexVector): Promise<NecFieldEvaluation>;
  terminate(): void;
}
```

Returning the integration field is intentional. The visualizer can pass it and
the solid-angle weights to its existing WASM power/polarization integration,
then bind the display field and the resulting power scalars to
`WasmPatternPost`. The NEC package need not understand visualizer quantities.

An alternative arbitrary-unit-direction API is acceptable if the product-grid
descriptor remains package-owned and the normal app path does not construct the
direction arrays in TypeScript.

## Lifecycle and invalidation

```text
create array description
  -> geometry-complete
  -> prepare(frequency)            retains NEC factorization and Z/Y
  -> prepareFields(grids, budget)  retains directions and response state
  -> evaluateCurrents/Voltages     retains latest solution and combined fields
```

- Excitation changes reuse geometry, factorization, grids, and any compatible
  response cache. They may evaluate the combined native NEC field directly.
- A display-grid change invalidates display directions/responses and combined
  display fields, but not factorization. An unchanged integration grid may be
  retained.
- A frequency change invalidates factorization, response caches, and combined
  fields. Immutable geometry may remain reusable under the existing solver
  lifecycle.
- Geometry, ports, loads, ground, or ground-connection changes require a new
  solver.
- A cache-budget change may retain entries that fit, but cannot change the
  numerical result.
- Solution, grid, and field generations must make atomicity observable. A
  result cannot combine a new solution with old fields or metadata.

## Numerical contract

### Product grids

The package must define UV, spherical, and Ludwig-3 axes and look directions
normatively. They should match this application's current convention:

- UV: axes `u,v` over `[-1,1]`; cells outside the visible disk are invalid;
- spherical: theta down from +Z and phi from +X toward +Y;
- Ludwig-3: azimuth/elevation product axes over the visible hemisphere; and
- product ordering: first-axis-fast row-major
  `sample = i2 * n1 + i1`.

The returned validity mask prevents the visualizer from mistaking invalid UV
corners or back-hemisphere cells for physical zero field. Tests must cover
`n1 != n2`, both dimensions greater than one, axis endpoints, horizon cells,
and azimuth wrapping.

### Integration grid

The integration grid is separate from the display grid and includes
solid-angle weights. `"auto"` chooses a resolution from electrical size and
environment. The public contract must state whether it covers the upper
hemisphere or full sphere and how that choice relates to perfect, finite, or no
ground.

The visualizer will perform the actual field integration in its existing WASM
code. Therefore the NEC package must return complex fields, `phi`, validity,
and weights that form a self-consistent quadrature. It need not return
directivity or gain.

### Field convention

Keep the existing public NEC convention:

- split-complex `E_theta` and `E_phi` in V/m;
- `e^(+j omega t)` phasors and `e^(-jkR)` outgoing propagation;
- theta-fast semantics replaced by the explicit product-grid ordering above;
  and
- fields referenced to the caller's model origin, including the existing phase
  correction for automatically recentered symmetric arrays.

The result must explicitly state the field radius or fix it normatively at 1 m.
The visualizer will reconcile peak/RMS normalization when adapting the NEC
field to its postprocessor; the NEC engine must not silently change its current
amplitude convention.

### Stateful combined-field evaluation

The correctness baseline already exists: `solveCurrents()` or
`solveVoltages()` retains the latest NEC current state, and
`computeFarField()` evaluates its combined field inside native WASM. The new
product-grid session should preserve that path rather than forcing callers
through `computeEmbeddedFarFields()`.

An optimized implementation may retain a unit-current embedded-field basis or
the proposed raw port-current basis. Either direct or cached evaluation is
acceptable if:

- all complex multiplication/summation occurs inside WASM;
- the result agrees with `solve*()` followed by the existing native
  `computeFarField()`;
- any cache budget and tiling do not affect the result;
- the native direct-compute path remains the low-memory fallback; and
- the normal worker response is O(samples + ports), never
  O(samples * ports).

The proposed persisted raw port-current response model in
`necpp/docs/wp10-port-current-persistence.md` may accelerate repeated solves,
but it is complementary. A raw-current basis, an embedded-field basis, and a
prepared direction grid need separate identities and invalidation rules.

## Work packages for `necpp`

### NEC-PAV-0 — Freeze the narrow public contract

Tasks:

- Turn the illustrative types, state transitions, units, ordering, and
  generation rules above into a normative public contract.
- Decide whether the feature extends `NecArraySolver` or adds a compatible
  facade.
- Specify cache identity, budget behavior, tiling, and fallback.
- Specify display versus integration grids and environment-dependent
  integration domains.
- Keep all matching and derived-pattern work explicitly out of scope.

DoD:

- A consumer can implement the visualizer adapter using only public imports and
  no electromagnetic loop in TypeScript.
- Existing 0.2.0 direct, worker, and array APIs remain source compatible.
- Every returned array has units, dimensions, ordering, ownership, and
  generation documented.
- Contract fixtures include two ports and a non-square grid.

### NEC-PAV-1 — High-level PEC ground connection

Tasks:

- Extend `FullArrayDescription` or its replacement with the geometry-completion
  ground-connection policy currently available only to the low-level model.
- Represent dipoles above a PEC plane and monopoles electrically rooted on it
  without relying on an undocumented endpoint tolerance.
- Include the policy in model identity, validation, symmetry eligibility,
  diagnostics, and fallback behavior.
- Preserve explicit fallback for tilted/off-axis straight-wire patterns outside
  the first symmetry optimizer.

DoD:

- A centre-fed dipole above perfect ground matches an equivalent low-level
  model for Z, port solution, and complex far field.
- A base-fed monopole connected to perfect ground matches its equivalent
  low-level model for the same quantities.
- Invalid ground/connection combinations fail with typed input or geometry
  errors.
- Explicit and eligible symmetric models preserve caller port order.

### NEC-PAV-2 — Product grids inside the WASM engine

Tasks:

- Add UV, spherical, and Ludwig-3 product-grid descriptors to native C++, the
  stable C ABI, direct facade, worker protocol, and array facade.
- Generate axes, directions, phi, validity, and integration weights in WASM.
- Add separate display and automatic integration grids.
- Support bounded field tiles and preserve caller-origin rephasing after
  symmetry recentering.

DoD:

- Direct, worker, explicit-array, and symmetric-array paths return identical
  complex fields for all three frames within documented tolerance.
- Tests cover non-square grids, invalid UV corners, horizon boundaries,
  full/upper sphere domains, and off-origin rephasing.
- Grid metadata alone is sufficient for the visualizer to bind the combined
  field to its existing postprocessor.
- No visualizer-side spherical interpolation or TypeScript direction expansion
  is required.
- Changing tile size does not change ordering or numerical values.

### NEC-PAV-3 — Prepared-grid native evaluation and optional WASM acceleration

Tasks:

- Add `prepareFields()` and retain grid directions in the model's WASM memory.
- Implement current- and voltage-driven evaluation that returns the port
  solution and combined display/integration fields atomically.
- Use the existing native solve plus combined-field calculation as the required
  correctness and low-memory path.
- Benchmark repeated steering. If response caching is needed to meet the agreed
  interaction target, implement the embedded-response or retained-current
  optimization entirely inside WASM with a byte budget, diagnostics, and
  tiling.
- Preserve the latest consumer solution while preparing any internal bases.
- Never transfer the full embedded basis in the normal path.

DoD:

- At least five complex multiport steering vectors agree with the existing
  direct native field path for both field components.
- Current-driven and voltage-driven evaluations both preserve the requested and
  achieved port solution semantics.
- Explicit and symmetric representations agree in caller order.
- Repeated excitation changes cause no geometry rebuild or factorization.
- The zero-cache/direct path is finite-memory and agrees with any accelerated
  path. If caching is exposed, a cache hit performs no basis recomputation and
  an insufficient budget falls back deterministically.
- Transfer diagnostics prove O(display samples + integration samples + ports)
  output, not O(samples * ports).
- Zero excitation returns exact zero combined fields and cannot expose stale
  values.

### NEC-PAV-4 — Worker reliability, progress, and atomic generations

Tasks:

- Expose immediate `terminate()` on the high-level array field facade.
- Add progress phases for planning, geometry, preparation, response
  preparation, display/integration tiles, and completion.
- Define cancellation boundaries and worker replacement behavior.
- Make solution, fields, grids, and cache diagnostics one atomic generation.
- Preserve typed `NecError` mapping across worker death and WASM memory growth.

DoD:

- Termination during each long phase promptly rejects outstanding promises,
  leaks no worker, and leaves the facade disposed.
- Failed or superseded operations cannot publish mixed generations.
- Progress is monotonic within a generation and does not materially affect
  runtime.
- Repeated replacement/disposal leaves no accumulating WASM instances or
  response buffers.

### NEC-PAV-5 — Performance decision and published-package gates

Tasks:

- Benchmark cold preparation, field preparation, repeated native combined-field
  evaluation, transfer bytes, and peak worker/WASM memory. Benchmark cache bytes
  as well if NEC-PAV-3 adds the optional acceleration.
- Use the existing 16 x 16, 11-segment symmetric array plus an explicit/fallback
  case.
- Include app-shaped 256 x 256 display grids in regular coverage and a scheduled
  high-resolution budget case.
- If caching is shipped, test a deliberately insufficient cache budget.
- Run from the packed npm tarball in Node direct, worker, Chromium, and a Vite
  consumer.
- Update the npm README, normative WASM API document, changelog, declarations,
  and version diagnostics.

DoD:

- Repeated steering has recorded medians and memory/transfer evidence. The
  results explicitly decide whether the direct native path is sufficient or a
  response cache is required.
- The 16 x 16 case never exports its embedded field basis during normal
  evaluation.
- Clean consumers use only documented package exports and do not copy a WASM
  artifact, import source internals, or parse a NEC report.
- Production Vite loads the package worker and WASM with the correct MIME type.
- Browser tests cover termination, memory growth, grid replacement, and
  repeated steering.
- A published npm version contains declarations and a complete example matching
  the shipped behavior.

## Dependency order

```text
NEC-PAV-0 contract
  -> NEC-PAV-1 ground connection
  -> NEC-PAV-2 product grids
       -> NEC-PAV-3 prepared native field evaluation
            -> NEC-PAV-4 worker reliability
                 -> NEC-PAV-5 published release gates
```

Ground-connection and native grid implementation may proceed in parallel after
the contract is frozen. Worker cancellation/progress work may begin alongside
the superposition implementation, but its final atomic-generation tests depend
on the complete evaluation result.

## Final Definition of Done before planning this repository

The prerequisite is complete only when a published npm release satisfies all
of the following:

- `FullArrayDescription` can faithfully represent both above-ground dipoles and
  PEC-rooted monopoles;
- UV, spherical, Ludwig-3, and integration grids are generated inside the NEC
  WASM engine with a tested axes/order/mask/weight contract;
- current- or voltage-driven evaluation returns atomic port solution plus
  combined display and integration `E_theta/E_phi` fields;
- all per-sample complex field evaluation and any response-basis superposition
  run inside WASM;
- normal steering never transfers an embedded field basis;
- the native direct path is the tested low-memory baseline; if a response cache
  is published, its budget, diagnostics, invalidation, and tiling are tested and
  numerically equivalent;
- explicit and symmetric representations preserve caller order and caller
  origin;
- high-level worker cancellation, progress, errors, memory growth, generations,
  and disposal are covered in Chromium;
- app-scale benchmarks record cold/repeated latency, cache bytes, transfer
  bytes, and peak memory; and
- the published README demonstrates many steering updates producing compact raw
  combined fields without consumer-side field superposition.

After that release, write the application implementation plan. It should add a
third `AnalysisMode`, adapt wavelength-relative geometry to
`FullArrayDescription`, calculate the requested port currents/voltages with the
existing matching layer, bind NEC fields to the existing WASM postprocessor,
and handle generations/capabilities. It must not reimplement NEC grids or field
superposition.

## Non-engine release gate

`@necpp-engine/wasm` and its WASM binary are GPL-2.0-or-later, while this Cargo
workspace currently declares MIT. Before deployment, the project owner must
decide and document the licensing and corresponding-source strategy. This does
not change the technical ownership boundary above, but remains a mandatory
product release gate.
