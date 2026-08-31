# Combined power and ground-connection support plan

## Status and objective

**Status:** planned for the release after `@necpp-engine/wasm` 0.2.0.

The next engine change is deliberately limited to two correctness and API
gaps:

1. expose NEC's native power budget for the latest simultaneous multi-port
   solution through the native, WASM, direct TypeScript, worker, and array
   facades; and
2. make the existing ground-connection choice work correctly and pass it
   through `FullArrayDescription` for both explicit and symmetric arrays.

This plan also updates the external visualizer handover so that consumers use
NEC's native combined-field path rather than superposing embedded fields in
JavaScript.

The authoritative `GE` semantics are in the
[NEC-2 Part III manual](https://www.nec2.org/other/nec2prt3.pdf): `GE 0` means
no geometry ground connection, `GE 1` interpolates current to the image below
the ground plane, and `GE -1` leaves the current expansion unmodified so that
current goes to zero at a wire end touching ground. The `GE` flag changes
geometry connection data; a `GN` ground model must still be supplied
separately.

## Settled scope

### Engine/package work

- Capture the total power budget immediately after every public simultaneous
  voltage- or current-driven solve.
- Add the captured budget to `PortSolution` without removing or redefining the
  existing per-port `powersW` array.
- Preserve the budget through the stable C ABI, direct TypeScript facade,
  worker protocol, and representation-independent array facade.
- Preserve the public ground-connection enum values while translating
  `"zero-current"` to NEC's signed `GE -1` value internally.
- Add `groundConnection` to `FullArrayDescription`, defaulting to `"none"`, and
  use it in both explicit and symmetric geometry completion.
- Validate incompatible ground/geometry combinations and document the
  limitations of connections to finite ground.
- Add native, ABI, TypeScript, worker, array, browser, and packaged-consumer
  regression coverage in proportion to each affected boundary.
- Update the package README, API reference, and
  `docs/wasm-visualizer-agent-onboarding.md`.

### Consumer-owned work

- Coordinate transforms from NEC's spherical `E_theta/E_phi` output.
- Polarization projection and angular quadrature for power in a selected
  polarization.
- Display grids, plotting, normalization, co/cross definitions, Ludwig-3, and
  application-specific measurements.

The consumer can request a regular NEC theta/phi integration grid with the
existing `computeFarField()` method. It should perform polarization and
quadrature in its existing Rust/WASM postprocessor, not in a port-by-sample
JavaScript superposition loop.

### Explicit non-goals

- No embedded-field or current-response cache.
- No JavaScript superposition of per-port far fields in the normal path.
- No arbitrary UV, Ludwig-3, or Cartesian field request in NEC.
- No engine-owned matching, S parameters, realized gain, EIRP, or beam metrics.
- No NEC-native integrated co/cross/RHCP/LHCP power API. NEC provides the total
  power budget and complex spherical fields; the consumer defines and
  integrates its measurement polarization.
- No separate display-and-integration session abstraction. The same solved
  excitation may be sampled repeatedly with ordinary `FarFieldRequest` values.

## Current gaps

### Power

`nec_context` already obtains the source input power from the simultaneous
multi-source solution and computes:

```text
radiated power = input power - structure loss - network loss
```

The individual source currents already include mutual coupling. Therefore the
budget contains the interference/cross-coupling effects of the combined
excitation; it is not a sum of powers from isolated element simulations.

The stateful API currently discards the aggregate budget. It returns only
`PortSolution.powersW[i] = 0.5 * Re(V[i] * conjugate(I[i]))`. Summing that array
gives combined input power, not necessarily radiated power when loads,
conductivity, or networks dissipate power.

The power values in `nec_context` are mutable working state and can be changed
by later internal solves, including embedded-field calculations. The public
consumer solution must therefore copy the budget at solve completion and keep
it tied to `solveGeneration`.

### Ground connection

The low-level TypeScript API already accepts:

```ts
type GroundConnection = "none" | "interpolate" | "zero-current";
```

Its stable ABI intentionally encodes those choices as `0`, `1`, and `2`.
However, the native stateful model currently casts that ABI enum directly to
the signed NEC `GE` flag. As a result, `"zero-current"` reaches NEC as `+2` and
is treated as the positive interpolation mode. The ABI value must remain `2`,
but the native geometry call must receive `-1`.

The high-level array facade has a second gap: both explicit and symmetric
builders hard-code `groundConnection: "none"`, and `FullArrayDescription` has
no property with which a caller can request either rooted-wire mode.

## Target public contract

### Power budget

Add one required nested object to every successful public port solution:

```ts
export interface PowerBudget {
  /** Total time-average power supplied by all voltage sources. */
  readonly inputPowerW: number;
  /** inputPowerW - structureLossW - networkLossW. */
  readonly radiatedPowerW: number;
  /** Ohmic/dissipative power in structure loads and wire conductivity. */
  readonly structureLossW: number;
  /** Net power absorbed by non-radiating networks and transmission lines. */
  readonly networkLossW: number;
  /** 100 * radiatedPowerW / inputPowerW; null when inputPowerW is zero. */
  readonly efficiencyPercent: number | null;
}

export interface PortSolution {
  // Existing fields remain unchanged.
  readonly powersW: Float64Array;
  readonly powerBudget: PowerBudget;
}
```

Normative semantics:

- `powerBudget` describes the same simultaneous solution and
  `solveGeneration` as the surrounding `PortSolution`.
- `inputPowerW` agrees with the sum of `powersW` within numerical tolerance.
- An individual `powersW` entry may be negative in a coupled active array;
  only the aggregate is the total source input.
- `radiatedPowerW` is NEC's native balance value, not an angular quadrature
  result.
- `efficiencyPercent` is `null` only when the exact captured input power is
  zero; no arbitrary near-zero tolerance is introduced in the public
  contract.
- The object and its scalar values remain readable after later solves and
  after worker transfer, just like the existing copied arrays.
- The NEC balance has no separate finite-ground-loss field. Do not document it
  as equivalent to upper-hemisphere flux for finite lossy ground without a
  separate validation. Consumer quadrature remains the measurement authority
  when that distinction matters.

### Array ground connection

Extend the array description additively:

```ts
export interface FullArrayDescription {
  readonly elements: readonly PositionedArrayElement[];
  readonly patterns: readonly ElementWirePattern[];
  readonly ground: GroundModel;
  /** Defaults to "none". Corresponds to NEC GE 0, +1, or -1. */
  readonly groundConnection?: GroundConnection;
}
```

Normative semantics:

- `"none"` maps to NEC `GE 0`.
- `"interpolate"` maps to NEC `GE +1` and is the normal rooted-monopole
  connection. NEC interpolates the segment current to its image, producing
  zero charge at the base.
- `"zero-current"` maps to NEC `GE -1`; it leaves the expansion unmodified, so
  a wire ending at the plane behaves as a zero-current end.
- A non-`"none"` connection requires a perfect or finite ground model by the
  time `prepare()` runs. The connection flag itself does not create ground.
- `groundConnection: "none"` remains valid with a ground model for structures
  wholly above the plane.
- The existing prohibition on combining a non-none ground connection with
  structural reflection through `z=0` remains in force.
- The explicit and symmetric representations must use the same connection and
  produce equivalent caller-order results.
- Document the NEC manual's warning that a base connection to finite ground is
  not an accurate ground-stake model and can make impedance depend strongly on
  source-segment length.

## Implementation work packages

### WP1: Capture a native power-budget value object

Add a small value type, preferably beside `nec_port_solution`, containing the
four independent watt quantities. Do not expose mutable `nec_context` fields
directly.

At the end of `stateful_solve_voltage_sources()` the context has already run
the excitation loop, source input calculation, and
`compute_structure_power_loss()`. In `finish_consumer_solve()`:

1. copy input, structure-loss, and network-loss values from a const context
   accessor;
2. calculate/copy radiated power using the same equation as NEC's printed
   budget;
3. store the budget in `nec_port_solution` before any other native operation
   can overwrite context working state; and
4. keep calculating per-port `powers_w` from achieved `V` and `I` exactly as
   today.

Use one shared power-budget calculation for legacy printing and the stateful
result so the two paths cannot drift. The legacy output format must remain
unchanged.

### WP2: Extend the stable WASM ABI additively

Add scalar solution accessors for:

- input power;
- radiated power;
- structure loss; and
- network loss.

Scalar accessors are preferable to adding a four-element result buffer. They
match the existing solution metadata, avoid changing existing result-buffer
numbers, and have no borrowed-pointer lifetime.

Tasks:

- extend `solution_buffers` and `sync_solution()`;
- declare and implement four `necpp_wasm_v1_solution_*` functions;
- return `0.0` before a solution, consistently with existing scalar getters;
- add the symbols to Emscripten `EXPORTED_FUNCTIONS` in `src/CMakeLists.txt`;
- extend `WasmModule` in `packages/necpp-wasm/src/wasm-internal.ts`; and
- leave all existing ABI enum values and function signatures unchanged.

This is an additive ABI-v1 extension. Do not renumber result buffers. Record
the new engine/package version in the normal release metadata.

### WP3: Expose the budget through direct and worker TypeScript APIs

In the direct facade:

- read the four scalar ABI values as part of `#solution()`;
- reject non-finite watt values as a runtime/solver contract violation;
- construct and freeze `powerBudget`;
- calculate `efficiencyPercent` in TypeScript, using `null` for exact zero
  input; and
- include the nested object in `PortSolution`.

In the worker boundary:

- update `revivePortSolution()` to validate/copy all four watt values and the
  nullable efficiency;
- preserve the existing transfer of typed arrays;
- update worker mocks, protocol tests, and declaration tests; and
- verify direct and worker results are numerically identical.

The worker method signatures and lifecycle do not change.

### WP4: Preserve the budget through the array facade

`NecArraySolver.#solve()` gathers caller-order vectors and `powersW`. The
aggregate budget has no port order and must pass through unchanged.

Tasks:

- attach `result.powerBudget` to the caller-facing result;
- do not recompute aggregate input power from the gathered array except in
  tests;
- verify explicit and symmetric solves report the same budget; and
- verify the budget retains the native solution generation associated with the
  returned caller-order vectors.

### WP5: Correct the signed NEC ground mapping

Keep the public/native enum values stable and replace the direct integer cast
in `nec_stateful_model::complete_geometry()` with an explicit switch:

```text
none         ->  0
interpolate  -> +1
zero_current -> -1
```

Store the selected connection mode in the stateful model so `prepare()` can
reject a non-none connection when no ground model has been selected. Clear or
copy that state consistently with geometry lifecycle operations.

Audit `c_geometry::build_connections()` against the manual for both signed
values. In particular:

- both nonzero flags declare ground-aware geometry and adjust incompatible
  symmetry;
- only the positive mode snaps/tags touching ends for interpolation;
- the negative mode leaves the touching end as an ordinary zero-current wire
  end; and
- both modes reject segments extending below or lying in the ground plane,
  while allowing a wire end to touch it.

If the last validation is currently only applied to the positive branch, move
or duplicate it so the signed modes satisfy the same geometric constraints
without changing their current-expansion behavior.

### WP6: Thread ground connection through array construction

Add and validate `FullArrayDescription.groundConnection` in
`array-symmetry.ts` and the public type declarations.

In `array-solver.ts`:

- replace both hard-coded `"none"` completion calls with the validated value;
- use the identical value in explicit and symmetric builders;
- preserve `"none"` as the omitted default;
- reject a non-none connection paired with `ground.kind === "free-space"`
  before creating a worker; and
- keep ground-model installation after geometry completion, matching NEC card
  order, while retaining the validated description for `prepare()`.

Ground connection does not by itself make an XY array ineligible for the
existing reflection/rotation optimizations. Only an actual symmetry conflict,
such as reflection through `z=0`, should force fallback or an error.

### WP7: Native and API regression tests

Add focused fixtures rather than relying only on snapshots.

#### Power-budget fixtures

1. **Lossless one-port dipole in free space**
   - finite nonnegative input and radiated power;
   - zero structure and network loss within tolerance;
   - radiated power equals input power;
   - sum of `powersW` equals `inputPowerW`.
2. **Loaded or finite-conductivity wire**
   - positive structure loss;
   - `input = radiated + structure + network` within tolerance;
   - efficiency below 100 percent.
3. **Two coupled ports with simultaneous complex excitation**
   - aggregate input agrees with the sum of simultaneous per-port powers;
   - native radiated power agrees with a sufficiently converged full-sphere
     field quadrature in the lossless case;
   - the result is tied to the latest `solveGeneration` after a second drive.
4. **Zero excitation**
   - all watt quantities are zero;
   - the public efficiency is `null`, not `NaN` or infinity.
5. **Perfect-ground monopole**
   - native budget agrees with upper-hemisphere flux within the documented
     quadrature tolerance.

Do not use finite-ground upper-hemisphere equality as a release assertion;
NEC's printed balance does not expose a separate ground-loss term.

#### Ground-connection fixtures

Use rooted vertical wires whose end is exactly at `z=0`, plus negative cases.

- omitted/default and explicit `"none"` remain identical;
- `"interpolate"` reaches native NEC as `+1`;
- `"zero-current"` reaches native NEC as `-1` and is demonstrably not
  bit-identical to interpolation for a discriminating fixture;
- a segment extending below the plane fails for both non-none modes;
- a segment lying in the plane fails for both non-none modes;
- a non-none connection with free space fails with a typed input/geometry
  error;
- perfect and finite ground descriptions reach both explicit and symmetric
  builders;
- explicit and symmetric rooted-array impedances, solutions, budgets, and
  combined far fields agree in caller order; and
- low-level direct, low-level worker, and high-level array APIs implement the
  same mapping.

#### Boundary coverage

Update or add coverage in:

- native stateful-model tests;
- stable ABI contract tests;
- direct facade mapping/runtime tests;
- worker protocol/client/integration tests;
- array planner and explicit/symmetric integration tests;
- TypeScript declaration tests;
- browser integration; and
- packed external-consumer tests.

### WP8: Documentation and handover

Update `packages/necpp-wasm/README.md` and `docs/wasm-api.md` with:

- the `PowerBudget` fields, units, zero-input efficiency behavior, and balance
  equation;
- the distinction between per-port accepted power, total NEC radiated power,
  and polarization-resolved angular flux;
- `FullArrayDescription.groundConnection` examples and NEC `GE` semantics;
- finite-ground caveats; and
- the fact that changing the ground connection requires reconstructing the
  solver.

Update `docs/wasm-visualizer-agent-onboarding.md` in two stages:

1. immediately remove the recommendation to superpose embedded fields in
   JavaScript and document the already-supported native combined path; and
2. with the implementation release, add the exact published package version,
   `powerBudget` example, rooted-monopole `groundConnection` example, and
   measurement-grid guidance.

The native combined-field handover must show this normal steering sequence:

```ts
await solver.prepare({ frequencyMHz });
const solution = await solver.solveCurrents(currents);
const displayField = await solver.computeFarField(displayRequest);
const integrationField = await solver.computeFarField(integrationRequest);
```

`solveCurrents()` calculates the simultaneous source voltages and executes one
combined NEC excitation. `computeFarField()` evaluates the latest combined
native current state. Calling it for a second grid reuses that solved current
state; it does not repeat a port solve and does not require
`computeEmbeddedFarFields()` or a JavaScript sum over ports.

For polarization-resolved measurements, the handover must specify:

```text
E_p = conjugate(p_theta) E_theta + conjugate(p_phi) E_phi
P_p = r^2 / (2 eta_0) * sum_i solidAngleWeight_i * |E_p,i|^2
```

Use midpoint theta rings, omit the duplicate `phi=360 degrees` endpoint, and
use exact ring weights:

```text
deltaTheta = thetaMaximum / nTheta
deltaPhi   = 2 pi / nPhi
theta_i    = (i + 1/2) deltaTheta
phi_j      = j deltaPhi
w_ij       = deltaPhi * [cos(i deltaTheta) - cos((i+1) deltaTheta)]
```

Use `thetaMaximum = pi` for free space and `pi/2` for an infinite ground
plane. For any orthonormal co/cross pair, require
`P_co + P_cross` to agree with total integrated power within quadrature error.
The RHCP/LHCP sign must follow the package's `e^(+j omega t)` convention and be
checked with a known circularly polarized fixture.

### WP9: Verification and release

Run the repository's normal native and package checks, including:

```text
native unit/contract tests
npm run test:wasm
npm run test:browser
package pack/consumer tests
```

Also perform a clean packed-package smoke test that imports only public entry
points and verifies:

- `PortSolution.powerBudget` is present through direct, worker, and array
  APIs;
- a rooted array accepts both connection modes;
- a simultaneous two-port solve followed by `computeFarField()` returns the
  compact combined field only; and
- no normal steering example transfers or superposes an embedded-field basis.

Publish as the next semver-compatible feature release if no other public
breaking changes are included. Record package, engine, and ABI versions in the
handover and release notes.

## Execution order

1. WP1 native budget capture.
2. WP5 signed ground mapping and native validation.
3. WP2 stable ABI additions.
4. WP3 direct/worker TypeScript budget exposure.
5. WP6 high-level array ground plumbing.
6. WP4 array budget propagation.
7. WP7 cross-layer regression suite.
8. WP8 final API documentation and handover version update.
9. WP9 clean build, browser, pack, and release verification.

Power and ground changes should be developed with independent commits where
practical, but the package release is gated on both because the external
handover will advertise them together.

## Definition of done

The work is complete when all of the following are true:

- every successful public solve returns one immutable aggregate native power
  budget associated with its solution generation;
- its input power agrees with the sum of simultaneous per-port powers and its
  balance equation closes within numerical tolerance;
- the budget survives the C ABI, direct facade, worker transfer, and array
  caller-order mapping;
- the public ABI value `2` reliably becomes NEC `GE -1`, while value `1`
  remains `GE +1`;
- `FullArrayDescription.groundConnection` works in explicit and symmetric
  arrays and defaults to `"none"`;
- rooted-wire and incompatible-ground cases have discriminating tests;
- the handover demonstrates repeated native combined far-field evaluation via
  `solveCurrents()`/`solveVoltages()` followed by `computeFarField()`, with no
  JavaScript embedded-pattern superposition;
- the handover explains the separate consumer quadrature needed for power in
  a chosen polarization; and
- native, TypeScript, worker, browser, and packed-consumer checks pass from a
  clean checkout.
