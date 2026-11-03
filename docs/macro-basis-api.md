# Macro-basis reduced interaction contract

Status: specified (2026-11-03); not implemented. This document is the normative
public contract for two additions to the stateful model: the reduced interaction
blocks of caller-given macro bases, and the far fields of those macro bases. It
serves reduced-basis method-of-moments models (CBFM, macro basis functions), in
which a caller replaces each element's segment currents by a small set of fixed
current shapes and solves the array in that reduced space. Terms are defined in
[`GLOSSARY.md`](../GLOSSARY.md); the choice of current space is recorded in
[ADR 0001](adr/0001-macro-bases-in-segment-centre-currents.md). Everything in
[`wasm-api.md`](wasm-api.md) and
[`current-quadrature-api.md`](current-quadrature-api.md) is unchanged.

## Scope

necpp provides exact NEC primitives. The caller owns everything that is model
policy:

| necpp | Caller |
|---|---|
| Reduced interaction blocks for given macro bases | Building macro bases (primaries, incident-field pieces, neighbour secondaries, compression) |
| The segment-level interaction of an element (identity basis) | Symmetrizing NEC's point-matched blocks |
| Far fields of given macro bases | Passivity policy, the reduced solve, port quantities |
| Segment geometry (existing `getCurrentDistribution` metadata) | Lattice reuse, by choosing which pairs to request |

Not in this contract: finite ground, geometry completed with a symmetry
descriptor, `createNecArraySolver`, any cached fill between calls, iterative
solvers, and complex macro bases.

## Numerical conventions

All [`wasm-api.md`](wasm-api.md) conventions apply: \(e^{+j\omega t}\), outgoing
\(e^{-jkR}/R\), metres, MHz, peak-amplitude phasors, current positive along the
wire from start to end.

### Elements and segment order

An **element** is an ordered, nonempty list of wire tags. Its segments are
ordered by tag in the given order, then by 1-based segment within the tag; \(S_e\)
is its segment count. Elements in one request must not share a tag. Wires that
belong to no element are allowed; they take no part in the requested blocks.

Every NEC basis function centred on a segment of element \(e\) must have its
support inside \(e\)'s segments (and their images). An element whose wires are
joined to a wire outside it, through a junction, is rejected with
`NecGeometryError`. A wire end on the ground plane with
`groundConnection: "interpolate"` connects to its own image and is allowed.

### Segment-centre currents and the segment-level interaction

A current vector \(I\in\mathbb{C}^{S_e}\) holds the current at each segment's
centre in amperes. NEC's unknowns are NEC basis amplitudes \(\alpha\); on one
element they map to segment-centre currents by a sparse, element-local matrix,
\(I=T_e\,\alpha\) (centre current \(A+C\) of the stored expansion
\(I(s)=A+B\sin ks+C\cos ks\)).

The **segment-level interaction** \(Z_{ij}\in\mathbb{C}^{S_i\times S_j}\), in
ohms, is defined by: \((Z_{ij} I)_m\) is the voltage that must be impressed
across a delta gap at the centre of segment \(m\) of element \(i\) to cancel the
tangential field there radiated by the NEC current on element \(j\) whose
segment-centre currents are \(I\), including the perfect-ground image and, for
\(i=j\), the element's loads. With a port on every segment of every element,
\(Z\) equals the impedance matrix `computeImpedanceMatrix` returns, in the
element and segment order above.

\(Z\) is point-matched: \(Z_{ij}\ne Z_{ji}^{\mathsf T}\) in general (a few per
cent on wire helices). necpp returns it unsymmetrized.

If \(T_e\) is singular or its condition estimate exceeds the implementation
threshold, the request fails with `NecConditioningError` naming the element.

### Macro bases and reduced blocks

A **macro basis** for element \(e\) is a real matrix
\(B_e\in\mathbb{R}^{S_e\times K_e}\), \(K_e\ge1\); each column is one macro basis
function in segment-centre amperes. Columns need not be orthonormal or
independent; necpp does not check them. The **reduced interaction block** of the
ordered pair \((i,j)\) is

\[
  Z^{r}_{ij}=B_i^{\mathsf T} Z_{ij} B_j\in\mathbb{C}^{K_i\times K_j}\ \Omega .
\]

The transpose, not the conjugate transpose, tests the field (Galerkin with real
weights). An **identity basis** \(B_e=I_{S_e}\) returns \(Z_{ij}\) itself.

## TypeScript

