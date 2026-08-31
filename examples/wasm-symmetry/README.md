# Manual symmetry examples

These two standalone examples construct one fundamental element and ask NEC2++
to generate the other three elements by reflection across `x=0` and `y=0`:

- `manual-direct.mjs` uses the synchronous model after asynchronous creation.
- `manual-worker.mjs` uses the package-supplied module worker and awaits every
  operation.

From this directory, install `@necpp-engine/wasm` and run either file with
Node 24 or newer. Release tests instead copy both files into a clean consumer,
install the exact candidate tarball, and require four finite ports and four
symmetry sections from each.

The transparent full-description example is the neighboring
[`wasm-array-vite`](../wasm-array-vite/README.md) application.
