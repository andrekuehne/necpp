# WP1 native stateful engine

`nec_stateful_model` is the deck-free native solver layer used by the future
C/WASM ABI. It owns a single `nec_context`; callers construct geometry and
register ports programmatically, then explicitly prepare and repeatedly solve
against a retained interaction-matrix factorization.

The public header is [`src/nec_stateful_model.h`](../src/nec_stateful_model.h).
It is part of the installed C++ development surface. The lower-level hooks in
`nec_context` exist only to split preparation from excitation and to preserve
the legacy NEC card API.

## Cache and result ownership

The factorization generation advances only after a successful matrix fill and
factorization. An unchanged `prepare()` is a true no-op, including from the
solved state. Changing frequency, ground, or loads invalidates prepared data;
the next successful preparation advances the generation. A voltage solve
advances only the solve generation.

Each consumer solve replaces the previous native result collection. A raw WP1
far-field calculation retains the current antenna-input result and replaces
only the prior radiation-pattern result. Thus repeated solves and repeated
field grids have bounded native ownership. WP3 will copy the complex field
components into its stable bulk result type; the raw WP1 radiation-pattern
reference is deliberately temporary.

Exact zero-valued voltage sources are preserved by the stateful excitation
hook. This differs intentionally from the legacy `EX` card compatibility path,
which continues replacing a near-zero source voltage with one volt.

## Mutable global-state audit

Most solver state—including geometry, ground, loads, factorized matrices,
sources, currents, and results—is already owned by `nec_context`. The mutable
process-wide electromagnetic permittivity and permeability were the one
model-configurable exception. WP1 now stores those settings on each context and
reactivates them synchronously at every numerical operation boundary. The
interleaved-context test alternates models at different frequencies and proves
that returning to the first context reproduces its current without a refactor.

Some numerical helper functions also contain lazily initialized, read-only
lookup tables. Their values do not vary by model after initialization, but the
native library does not promise concurrent calls on different contexts from
multiple threads. Sequential interleaving is supported. Browser parallelism
must use the separate modular Emscripten instances/workers planned by WP5 and
WP6; each worker/module has its own WASM globals. A future pthread-enabled build
would require a separate thread-safety review before sharing one module across
concurrent solves.

## Verification

The WP1 Catch2 cases live in
[`src/nec_stateful_model_tb.cpp`](../src/nec_stateful_model_tb.cpp). They cover:

- programmatic geometry, ordered ports, prepare, and solve without a deck;
- repeated complex voltage excitations, including an exact zero source;
- deterministic frequency, ground, load, excitation, and far-field generations;
- invalid and duplicate ports with unchanged lifecycle state;
- sequentially interleaved independent contexts;
- 1,000 solves with one factorization and a one-result ownership bound.

The existing deck parser, C API, CLI, native numerical tests, and WASM smoke
path continue to use the legacy `nec_context` card methods.
