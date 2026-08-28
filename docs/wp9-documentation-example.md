# WP9 documentation and example application

WP9 completes the public onboarding surface for `@necpp-engine/wasm` and makes
that surface executable in the release pipeline.

## Documentation coverage

The npm README is the primary consumer guide because it travels in the
tarball. It covers:

- a complete five-minute centre-fed dipole;
- metres/MHz units, geometry tags, one-based port segments, and stable port
  ordering;
- row-major Z/Y indexing and the physical meaning of matrix entries;
- simultaneous voltage and current drives, achieved quantities, powers, and
  active versus matrix impedance;
- the `e^(+j omega t)` phasor, `e^(-jkR)/R` propagation, V/m units, 1 m
  default radius, theta/phi axes, and theta-fast sample ordering;
- unit-current embedded-pattern superposition for JavaScript-side
  beamforming;
- direct and worker entry points, cancellation, lifecycle, reuse, and
  deterministic disposal;
- default adjacent-WASM loading plus Node, browser, Vite, CDN/CORS, and
  caller-supplied-byte paths;
- typed error handling, performance, result ownership, browser memory sizing,
  and GPL-2.0-or-later distribution implications.

The normative detail remains in [`wasm-api.md`](wasm-api.md). The README links
to that document on the `main` branch so the link also works from npm, where
repository-relative paths are unavailable.

## Four-element Vite application

[`examples/wasm-array-vite`](../examples/wasm-array-vite/README.md) is a
standalone downstream application. It has no relative import into the
monorepo. Its package manifest contains only pinned TypeScript and Vite
development tools; the solver is installed separately from either the public
registry or an exact `.tgz`.

The application:

1. creates four parallel, centre-fed half-wave dipoles in a package-managed
   Web Worker;
2. prepares the model at 300 MHz and computes the full complex 4 x 4 Z/Y
   result;
3. requests unit-amplitude currents with a -60 degree progressive phase;
4. displays requested and achieved current, required voltage, active
   impedance, and time-average power for every port;
5. displays the row-major impedance matrix and condition estimate; and
6. computes and plots the combined complex-field magnitude for a 361-point
   azimuth cut at theta = 90 degrees and radius = 1 m.

No plotting dependency is needed: the example generates a compact accessible
SVG. It exposes a test-only result summary on `window` after the UI has been
rendered.

## Executable documentation gates

The exact release tarball is built once by WP8. The clean-consumer job installs
that tarball, extracts every `ts` fence from the npm README, compiles every
snippet with strict TypeScript 5.8.3, and executes the first dipole example in
Node. Vite is present in the fixture so the documented worker configuration is
also type-checked.

The browser-worker job additionally copies the checked-in example to a clean
temporary directory, injects only the exact tarball as its solver dependency,
runs its strict type-check plus Vite production build, and opens it in
Chromium. Acceptance requires:

- package version `0.1.0` from the installed package;
- four rendered port rows and a 4 x 4 matrix;
- 361 finite complex-field samples and a rendered plot;
- at least one `.wasm` request, all served as `application/wasm`; and
- no browser console or page errors.

This is the intended downstream integration path, not a special monorepo test
entry point.

## Release state

The initial npm version is `0.1.0`; the internal engine remains `2.3.4` and
the stable C ABI remains v1. Package, engine, and ABI versions are exposed
separately because they follow different compatibility lines.

The public registry returned 404 for `@necpp-engine/wasm` during the WP9
preflight on 2026-08-28. Publication still requires control of the
`necpp-engine` scope and the protected release environment described in
[`wp8-ci-release.md`](wp8-ci-release.md). The release workflow—not a local
command—must publish the tested tarball after the branch is merged to `main`.
