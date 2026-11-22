# `@necpp-engine/wasm`

Stateful NEC2++ antenna simulation for Node and browsers, exposed through a
handwritten TypeScript API. The package owns the WebAssembly details: callers
do not copy artifacts, build NEC decks, parse reports, or handle native
pointers.

> **License:** this package and its `nec2pp.wasm` engine are
> **GPL-2.0-or-later**. Distributing an application that includes or serves the
> package is distribution of GPL software. Read [License](#license) before
> shipping it in a product.

## Five-minute dipole

Install with `npm install @necpp-engine/wasm`. The package is ESM-only and
requires Node 24 or newer.

```ts
import { createNecModel } from "@necpp-engine/wasm";

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
  model.definePorts([{ tag: 1, segment: 6, name: "feed" }]);
  model.prepare({ frequencyMHz: 300 });

  const { impedance, admittance } = model.computeImpedanceMatrix();
  const solution = model.solveCurrents({
    real: new Float64Array([1]),
    imag: new Float64Array([0]),
  });
  const field = model.computeFarField({
    radiusM: 1,
    theta: { startDeg: 0, count: 181, stepDeg: 1 },
    phi: { startDeg: 0, count: 1, stepDeg: 0 },
  });

  console.log({
    zOhm: [impedance.real[0], impedance.imag[0]],
    ySiemens: [admittance.real[0], admittance.imag[0]],
    requiredVoltageV: [solution.voltages.real[0], solution.voltages.imag[0]],
    fieldSamples: field.eThetaReal.length,
  });
} finally {
  model.dispose();
}
```

This complete example is executed from the packed npm tarball in CI.

## Isolated-element currents and patterns

`characterizeIsolatedElement()` returns isolated Z/Y, packed quadrature
currents (`NECQ`), and NEC-native embedded patterns (`NECF`) from one
unit-current basis loop per port. Keep the large buffers off the UI thread:
worker handoff transfers them once onto a compute worker.

```ts
import { createNecModel } from "@necpp-engine/wasm";

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
  model.definePorts([{ tag: 1, segment: 6, name: "feed" }]);
  model.prepare({ frequencyMHz: 300 });

  const characterization = model.characterizeIsolatedElement({
    quadrature: {
      nodes: Float64Array.of(-1, -1 / 3, 1 / 3, 1),
      images: "physical-only",
      modes: "unit-current",
    },
    field: {
      radiusM: 1,
      theta: { startDeg: 0, count: 5, stepDeg: 45 },
      phi: { startDeg: 0, count: 3, stepDeg: 90 },
    },
  });

  console.log({
    zOhm: [characterization.impedance.real[0], characterization.impedance.imag[0]],
    quadratureBytes: characterization.quadrature.byteLength,
    embeddedBytes: characterization.embeddedField.byteLength,
  });
} finally {
  model.dispose();
}
```

Published goldens are importable from
`@necpp-engine/wasm/fixtures/current-quadrature-v1/*`. A worker destination
handoff resolves to compact `IsolatedElementHandoff` metadata (Z/Y and
`byteLength`s). Do not put NECQ/NECF `ArrayBuffer`s in React state.

The repository's
[current-quadrature examples](https://github.com/andrekuehne/necpp/tree/master/examples/wasm-current-quadrature)
run the direct and MessagePort-handoff paths from a packed tarball.

## Symmetric arrays and automatic optimization

For array applications, `createNecArraySolver()` accepts the caller's complete
element list and keeps one contract whether it builds that geometry explicitly
or proves that NEC can use a smaller fundamental section. `prepare()`, complete
Z/Y matrices, current- and voltage-driven solves, combined fields, and embedded
fields always use the full caller element and port order. Generated tags, copy
indices, and native copy-major order do not leak into ordinary results.

The facade defaults to `symmetry: "auto"`. Automatic analysis never assumes a
hidden tolerance, so callers using the default must still provide
`symmetrizer.positionEpsilonM`. Use `"off"` to force the unchanged explicit
model or `"require"` to reject a description that cannot use supported
symmetry. All three modes use a package-supplied worker and expose the same
asynchronous solver methods.

After `solveCurrents()` or `solveVoltages()`, the same facade exposes the exact
latest NEC segment currents:

```ts
import type { NecArraySolver } from "@necpp-engine/wasm";

declare const solver: NecArraySolver;

const currents = await solver.getCurrentDistribution({
  kind: "latest-solution",
});

console.log(currents.aReal[0], currents.aImag[0]);
```

Segments are returned in caller element, pattern wire, and segment order.
Tags and decoded endpoint references are caller-facing, while each
`nativeIndex` retains the true NEC index for diagnostics. Symmetric geometry is
translated into the planner-canonicalized absolute coordinate frame; inspect
`getDiagnostics().planner.canonicalizations` for any epsilon-bounded position
adjustments. Current coefficients are not phase-rotated because the native
solution already includes every complex excitation. Returned numeric buffers
are caller-owned. The array facade deliberately accepts only
`"latest-solution"`; isolated `"unit-current"` bases remain available through
`NecModel` and `NecWorkerModel`.

### Parallel far fields

`createNecArraySolver()` also owns an optional pool of lightweight far-field
evaluators inside its package-supplied worker. The evaluators receive geometry
and solved-current snapshots, never the interaction matrix or factorization,
and use ordinary transferable `ArrayBuffer`s. No `SharedArrayBuffer`,
cross-origin isolation, COOP, or COEP is required.

```ts
import {
  createNecArraySolver,
  type FullArrayDescription,
} from "@necpp-engine/wasm";

declare const description: FullArrayDescription;

const solver = await createNecArraySolver(description, {
  symmetry: "auto",
  symmetrizer: { positionEpsilonM: 1e-9 },
  fieldWorkers: "auto", // default; use 1 for the serial field path
});

await solver.dispose();
```

`fieldWorkers` accepts `"auto"` or an integer from 1 through 8. `1` always
uses the native serial WP2a path. Explicit values from 2 through 8 request that
many evaluators for supported ordinary-wire models in free space or over
perfect ground. `"auto"` selects at most four evaluators from the logical-core
hint and stays serial below 250,000 segment-direction-image contributions or
when the grid contains too few 512-sample tiles. Unsupported ground/geometry,
worker startup, and asset failures fall back to the serial field path and are
reported rather than changing the model or grid.

Every returned array field has `fieldBackend`, and
`solver.getDiagnostics().field` retains the latest report. It identifies the
selected backend, active count, tile size, fallback reason, warm-up, snapshot,
dispatch, kernel and merge timings, bytes, restarted workers, and cancelled
tiles. A newer solve or field request supersedes an active pooled field between
512-sample tiles; the stale promise rejects with `NecRuntimeError` and
`details.reason === "superseded"`. Explicit disposal terminates every evaluator.

Schedulers that coalesce interaction updates before issuing the next solve can
call `solver.cancelFarField()` as soon as a newer generation is known. It is a
safe no-op without an active pooled field, retains prepared state and the last
completed result, and bounds obsolete work to tiles that are already running.

For hard candidate cancellation, pass an `AbortSignal` while the asynchronous
factory is constructing geometry, then call `solver.terminate()` after it has
resolved:

```ts
import {
  createNecArraySolver,
  NecCancellationError,
  type FullArrayDescription,
} from "@necpp-engine/wasm";

declare const description: FullArrayDescription;

const controller = new AbortController();
const candidate = createNecArraySolver(description, {
  symmetry: "off",
  signal: controller.signal,
});

// Cancels create or geometry construction before `candidate` resolves.
controller.abort();
await candidate.catch((error) => {
  if (!(error instanceof NecCancellationError)) throw error;
});

// For a candidate that resolves, this cancels prepare, matrix, solve, or field work.
const solver = await createNecArraySolver(description, { symmetry: "off" });
solver.terminate();
```

Each array solver owns an isolated worker, so terminating a candidate cannot
destroy another ready solver. Creation abort and hard termination reject with
`NecCancellationError` (`code === "NEC_RUNTIME"`) and stable
`details.reason` values of `"aborted"` and `"terminated"`, respectively.
Both boundaries are idempotent. A terminated solver cannot be reused.

### Full NxN input with automatic selection

This runnable 4 x 4 example supplies all 16 XY positions in row-major order.
The only reusable pattern is a Z-directed straight wire on its element-local Z
axis. The planner recognizes reflection across `x=0` and `y=0`, constructs one
quadrant, and gathers every result back into the 16-port caller order. The
current phases are deliberately progressive: excitation weights do not need to
share the structural symmetry.

```ts
import {
  createNecArraySolver,
  type FullArrayDescription,
} from "@necpp-engine/wasm";

const frequencyMHz = 300;
const wavelengthM = (1 / Math.sqrt(8.854e-12 * 4 * Math.PI * 1e-7))
  / (frequencyMHz * 1e6);
const side = 4;
const description: FullArrayDescription = {
  elements: Array.from({ length: side * side }, (_, index) => {
    const x = index % side;
    const y = Math.floor(index / side);
    return {
      id: `element-${index}`,
      positionM: [
        (x - (side - 1) / 2) * wavelengthM / 2,
        (y - (side - 1) / 2) * wavelengthM / 2,
      ] as const,
      patternId: "dipole",
    };
  }),
  patterns: [{
    id: "dipole",
    kind: "straight-wire-pattern",
    wires: [{
      id: "radiator",
      segments: 11,
      startM: [0, 0, wavelengthM / 12],
      endM: [0, 0, 5 * wavelengthM / 12],
      radiusM: wavelengthM / 1000,
    }],
    ports: [{ wireId: "radiator", segment: 6, name: "feed" }],
  }],
  ground: { kind: "perfect" },
};

const solver = await createNecArraySolver(description, {
  symmetry: "auto",
  symmetrizer: { positionEpsilonM: 1e-9 },
});

try {
  await solver.prepare({ frequencyMHz });
  const { impedance, admittance } = await solver.computeImpedanceMatrix();
  const currents = {
    real: Float64Array.from(
      description.elements,
      (_, index) => Math.cos(index * Math.PI / 12),
    ),
    imag: Float64Array.from(
      description.elements,
      (_, index) => Math.sin(index * Math.PI / 12),
    ),
  };
  const solution = await solver.solveCurrents(currents);
  const request = {
    radiusM: 1,
    theta: { startDeg: 90, count: 1, stepDeg: 0 },
    phi: { startDeg: 0, count: 361, stepDeg: 1 },
  } as const;
  const field = await solver.computeFarField(request);
  const embedded = await solver.computeEmbeddedFarFields(
    request,
    { kind: "unit-current", valueA: 1 },
  );
  const diagnostics = solver.getDiagnostics();

  console.log({
    representation: diagnostics.representation,
    sections: diagnostics.symmetry?.sectionCount,
    exact: diagnostics.planner.exact,
    maxAdjustmentM: diagnostics.planner.maxPositionAdjustmentM,
    warnings: diagnostics.planner.reasons,
    zOrder: impedance.rows,
    yOrder: admittance.rows,
    solvedPorts: solution.ports.length,
    combinedSamples: field.eThetaReal.length,
    embeddedPorts: embedded.ports.length,
  });
} finally {
  await solver.dispose();
}
```

`positionEpsilonM` is an acceptance and canonicalization tolerance, not a claim
that the input was exact. Every accepted coordinate replacement appears in
`diagnostics.planner.canonicalizations`; `exact` and
`maxPositionAdjustmentM` summarize the adjustment. If an off-origin array is
recentered for NEC symmetry, combined and embedded complex fields are restored
to the caller's origin automatically with the package's `e^(+j k u·center)`
phase correction.

Inspect diagnostics when optimization information matters; ordinary solver
code does not branch on it. An accepted plan reports `representation:
"symmetric"`, its reduction metadata, candidate decisions, and coordinate
adjustments. A fallback reports `representation: "explicit"` and stable reason
codes such as `FIXED_ELEMENT_ON_REFLECTION_PLANE`,
`FIXED_ELEMENT_ON_ROTATION_AXIS`, `POSITION_OUTSIDE_EPSILON`,
`PATTERN_MISMATCH`, `UNSUPPORTED_ELEMENT_PATTERN_TRANSFORM`,
`UNSYMMETRIC_LOAD`, or `GROUND_BREAKS_SYMMETRY`. Centered odd-sided square
arrays therefore remain explicit because elements lie on reflection planes and
the rotation axis; no element is dropped.

The modes are explicit application policy:

```ts
import {
  createNecArraySolver,
  type FullArrayDescription,
} from "@necpp-engine/wasm";

declare const description: FullArrayDescription;

const automatic = await createNecArraySolver(description, {
  symmetry: "auto",
  symmetrizer: { positionEpsilonM: 1e-9 },
});
const explicit = await createNecArraySolver(description, { symmetry: "off" });
const required = await createNecArraySolver(description, {
  symmetry: "require",
  symmetrizer: { positionEpsilonM: 0 },
});

await Promise.all([
  automatic.dispose(),
  explicit.dispose(),
  required.dispose(),
]);
```

The first release accepts only pointwise transform-invariant element patterns:
straight Z-directed wires whose local X and Y coordinates are zero, with zero
or omitted element rotation. Helices, tilted or off-axis wires, multiple
off-axis wire sets, arcs, patches, rotated patterns, and transforms whose
handedness, endpoint direction, segment mapping, or port polarity is unresolved
fall back under `"auto"`. `"require"` or `onUnsupported: "error"` turns that
condition into a controlled error. This is structural symmetry: sources,
requested currents/voltages, and non-radiating networks may be arbitrary, but
geometry, loads, and the radiating environment must form complete equal orbits.

Supported structural operations are:

| Operation | Free space | Homogeneous horizontal ground | Important restriction |
|---|---:|---:|---|
| Reflection in `x=0` and/or `y=0` | Yes | Yes | No wire may lie in or cross a generating plane |
| Reflection in `z=0` | Yes | No | Ground and structural `z=0` reflection are incompatible |
| N-fold rotation about global Z | Yes | Yes | Order is at least 2; no element may be fixed on the axis |

The automatic planner may translate the XY origin before applying one of these
groups. It does not combine reflection and rotation into a general dihedral
optimization. Loads attached to a reusable pattern are expanded over the
complete orbit atomically; low-level manual users must supply equal complete
load orbits before `prepare()`.

### Manual symmetry from one quadrant

When the geometry is known to be symmetric, build only its fundamental section
and make symmetry the final geometry operation. This 300 MHz reference model
creates a 4 x 4 array from the four positive-X/positive-Y dipoles:

```ts
import { createNecModel } from "@necpp-engine/wasm";

const frequencyMHz = 300;
const epsilon0 = 8.854e-12;
const mu0 = 4 * Math.PI * 1e-7;
const wavelengthM = (1 / Math.sqrt(epsilon0 * mu0)) / (frequencyMHz * 1e6);
const side = 4;
const half = side / 2;
const fundamentalCount = half * half;
const model = await createNecModel();

try {
  for (let y = half; y < side; y += 1) {
    for (let x = half; x < side; x += 1) {
      const tag = (y - half) * half + (x - half) + 1;
      const xM = (x - (side - 1) / 2) * wavelengthM / 2;
      const yM = (y - (side - 1) / 2) * wavelengthM / 2;
      model.addWire({
        tag,
        segments: 11,
        start: [xM, yM, wavelengthM / 12],
        end: [xM, yM, 5 * wavelengthM / 12],
        radiusM: wavelengthM / 1000,
      });
    }
  }

  const completion = model.completeGeometry({
    groundConnection: "none",
    symmetry: {
      kind: "reflection",
      planes: ["x=0", "y=0"],
      tagIncrement: fundamentalCount,
    },
  });
  model.definePorts(Array.from(
    { length: side * side },
    (_, index) => ({ tag: index + 1, segment: 6 }),
  ));
  model.setGround({ kind: "perfect" });
  model.prepare({ frequencyMHz });

  console.log(completion.symmetry);
  console.log(model.computeImpedanceMatrix().impedance);
} finally {
  model.dispose();
}
```

The four copy blocks are the fundamental section, Y reflection, X reflection,
then XY reflection. Their tag offsets are `0`, `4`, `8`, and `12`; this native
copy-major order is not XY row-major order. `completion.symmetry` reports the
section count, fundamental/full segment counts, transforms, and offsets. It is
deeply immutable and has the same shape when returned by the worker API. Use
`rotationalOrder(n)` for N-fold rotation about global Z.

The worker API uses the same descriptor and returns the same immutable
metadata; only the operation calls are awaited:

```ts
import { createNecWorkerModel } from "@necpp-engine/wasm/worker";

const model = await createNecWorkerModel();
try {
  await model.addWire({
    tag: 1,
    segments: 11,
    start: [0.25, 0.25, 0.1],
    end: [0.25, 0.25, 0.4],
    radiusM: 0.001,
  });
  const completion = await model.completeGeometry({
    symmetry: {
      kind: "reflection",
      planes: ["x=0", "y=0"],
      tagIncrement: 1,
    },
  });
  await model.definePorts(Array.from(
    { length: 4 },
    (_, index) => ({ tag: index + 1, segment: 6 }),
  ));
  await model.prepare({ frequencyMHz: 300 });
  console.log(completion.symmetry, await model.computeImpedanceMatrix());
} finally {
  await model.dispose();
}
```

Plane reflection rejects wires that lie in or cross a generating plane.
Structural `z=0` reflection is incompatible with ground, while the vertical
planes used above remain valid over homogeneous horizontal ground. Geometry
cannot be added after symmetric completion, and structural loads must cover
complete symmetry orbits before `prepare()`.

On an AMD Ryzen 7 PRO 7840HS running Windows, Node 24.14.1, and the Emscripten
4.0.7 artifact, the three-round 16 x 16 perfect-ground reference benchmark
measured 13,196.45 ms explicit preparation versus 1,142.14 ms manual
two-plane-reflection preparation (11.55x), while the primary interaction
matrix allocation fell from 121.00 MiB to 30.25 MiB (4.00x). These are
model- and host-specific measurements, not a universal speedup promise. See
the [benchmark method and full results](https://github.com/andrekuehne/necpp/blob/master/packages/necpp-wasm/bench/RESULTS.md).

## Numerical conventions

- Coordinates, wire radius, and field radius are metres. Public frequencies
  are MHz.
- Phasors use `e^(+j omega t)` and outgoing propagation uses `e^(-jkR)`.
- Port voltage is in complex volts. Port current is in complex amperes and is
  positive **into** the modeled antenna.
- `V = Z I` and `I = Y V`; impedance is in ohms and admittance is in siemens.
- Complex far-field components are V/m. `radiusM` defaults to 1 m and is
  retained in every result.
- Theta is the polar angle down from +Z. Phi is azimuth from +X toward +Y.
- Matrices are row-major: `index = row * columns + column`. Far-field samples
  are theta-fast: `index = phiIndex * thetaCount + thetaIndex`.
- Fields are referenced to the model origin and remain far-field
  approximations even when a small radius is requested.
- Every returned typed array is a JavaScript-owned copy. It remains valid
  across later solves, WebAssembly memory growth, and model disposal.

Coordinate orientation:

```text
                         +Z  theta=0 deg
                          |
                          |\  r
                          | \
                          |  * sample
                          | / theta
                          |/
             +Y          origin -------- +X  phi=0 deg
              \          /
               \  phi   /
                \------/

Phi increases from +X toward +Y; theta increases from +Z toward the XY plane.
```

The full normative contract, including loads, ground, tolerances, and every
state transition, is in
[`docs/wasm-api.md`](https://github.com/andrekuehne/necpp/blob/master/docs/wasm-api.md).

## Geometry and ports

Build geometry first, complete it once, then define an ordered port list.
Wire tags are positive integers. A port segment is one-based among all
segments carrying that tag, so an 11-segment dipole is centre-fed at segment
6. Port order fixes the order used by every vector, matrix row/column, and
embedded field basis.

The initial environment is free space with no loads. Call `addLoad()`,
`clearLoads()`, or `setGround()` after geometry completion and before
`prepare()`. Changing ground or loads later is allowed, but invalidates the
factorization and returns the model to `geometry-complete`.

### Ground-connected wires

`groundConnection` controls the NEC `GE` connection rule; it does not install
a ground model. The default `"none"` is `GE 0`. `"interpolate"` is `GE +1`,
the normal rooted-monopole connection that interpolates current to the image
below the plane. `"zero-current"` is `GE -1` and leaves the current expansion
unchanged, so a wire end touching `z=0` is a zero-current end.

```ts
import type { FullArrayDescription } from "@necpp-engine/wasm";

const rooted: FullArrayDescription = {
  elements: [{ id: "monopole", positionM: [0, 0], patternId: "vertical" }],
  patterns: [{
    id: "vertical",
    kind: "straight-wire-pattern",
    wires: [{
      id: "radiator",
      segments: 11,
      startM: [0, 0, 0],
      endM: [0, 0, 0.25],
      radiusM: 0.001,
    }],
    ports: [{ wireId: "radiator", segment: 2 }],
  }],
  ground: { kind: "perfect" },
  groundConnection: "interpolate",
};
```

A non-none connection requires perfect or finite ground when `prepare()`
runs and cannot be combined with structural reflection through `z=0`.
Segments may end at the plane but may not extend below or lie in it. NEC-2
cannot accurately model a ground stake through finite ground; a driven base
connection there can make impedance strongly dependent on source-segment
length. Reconstruct an array solver to change `groundConnection`.

## Z and Y matrices

`computeImpedanceMatrix()` factors the electromagnetic interaction matrix once
and returns both port matrices. Entry `Z[row,column]` is the voltage at port
`row` produced by a unit current at port `column`, with all other requested
port currents zero. `Y` has the analogous voltage-driven interpretation.

```ts
import type { ComplexMatrix } from "@necpp-engine/wasm";

function entry(matrix: ComplexMatrix, row: number, column: number) {
  const index = row * matrix.columns + column;
  return {
    real: matrix.real[index],
    imag: matrix.imag[index],
  };
}

declare const z: ComplexMatrix;
const selfImpedance = entry(z, 0, 0);
const mutualImpedance = entry(z, 0, 1);
console.log({ selfImpedance, mutualImpedance });
```

The returned `conditionEstimate` is omitted only when the native implementation
cannot estimate it. Matrix formation throws `NecConditioningError` instead of
returning a singular or excessively ill-conditioned inverse.

## Voltage- and current-driven arrays

`solveVoltages()` applies exactly the requested simultaneous complex voltages.
`solveCurrents()` first computes the required voltages with `V = Z I`, then
executes one simultaneous source solve. Both return achieved voltages and
currents, per-port powers, and active impedances in stable port order.

```ts
import type { NecModel } from "@necpp-engine/wasm";

declare const model: NecModel;

const voltageDriven = model.solveVoltages({
  real: new Float64Array([1, 0]),
  imag: new Float64Array([0, 1]),
});

const currentDriven = model.solveCurrents({
  real: new Float64Array([1, 0]),
  imag: new Float64Array([0, -1]),
});

console.log(voltageDriven.currents, currentDriven.voltages);
```

Matrix impedance and active impedance are different quantities. `Z[i,j]` is a
fixed property of the prepared model. Active impedance is `V[i] / I[i]` for
one particular simultaneous excitation, so mutual coupling makes it change
when array weights change. An exactly zero achieved current produces
`NaN + jNaN` active impedance; inspect the voltage/current vectors instead of
dividing by zero. Time-average input power is
`0.5 * Re(V * conjugate(I))` watts.

Every successful solve also returns a frozen aggregate native balance:

```ts
import type { PortSolution } from "@necpp-engine/wasm";

declare const currentDriven: PortSolution;

const {
  inputPowerW,
  radiatedPowerW,
  structureLossW,
  networkLossW,
  efficiencyPercent,
} = currentDriven.powerBudget;
```

`inputPowerW` agrees numerically with the sum of simultaneous per-port
`powersW`, including mutual-coupling contributions. NEC defines
`radiatedPowerW = inputPowerW - structureLossW - networkLossW`;
`efficiencyPercent` is `null` only for exact zero input. This is the native
total balance, not power in a selected polarization. Finite lossy ground has
no separately reported ground-loss term, so do not treat this value as an
upper-hemisphere flux identity without separate validation.

## Complex far fields and beamforming

`computeFarField()` uses the most recent public solve. At the default 1 m,
`eTheta*` and `ePhi*` are split real/imaginary V/m arrays. At another range,
the field follows `e^(-jkR) / R` while retaining the same angular far-field
approximation.

Normal steering uses one simultaneous solve followed by the native combined
field path. Multiple display or integration grids reuse that solved state:

```ts
import type {
  ComplexVector,
  FarFieldRequest,
  NecModel,
} from "@necpp-engine/wasm";

declare const model: NecModel;
declare const currents: ComplexVector;
declare const displayRequest: FarFieldRequest;
declare const integrationRequest: FarFieldRequest;

await model.prepare({ frequencyMHz: 300 });
const solution = model.solveCurrents(currents);
const displayField = model.computeFarField(displayRequest);
const integrationField = model.computeFarField(integrationRequest);
```

Do not superpose embedded fields in JavaScript for this normal path.

`computeEmbeddedFarFields()` returns one complex basis pattern per port.
Unit-current normalization makes array beamforming a direct weighted sum. The
arrays are basis-major, followed by the normal theta-fast sample layout.
At a prepared frequency, the solver retains voltage-basis current coefficients
while extracting the admittance matrix. One-point field requests evaluate the
requested angle from those coefficients and convert to the one-ampere basis
with the impedance matrix, without repeating the port solves. Larger grids
use the established serial path. A one-point request uses `count: 1` on both
axes and accepts any valid theta and phi
values. The retained basis has a 64 MiB allocation budget; larger models use
the serial extraction path.

```ts
import type {
  EmbeddedFarFieldResult,
  NecModel,
} from "@necpp-engine/wasm";

declare const model: NecModel;

const embedded = model.computeEmbeddedFarFields(
  {
    radiusM: 1,
    theta: { startDeg: 90, count: 1, stepDeg: 0 },
    phi: { startDeg: 0, count: 361, stepDeg: 1 },
  },
  { kind: "unit-current", valueA: 1 },
);

const phaseStepRad = Math.PI / 3;
const weights = embedded.ports.map((_, port) => ({
  real: Math.cos(port * phaseStepRad),
  imag: Math.sin(port * phaseStepRad),
}));

function combineETheta(basis: EmbeddedFarFieldResult) {
  const real = new Float64Array(basis.samplesPerPort);
  const imag = new Float64Array(basis.samplesPerPort);
  for (let port = 0; port < basis.ports.length; port += 1) {
    const weight = weights[port]!;
    for (let sample = 0; sample < basis.samplesPerPort; sample += 1) {
      const index = port * basis.samplesPerPort + sample;
      const er = basis.eThetaReal[index]!;
      const ei = basis.eThetaImag[index]!;
      real[sample] = real[sample]! + weight.real * er - weight.imag * ei;
      imag[sample] = imag[sample]! + weight.real * ei + weight.imag * er;
    }
  }
  return { real, imag };
}

console.log(combineETheta(embedded));
```

For a one-off excitation, `solveCurrents()` plus `computeFarField()` is simpler.
Embedded fields are useful when many weight sets share one geometry and
frequency: compute the bases once, then combine them in JavaScript without
additional native solves.

## Infinite periodic arrays

`createNecPeriodicModel()` models one **unit cell** of an infinite planar
array in free space, above a perfect ground plane or above finite ground.
Wires, ports and loads
use the same definitions as `NecModel`; the lattice is two vectors in the
xy-plane, in metres. For each **scan state** it returns the P x P **scan
impedance** and **scan admittance** of the unit-cell ports: the port matrices
of the cell inside the infinite array.

```ts
import { createNecPeriodicModel, squareLattice } from "@necpp-engine/wasm";

const cell = await createNecPeriodicModel();
cell.addWire({ tag: 1, segments: 11, start: [-0.24, 0, 0], end: [0.24, 0, 0], radiusM: 0.001 });
cell.completeGeometry();
cell.definePorts([{ tag: 1, segment: 6 }]);
cell.setLattice(squareLattice({ spacingM: 0.7 })); // a1M = [0.7, 0], a2M = [0, 0.7]

// Scan phases: radians per cell along a1 and a2.
const scan = cell.computeScanImpedance({ frequencyMHz: 300, scanPhasesRad: [1.2, 0] });
console.log(scan.impedance.real[0], scan.impedance.imag[0]);

// Or a beam direction in visible space; the result reports the scan phases.
const steered = cell.computeScanImpedance({
  frequencyMHz: 300,
  scanDirection: { thetaDeg: 30, phiDeg: 45 },
});
console.log(steered.scanPhasesRad);
cell.dispose();
```

### Lattices

Any planar lattice works: pass two non-parallel vectors, or use a preset.
Presets return plain `{ a1M, a2M }` vectors, and those vectors fix the
meaning of the scan phases:

| Preset | `a1M` | `a2M` |
|---|---|---|
| `squareLattice({ spacingM: d })` | `[d, 0]` | `[0, d]` |
| `rectangularLattice({ spacingXM: dx, spacingYM: dy })` | `[dx, 0]` | `[0, dy]` |
| `centeredRectangularLattice({ spacingXM: dx, spacingYM: dy })`, rows along x, `dy` apart, every other row shifted by `dx / 2` | `[dx, 0]` | `[dx / 2, dy]` |
| `hexagonalLattice({ spacingM: d })` or `rowsAlong: "x"` | `[d, 0]` | `[d / 2, d sqrt(3) / 2]` |
| `hexagonalLattice({ spacingM: d, rowsAlong: "y" })` | `[0, d]` | `[d sqrt(3) / 2, d / 2]` |

An oblique lattice is just two other vectors. The engine reduces a skewed
pair internally to short vectors spanning the same lattice, but the scan
phases always refer to the vectors you gave: `{ a1M, a2M }` and
`{ 2 a1M + a2M, 3 a1M + 2 a2M }` describe the same array, and give the same
scan impedance for the same physical scan state (`psi1' = 2 psi1 + psi2`,
`psi2' = 3 psi1 + 2 psi2`).

A unit cell may hold any number of elements and ports. A honeycomb array is a
hexagonal lattice with two elements per cell; dual-polarized and
sub-lattice arrangements work the same way. The scan impedance then couples
all ports of the cell.

### Scan phases and scan direction

- Cell (m, n) sits at `m * a1M + n * a2M`. Its currents are the unit-cell
  currents times `exp(j (m * psi1 + n * psi2))`, with `scanPhasesRad = [psi1,
  psi2]` always relative to the lattice vectors as given. Scan phases reach
  every scan state, including invisible space.
- `scanDirection: { thetaDeg, phiDeg }` is the main-beam direction, with
  `thetaDeg` from +z (0 to 90, visible space only) and `phiDeg` from +x
  towards +y. It maps to `psi_i = -kt0 . a_i` with
  `kt0 = k sin(theta) [cos(phi), sin(phi)]`. `scanPhasesForDirection({
  lattice, frequencyMHz, thetaDeg, phiDeg })` gives the same mapping without
  a solve. A request takes exactly one of `scanPhasesRad` and `scanDirection`.

### Scan sweeps and workers

A scan change at the frequency of the previous call keeps the
scan-independent part of the fill (the free-space matrix and the sum over
lattice points) and costs about half of a call at a new frequency. To map the
scan impedance over many scan states, sweep them on a pool of workers:

```ts
import { createNecPeriodicModel, squareLattice, type ScanState } from "@necpp-engine/wasm";

const cell = await createNecPeriodicModel();
cell.addWire({ tag: 1, segments: 11, start: [-0.24, 0, 0], end: [0.24, 0, 0], radiusM: 0.001 });
cell.completeGeometry();
cell.definePorts([{ tag: 1, segment: 6 }]);
cell.setLattice(squareLattice({ spacingM: 0.7 }));

const states: ScanState[] = [];
for (let theta = 0; theta <= 60; theta += 5) states.push({ scanDirection: { thetaDeg: theta, phiDeg: 0 } });

const controller = new AbortController();
for await (const chunk of cell.sweepScanImpedance(
  { frequencyMHz: 300, scanStates: states },
  { workers: "auto", signal: controller.signal },
)) {
  for (const { index, result } of chunk.points) {
    console.log(states[index], result.impedance.real[0], result.impedance.imag[0]);
  }
  console.log(`${chunk.completed} of ${chunk.total}`);
}
cell.dispose();
```

- Each chunk holds the scan states solved since the previous one, in
  completion order; `index` points into `scanStates`. The results equal those
  of `computeScanImpedance`.
- `workers`: 1 through 8, or `"auto"` (the default, one per logical core
  minus one). Each worker holds a copy of the unit cell; they start on the
  first sweep, keep their fill between sweeps and stop on `dispose()`.
- Aborting the signal rejects the iteration with a `NecCancellationError`
  and dispatches nothing more. A worker finishes at most the scan state it
  is solving, whose result is dropped, and is then free for the next sweep.

The periodic model also runs in a worker of its own:
`createNecPeriodicWorkerModel()` from `@necpp-engine/wasm/worker` has the same
methods, asynchronous, plus `terminate()` and `subscribeProgress()`. The
lattice presets and `scanPhasesForDirection` are exported there too.

### Floquet modes and power

Above and below the array the field is a sum of **Floquet modes**: plane
waves with transverse wavevector `kt = kt0 + p b1 + q b2`, where `b1`, `b2`
are the reciprocal vectors of the lattice vectors as given. Every scan result
carries, per port, the amplitudes of all propagating modes and of any
evanescent modes you ask for:

```ts
import { createNecPeriodicModel, rectangularLattice, terminatedFloquetAmplitudes } from "@necpp-engine/wasm";

const cell = await createNecPeriodicModel();
cell.addWire({ tag: 1, segments: 21, start: [-0.24, 0, 0], end: [0.24, 0, 0], radiusM: 0.001 });
cell.completeGeometry();
cell.definePorts([{ tag: 1, segment: 11 }]);
cell.setLattice(rectangularLattice({ spacingXM: 0.7, spacingYM: 0.5 }));

const scan = cell.computeScanImpedance({
  frequencyMHz: 300,
  scanDirection: { thetaDeg: 45, phiDeg: 0 },
  evanescentModes: [{ p: 1, q: 0 }],
});
for (const mode of scan.floquet.modes) {
  // At 45 degrees mode (-1, 0) is a grating lobe.
  console.log(mode.p, mode.q, mode.side, mode.propagating, mode.powerW[0]);
}
const [budget] = scan.floquet.powerBudget;
console.log(budget?.inputW, budget?.propagatingW, budget?.lossW);

// Every port terminated in 50 ohm, one driven with 1 W available power.
const terminated = terminatedFloquetAmplitudes(scan, { generatorImpedanceOhm: 50 });
console.log(terminated.modes.map((mode) => mode.powerW[0]));
cell.dispose();
```

- `te` and `tm` are the components along phi-hat and theta-hat of the mode
  direction, in square-root watts: a propagating mode carries
  `(|te|^2 + |tm|^2) / 2` watts per cell. Their phase is referred to the
  origin, like the far fields of a finite model, so the (0, 0) mode above the
  cell is the **scan element pattern** in the scan direction:
  `R exp(j k R) E_theta = j sqrt(eta A cos(theta)) tm / wavelength`
  (likewise `E_phi` and `te`), A the cell area.
- `normalization` (default unit voltage with the other ports shorted, or
  `{ kind: "unit-current", valueA: 1 }` with them open) is that of embedded
  far fields. `powerBudget` checks each port's drive: the input power returns
  as propagating Floquet power plus the loss in the loads, to the
  discretization error of the wires (about 1e-3 at 21 segments per
  half-wave, falling with the square of the segment length).
- Over perfect or finite ground only modes above the cell exist.
- `terminatedFloquetAmplitudes(result, { generatorImpedanceOhm })` terminates
  every port in the same generator impedance (ohms, or `[resistance,
  reactance]`) and drives one port at a time with 1 W of available power,
  without a new solve; `powerW` is then the fraction of the available power
  in each mode.

### Scan element pattern

The **scan element pattern** of a port is its far field inside the infinite
array: in each direction, the (0, 0) Floquet amplitude at the scan state
pointing that way. `computeScanElementPattern` samples it with a scan sweep
over visible space and returns an object you can evaluate in any direction,
in `(u, v) = sin(theta) (cos(phi), sin(phi))` or in angles:

```ts
import { createNecPeriodicModel, rectangularLattice } from "@necpp-engine/wasm";

const cell = await createNecPeriodicModel();
cell.addWire({ tag: 1, segments: 11, start: [-0.24, 0, 0.25], end: [0.24, 0, 0.25], radiusM: 0.001 });
cell.completeGeometry();
cell.definePorts([{ tag: 1, segment: 6 }]);
cell.setGround({ kind: "perfect" });
cell.setLattice(rectangularLattice({ spacingXM: 0.7, spacingYM: 0.6 }));

const pattern = await cell.computeScanElementPattern(
  { frequencyMHz: 300, grid: { spacingUV: 0.2 } },
  { onProgress: ({ completed, total, round }) => console.log(round, completed, total) },
);
const value = pattern.evaluate({ thetaDeg: 30, phiDeg: 0 });
console.log(value.te.real[0], value.tm.real[0], value.interpolationError[0]);
console.log(pattern.samples.length, pattern.woodCircles.map(({ p, q }) => [p, q]));
cell.dispose();
```

- At a sweep point (`pattern.samples`), `evaluate` returns the solved
  amplitudes exactly (`sampled: true`). Elsewhere it interpolates, never
  across a **Wood circle** (where a grating lobe appears), so the pattern
  stays sharp at Wood anomalies and scan-blindness notches, and states an
  `interpolationError` per port. That is an estimate: in tests it covered
  99.5 % of directions, falling short by up to about 3 times only where two
  Wood circles, or one and the horizon, are both close.
- The grid: a square grid of `spacingUV` (by default a tenth of the distance
  to the nearest grating-lobe circle centre, at most 0.1, widened to keep the
  grid at 8,000 samples) or your own `points`, plus rows along both sides of
  every Wood circle, graded towards it.
- Adaptive refinement (on by default) then adds samples wherever the
  interpolation error exceeds 1 % of the pattern's peak: up to 4 rounds and
  four times the grid's samples (`refinement: { tolerance, maxRounds,
  maxSamples }`, or `false`). Next to a Wood anomaly a dipole array's
  pattern can drop to a null within `|kz| / k ~ 0.01`, which only refinement
  resolves.
- The sweeps run on the same workers as `sweepScanImpedance` and take
  `workers` and `signal`. Building the interpolant also costs about 1 ms of
  main-thread time per sample.
- In free space `side` may be `"below"` for the pattern below the cell.

### Windowed arrays

A **windowed array** is a finite block of driven cells inside the infinite
array, every other cell still present and terminated. Its pattern is exactly
the array factor times the scan element pattern, so one pattern serves any
window, taper and steering direction without a further solve:

```ts
import {
  createNecPeriodicModel,
  rectangularLattice,
  windowedArray,
  type WindowedArrayCell,
} from "@necpp-engine/wasm";

const cell = await createNecPeriodicModel();
cell.addWire({ tag: 1, segments: 11, start: [-0.24, 0, 0], end: [0.24, 0, 0], radiusM: 0.001 });
cell.completeGeometry();
cell.definePorts([{ tag: 1, segment: 6 }]);
cell.setLattice(rectangularLattice({ spacingXM: 0.6, spacingYM: 0.5 }));

const pattern = await cell.computeScanElementPattern({ frequencyMHz: 300 });
const steering = cell.computeScanImpedance({
  frequencyMHz: 300,
  scanDirection: { thetaDeg: 30, phiDeg: 0 },
});

// A 16 x 16 window under a cosine taper, steered to 30 degrees.
const cells: WindowedArrayCell[] = [];
const taper: number[] = [];
for (let m = 0; m < 16; m += 1) {
  for (let n = 0; n < 16; n += 1) {
    cells.push([m, n]);
    taper.push(Math.cos((Math.PI * (m - 7.5)) / 16) * Math.cos((Math.PI * (n - 7.5)) / 16));
  }
}
const array = windowedArray(pattern, {
  steering,
  cells,
  excitation: { real: Float64Array.from(taper), imag: new Float64Array(taper.length) },
});
const field = array.computeFarField({
  theta: { startDeg: -90, count: 181, stepDeg: 1 },
  phi: { startDeg: 0, count: 1, stepDeg: 0 },
});
console.log(field.eThetaReal[120], array.activeImpedances.real[0], array.activeImpedances.approximate);
cell.dispose();
```

- `cells` are lattice indices `[m, n]`, the cell at `m a1 + n a2`.
  `excitation` (cell-major, `cell * portCount + port`, volts or amperes as
  the pattern's normalization; 1 on every port by default) is the taper; the
  steering result's scan phases are applied on top, and `drive` holds the
  result: a finite array driven with `drive` is the same block without the
  surrounding cells.
- `computeFarField` takes the theta-phi grid of a finite model's
  `computeFarField` and returns the same `FarFieldResult`, `E` in V/m with
  `exp(-j k R) / R`. Below the horizon it uses the pattern below the cell in
  free space and is zero over ground.
- `activeImpedances` is an **approximation**, flagged `approximate: true`:
  every driven element is taken to see the scan impedance of the steering
  state (applied to its own port drives). Deep inside a large window that is
  close (0.7 % at the centre of a uniform 32 x 32 array in tests); towards
  the edges it is not. For the per-element active impedances of an array of
  moderate size, solve the finite array (`createNecArraySolver`).
- What the windowed model leaves out: the edges. A finite array has no cells
  outside the block, and its pattern differs by the edge effects: against
  direct finite solves of half-wave dipoles (three segments each, on a 0.6 x
  0.5 wavelength lattice) steered to 30 degrees, the main
  beam and near sidelobes differ by 7.8, 4.8 and 2.2 % of the peak at 8 x 8,
  16 x 16 and 32 x 32, and by 1 % or less under a cosine taper at 16 x 16.
  Strongly coupled elements (vertical dipoles, for example) converge far
  more slowly.
- The infinite model overstates scan blindness: a guided wave needs many
  cells to build up, so a real array shows a shallower, wider and shifted
  dip. The notch also appears in every steered pattern, because the scan
  element pattern multiplies them all.
- The windowed model is exact only when the passive cells are terminated in
  the generators' internal impedance: shorted with ideal voltage drive (the
  default unit-voltage normalization), open with ideal current drive
  (`{ kind: "unit-current", valueA: 1 }`). For a common generator impedance,
  load every port of the cell with it (`addLoad`) and drive the window
  through it; the active impedances then include the load.

### Layered stacks (radomes, substrates) and finite ground

A **layered stack** above the wires, such as a radome or a wide-angle impedance
matching (WAIM) sheet, is made of dielectric layers that are uniform in the
lattice plane, with air above them:

```ts
import { createNecPeriodicModel, rectangularLattice } from "@necpp-engine/wasm";

// Strip dipoles (as wires of radius width / 4) 25 mm over ground at 3 GHz.
const cell = await createNecPeriodicModel();
cell.addWire({ tag: 1, segments: 21, start: [-0.024, 0, 0.025], end: [0.024, 0, 0.025], radiusM: 0.0005 });
cell.completeGeometry();
cell.definePorts([{ tag: 1, segment: 11 }]);
cell.setGround({ kind: "perfect" });
cell.setLattice(rectangularLattice({ spacingXM: 0.06, spacingYM: 0.05 }));

// A 3 mm sheet of eps_r 4 whose lower face is 15 mm above the dipoles.
cell.setLayeredStacks({
  above: {
    bottomZM: 0.04,
    layers: [{ thicknessM: 0.003, relativePermittivity: 4, lossTangent: 0.02 }],
  },
});
const result = cell.computeScanImpedance({
  frequencyMHz: 2997.92458,
  scanDirection: { thetaDeg: 45, phiDeg: 90 },
});
const [power] = result.floquet.powerBudget;
// The gap and the modes the stack's terms took; the share of the input power
// absorbed in the sheet.
console.log(result.diagnostics.layeredStack, power && power.dielectricLossW / power.inputW);
cell.setLayeredStacks({}); // removes the stack
cell.dispose();
```

- Each Floquet mode sees the stack through a TE and a TM reflection, from a
  transmission-line model of its layers. Their effect enters the scan
  impedance directly, also over perfect ground, where the reflections between
  ground and stack are included.
- The Floquet modes above the cell are the waves **transmitted** through the
  stack, so the scan element pattern is what an observer outside sees. The
  power budget closes with `dielectricLossW`, which includes the power that
  evanescent modes leave in a lossy layer close to the wires.
- The wires must stay in the air below the stack: a wire that reaches it is
  refused. The reflection terms decay like `exp(-2 |kz| gap)`, so a small gap
  needs many modes. Above 20,000 modes (a gap of about 0.01 wavelengths in a
  half-wavelength cell) the stack is refused with the gap and the mode count.
- Against a full-wave FEM unit cell (CST) of strip dipoles over ground with a
  spaced lossy sheet, the transmitted power fractions and the sheet loss
  agree to 3e-4, and the sheet's change of the scan impedance to 3 to 4 %.
- Permittivity is constant over frequency: `relativePermittivity` at least 1,
  `lossTangent` at least 0, and `mu_r = 1`.

A stack **below** the wires, such as a substrate, is placed by its upper face
and lists its layers from there down. Below it is the ground: perfect or
finite, with air between the stack and z=0 unless it rests there, or in free
space air, through which the stack transmits the modes below the cell.
**Finite ground** (soil of finite conductivity) is a reflection of the same
kind, with no layers:

```ts
import { createNecPeriodicModel, rectangularLattice } from "@necpp-engine/wasm";

// Half-wave dipoles 0.25 m over a 0.1 m substrate on soil, at 300 MHz.
const cell = await createNecPeriodicModel();
cell.addWire({ tag: 1, segments: 21, start: [-0.24, 0, 0.25], end: [0.24, 0, 0.25], radiusM: 0.001 });
cell.completeGeometry();
cell.definePorts([{ tag: 1, segment: 11 }]);
cell.setGround({ kind: "finite", method: "sommerfeld-norton", relativePermittivity: 13, conductivitySPerM: 0.005 });
cell.setLattice(rectangularLattice({ spacingXM: 0.6, spacingYM: 0.5 }));
cell.setLayeredStacks({
  below: { topZM: 0.1, layers: [{ thicknessM: 0.1, relativePermittivity: 3, lossTangent: 0.01 }] },
});
const result = cell.computeScanImpedance({ frequencyMHz: 299.792458, scanPhasesRad: [0, 0] });
const [power] = result.floquet.powerBudget;
// The share of the input power taken by the substrate and the soil.
console.log(power && power.dielectricLossW / power.inputW);
cell.dispose();
```

- Each Floquet mode sees finite ground through its exact Fresnel reflection,
  whichever `method` is set: no Sommerfeld integrals and no
  reflection-coefficient approximation. Against the centre of a tapered
  finite array over NEC's Sommerfeld-Norton ground the scan impedance agrees
  to the finite array's edge error (1.9 % at 21 x 21).
- Stacks above and below can be combined, over any ground; the reflections
  between them are included. `dielectricLossW` then counts the loss in both
  stacks and all the power that enters the soil.
- Wires must stay in the air above the stack below and above finite ground;
  over ground, the stack below must not reach below z=0. The gap reported in
  `diagnostics.layeredStack` is the smallest one, to either stack or to
  finite ground, and it sets the mode count as above.

### Conventions and limits

- Scan impedance is not the active impedance of any finite array: it belongs
  to the infinite array. It is not symmetric in general; reciprocity holds as
  `Z(psi) = Z(-psi)^T`.
- A single cell of an infinite array has no far field of its own, so the
  periodic model has no far-field, embedded-field or isolated-element methods.
- Free space, perfect ground with `cell.setGround({ kind: "perfect" })` (a
  ground plane at z=0 under every cell) or finite ground (see above). Every
  conductor must stay above the ground; one that touches, nearly touches or
  crosses a perfect ground plane, or reaches finite ground, is refused with a
  `NecGeometryError` (ground connections, such as monopoles on the plane,
  are not supported). Layered stacks can sit above and below the wires (see
  above). No geometry symmetry.
- Accuracy: one fixed internal tolerance, `1e-5` relative to the largest
  scan-impedance entry, and no numerical parameters. Each result carries
  `diagnostics.estimatedError` (the solver's numerical error: periodic
  Green's function, quadrature, rounding near a Wood anomaly; about `2e-10`
  for typical cells) and `diagnostics.status`. Thin-wire modelling error is
  not included. Configurations that cannot reach the tolerance are refused
  with a reason: unit cells above about 320 square wavelengths and segments
  longer than about 0.3 wavelengths.
- Wood anomalies: results are finite and continuous on and next to them
  (with a square-root kink), never refused or NaN. Within `|kz| < 1e-3 k` of
  a Floquet mode's cut-off the status is `"near-cutoff"`, otherwise `"ok"`;
  do not interpolate across a Wood circle.
- Clearance: the cells must be electrically separate. `setLattice` refuses,
  with a `NecGeometryError` naming the segments and the image cell, a lattice
  under which any conductor touches or nearly touches a periodic image of a
  conductor in the cell (its own or another's): the distance between the
  segment axes is at most the sum of the two wire radii plus NEC's segment
  joining tolerance (0.001 times the longer segment's length). Connected
  arrays are not supported. Conductors that keep clear but come close to a
  neighbouring cell's conductors (tightly packed cells, small end gaps) need
  no special input: close periodic images are evaluated with the same
  thin-wire kernel as a finite array. Dividing the same array into larger
  cells changes the scan impedance by a few 1e-6 relative.

## Direct mode and worker mode

| Mode | Import | Calls | Best for |
|---|---|---|---|
| Direct | `@necpp-engine/wasm` | Synchronous after creation | Node, tests, small browser models |
| Worker | `@necpp-engine/wasm/worker` | Asynchronous and serialized | Browser UI and realistic solves |

The factory is always asynchronous because it instantiates WebAssembly. A
direct browser solve then occupies the main thread until it finishes. The
worker facade preserves model state in a package-supplied module worker and
transfers large result buffers back to the caller.

```ts
import { createNecWorkerModel } from "@necpp-engine/wasm/worker";

const model = await createNecWorkerModel({
  onProgress: ({ operation, phase }) => console.log(operation, phase),
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
  await model.definePorts([{ tag: 1, segment: 6 }]);
  await model.prepare({ frequencyMHz: 300 });
  console.log(await model.computeImpedanceMatrix());
} finally {
  await model.dispose();
}
```

Worker calls cannot interrupt a synchronous native calculation. Use
`model.terminate()` for immediate cancellation; it kills the worker and
rejects outstanding operations with `NecCancellationError`. The same hard
boundary is available as `solver.terminate()` on `NecArraySolver`; its
`cancelFarField()` remains the reusable, field-only supersession boundary.
Create a new model or solver after hard termination. Direct `NecModel`
operations are synchronous and therefore cannot be preempted; `dispose()` is
safe and idempotent but is not an interruption mechanism.

## Lifecycle and disposal

The normal lifecycle is
`empty -> geometry-building -> geometry-complete -> prepared -> solved`.
`computeImpedanceMatrix()` and embedded-field calculation are legal while
prepared; combined far fields require a latest solution. Repeating
`prepare()` at the same frequency is idempotent. New excitations and field
grids reuse the retained factorization. Geometry cannot change after
`completeGeometry()`.

Always dispose in `finally`. Direct `dispose()` and worker `await dispose()`
are idempotent. Every other operation after disposal throws `NecStateError`.

## Node, browser, Vite, and CDN loading

Node and browsers use the same package and public types. By default,
`nec2pp.wasm` is resolved beside the installed JavaScript with
`new URL("./nec2pp.wasm", import.meta.url)`; consumers do not copy it.
The array facade likewise resolves `field-evaluator-worker.js`,
`field-evaluator.js`, `necpp-field-evaluator.generated.js`, and
`necpp-field-evaluator.wasm` from the package. Vite emits content-hashed worker,
loader, and WASM assets even under a non-root `base`.

Direct mode needs no Vite configuration. For the module-worker entry point,
use this Vite configuration:

```ts
import { defineConfig } from "vite";

export default defineConfig({
  build: { target: "es2024" },
  worker: { format: "es" },
});
```

Production servers should serve `.wasm` as `application/wasm`. To host the
binary on a CDN, pass an HTTP(S) URL. Cross-origin servers must also send an
appropriate CORS header.

```ts
import { createNecModel } from "@necpp-engine/wasm";

const model = await createNecModel({
  wasmUrl: new URL("https://cdn.example.test/necpp/0.11.0/nec2pp.wasm"),
});
model.dispose();
```

To relocate the complete evaluator asset set, place the packaged evaluator
worker, generated loader, and WASM binary in one directory and pass its URL as
`fieldWorkerAssetBaseUrl` to `createNecArraySolver()`. The default package URL
is recommended for bundlers because it enables static content hashing.

`wasmBinary` accepts an `ArrayBuffer` or `Uint8Array` when the host application
wants to fetch/cache the bytes itself. `wasmUrl` and `wasmBinary` are mutually
exclusive. `runDeck(deck)` remains available as a compatibility escape hatch
for complete NEC text decks.

## Error handling

Every package-defined operational error derives from `NecError` and has a
stable `code`: `NEC_STATE`, `NEC_INPUT`, `NEC_GEOMETRY`, `NEC_PORT`,
`NEC_CONDITIONING`, `NEC_SOLVER`, or `NEC_RUNTIME`. Messages and `details` are
diagnostic rather than a compatibility contract.

```ts
import {
  NecConditioningError,
  NecError,
  createNecModel,
} from "@necpp-engine/wasm";

try {
  const model = await createNecModel();
  try {
    model.computeImpedanceMatrix();
  } finally {
    model.dispose();
  }
} catch (error: unknown) {
  if (error instanceof NecConditioningError) {
    console.error("Port matrix cannot be inverted reliably", error.details);
  } else if (error instanceof NecError) {
    console.error(error.code, error.message, error.details);
  } else {
    throw error;
  }
}
```

## Performance and browser memory

- Segment count dominates factorization time and memory. Thin-wire modeling
  still requires physically sensible segment length/radius ratios; begin with
  modest odd segment counts and refine while checking convergence.
- Keep a prepared model alive while changing excitations or angular grids.
  Recreating it discards the expensive factorization.
- Prefer embedded fields when exploring many array weights at one frequency.
- The retained voltage field basis uses memory proportional to ports times
  segments. For an ordinary 256-port, five-segment wire array it occupies
  about 23 MiB in native coefficient arrays. It is cleared by any model or
  frequency change that invalidates the prepared matrix.
- Field storage scales with `theta.count * phi.count`; embedded storage also
  multiplies by port count and by four `Float64Array` components. A full
  181 x 361 field is about 2 MiB for the four component arrays; four embedded
  bases are about 8 MiB, excluding axes and temporary/native storage.
- Returned arrays are copies, so release references when results are no longer
  needed. Compute cuts instead of dense spheres when possible.
- Use worker mode for browser responsiveness. Each worker model owns an
  isolated WebAssembly instance and memory, so dispose unused models rather
  than pooling many idle workers.
- Isolated-element characterization packs currents and embedded patterns once.
  Transfer those `ArrayBuffer`s to a compute worker and bind them there; do
  not retain them in UI state or re-transfer them on steering.
- There is no shared-memory or thread requirement. Normal cross-origin
  isolation headers are not needed for this package.

## Complete Vite array example

The repository's
[four-element array application](https://github.com/andrekuehne/necpp/tree/master/examples/wasm-array-vite)
installs the packed package, computes Z/Y, applies progressive complex current
weights, displays achieved port quantities, and plots a normalized azimuth
cut. CI builds and runs that exact application in Chromium from the same
tarball used by every release gate.

## Versions

| Export | Meaning |
|---|---|
| `packageVersion` | Semantic version of the public TypeScript API |
| `engineVersion` | NEC2++ version compiled into the shipped WebAssembly |
| `abiVersion` | Stable internal C ABI; currently `1` |
| `necqSchemaVersion` | Schema of the packed `NECQ` quadrature buffer (byte offset 4); currently `1` |
| `necfSchemaVersion` | Schema of the packed `NECF` embedded-field envelope (byte offset 4); currently `1` |
| `necqFlags` | Defined `NECQ` flag bits (byte offset 8): `{ images: 1, weights: 2 }` |

Instantiation rejects a binary whose ABI or engine version does not match the
facade. Package and engine versions intentionally have independent version
lines; the release records both.

External readers of `NECQ`/`NECF` buffers can compare their own expected
schema against `necqSchemaVersion` and `necfSchemaVersion` of the installed
package. A schema bump then fails that check instead of passing silently.

## License

`@necpp-engine/wasm` is distributed under **GPL-2.0-or-later**, matching
NEC2++. The npm tarball includes `COPYING` with the full license text.

If you convey the JavaScript loader, WebAssembly binary, or an application
containing them, review and satisfy the GPL's corresponding-source, license,
and notice requirements for your distribution. This README is a technical
notice, not legal advice. Consult qualified counsel for a product-specific
licensing decision.

### Opt-in ring far fields

The default evaluator remains `"exact"`. For a complete, periodic, uniformly
sampled azimuth grid, opt into the ring evaluator once when creating a model,
worker model, or array solver:

```ts
import {
  createNecArraySolver,
  type FullArrayDescription,
  type FarFieldRequest,
  type ComplexVector,
} from "@necpp-engine/wasm";

declare const description: FullArrayDescription;
declare const grid: FarFieldRequest;
declare const voltages: ComplexVector;

const solver = await createNecArraySolver(description, {
  symmetry: "off",
  fieldWorkers: "auto",
  farFieldEvaluator: "ring",
});
try {
  await solver.prepare({ frequencyMHz: 300 });
  await solver.solveVoltages(voltages);
  const field = await solver.computeFarField(grid);
  const reference = await solver.computeFarField({ ...grid, evaluator: "exact" });
} finally {
  await solver.dispose();
}
```

The request's `evaluator` overrides the factory's `farFieldEvaluator`. The same
selection applies to `computeEmbeddedFarFields` and to `field` inside
`characterizeIsolatedElement`. Unit-voltage and unit-current normalization,
port ordering, and retained factorization behavior are unchanged. `runDeck`
continues to use the exact evaluator.

`"ring"` is an approximation with an engineering target of `1e-7` component
error relative to the requested grid's global vector-field peak. Its fixed
analytical truncation budget is much tighter; that bound excludes floating-point
roundoff and differences between the two existing exact kernels. It is **not**
the exact-binary64 evaluator. Free space and perfect ground with ordinary wires
are supported. Other models, nonperiodic grids, unsafe numerical budgets, and
rings estimated to cost more than direct evaluation use the existing direct path.
No requested samples are removed or moved. Periodic grids use `phi.stepDeg =
360 / phi.count`, without a duplicate endpoint.

Ring requests include optional `fieldEvaluation` provenance:

- `evaluator`: `"ring-bandlimited-v1"`;
- `execution`: `"ring"`, `"mixed"`, or `"exact"` after fallbacks;
- `interpolatedRings`, `directRings`, and `evaluatedDirections` (including scouts);
- `truncationBound`: absolute field bound in V/m, excluding roundoff;
- `fallbackReason`, when applicable.

For embedded results, counts sum over port bases and the bound is the maximum
per-basis bound. `fieldBackend` continues to describe worker execution separately.
Worker jobs process complete rings, so its tile counts refer to rings for this
method; an in-flight ring finishes before its stale result is discarded on
cancellation. Automatic scheduling chooses active workers using the planned
sparse work, while retaining the configured pool for reuse.

Packed NECF buffers retain schema version 1. Characterization and handoff results
carry provenance alongside the buffer; persist that sidecar if saving approximate
fields. Existing exact requests, packed goldens, and default result shapes remain
unchanged. Override with `evaluator: "exact"` for a comparison or rollback without
recreating or resolving the model.
