# Ring far-field bench

See [the report](../../docs/ring-far-field-evaluation.md) for the derivation,
measured results, limitations, and exact build/test/run commands.

This directory is deliberately outside the production build and package:

- `ring.hpp`: C++ ring prototype; includes the existing tile kernel unchanged.
- `bench.cpp`: full NEC solves, phase timings, direct/ring comparisons and gates.
- `test.cpp`: deterministic interpolation and fallback tests, native and WASM.
- `build.py`: separate binaries with phase probes in a temporary source copy.
- `run.py`: serial native/WASM measurements and environment metadata.
- `summarize.py`: report tables from raw observations.
- `profile-package.mjs`: initial public-package relevance probe.
- `evidence/`: raw observations, not replacement goldens.

`ring.hpp` is a research implementation for trusted solved snapshots and
complete hemisphere/sphere grids. It is not a validated public interface.
