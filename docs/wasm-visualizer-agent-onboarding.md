# External implementation guide: NEC2++ TypeScript/WASM visualizer

This handoff targets `@necpp-engine/wasm` **0.4.0**, containing NEC2++ 2.5.0
and stable WASM ABI 1.

This document is the handoff for the agent implementing a browser visualizer
with `@necpp-engine/wasm`. The implementation must consume the published npm
package only. Do not assume access to the NEC2++ source repository, import an
internal file, copy a WebAssembly artifact, or parse a formatted NEC report for
features that the typed API already exposes.

## Start with the package contract

The primary consumer documentation is the
[`@necpp-engine/wasm` npm README](https://www.npmjs.com/package/@necpp-engine/wasm?activeTab=readme).
Read it before implementing the simulation layer. It contains complete direct,
worker, array, matrix, excitation, and far-field examples. The README and TypeScript
declarations installed with the selected package version are the authority for
that version; do not copy API details from an unversioned third-party example.

The same README can be read without a browser:

```sh
npm view @necpp-engine/wasm readme
```

Inspect the version and runtime boundary before starting:

```sh
npm view @necpp-engine/wasm version engines exports
node --version
```

The package is ESM-only and requires Node 24 or newer for the build and Node
runtime. The engine itself runs in current browsers as WebAssembly.

Isolated-element current and embedded-pattern fixtures ship with the package
at `@necpp-engine/wasm/fixtures/current-quadrature-v1/*`. Bind the NECQ/NECF
buffers once in the compute worker; do not reconstruct element patterns.
See [`docs/current-quadrature-api.md`](current-quadrature-api.md).

## Install

In the visualizer application, install the public package from npm:

```sh
npm install @necpp-engine/wasm
```

The package must be published and visible through the application's configured
npm registry. If `npm view @necpp-engine/wasm version` returns `E404`, stop and
ask the package owner for the published version or registry access. Do not work
around it with a repository path, an internal build, or an untracked tarball;
those would violate this handoff's external-consumer constraint.

Commit the application's `package-lock.json` so CI, reviewers, and deployments
use the same engine version. To deliberately pin an exact version rather than
accept the project's normal semver range, use:

```sh
npm install --save-exact @necpp-engine/wasm
```

For a new Vite TypeScript application, one possible starting point is:

```sh
npm create vite@latest nec-visualizer -- --template vanilla-ts
cd nec-visualizer
npm install
npm install @necpp-engine/wasm
```

Use this Vite configuration when any package worker API is used:

```ts
// vite.config.ts
import { defineConfig } from "vite";

export default defineConfig({
  build: { target: "es2024" },
  worker: { format: "es" },
});
```

The package resolves `nec2pp.wasm` and its module worker relative to its
installed JavaScript. Do not add a worker bootstrap and do not manually copy
`nec2pp.wasm` into `public/`. A production server must return the emitted
`.wasm` asset with `Content-Type: application/wasm`.

## Choose the correct API

Use the highest-level API that represents the visualizer's model:

| Application data | API | Import | Recommendation |
|---|---|---|---|
| A complete list of repeated array elements and their reusable wire patterns | `createNecArraySolver()` | `@necpp-engine/wasm` | Preferred for an array visualizer. It is asynchronous and worker-backed. |
| Arbitrary wires, tags, ports, loads, and ground | `createNecWorkerModel()` | `@necpp-engine/wasm/worker` | Preferred low-level browser API. It keeps native work off the UI thread. |
| Small models, Node tools, or tests where blocking is acceptable | `createNecModel()` | `@necpp-engine/wasm` | Direct calls after creation are synchronous and can block a browser tab. |
| An existing complete NEC text deck | `runDeck()` | `@necpp-engine/wasm` | Compatibility escape hatch, not the default architecture for a new visualizer. |

`createNecArraySolver()` accepts the caller's full ordered array. It can reduce
a supported symmetric layout internally, but all matrices, port vectors, and
embedded patterns remain in the caller's original element/port order. UI code
must not depend on whether diagnostics report `"explicit"` or `"symmetric"`.

Use `symmetry: "auto"` with an explicit `positionEpsilonM`. A value of `0`
accepts exact symmetry only. A positive value permits the planner to
canonicalize positions within that many metres; expose or log
`getDiagnostics()` so adjustments and fallback reasons remain visible. Use
`symmetry: "off"` if the application requires the exact supplied geometry and
does not want symmetry analysis.

## Copy-ready array simulation

The example below models four parallel, centre-fed dipoles, drives progressive
complex currents, and obtains a horizontal far-field cut. It uses only the
public npm API.

```ts
import {
  NecError,
  createNecArraySolver,
  type FarFieldRequest,
  type FarFieldResult,
  type FullArrayDescription,
  type ImpedanceResult,
  type NecArraySolver,
  type PortSolution,
} from "@necpp-engine/wasm";

export interface SimulationResult {
  readonly matrices: ImpedanceResult;
  readonly solution: PortSolution;
  readonly field: FarFieldResult;
  readonly representation: "explicit" | "symmetric";
}

const description = {
  elements: [-0.45, -0.15, 0.15, 0.45].map((xM, index) => ({
    id: `element-${index + 1}`,
    positionM: [xM, 0] as const,
    patternId: "dipole",
  })),
  patterns: [{
    id: "dipole",
    kind: "straight-wire-pattern",
    wires: [{
      id: "radiator",
      segments: 11,
      startM: [0, 0, -0.25],
      endM: [0, 0, 0.25],
      radiusM: 0.001,
    }],
    ports: [{ wireId: "radiator", segment: 6, name: "feed" }],
  }],
  ground: { kind: "free-space" },
} satisfies FullArrayDescription;

const fieldRequest = {
  radiusM: 1,
  theta: { startDeg: 90, count: 1, stepDeg: 0 },
  phi: { startDeg: 0, count: 361, stepDeg: 1 },
} satisfies FarFieldRequest;

export async function createArraySession(): Promise<NecArraySolver> {
  return createNecArraySolver(description, {
    symmetry: "auto",
    symmetrizer: {
      positionEpsilonM: 0,
      allowRotation: false,
    },
  });
}

export async function simulate(
  solver: NecArraySolver,
  frequencyMHz: number,
  phaseStepDeg: number,
): Promise<SimulationResult> {
  await solver.prepare({ frequencyMHz });
  const matrices = await solver.computeImpedanceMatrix();
  const phaseStepRad = phaseStepDeg * Math.PI / 180;
  const portCount = description.elements.length;
  const currents = {
    real: Float64Array.from(
      { length: portCount },
      (_, port) => Math.cos(port * phaseStepRad),
    ),
    imag: Float64Array.from(
      { length: portCount },
      (_, port) => Math.sin(port * phaseStepRad),
    ),
  };
  const solution = await solver.solveCurrents(currents);
  const field = await solver.computeFarField(fieldRequest);

  return {
    matrices,
    solution,
    field,
    representation: solver.getDiagnostics().representation,
  };
}

async function run(): Promise<void> {
  const solver = await createArraySession();
  try {
    const result = await simulate(solver, 300, -60);
    console.log(result);
  } finally {
    await solver.dispose();
  }
}

run().catch((error: unknown) => {
  if (error instanceof NecError) {
    console.error(error.code, error.message, error.details);
    return;
  }
  throw error;
});
```

In the production app, keep the solver alive while frequency, excitation, or
field-grid controls change. Dispose and recreate it only when geometry, ports,
pattern loads, or ground change. Returned typed arrays are JavaScript-owned
copies, so results remain valid after later solves and after disposal.

For a rooted monopole, put the wire end exactly at `z=0`, select a real ground
model, and opt into the NEC geometry connection explicitly:

```ts
const rootedArray: FullArrayDescription = {
  elements: [{ id: "m0", positionM: [0, 0], patternId: "monopole" }],
  patterns: [{
    id: "monopole",
    kind: "straight-wire-pattern",
    wires: [{
      id: "wire",
      segments: 11,
      startM: [0, 0, 0],
      endM: [0, 0, 0.25],
      radiusM: 0.001,
    }],
    ports: [{ wireId: "wire", segment: 2 }],
  }],
  ground: { kind: "perfect" },
  groundConnection: "interpolate",
};
```

`"interpolate"` is NEC `GE +1`; `"zero-current"` is signed `GE -1`; omission
is `GE 0`. A non-none connection requires perfect or finite ground and changing
it requires solver reconstruction. NEC does not model a finite-ground stake
accurately; base impedance can be strongly source-segment-length dependent.

## Obtain combined far fields without JavaScript superposition

The `simulate()` example above already uses the preferred combined-field path.
`solveCurrents()` first calculates the source voltages required for the whole
requested current vector and executes one simultaneous NEC excitation.
`computeFarField()` then evaluates the latest combined native current state.
Mutual coupling and complex interference are therefore included by NEC; the
application must not separately solve each port and add embedded fields in
JavaScript.

For each steering update, use this sequence:

```ts
const solution = await solver.solveCurrents(currents);
const field = await solver.computeFarField(fieldRequest);
```

Use `solveVoltages(voltages)` instead when voltages are the application's
independent drive values. Both methods leave one latest consumer solution for
`computeFarField()`. A second `computeFarField()` call with another regular
theta/phi request reuses that solution, so display and integration grids can
be sampled without another port solve:

```ts
const solution = await solver.solveCurrents(currents);
const displayField = await solver.computeFarField(displayRequest);
const integrationField = await solver.computeFarField(integrationRequest);
```

The returned solution carries NEC's simultaneous native power balance:

```ts
console.log(solution.powerBudget);
// {
//   inputPowerW, radiatedPowerW, structureLossW, networkLossW,
//   efficiencyPercent // null only for exact zero input
// }
```

The sum of `solution.powersW` is aggregate source input, while
`powerBudget.radiatedPowerW` subtracts structure and network loss. It is total
native radiated power, not power in a selected polarization. Finite lossy
ground has no separate ground-loss field in this balance.

`computeEmbeddedFarFields()` remains available for specialized basis analysis,
but it is not required for ordinary beam steering. Do not transfer its
port-major basis merely to run a `ports * samples` complex sum in application
JavaScript. The array facade may apply its documented caller-origin rephasing;
that coordinate correction is not per-port field superposition.

For polarization-resolved measurements, project and integrate in the existing
Rust/WASM postprocessor:

```text
E_p = conjugate(p_theta) E_theta + conjugate(p_phi) E_phi
P_p = r^2 / (2 eta_0) * sum_i solidAngleWeight_i * |E_p,i|^2
```

Use midpoint theta rings, omit a duplicate `phi=360 degrees` endpoint, and use
exact ring weights:

```text
deltaTheta = thetaMaximum / nTheta
deltaPhi   = 2 pi / nPhi
theta_i    = (i + 1/2) deltaTheta
phi_j      = j deltaPhi
w_ij       = deltaPhi * [cos(i deltaTheta) - cos((i+1) deltaTheta)]
```

Use `thetaMaximum = pi` in free space and `pi/2` over an infinite ground
plane. For an orthonormal co/cross pair, `P_co + P_cross` must agree with total
integrated power within quadrature error. Define RHCP/LHCP for the package's
`e^(+j omega t)` convention and verify the sign with a known circular fixture.

## Convert a field result for plotting

Far-field components are complex V/m values. The total field magnitude for a
sample is

`sqrt(|E_theta|^2 + |E_phi|^2)`.

Samples are theta-fast:

`sampleIndex = phiIndex * thetaCount + thetaIndex`.

This adapter produces normalized dB values suitable for a 2D or 3D pattern
plot:

```ts
import type { FarFieldResult } from "@necpp-engine/wasm";

export interface PatternSample {
  readonly thetaDeg: number;
  readonly phiDeg: number;
  readonly magnitudeVPerM: number;
  readonly normalizedDb: number;
}

export function toNormalizedPattern(
  field: FarFieldResult,
  floorDb = -60,
): readonly PatternSample[] {
  const thetaCount = field.thetaDeg.length;
  const magnitudes = Float64Array.from(
    field.eThetaReal,
    (eThetaReal, index) => Math.hypot(
      eThetaReal,
      field.eThetaImag[index]!,
      field.ePhiReal[index]!,
      field.ePhiImag[index]!,
    ),
  );
  let peak = 0;
  for (const magnitude of magnitudes) {
    peak = Math.max(peak, magnitude);
  }
  if (!Number.isFinite(peak) || peak <= 0) {
    throw new Error(`Cannot normalize a field with peak ${peak}`);
  }

  return Array.from(magnitudes, (magnitudeVPerM, index) => {
    const phiIndex = Math.floor(index / thetaCount);
    const thetaIndex = index % thetaCount;
    const normalizedDb = Math.max(
      floorDb,
      20 * Math.log10(Math.max(magnitudeVPerM / peak, Number.EPSILON)),
    );
    return {
      thetaDeg: field.thetaDeg[thetaIndex]!,
      phiDeg: field.phiDeg[phiIndex]!,
      magnitudeVPerM,
      normalizedDb,
    };
  });
}
```

Label that visualization **normalized field pattern** or **dB relative to
peak**. Field magnitude by itself is not antenna gain or directivity; do not
label it as either unless the application also performs the required power
normalization.

For a 3D surface, use the package's spherical convention:

```text
x = r * sin(theta) * cos(phi)
y = r * sin(theta) * sin(phi)
z = r * cos(theta)
```

Theta is measured down from +Z. Phi increases in the XY plane from +X toward
+Y. Convert degrees to radians before applying the formulas. Use normalized
linear magnitude, not a negative dB number, as `r`.

## Low-level worker model

Use the worker entry point when the visualizer edits arbitrary individual
wires instead of reusable array patterns:

```ts
import { createNecWorkerModel } from "@necpp-engine/wasm/worker";

const model = await createNecWorkerModel({
  onProgress: ({ operation, phase }) => {
    console.log(operation, phase);
  },
});

try {
  await model.addWire({
    tag: 1,
    segments: 11,
    start: [0, 0, -0.25],
    end: [0, 0, 0.25],
    radiusM: 0.001,
  });
  await model.completeGeometry();
  await model.definePorts([{ tag: 1, segment: 6, name: "feed" }]);
  await model.prepare({ frequencyMHz: 300 });
  const solution = await model.solveVoltages({
    real: new Float64Array([1]),
    imag: new Float64Array([0]),
  });
  console.log(solution);
} finally {
  await model.dispose();
}
```

Worker method calls are asynchronous and serialized for each model. If the
user cancels a long low-level worker calculation, call `model.terminate()`;
this immediately kills that worker and rejects outstanding operations. A
terminated model cannot be reused, so create a new one. The higher-level
`NecArraySolver` exposes `cancelFarField()` for generation supersession and
`dispose()`, but not `terminate()`. Cancellation stops assigning pooled field
tiles, rejects the active field as superseded, and leaves the solver reusable.

## Numerical and ordering contract

These details must be reflected in the UI and its data adapters:

- Coordinates, wire radii, and field radius are metres. Frequency is MHz.
- A wire tag is a positive integer. Port segment indices are one-based. For an
  11-segment wire, the centre segment is `6`.
- Port definition order determines all vector indices, matrix rows/columns,
  power values, and embedded-pattern bases. Preserve a stable app-level ID for
  every port and never re-sort result arrays independently.
- Complex matrices are row-major. Entry `(row, column)` is at
  `row * matrix.columns + column`.
- `solveVoltages()` drives complex volts. `solveCurrents()` drives complex
  amperes and returns the voltages required to achieve them. Current is
  positive into the modeled antenna.
- The package uses `V = Z I`, `I = Y V`, `e^(+j omega t)` phasors, and
  `e^(-jkR)` outgoing propagation.
- `PortSolution.activeImpedances[i]` is `V[i] / I[i]` for the current
  simultaneous excitation. It is not the same quantity as matrix entry
  `Z[i,i]`, and is `NaN + jNaN` when achieved current is exactly zero.
- `PortSolution.powersW[i]` is time-average input power
  `0.5 * Re(V * conjugate(I))`. An individual coupled port can absorb or
  deliver power; inspect the total as well as each port.
- `computeFarField()` requires a successful preceding excitation solve.
  `computeEmbeddedFarFields()` can run from the prepared state.
- Fields are far-field approximations referenced to the model origin, even if
  a small `radiusM` is requested.

The engine does not need to be the visualizer's geometry store. Keep the
editable geometry in application state and use the same domain objects both
to render wire segments and to construct a new solver when geometry changes.

## Lifecycle and UI behavior

The normal low-level lifecycle is:

```text
empty -> geometry-building -> geometry-complete -> prepared -> solved
                                                               |
                                                               +-> new solve/field
```

Use these invalidation rules in the app:

| User change | Engine action |
|---|---|
| Camera, color scale, clipping floor, or plot style | Re-render existing results only. |
| Current/voltage amplitude or phase | Reuse the prepared model and solve again. |
| Angular resolution or requested cut | Reuse the latest solution and compute a new far field. |
| Frequency | Call `prepare()` at the new frequency, then solve again. |
| Geometry, ports, structural loads, or ground | Dispose the old model and construct a new one. |

Protect the UI from stale asynchronous results. Increment a request generation
when controls change and commit a result only if its generation is still
current. Disable impossible actions based on application state rather than
allowing a `computeFarField()` call before a solve.

For interactive beam steering, keep the prepared solver alive and call
`solveCurrents()` or `solveVoltages()` for each new weight vector, followed by
`computeFarField()`. This uses NEC's retained factorization and native combined
current state. Measure this direct path before considering any response cache;
do not implement ordinary steering as JavaScript embedded-field
superposition.

## Performance and memory

- Factorization cost and memory grow quickly with segment count. Start with
  modest odd segment counts and add a convergence workflow rather than
  defaulting every model to extreme resolution.
- Keep a prepared model alive. Recreating it for every weight or field-grid
  change discards the most expensive reusable work.
- Start with angular cuts. A `181 x 361` combined field stores about 2 MiB
  across its four `Float64Array` components. Embedded fields multiply that by
  port count and should not be requested by the normal steering path.
- Release references to obsolete field arrays. Each worker model owns a
  separate WebAssembly instance and memory, so dispose unused models instead
  of accumulating them.
- Large result buffers from the worker API are transferred back to the app.
  There is no shared-memory or cross-origin-isolation requirement.

## Errors and diagnostics

All package operational errors derive from `NecError` and expose a stable
`code`:

| Code | UI meaning |
|---|---|
| `NEC_INPUT` | Invalid values, dimensions, units, or request grid. Highlight editable input. |
| `NEC_GEOMETRY` | Invalid/intersecting geometry, load target, or ground compatibility. |
| `NEC_PORT` | Missing, duplicate, or invalid port. |
| `NEC_CONDITIONING` | Port matrix is singular or too ill-conditioned for a reliable result. |
| `NEC_SOLVER` | Native fill, factorization, solve, or field operation failed. |
| `NEC_RUNTIME` | Worker, WebAssembly loading, ABI, allocation, or runtime failure. |
| `NEC_STATE` | The app called an operation in the wrong lifecycle state. This usually indicates an integration bug. |

Use `error.code` for program flow and show `error.message` for diagnostics; do
not parse message text. Log `packageVersion`, `engineVersion`, and `abiVersion`
with bug reports. Array applications should also log
`solver.getDiagnostics()`, especially symmetry representation, planner reason
codes, and `maxPositionAdjustmentM`.

## Deployment checks

Before declaring the integration complete, verify all of the following in a
clean checkout of the visualizer application:

- `npm ci`, TypeScript checking, tests, and the production bundle succeed with
  no path to the NEC2++ source repository.
- Imports use only `@necpp-engine/wasm` or
  `@necpp-engine/wasm/worker`; there are no imports from package internals.
- The production browser loads a `.wasm` response successfully with
  `application/wasm` content type and the worker API does not block normal UI
  interaction.
- A known dipole or array produces finite port values and the expected field
  sample count. Reject `NaN` or infinity before plotting.
- Matrix, vector, and field indexing tests use at least two ports and a grid
  with both theta and phi counts greater than one, so transposition mistakes
  cannot hide.
- Geometry/frequency changes invalidate the correct data, stale async results
  cannot overwrite new results, and every model is disposed on replacement
  and page/component teardown.
- The UI distinguishes normalized field magnitude from gain/directivity.
- User-facing diagnostics include package/engine version and typed NEC error
  codes.

## Licensing and deck fallback

`@necpp-engine/wasm` and the shipped `nec2pp.wasm` engine are
**GPL-2.0-or-later**. Serving or distributing a visualizer that contains them
distributes GPL software. Confirm the application's source, notices, license
text, and distribution process satisfy the GPL before shipping; obtain legal
review for a product-specific decision.

If the typed API cannot yet express a required feature, `runDeck()` can execute
a complete NEC input deck and return its formatted report. Treat that as a
deliberate compatibility boundary, because the application must then create
cards and parse output itself. The authoritative card layout and semantics are
in the
[NEC-2 Part 3 Program Description](https://www.nec2.org/other/nec2prt3.pdf).
