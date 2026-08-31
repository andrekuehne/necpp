# Four-element array Vite example

This is a downstream application for `@necpp-engine/wasm`, not a monorepo
source import. It supplies the complete list of four parallel half-wave
dipoles to the representation-independent array solver. The transparent
planner recognizes the exact reflection, builds a reduced model in a
package-supplied Web Worker, and reports its decision and maximum coordinate
adjustment. The application then uses the same matrix, solve, and field calls
that it would use after an explicit fallback: it computes the complex 4 x 4
impedance matrix, applies progressive complex current weights, shows achieved
port quantities, and plots the combined azimuth far-field cut at 1 m.

## Run with the published package

From this directory, run `npm install`, then
`npm install @necpp-engine/wasm@0.3.0`, followed by `npm run dev`. Open the URL
printed by Vite. Use `npm run build` and `npm run preview` to inspect the
production bundle.

The package dependency is intentionally installed as a separate command so
this example remains runnable before the first registry release and so CI can
substitute the exact release tarball.

## Run from a release tarball

First build the repository's WASM artifacts and release tarball as described
in [`docs/wp8-ci-release.md`](../../docs/wp8-ci-release.md). In this directory,
run `npm install`, then `npm install --no-save <absolute-path-to.tgz>`, followed
by `npm run build` or `npm run dev`.

CI copies this directory to a clean temporary location, installs the exact
tarball produced by the release packer, type-checks and bundles it, opens the
production build in Chromium, and verifies four finite port results, 361 field
samples, the rendered plot, and an `application/wasm` response. No file is
resolved from `packages/necpp-wasm/src`.

The app and installed solver are GPL-2.0-or-later. Distributing the built app
conveys the solver and requires GPL compliance, including corresponding source
and notices. See the package README for the full technical notice.
