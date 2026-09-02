# NECQ / NECF Rust binder sketch

This is a compilable sketch, not a published crate. Source lives in
[`packages/necpp-wasm/rust/`](../packages/necpp-wasm/rust/) so a visualizer
compute worker can bind packed transfer envelopes without copying them on
every steer. WP5 binds published `current-quadrature-v1` fixtures and typed
little-endian planes. WP6 records bind-once/steer timing. Visualizer
production ingestion stays in the visualizer; pin
`@necpp-engine/wasm@0.5.0` and
`@necpp-engine/wasm/fixtures/current-quadrature-v1/*`. This crate stays
`publish = false`.

## Envelopes

| Magic | Contents | TypeScript handle |
|---|---|---|
| ASCII `NECQ` | Prepared quadrature (WP2 layout) | `PreparedTransferHandle` |
| ASCII `NECF` | Embedded far-field planes (WP4 envelope of existing `computeEmbeddedFarFields` layout) | `PreparedTransferHandle` |

Both are little-endian schema 1. Do not interpret the first four bytes as a
host-endian `u32`. `abiVersion` stays 1; these envelopes are additive.

## Endianness and alignment

- All multi-byte integers and IEEE-754 `f64` values are little-endian.
- NECQ identity is `i32` SoA (`tag`, `segment`, `nativeIndex`), then 0–4 pad
  bytes so geometry starts on an 8-byte boundary:
  `pad = (8 - ((64 + 12 * nSeg) % 8)) % 8`.
- NECF has no identity block; `f64` planes start at byte 64.

## NECQ index formulas

Geometry (per sample, including an optional PEC image plane):

```text
N = nSeg * nNodes * nImagePlanes
geometry_index = (plane * nSeg + segment) * nNodes + node
plane 0 = physical, plane 1 = PEC image
```

Currents (mode-major):

```text
current_index = ((mode * nImagePlanes + plane) * nSeg + segment) * nNodes + node
I = iReal[current_index] + j iImag[current_index]
```

`dsWeight` is always present. Omitted caller weights store `w_i = 1`, so
`dsWeight = L/2`.

## NECF plane formulas

After the 64-byte header:

```text
thetaDeg[nTheta]
phiDeg[nPhi]
eThetaReal, eThetaImag, ePhiReal, ePhiImag
  each length nPorts * samplesPerPort, port-major
sampleIndex = phiIndex * nTheta + thetaIndex
embeddedIndex = portIndex * samplesPerPort + sampleIndex
```

This is a transfer envelope of `EmbeddedFarFieldResult`, not a new field
kernel. The sample index matches [`wasm-api.md`](wasm-api.md).

## Bind once

1. Receive the handoff message (`kind: "isolated-element-characterization"`)
   with the two `ArrayBuffer`s transferred, not cloned, **or** load the
   published `current-quadrature-v1` binaries from
   `@necpp-engine/wasm/fixtures/current-quadrature-v1/*`.
2. Decode headers, retain the buffers (or `wasm-bindgen` memory views) for the
   life of the element. Typed `f64` loads alias those bytes.
3. A follow-up “steer” message must not re-transfer or recopy NECQ/NECF.
   Repeat `characterizeIsolatedElement` with a new destination is a new bind.

Z/Y stay small `ComplexMatrix` values on the client even in handoff mode.

Do not reconstruct or replace NEC embedded patterns. Array mutual-impedance
integration stays in the visualizer.

## Fixtures

Checked-in goldens:

[`packages/necpp-wasm/fixtures/current-quadrature-v1/`](../packages/necpp-wasm/fixtures/current-quadrature-v1/)

`cargo test` loads `dipole.necq` / `dipole.necf` and
`rooted-monopole-images.necq`. An optional sibling
`PhasedArrayVisualizer-NG` checkout, or `NECPP_VISUALIZER_ROOT`, is recorded
and must not fail CI when absent.

## Build

```text
cargo test --manifest-path packages/necpp-wasm/rust/Cargo.toml
```
