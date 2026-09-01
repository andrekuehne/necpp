# WP7 npm package assembly

WP7 turns the handwritten TypeScript facade and generated WASM into a
packable ESM package named `@necpp-engine/wasm`. Consumers install a tarball (or a
future npm publish) and import the documented entry points. They do not copy
artifacts, author a worker bootstrap, or depend on this repository's source
tree.

## Layout

```text
packages/necpp-wasm/
  package.json
  README.md
  COPYING          (copied from the repository root at pack time)
  src/
  dist/
    index.js
    index.d.ts
    worker.js
    worker.d.ts
    worker-entry.js
    field-evaluator-worker.js
    field-evaluator.js
    field-worker-pool.js
    nec2pp.generated.js
    nec2pp.wasm
    necpp-field-evaluator.generated.js
    necpp-field-evaluator.wasm
```

`package.json` is `"type": "module"` with encapsulated `exports` for `.` and
`./worker`. The `files` allowlist is `dist`, `README.md`, and `COPYING`. The
package was initially kept `private` until the WP8 release gate existed;
`npm pack` was the distribution path. WP8 makes the manifest publishable and
guards registry publication behind the complete tagged release workflow. Node
24 is the minimum supported Node runtime and the TypeScript facade is emitted
as ES2024.

`prepack` runs `scripts/build-dist.mjs`, which compiles `src/` to `dist/`,
copies both generated loaders and WASM binaries, copies `COPYING`, and rejects
source maps, debug symbols, a main WASM binary at or above 1 MiB, a main loader
at or above 200 KiB, or an evaluator loader/binary at or above 64 KiB.
`packageVersion` must match `package.json`; `engineVersion` must match the CMake
project version.

## Loading and versions

The packed loader resolves WASM with `new URL("./nec2pp.wasm", import.meta.url)`
and still accepts `wasmUrl` or `wasmBinary`. HTTP(S) `wasmUrl` values are
downloaded into a copied `wasmBinary` so CDN URLs work in Node as well as
browsers.

The public API exports `packageVersion`, `engineVersion`, and `abiVersion`.
Instantiation fails if the native ABI or engine string does not match.

## Clean-consumer tests

Package tests never import workspace `src/` or `.test-build`. They:

1. `npm pack` the assembled package
2. install the `.tgz` into a temporary fixture
3. `import { createNecModel } from "@necpp-engine/wasm"` by name
4. solve the centre-fed dipole
5. import `@necpp-engine/wasm/worker` and repeat
6. load WASM from an HTTP `wasmUrl`
7. build a non-root Vite fixture, confirm the outer and nested workers are
   bundled, and fetch both emitted `.wasm` files with
   `Content-Type: application/wasm`
8. execute the packed pooled-field fixture in Chromium and Firefox without
   cross-origin isolation

Direct `createNecModel()` needs no bundler config. Vite apps that import the
worker subpath set `worker: { format: "es" }` and `build.target: "es2024"`,
which match the module worker and ES2024 syntax the package ships.

The fixture's resolved module path must contain `node_modules/@necpp-engine/wasm`
and must not contain `packages/necpp-wasm/src`.

## License

The engine and package are GPL-2.0-or-later. The package README states that
distributing the loader or WASM is distribution of GPL software and that
downstream products must be reviewed against those obligations. `COPYING` is
included in the tarball.
