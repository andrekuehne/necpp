/**
 * Public version identifiers for the packed package.
 *
 * `packageVersion` must match `package.json`. `engineVersion` must match the
 * CMake `project(necpp VERSION ...)` value compiled into the shipped WASM.
 * `abiVersion` is the stable C ABI prefix `necpp_wasm_v1`.
 */
export const packageVersion = "0.5.1";
export const abiVersion = 1;
export const engineVersion = "2.5.0";
