# WP4 stable C/WASM ABI

WP4 exposes the deck-free engine through
[`necpp_wasm_v1.h`](../src/necpp_wasm_v1.h). The header is valid C and is also
the complete contract exported by the Emscripten build. C++ classes, standard
library objects, exceptions, raw `std::complex` storage, and solver internals
do not cross this boundary.

## Versioning and errors

Every symbol starts with `necpp_wasm_v1_`. `necpp_wasm_v1_abi_version()`
returns `1`; later incompatible ABIs must use a new symbol prefix rather than
change an existing signature. `necpp_wasm_v1_engine_version()` returns the
configured NEC2++ release version.

Stateful calculations return one of the stable status values:

- `OK`;
- `STATE_ERROR`;
- `INPUT_ERROR`;
- `GEOMETRY_ERROR`;
- `PORT_ERROR`;
- `CONDITIONING_ERROR`;
- `SOLVER_ERROR`;
- `RUNTIME_ERROR`.

No exception is allowed to cross an ABI function. Each model retains its own
last status and diagnostic string. A successful status-returning operation
clears the previous diagnostic. Creation reports allocation failure with a
null handle; deletion accepts a null handle, which makes cleanup safe after
partial initialization.

## Inputs and results

Ports use parallel `int32_t` tag and segment arrays. Complex drives use
parallel binary64 real and imaginary arrays. All arrays are pointer plus
length; null pointers, wrong lengths, nonfinite values, and illegal lifecycle
calls return controlled statuses without trapping the WASM runtime.

Calculations copy native complex results into model-owned split binary64
buffers. `necpp_wasm_v1_result_buffer()` selects a documented buffer kind and
`necpp_wasm_v1_result_buffer_length()` gives its element count. Matrix values
remain row-major, far-field samples remain theta-fast, and embedded fields
remain port-major. Scalar accessors provide matrix order, grid dimensions,
frequency, normalization, condition estimate, and generations.

Returned pointers are borrowed. A successful operation replacing the same
result category, configuration invalidation, or model deletion can invalidate
them. A JavaScript wrapper must copy them immediately from `HEAPF64`; it must
not retain a WASM heap view across a call or memory growth.

The model handle separately retains:

- ordered port tag and segment arrays;
- impedance and admittance buffers;
- the latest consumer port solution;
- the latest combined far field;
- the latest embedded far-field basis.

Unrelated result categories do not alias one another. Environment changes
clear every calculated ABI result. A same-frequency no-op `prepare` preserves
the native and ABI caches.

## Complete-deck compatibility

The independent `necpp_wasm_v1_deck_*` handle accepts a UTF-8 pointer and
explicit byte length and returns the formatted report through a borrowed
string buffer. It exists for the future `runDeck()` facade and does not share
state with a deck-free model. Empty input and embedded NUL bytes are input
errors. Text, geometry, and non-executing card validation failures are input
errors; failures while an execution or field card is running are solver errors.

## Emscripten surface

The generated module exports only:

- the documented `necpp_wasm_v1_*` functions;
- `_malloc` and `_free`;
- `HEAPU8`, `HEAP32`, and `HEAPF64`.

The old unversioned deck functions and convenience runtime methods such as
`ccall` and `cwrap` are not exported. The build remains modular ES6 with
memory growth enabled.

## Verification

The C contract test is compiled as C, linked to the C++ engine, and invoked by
the `[wp4]` Catch2 partition. It covers every operation family, null and
dimension failures, invalid geometry and port addressing, status/message
retention, matrix and field metadata, both drive types, both embedded
normalizations, configuration invalidation, deck compatibility, and repeated
create/delete cleanup. A separate comparison checks split ABI matrix, current,
and complex far-field buffers against direct native results at `1e-12`.

The Docker WASM smoke test performs a real one-port matrix extraction, voltage
solve, combined field, embedded field, controlled invalid calls, and deck
solve through direct versioned exports. It copies a field result, forces WASM
memory growth, and verifies that the JavaScript-owned copy remains valid.
