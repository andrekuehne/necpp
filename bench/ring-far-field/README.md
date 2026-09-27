# Ring far-field bench

See [the report](../../docs/ring-far-field-evaluation.md) for the derivation,
measured results, limitations, and exact build/test/run commands.

The harness is outside the production package; it now exercises the shared
production kernel. The original prototype and its measurements are preserved in
commit `970d1ed` and the original `evidence/` files.

- `ring.hpp`: thin adapter to the shared production C++ kernel.
- `bench.cpp`: full NEC solves, phase timings, direct/ring comparisons and gates.
- `test.cpp`: deterministic interpolation and fallback tests, native and WASM.
- `build.py`: separate binaries with phase probes in a temporary source copy.
- `run.py`: serial native/WASM measurements and environment metadata.
- `summarize.py`: report tables from raw observations.
- `profile-package.mjs`: initial public-package relevance probe.
- `package-production.mjs`: packaged worker timings and embedded/packed verification.
- `evidence/`: original observations; `evidence/production/` records integration measurements.

The production comparison requires Emscripten **4.0.7**, matching the package
build. Run timing commands sequentially on an otherwise idle machine. The
embedded package benchmark uses the same seven geometries on a compact
3 × 181 grid to keep the 256-port basis arrays practical; ordinary fields and
worker timings use each geometry's full visualizer grid.

Standalone tests now link the unchanged direct kernel explicitly:

```sh
g++ -std=c++17 -O3 -Isrc -Isrc/eigen -I/tmp/ring-production-native \
  bench/ring-far-field/test.cpp src/nec_field_evaluator_wasm.cpp \
  -o /tmp/ring-test
/tmp/ring-test
```