```ts
interface MacroBasisElement {
  /** Wire tags in segment order. */
  readonly tags: readonly number[];
}

/** Real basis, one macro basis function per row: K × S, row-major. */
type MacroBasis =
  | { readonly kind: "matrix"; readonly functions: number; readonly values: Float64Array }
  | { readonly kind: "identity" };

interface ReducedInteractionRequest {
  readonly frequencyMHz: number;
  readonly elements: readonly MacroBasisElement[];
  /** One per element, same order. */
  readonly bases: readonly MacroBasis[];
  /** Ordered (row, column) element pairs; defaults to every ordered pair, row-major. */
  readonly pairs?: readonly (readonly [row: number, column: number])[];
}

interface ReducedInteractionBlock {
  readonly row: number;        // element index i
  readonly column: number;     // element index j
  readonly block: ComplexMatrix; // K_i × K_j, row-major, ohms
}

interface ReducedInteractionResult {
  readonly frequencyMHz: number;
  /** In request order. */
  readonly blocks: readonly ReducedInteractionBlock[];
}

interface MacroBasisFarFieldRequest {
  readonly frequencyMHz: number;
  readonly element: MacroBasisElement;
  readonly basis: MacroBasis;
  /** Phase reference point, metres. */
  readonly referenceM: CartesianPointM;
  readonly radiusM?: number; // default 1
  readonly theta: AngleSweep;
  readonly phi: AngleSweep;
}

interface MacroBasisFarFieldResult extends FarFieldResult {
  readonly functions: number;
  readonly samplesPerFunction: number;
  /** Function-major: functionIndex * samplesPerFunction + sampleIndex. */
}

interface NecModel {
  computeReducedInteraction(request: ReducedInteractionRequest): ReducedInteractionResult;
  computeMacroBasisFarFields(request: MacroBasisFarFieldRequest): MacroBasisFarFieldResult;
}
// NecWorkerModel: the same two methods returning promises.
```

A macro basis is given **K × S with one function per row** (the transpose of
\(B_e\)) so each function is contiguous. `values.length` must equal
`functions * S_e`.

### Far field of a macro basis

For each macro basis function \(b\) of the element, the result holds the far
field of the NEC current on that element alone whose segment-centre currents
are \(b\), with \(\alpha=T_e^{-1}b\) expanded into the stored A/B/C coefficients
and evaluated by the exact wire field kernel. Other wires are absent: this is
the field of the given current, not an embedded pattern. Over perfect ground the
image is included. The phase is referenced to `referenceM`:

