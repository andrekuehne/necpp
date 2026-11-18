# Infinite-array periodic boundary and Floquet port: evaluation

## Status

**Evaluation only, 2026-11-18.** Nothing described here is implemented or
prototyped. The findings come from reading the engine and the WASM layer.
Formulas are written from the standard literature and have not been checked
numerically against this code base; items that need verification before
implementation are marked **[verify]**. Cost figures are estimates.

## Goal

1. Define an antenna configuration (the unit cell) and a 2D lattice, and get
   back the periodic (active / scan) Z and Y of the unit-cell ports for given
   scan directions.
2. As an additional feature, a Floquet port at a defined height above the
   cell: Floquet-mode amplitudes radiated by the cell, and eventually a
   generalized scattering matrix between circuit ports and Floquet modes.

Both must be usable from the WASM package (`packages/necpp-wasm`) that the
visualizer consumes.

## Verdict

Feasible. The periodic Z/Y is a contained change in the C++ matrix fill plus
additive ABI and TypeScript surface. The Floquet port is mostly
post-processing on current data the package already exports, plus one new
excitation type for the receive direction.

The main reason it fits well: the periodic Green's function can be split into
the free-space term that NEC already handles (including all the singular
self-term machinery) and a smooth remainder that only needs low-order
quadrature. No existing kernel code has to be rewritten.

## Relevant existing code

| Area | Location | Relevance |
|---|---|---|
| Matrix assembly | `nec_context::cmset`, `src/nec_context.cpp:2214` | Outer source-segment loop, loading terms, symmetry-mode combination |
| Wire-wire fill | `nec_context::cmww`, `src/nec_context.cpp:2651` | Observation loop; projects the field on the observation segment and scatters into the matrix through the basis coefficients `ax/bx/cx` |
| Segment field | `nec_context::efld`, `src/nec_context.cpp:2982` | Direct field plus ground image; the image is a second `efld_compute` call with a displaced source |
| Field of one source | `nec_context::efld_compute`, `src/nec_context.cpp:2914` | Field of constant / sin / cos current on one segment at a relative offset |
| Thin-wire kernel | `eksc`, `ekscx`, `gx`, `gf`, `intx`, `src/nec_context.cpp:3188` onwards | Closed-form end terms plus numeric integral of exp(-jkR)/R |
| Plane-wave excitation | `etmns_linear_wave`, `src/nec_context.cpp:3350` | Model for a Floquet-mode right-hand side |
| Stateful prepare / solve | `stateful_prepare_frequency`, `stateful_solve_voltage_sources`, `src/nec_context.cpp:311`, `:341` | Entry points the WASM model uses |
| Stateful model | `src/nec_stateful_model.h`, `.cpp` | Ports, loads, ground, Y/Z extraction, retained factorization |
| C ABI | `src/necpp_wasm_v1.h`, `.cpp` | Stable, additive-only ABI; exported-function list in `src/CMakeLists.txt:192` |
| TS model | `packages/necpp-wasm/src/types.ts` (`NecModel`), `model.ts`, worker files | Public API to extend |
| Finite array solver | `packages/necpp-wasm/src/array-solver.ts`, `array-symmetry.ts` | Validation reference (large finite array) |
| Current export | `necpp_wasm_v1_get_current_distribution`, buffers `CURRENT_A/B/C_*` | Input for Floquet-mode amplitudes |

Observations that matter for the design:

- Inside the matrix fill, lengths are normalized to the wavelength (the
  kernel is called with `xk = 2*pi`). The time convention is exp(+jwt), the
  kernel is exp(-jkR)/R.
- NEC uses point matching at segment centres, so there is no testing
  integral; each matrix entry is a field evaluation.
- Each segment carries three current terms (constant, sin ks, cos ks). The
  field of each is returned separately (`exk/eyk/ezk`, `exs/..`, `exc/..`) and
  combined through `ax/bx/cx`.
- The stateful model and the WASM ABI expose voltage and current drives only.
  Plane-wave excitation exists in the legacy card path but is not reachable
  from the stateful model.
