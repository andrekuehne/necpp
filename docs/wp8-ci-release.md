# WP8 CI and release pipeline

WP8 makes [the WASM workflow](../.github/workflows/build.yml) the release gate
for `@necpp/wasm`. Pull requests and pushes run the complete native, WASM,
facade, package, and browser verification graph. A `wasm-v*` tag runs the same
graph and publishes only after every required job succeeds.

## Pinned toolchain

The workflow declares its release tool versions once:

- Node 24;
- `emscripten/emsdk:4.0.7`;
- TypeScript 5.8.3;
- Playwright 1.62.1.

The Emscripten container only invokes `scripts/build_wasm_inner.sh`. Node ABI,
TypeScript, package, and browser verification all run on the Node 24 host using
the artifacts copied out of that container. The npm lockfile fixes the complete
JavaScript test dependency graph.

## Verification graph

The native jobs independently cover the legacy Catch2/CLI suite and the WP1–4
stateful port, matrix, far-field, and C ABI partitions. The generated loader,
WASM binary, and internal declaration file are uploaded once and consumed by
the Node ABI and facade jobs.

After the facade passes, `scripts/pack-release.mjs` creates one npm tarball. It
validates the publish allowlist, license file, package version, source/debug
exclusions, and the size guards already enforced by `prepack`. It records the
tarball's SHA-256 digest and npm file report next to the tarball.

Every downstream consumer uses `NECPP_WASM_TARBALL` to install that exact file:

- clean Node direct and worker solves;
- CDN-style `wasmUrl` loading;
- a clean Vite bundle and preview;
- a real Chromium direct-mode solve;
- a real Chromium module-worker solve.

The browser tests validate impedance and complex far-field output and observe
that the emitted WASM request is served as `application/wasm`. The artifact job
then enforces a WASM size below 1 MiB, a generated loader below 200 KiB, and no
source maps or debug symbols. It emits final sizes and SHA-256 checksums.

## Tag release

The public package version and tag must match exactly. For package version
`X.Y.Z`, create tag `wasm-vX.Y.Z`. Prerelease identifiers are retained, so the
WP8 development version uses `wasm-v0.0.0-wp8`.

The repository must configure an `npm` GitHub environment with an `NPM_TOKEN`
secret authorized to publish the `@necpp/wasm` scope. The release job has only
`contents: write` and `id-token: write` permissions. It verifies the tag and
all checksums, publishes the already-tested `.tgz` with npm provenance, then
attaches that same tarball, `SHA256SUMS`, and `ARTIFACTS.txt` to a GitHub
release. It never runs `npm pack` again.

Any failure in native numerics, ABI compatibility, strict TypeScript, package
contents, GPL license inclusion, clean-consumer installation, either browser
mode, size limits, version matching, or checksum verification prevents the
publish job from starting.
