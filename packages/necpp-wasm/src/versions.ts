/**
 * Public version identifiers for the packed package.
 *
 * `packageVersion` must match `package.json`. `engineVersion` must match the
 * CMake `project(necpp VERSION ...)` value compiled into the shipped WASM.
 * `abiVersion` is the stable C ABI prefix `necpp_wasm_v1`.
 *
 * `necqSchemaVersion`, `necfSchemaVersion`, and `necqFlags` describe the packed
 * `NECQ` and `NECF` buffers this package writes. They must match
 * `src/nec_prepared_current_quadrature.h` and `src/necpp_wasm_v1.cpp`.
 */
export const packageVersion = "0.10.1";
export const abiVersion = 1;
export const engineVersion = "2.5.0";

/** Schema version at byte offset 4 of every `NECQ` buffer. */
export const necqSchemaVersion = 1;
/** Schema version at byte offset 4 of every `NECF` envelope. */
export const necfSchemaVersion = 1;
/** Defined bits of the `NECQ` flags word at byte offset 8. */
export const necqFlags: Readonly<{ readonly images: 1; readonly weights: 2 }> =
  Object.freeze({ images: 1, weights: 2 } as const);