\[
  E_k(\hat r)=\frac{e^{-jkr}}{r}\,F_k(\hat r),\qquad
  F_k \text{ with } e^{+jk\,\hat r\cdot(\mathbf r'-\mathbf r_{\text{ref}})} \text{ in the source integral,}
\]

so that an array field is \(\sum_e\sum_k c_{e,k}F_{e,k}(\hat r)\) with each
element's own reference point. The grid, sample order and the meaning of
`radiusM` follow `computeFarField`; arrays are function-major as the
basis-major arrays of `computeEmbeddedFarFields`.

## Lifecycle

| Operation | empty | geometry-building | geometry-complete | prepared | solved | disposed |
|---|---|---|---|---|---|---|
| `computeReducedInteraction` | — | — | same | same | same | — |
| `computeMacroBasisFarFields` | — | — | same | same | same | — |

- Ports are not required. The frequency is the request's, independent of any
  `prepare` frequency.
- Both calls fill only what they need: the requested blocks, or the element's
  T. They do not form or factor the full interaction matrix and keep nothing
  between calls.
- Both leave the model as it was: state, prepared factorization, latest
  solution, `factorizationGeneration`, `solveGeneration` and every retained
  result are unchanged.
- In-progress native work is not interruptible; `terminate` on a worker model
  rejects it as for other methods.

## Errors

The existing taxonomy; no new error class.

| Condition | Error |
|---|---|
| Nonpositive or nonfinite frequency; empty element; unknown tag; tag in two elements; `bases.length ≠ elements.length`; basis shape mismatch; `functions < 1`; nonfinite basis value; pair index out of range; empty `pairs`; grid errors as `computeFarField`; size overflow | `NecInputError` |
| Finite ground; geometry completed with a symmetry descriptor | `NecInputError` with `details.reason` `"finite-ground"` or `"symmetric-geometry"` |
| Element joined to a wire outside it | `NecGeometryError` |
| \(T_e\) singular or ill-conditioned | `NecConditioningError` |
| Fill failure | `NecSolverError` |

## C ABI (`abiVersion` stays 1)

Additive in [`src/necpp_wasm_v1.h`](../src/necpp_wasm_v1.h) and
`EXPORTED_FUNCTIONS` in `src/CMakeLists.txt`. Elements are passed flat:
`element_tag_counts[e]` tags per element, concatenated in `tags`. Bases are
concatenated row-major in `basis_values`; `basis_function_counts[e]` is
\(K_e\), or `-1` for an identity basis (no values).

```c
int32_t necpp_wasm_v1_compute_reduced_interaction(
  model, double frequency_mhz,
  const int32_t* element_tag_counts, size_t element_count,
  const int32_t* tags, size_t tag_count,
  const int32_t* basis_function_counts,            /* element_count entries */
  const double* basis_values, size_t basis_value_count,
  const int32_t* pairs, size_t pair_count);        /* 2 * pair_count; null/0 = all */

int32_t necpp_wasm_v1_compute_macro_basis_far_fields(
  model, double frequency_mhz,
  const int32_t* tags, size_t tag_count,
  int32_t basis_function_count,                    /* -1 = identity */
  const double* basis_values, size_t basis_value_count,
  double reference_x_m, double reference_y_m, double reference_z_m,
  double radius_m,
  double theta_start_deg, int32_t theta_count, double theta_step_deg,
  double phi_start_deg, int32_t phi_count, double phi_step_deg);
```

Results are borrowed, copy-immediately buffers, valid until the next call of
the same function:

| Buffer | Kind | Content |
|---|---|---|
| f64 | 50, 51 | `REDUCED_BLOCKS_REAL/IMAG`: blocks in request order, each row-major |
| i32 | 11 | `REDUCED_BLOCK_LAYOUT`: per block `row, column, rows, columns, offset` |
| f64 | 52–55 | `MACRO_BASIS_FIELD_E_THETA_REAL/IMAG`, `E_PHI_REAL/IMAG`, function-major |

Scalars: `reduced_frequency_mhz`, `reduced_block_count`,
`macro_basis_field_function_count`, `macro_basis_field_theta_count`,
`macro_basis_field_phi_count`, `macro_basis_field_radius_m`. The worker protocol
transfers the copied arrays.

## Oracles

Tests assert properties against references; timings are measurements in
`bench/`, not gates. Fixtures: the canonical dipole, the default balanced helix
of the visualizer (51 segments), each in free space and over perfect ground,
2×2 arrays at 0.5 λ, and a loaded element.

1. **Segment-level interaction.** Identity bases on every element reproduce the
   impedance matrix of the same model with a port on every segment, in element
   and segment order, over all ordered pairs. Relative-L2 `1e-7`; the two paths
   differ by an inversion, so a fixture may document a looser bound from its
   condition estimate.
2. **Exact isolated element.** For one element with its isolated unit-current
   port current \(J\), the basis \([\operatorname{Re}J,\operatorname{Im}J]\)
   gives \(1/(p^{\mathsf T}(Z^{r}_{ee})^{-1}p)\), \(p=B_e^{\mathsf T}e_{\text{feed}}\),
   equal to the element's isolated port impedance. Relative `1e-7`.
3. **Macro-basis far field.** For the same \(J\), \(F_{\operatorname{Re}J}+
   jF_{\operatorname{Im}J}\) equals the unit-current `computeEmbeddedFarFields`
   of the element alone, after the phase factor of `referenceM`; checked with
   the element at the origin and offset. Relative-L2 `1e-7`.
4. **Current map.** \(T_e\) is invertible and \(T_e^{-1}\) reproduces NEC's own
   amplitudes from a solved current on: free wire ends, both ground connection
   modes, and an element with an internal multi-wire junction.
5. **Element validation.** A junction between two elements, a shared tag and an
   unknown tag are rejected with the errors above.
6. **Reduction identity.** For random real bases, each block equals
   \(B_i^{\mathsf T}Z_{ij}B_j\) formed from the identity-basis blocks.
   Relative-L2 `1e-12`.
7. **No side effects.** After `prepare` and a solve, either call leaves the
   generations, the latest solution and its far field bit-identical.
8. **Direct and worker agree** bit-identically.

## Implementation notes (non-normative)

- `structure_segment_loading` fills and then factors in one step, and the LU
  is in place. The reduced call needs a fill-only entry that loops the source
  segments of element \(j\) through `cmww` with observation rows restricted to
  element \(i\), keeps only the columns of NEC basis functions in \(j\), and
  contracts with \(B_i^{\mathsf T}\) and \(T_j^{-1}B_j\) without storing more
  than one element pair's block.
- `frequency_scale` rewrites the geometry in place; the call must restore the
  prepared frequency's geometry or work on a copy.
- The far field reuses the stateless wire field kernel behind
  `necpp_field_evaluator_v1_evaluate`, which takes arbitrary A/B/C.