- The repository has no complex error function (`erfc` of complex argument).
- The LU solver is general (not symmetric-only), so a non-symmetric
  interaction matrix is acceptable to the solver itself.

## Formulation

### Lattice and scan

Lattice vectors `a1`, `a2` in the xy-plane, cell area `A = |a1 x a2|`,
reciprocal vectors `b1`, `b2` with `a_i . b_j = 2*pi*delta_ij`. The current in
cell (m, n) equals the unit-cell current times `exp(-j k_t0 . rho_mn)` with
`rho_mn = m a1 + n a2`.

The scan state is the transverse wavevector `k_t0`. Two equivalent inputs:

- scan direction: `k_t0 = k sin(theta) (cos(phi), sin(phi))`;
- inter-element phases: `psi_i = -k_t0 . a_i`.

Phases are the better primary input: they also cover invisible space
(`|k_t0| > k`), which is needed if the active Y is later integrated over the
Brillouin zone. (theta, phi) is a convenience on top.

### Periodic Green's function

Spatial form (conditionally convergent, not usable directly):

    G_p(r, r') = sum_mn exp(-j k_t0 . rho_mn) exp(-j k R_mn) / (4 pi R_mn)
    R_mn = | r - r' - rho_mn |

Spectral (Floquet) form, with `k_tpq = k_t0 + p b1 + q b2` and
`kz_pq = sqrt(k^2 - |k_tpq|^2)` on the branch with `Im(kz) <= 0`:

    G_p = 1/(2 j A) * sum_pq exp(-j k_tpq . (rho - rho')) exp(-j kz_pq |z - z'|) / kz_pq

The spectral form converges exponentially only when `|z - z'| > 0`, so it is
useless for a planar or thin cell but is exactly what the Floquet port needs.

Ewald form, usable everywhere, with splitting parameter `E` **[verify signs
and prefactors against the references before coding]**:

    G_p = G_spat + G_spec

    G_spat = 1/(8 pi) * sum_mn exp(-j k_t0 . rho_mn) / R_mn *
             [ exp(-j k R_mn) erfc(R_mn E - j k/(2E))
             + exp(+j k R_mn) erfc(R_mn E + j k/(2E)) ]

    G_spec = 1/(4 j A) * sum_pq exp(-j k_tpq . (rho - rho')) / kz_pq *
             [ exp(-j kz_pq dz) erfc(j kz_pq/(2E) - dz E)
             + exp(+j kz_pq dz) erfc(j kz_pq/(2E) + dz E) ],   dz = z - z'

Both sums converge like a Gaussian; with `E = sqrt(pi / A)` roughly 9 to 25
terms each are enough. For cells larger than about one wavelength the optimal
`E` causes loss of significance (large terms cancelling); `E` must then be
raised so that `k/(2E)` stays bounded (around 3), at the cost of more spectral
terms.

### Splitting off what NEC already does

Write

    G_p = G_free(0,0) + G_smooth
    G_smooth = G_spec + G_spat(without its (0,0) term) + [ G_spat(0,0) - G_free ]

The bracket is finite at `R -> 0` (the 1/R singularities cancel; the limit
has a closed form involving `erfc` and its derivative), so `G_smooth` is
smooth everywhere inside the cell.

- `G_free(0,0)` is the existing NEC interaction, unchanged, including the
  self term, the extended thin-wire kernel and the far-segment lumped
  approximation.
- `G_smooth` is the only new physics. Because it is smooth, the field it
  produces can be computed with a 2 or 3 point Gauss rule per source segment.

If conductors come close to a cell wall, the nearest images make `G_smooth`
nearly singular. The remedy is to move the nearest ring (3x3 minus centre)
out of `G_smooth` and evaluate those eight images through the existing
`efld_compute` with a displaced source and a phase factor, the same way the
ground image is handled today. Those image fields are scan-independent apart
from the phase factor.

### Field of a segment under the smooth kernel

For a current `I(s')` along unit vector `s'` on one segment, with `G`
including the `1/(4 pi)`:

    E(r) = (-j eta / k) * [ k^2 s' * int I G ds'
                           + int (dI/ds') grad G ds'
                           - ( I grad G ) evaluated between the segment ends ]

`grad` is with respect to the observation point. Only `G_smooth` and its
gradient are needed, never second derivatives. The end terms do not cancel
per segment (NEC's basis has non-zero current at segment ends), so they must
be kept; they cancel only in the sum over connected segments.

This is evaluated three times per source segment, for `I = 1`, `sin(k s')`,
`cos(k s')`, and added to `exk..ezc` before `cmww` projects on the observation
segment. Unlike the free-space term, the result is a full 3-vector; the local
(rho, z) decomposition used in `efld_compute` does not apply because the
lattice sum is not axially symmetric about the source segment.

**[verify]** The normalization and sign must match `efld_compute`. A direct
test: feed the new routine with the plain free-space kernel for a source
displaced by several segment lengths and compare with `efld_compute` output.

### Ground

- **Perfect ground:** the image source gets the same treatment as the direct
  source (free-space image term from existing code, plus a smooth correction
  for the image lattice).
- **Finite ground:** out of scope initially. It is attractive later because in
  the spectral domain each Floquet mode sees an exact Fresnel coefficient, so
  no Sommerfeld integrals are needed.

## Engine changes for periodic Z/Y

1. **Periodic kernel unit** (new file, e.g. `nec_periodic_green.{h,cpp}`):
   lattice setup, Ewald evaluation of `G_smooth` and its gradient, complex
   `erfc` (Faddeeva function; needs a small self-contained implementation
   with a compatible licence), Wood-anomaly detection.
2. **Context state:** lattice vectors, scan phases, a periodic-mode flag on
   `nec_context`. In periodic mode force `nop = 1` (no symmetry reduction).
3. **Matrix fill:** in `cmww` (or a sibling called from `cmset`), add the
   smooth-kernel field to the nine field components before projection.
4. **Caching:** the free-space matrix depends on frequency only. Keep a copy
   so that a scan change needs only the correction fill and a new LU. Memory
   is one extra N x N complex matrix.
5. **Stateful model:** `set_lattice`, `set_scan`; invalidate the factorization
   on scan change; reject unsupported configurations (below).
6. **C ABI (additive):** e.g. `necpp_wasm_v1_set_lattice`,
   `necpp_wasm_v1_set_scan_phases`, `necpp_wasm_v1_clear_lattice`; add to the
   exported-function list in `src/CMakeLists.txt`.
7. **TypeScript:** a periodic variant of `NecModel` (or options on it), worker
   protocol entries, and a sweep helper that loops scan points.

Everything downstream of the matrix (loads, port definition, Y by unit-voltage
solves, Z by inversion, power budget) works unchanged. The result at each scan
point is the P x P active admittance of the P unit-cell ports.

### Restrictions for a first version

- 2D lattice in the xy-plane only. A 1D (linear) periodic array needs a
  different Green's function.
- Wires only; no surface patches.
- No conductor may touch or cross the cell boundary (see connected arrays).
- Free space or perfect ground only.
- Geometry symmetry reduction disabled.
- Networks and transmission lines: untested in this mode; exclude until
  checked.

### Things that change meaning in periodic mode

- **Reciprocity:** `Z(psi)` is not symmetric. The relation is
  `Z(psi) = Z(-psi)^T`. Any code that assumes or enforces `Z = Z^T` must be
  reviewed, in the engine and in the TS layer.
- **Far field:** radiation patterns of a single cell are meaningless. They are
  replaced by Floquet-mode amplitudes. The existing far-field, embedded-field
  and ring-field calls should be rejected in periodic mode.
- **Power:** the budget is per unit cell.

### Cost estimate

Per scan point, for N segments and Q quadrature points: `N^2 (Q + 2)` kernel
evaluations, each roughly 20 to 50 terms with one or two complex `erfc`.
For N = 100 that is a few million `erfc` calls, which I would expect to land
around 0.1 s in WASM, plus one LU of an N x N matrix. A dense 2D scan sweep
(thousands of points) is therefore tens of seconds to minutes on one worker
and would benefit from the existing worker pool or from interpolating
`G_smooth` on a difference grid. None of this has been measured.

## Floquet port

### Transmit: circuit port to Floquet modes

Above all conductors, the field of the periodic current is a sum of Floquet
modes `E_pq exp(-j k_pq . r)` with `k_pq = (k_tpq, kz_pq)`:

    N(k) = integral over the unit-cell current of J(r') exp(+j k . r')
    E_pq = -( eta / (2 A k kz_pq) ) * [ k^2 N(k_pq) - k_pq ( k_pq . N(k_pq) ) ]

and the amplitude at the port plane `z = h` carries the extra factor
`exp(-j kz_pq h)`. Below the cell the same holds with `-kz_pq`. With a perfect
ground, add the image current to `N`.

- For a propagating mode, `N(k_pq)` is the same segment integral the far-field
  code evaluates at the direction of `k_pq`. So the amplitude is the existing
  far-field quantity scaled by `1 / (A cos(theta_pq))`.
- For an evanescent mode, `kz_pq` is imaginary. The closed-form segment
  integral of `(A + B sin ks + C cos ks) exp(j k . r')` is the same expression
  with a complex direction cosine; this needs a small generalization.
- The inputs (segment centres, tangents, lengths, A/B/C coefficients) are
  already exported by `getCurrentDistribution`, so this stage can be done in
  TypeScript first and moved into C++ only if performance requires.

Modes are split into TE and TM with respect to z and power-normalized. The
power carried per cell by a propagating mode is
`P_pq = A |E_pq|^2 kz_pq / (2 eta k)` (peak phasors).

By-products:

- **Scan element pattern:** the (0,0) amplitude as a function of scan is the
  element pattern in the infinite array.
- **Power check:** port input power equals the sum of propagating Floquet
  power (above and below) plus ohmic loss. This is a strong built-in test.

### Receive and Floquet-to-Floquet

This needs an incident Floquet mode as excitation: a plane wave whose
transverse wavevector matches the scan state, so the Bloch condition is met
automatically. The right-hand side is the negative tangential incident field
at each match point (plus the ground reflection when a ground is present),
modelled on `etmns_linear_wave`. It must be added to the stateful model and
the ABI as a new drive type.

With that:

- port currents under termination give the Floquet-to-port entries (these can
  be cross-checked against the transmit entries at the reversed scan through
  reciprocity);
- scattered Floquet amplitudes, plus the direct term of the incident wave,
  give the Floquet-to-Floquet block. This also makes the engine usable for
  frequency-selective-surface style problems.

Without a ground plane a second port below the cell is required for the
transmitted wave. Only propagating modes need to be supported as incident
modes; evanescent modes are useful as outputs when `h` is small.

### Mutual coupling from the periodic result

The coupling between the reference element and element (m, n) in the infinite
array is the Fourier coefficient of the active admittance over the Brillouin
zone:

    Y_mn = 1/(4 pi^2) * double integral over psi1, psi2 of
           Y(psi1, psi2) exp(-j (m psi1 + n psi2))      [verify sign convention]

The integrand is singular on the Wood-anomaly curves, so the quadrature needs
care. This is optional and purely a TS-side feature.

## Risks and open questions

| Risk | Consequence | Mitigation |
|---|---|---|
| Sign / normalization mismatch with NEC's field routines | Wrong Z that looks plausible | Free-space-kernel comparison test against `efld_compute` |
| Wood anomalies (`kz_pq = 0`) | Kernel diverges; ill-conditioned matrix | Detect and report through the existing conditioning status; never return silently |
| Ewald breakdown for large cells or high frequency | Loss of accuracy | Bound `k/(2E)`; test with cells of several wavelengths |
| Conductors near the cell wall | Low-order quadrature of `G_smooth` inaccurate | Nearest-image ring through `efld_compute`; clearance check |
| Code assuming symmetric Z | Wrong results outside the engine core | Audit stateful model, ABI and TS for symmetry assumptions |
| Complex `erfc` implementation | Accuracy and licence | Use a known algorithm; unit-test against reference values |
| Scan-sweep run time | Slow visualizer interaction | Free-space matrix cache, worker pool, later kernel interpolation |
| Connected arrays requested early | Changes basis-function handling in stage 2 | Decide before stage 2 (see below) |

### Connected arrays

Elements that connect to their own periodic image (tightly coupled dipoles,
wire grids, long-slot style structures) need junction basis functions that
span the cell boundary with a Bloch phase on the neighbour segment's
coefficients. This touches NEC's connection logic (`icon1/icon2`, `trio`,
`tbf/sbf` in `c_geometry.cpp`), not only the kernel. It is tractable but a
separate piece of work, and analytic wire-grid references only become usable
for validation once it exists.

## Suggested staging

| Stage | Content | Depends on | Size |
|---|---|---|---|
| 1 | Periodic kernel unit: Ewald `G_smooth` and gradient, complex `erfc`, tests against a brute-force lattice sum with small loss and against the spectral form at `dz > 0` | none | small |
| 2 | Lattice and scan state, matrix-fill correction, free-space cache, stateful model, ABI, TS periodic model returning Y/Z | 1 | largest |
| 3 | Floquet transmit amplitudes, TE/TM normalization, scan element pattern, power check | 2 | small to medium |
| 4 | Floquet-mode excitation, full generalized S-matrix, lower port | 3 | medium |
| 5 | Connected arrays; finite ground through spectral Fresnel coefficients; sweep acceleration; Brillouin-zone mutual coupling | 2 to 4 | open-ended |

Stage 1 has no effect on existing behaviour and can be merged on its own.

## Validation plan

- **Kernel:** Ewald result against a direct lattice sum with slight loss, and
  against the spectral series for `|dz| > 0`; independence of the result from
  the splitting parameter.
- **Field routine:** smooth-kernel routine fed with the free-space kernel
  against `efld_compute`.
- **Limits:** very large lattice spacing should approach the isolated-element
  impedance.
- **Finite array:** centre-element active impedance of a large uniformly
  phased finite array from `array-solver.ts` should approach the periodic
  result (slowly, with edge ripple).
- **Literature:** published scan-impedance curves for infinite planar dipole
  arrays with and without a ground plane.
- **Power:** port power against Floquet power plus loss for every test case.
- **Reciprocity:** `Z(psi) = Z(-psi)^T`; transmit and receive Floquet entries.

## Decisions needed before stage 2

1. **Scan input:** phases (psi1, psi2) as primary input with (theta, phi) as a
   convenience (recommended), or angles only.
2. **Connected arrays:** needed early or not. If yes, the basis-function work
   should be designed together with stage 2.
3. **API shape:** a separate periodic model type in TS, or lattice options on
   the existing `NecModel`. A separate type makes it easier to reject
   far-field calls and to return scan-indexed results.
4. **Where Floquet amplitudes are computed:** TypeScript from the exported
   current distribution (faster to build) or C++ (faster to run in sweeps).

## References to consult

Listed from memory; check the bibliographic details before citing.

- K. E. Jordan, G. R. Richter, P. Sheng, "An efficient numerical evaluation of
  the Green's function for the Helmholtz operator on periodic structures,"
  J. Comput. Phys., 1986.
- A. Kustepeli, A. Q. Martin, "On the splitting parameter in the Ewald
  method," IEEE Microwave and Guided Wave Letters, 2000.
- I. Stevanovic, P. Crespo-Valero, K. Blagovic, F. Bongard, J. R. Mosig,
  "Integral-equation analysis of 3-D metallic objects arranged in 2-D lattices
  using the Ewald transformation," IEEE Trans. MTT, 2006.
- R. C. Hansen, "Phased Array Antennas" (scan impedance of infinite dipole
  arrays; scan element pattern).
- NEC-2 manual Part I (theory) and Part III (cards):
  https://www.nec2.org/other/nec2prt3.pdf
