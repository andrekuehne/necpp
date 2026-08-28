# `@necpp-engine/wasm`

Stateful NEC2++ antenna solver for Node and the browser. Consumers import a
high-level TypeScript API; they never copy WASM artifacts, parse NEC reports,
or touch Emscripten handles.

## License

This package is **GPL-2.0-or-later**, the same license as NEC2++. Shipping the
JavaScript loader or `nec2pp.wasm` binary to users is distribution of GPL
software. A product that includes this package must comply with GPL-2.0 or
later, including the obligation to provide corresponding source. Review those
obligations for the intended product before shipping. The full license text is
in `COPYING`.

Publication to the public npm registry requires control of the `necpp-engine` scope.
Tagged releases are gated by the full WP8 CI pipeline; until registry access is
configured, install the exact packed tarball produced by that workflow.

## Install

From a packed tarball:

```bash
npm install ./necpp-engine-wasm-0.0.0-wp8.tgz
```

The package is ESM-only (`"type": "module"`). Node 24 or later is required.

## Quick start

```ts
import {
  abiVersion,
  createNecModel,
  engineVersion,
  packageVersion,
} from "@necpp-engine/wasm";

console.log({ packageVersion, engineVersion, abiVersion });

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
  model.definePorts([{ tag: 1, segment: 6 }]);
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

  void impedance;
  void solution;
  void field;
} finally {
  model.dispose();
}
```

Geometry is metres, frequency is MHz, port current is positive into the
antenna, and far fields are complex V/m. See the
[numerical and API contract](https://github.com/andrekuehne/necpp/blob/master/docs/wasm-api.md).

## Versions

| Identifier | Meaning |
|---|---|
| `packageVersion` | npm package version of this TypeScript API |
| `engineVersion` | NEC2++ version compiled into the shipped WASM |
| `abiVersion` | Stable C ABI (`necpp_wasm_v1`); currently `1` |

The facade refuses to instantiate a binary whose ABI or engine version does
not match these constants.

## Loading WASM

By default the adjacent `nec2pp.wasm` is resolved with:

```ts
new URL("./nec2pp.wasm", import.meta.url)
```

Overrides:

- `wasmUrl` — file URL, HTTP(S) CDN URL, or path resolved against the package
- `wasmBinary` — caller-owned `ArrayBuffer` or `Uint8Array` (copied)

Bundlers such as Vite rewrite the default `import.meta.url` resolution; no
extra consumer config or artifact copying is required for `createNecModel()`.
Apps that import `@necpp-engine/wasm/worker` and bundle with Vite should set:

```js
export default {
  build: { target: "es2024" },
  worker: { format: "es" },
};
```

`worker.format` is Vite's setting for `{ type: "module" }` workers. `build.target`
must support the ES2024 syntax used by the package. Direct `createNecModel()`
still needs no application source changes and no artifact copying.

## Worker entry

Large browser solves should use the worker subpath:

```ts
import { createNecWorkerModel } from "@necpp-engine/wasm/worker";

const model = await createNecWorkerModel();
```

The package ships the worker script. Methods are asynchronous, serialized per
model, and otherwise match `NecModel`. `terminate()` is cancellation;
`dispose()` destroys the native handle first.

## Compatibility deck runner

`runDeck(deck)` executes a complete NEC text deck and returns the formatted
report. It is independent of `NecModel`.
