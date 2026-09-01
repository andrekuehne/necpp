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
rejects outstanding operations. Create a new model to continue afterward.
The higher-level array solver is different for eligible pooled far fields: a
newer solve or field request cancels obsolete work between bounded tiles while
retaining the outer solver and factorization.

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
  wasmUrl: new URL("https://cdn.example.test/necpp/0.4.0/nec2pp.wasm"),
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
- Field storage scales with `theta.count * phi.count`; embedded storage also
  multiplies by port count and by four `Float64Array` components. A full
  181 x 361 field is about 2 MiB for the four component arrays; four embedded
  bases are about 8 MiB, excluding axes and temporary/native storage.
- Returned arrays are copies, so release references when results are no longer
  needed. Compute cuts instead of dense spheres when possible.
- Use worker mode for browser responsiveness. Each worker model owns an
  isolated WebAssembly instance and memory, so dispose unused models rather
  than pooling many idle workers.
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

Instantiation rejects a binary whose ABI or engine version does not match the
facade. Package and engine versions intentionally have independent version
lines; the release records both.

## License

`@necpp-engine/wasm` is distributed under **GPL-2.0-or-later**, matching
NEC2++. The npm tarball includes `COPYING` with the full license text.

If you convey the JavaScript loader, WebAssembly binary, or an application
containing them, review and satisfy the GPL's corresponding-source, license,
and notice requirements for your distribution. This README is a technical
notice, not legal advice. Consult qualified counsel for a product-specific
licensing decision.
