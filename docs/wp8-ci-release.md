# WP8 CI and release pipeline

WP8 makes [the WASM workflow](../.github/workflows/build.yml) the release gate
for `@necpp-engine/wasm`. Pull requests and pushes run the complete native, WASM,
facade, package, and browser verification graph. A `wasm-v*` tag runs the same
graph and publishes only after every required job succeeds.

## Pinned toolchain

The workflow declares its release tool versions once:

- Node 24;
- `emscripten/emsdk:4.0.7`;
- TypeScript 5.8.3;
- Playwright 1.62.1.

The Emscripten container only invokes `scripts/build_wasm_inner.sh`. It emits
the loader and WASM binary without invoking TypeScript. Node ABI, TypeScript,
package, and browser verification all run on the Node 24 host using the
artifacts copied out of that container. The npm lockfile fixes the complete
JavaScript test dependency graph.

## Verification graph

The native jobs independently cover the legacy Catch2/CLI suite and the WP1–4
stateful port, matrix, far-field, and C ABI partitions. The generated loader
and WASM binary are uploaded once and consumed by the Node ABI and facade jobs.
The committed handwritten declaration for the generated factory remains the
authoritative internal TypeScript boundary.

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
`X.Y.Z`, create tag `wasm-vX.Y.Z`. The initial public package version is
`0.1.0`, so its release tag is `wasm-v0.1.0`.

The first publication must use the repository's `npm` GitHub environment with
an `NPM_TOKEN` secret authorized to create a public package in the
`necpp-engine` scope. The token needs publishing access and npm's required 2FA
bypass setting. The release job has only `contents: write` and `id-token:
write` permissions. It verifies the tag and all checksums, publishes the
already-tested `.tgz` with npm provenance, then attaches that same tarball,
`SHA256SUMS`, and `ARTIFACTS.txt` to a GitHub release. It never runs `npm pack`
again.

After `0.1.0` exists on npm, replace the long-lived token with npm trusted
publishing. Configure the GitHub publisher for repository `andrekuehne/necpp`,
workflow `build.yml`, environment `npm`, and allowed action `npm publish`;
then remove `NODE_AUTH_TOKEN` from the release step and revoke the token. npm
requires a package to exist before a trusted relationship can be configured.

## Initial 0.1.0 release checklist

Before merging, the checked-in `package.json`, `packageVersion` export, and tag
must all identify `0.1.0`. After the WP9 branch reaches `main`:

1. Confirm the public npm organization/scope `necpp-engine` exists and the
   publishing account can create packages in it.
2. Protect the GitHub `npm` environment with required reviewers and add the
   initial granular `NPM_TOKEN` secret.
3. Wait for the complete `main` workflow to pass.
4. Create and push `wasm-v0.1.0` at that exact tested commit. Do not publish
   manually and do not rebuild the tarball locally.
5. Confirm the tag workflow passes every native, WASM, Node, package,
   documentation, Vite-example, and Chromium gate before approving the
   environment deployment.
6. Verify the npm page reports public access, version `0.1.0`, repository
   provenance, `GPL-2.0-or-later`, and both documented exports.
7. Download the GitHub release tarball and verify it against `SHA256SUMS`.
8. Configure npm trusted publishing as described above, remove the publish
   token, and retain environment approval plus tag protection.

Any failure in native numerics, ABI compatibility, strict TypeScript, package
contents, GPL license inclusion, clean-consumer installation, either browser
mode, size limits, version matching, or checksum verification prevents the
publish job from starting.
