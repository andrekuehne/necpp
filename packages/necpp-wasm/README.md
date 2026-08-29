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

## Complex far fields and beamforming

`computeFarField()` uses the most recent public solve. At the default 1 m,
`eTheta*` and `ePhi*` are split real/imaginary V/m arrays. At another range,
the field follows `e^(-jkR) / R` while retaining the same angular far-field
approximation.

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
  wasmUrl: new URL("https://cdn.example.test/necpp/0.1.1/nec2pp.wasm"),
});
model.dispose();
```

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
