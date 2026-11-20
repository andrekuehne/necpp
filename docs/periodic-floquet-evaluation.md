# Infinite-array periodic boundary and Floquet port: evaluation

## Status

**Evaluation with design decisions, 2026-11-18.** The findings come from
reading the engine and the WASM layer. Formulas are written from the standard
literature; items that need verification before implementation are marked
**[verify]**. Cost figures are estimates.

**Implemented so far:** stage 1, the periodic kernel unit, tested in the
native `[periodic_green]` suite:

- issue #20: lattice setup with Gauss reduction, the complex error function
  and the Ewald evaluation of `G_p` and `G_smooth` with gradients. The
  spatial, spectral and Ewald formulas below are verified against direct
  lattice sums with loss, the spectral series and independence of the
  splitting parameter.
- issue #21: the field of a segment under a smooth kernel. Its sign and
  normalization are verified against `efld_compute` (see
  [Field of a segment under the smooth kernel](#field-of-a-segment-under-the-smooth-kernel)).

Stage 2 so far:

- issue #22: lattice and scan phases on `nec_context` and the stateful model,
  the smooth correction in `cmww`, the C ABI entry points and
  `createNecPeriodicModel()` in the WASM package. Free space only; symmetric
  geometry is refused rather than unfolded. Verified at the package seam
  against finite arrays driven with uniform phase progression and a
  Gaussian amplitude taper:
  - broadside scan impedance of a half-wave dipole cell against the centre
    of a 15 x 15 array, 3.7 % (1.6 % at 21 x 21, so the difference is the
    finite array's edge error);
  - the sign of the scan phases, with an asymmetric two-dipole cell at
    `psi = (1.2, 0.5)`: the finite mutual impedance matches `Z01(psi)` to
    5.7 % and misses `Z01(-psi)` by 100 %. A one-port cell cannot show the
    sign, because reciprocity makes its `Z(psi) = Z(-psi)`.

  Also verified: the approach to the isolated element at large spacing,
  reciprocity `Z(psi) = Z(-psi)^T` to 2.5e-4, and power closure (Re Z equals
  the (0,0) Floquet-mode power to 1e-3 at 21 segments, checked natively). A
  uniformly driven finite array is no usable reference: its centre converges
  only like `N^(-1/2)` and is off by tens of percent at 11 x 11.
- issue #23: any lattice and multi-element unit cells. Lattice presets
  (square, rectangular, centered rectangular, hexagonal with rows along x or
  y) and the scan direction `(theta, phi)` live in TypeScript only; the
  engine keeps taking two vectors. `setLattice` refuses a lattice under which
  a conductor touches or nearly touches a periodic image: the axis distance
  of a segment to any image segment (its own or another conductor's) is at
  most the two radii plus NEC's joining tolerance `SMIN` times the longer
  segment. Verified at the package seam against tapered finite arrays at
  oblique scan: rectangular 4.1 % (9 cells, sin theta = 0.61), centered
  rectangular 2.8 % (sin theta = 0.41), hexagonal 2.3 % (sin theta = 0.58),
  and a honeycomb cell (hexagonal lattice, two dipoles) 3.7 % on all four
  entries of its non-reciprocal 2 x 2 scan impedance; broadside differs from
  the same finite results by 19 to 29 %. Oblique lattice vectors and their reduced
  equivalent agree to 8e-15 for the same physical scan state, and a scan
  direction gives the same result as its scan phases.
- issue #24: close images. For each observation point (segment centre) and
  source segment, the images of the source within `max(2 L, 40 a)` of the
  observation point (L, a the source segment's length and radius; capped at
  `rkh / 2`, below `efld_compute`'s lumped approximation) are taken out of
  `G_smooth` and evaluated through `efld_compute` with a displaced source and
  the scan phase factor. Images are chosen by distance per pair, not as a
  fixed 3x3 ring, so skewed lattices and cells larger than one lattice step
  need nothing special, and distant pairs keep the exact Gauss-integrated
  route. Measured with collinear half-wave dipoles (11 segments, radius 0.001
  wavelengths) against a reference that sends every image within 40 segment
  lengths through `efld_compute` (lumped approximation off): the filament
  route was off by 7.6e-5 at a 0.02 wavelength end gap and 3.6e-4 at 0.003;
  the thin-wire route stays at 5.7e-6 for any reach of one segment length or
  more. The error was never the Gauss rule (6 and 64 points agree to 3e-7 at
  a 0.003 gap) but the filament model of a close image, whose difference
  from the thin-wire kernel grows like `(a/d)^2`; hence the reach in radii
  (at 5 mm radius the jump where an image switches route is 9e-5 with two
  segment lengths, 3.3e-6 with 40 radii). Verified at the package seam: a
  stack of parallel dipoles 10 wire radii apart gives the same scan
  impedance as a one-dipole cell and as a two-dipole supercell to 3.0e-6
  (9.5e-4 before); the jump where an image switches route is 2.1e-6 (1 mm
  wires) and 3.3e-6 (5 mm); cells without close images are unchanged.
  Collinear dipoles with 5 mm gaps match a tapered finite array to 1.2 %,
  which is the finite array's edge error and larger than the close-image
  effect, so that case guards only against gross errors.
- issue #25: accuracy reporting and refusals. One fixed tolerance, `1e-5`
  relative to the largest scan-impedance entry (`nec_periodic_accuracy.h`),
  and no numerical parameters in the API. Every result carries an estimated
  error and a point status. The estimate covers the solver's numerics: the
  Ewald kernel (`1e-10`), the 6-point Gauss rule over the longest segment
  (`1e-10 max(1, (L / 0.1)^10)`, L in wavelengths, at least four times the
  error measured on lattices of 0.5, 1 and 3 wavelengths) and the rounding
  near the Floquet mode nearest to cut-off (`eps / (|kz| / k)`). Refused
  instead of loosened: cells whose spectral sum would need more than 10000
  modes per evaluation (about 320 square wavelengths; the cost grows with the
  cell area, 22 s for one 11-segment dipole in a 40 wavelength cell), segments
  above about 0.3 wavelengths, and scan states exactly on a Wood anomaly.
  Next to one the solution is benign: the scan impedance follows the
  expected square-root kink down to 1e-12 of cut-off, finite throughout, and
  even at the closest floating-point states (`|kz| / k` about 1e-8) the noise
  is about 1e-9, consistent with `eps / (|kz| / k)`. NEC's `pi()` is truncated
  (3.1415926536), so k and the reciprocal vectors differ by 1.6e-11 and an
  exact cut-off is reached only by searching for it.
  Thin-wire modelling error is not part of the estimate. The difference
  between the thin-wire route of close images and the filament of the smooth
  kernel is not mainly `(a/d)^2`, as assumed for issue #24: NEC's reduced
  kernel evaluates the free-space kernel at `sqrt(d^2 + a^2)` at every
  distance, a phase of about `k a^2 / (2 d)` far from the wire, whereas the
  field of a tube current differs from a filament only by order `(ka)^2` and
  `(a/d)^2`. Sending more images through the thin-wire kernel does not
  converge (the lattice sum of that phase converges only conditionally): from
  the issue #24 reach to 16 times it, with the thin-wire kernel evaluated by
  the Gauss rule so that `efld_compute`'s Romberg tolerance plays no part, the
  scan impedance moves by 7e-6 (1 mm wires, 0.7 x 0.5 wavelength cell, 22 cm
  end gaps), 1e-5 (10 cm gaps), 3e-5 (5 mm gaps), 6e-5 (stack with 10 mm
  pitch) and 3e-4 (5 mm wires, 2 cm gaps). That is the order by which a
  finite NEC array differs from the periodic result for this reason alone.
- issue #26: perfect ground. The ground images of the other cells, mirrored
  in z=0 with the opposite current along the mirrored segment (NEC's
  `frati = 1`), go through the same correction as the direct images:
  `add_periodic_images` runs once for the source and once for its mirror,
  with close images through `efld_compute` at `zi + zj` and `-salpj`. The
  close-image list of the direct images serves both, since for conductors
  above the plane `|p - q'| >= |p - q|` for every pair of points; conductors
  that touch, nearly touch or cross the plane are refused by the image-contact
  rule against their own ground image. Ground connections stay unsupported.
  Image theory: a dipole over ground equals a free-space cell with the dipole
  and its mirror driven oppositely, `Z = Z00 - Z01`, to 8e-14 (horizontal)
  and 5e-14 (tilted). A tapered 15 x 15 finite array over the same ground
  (horizontal dipoles at a quarter wavelength, off broadside) matches the
  centre element to 1.9 %, 0.9 % at 21 x 21; without the ground images of the
  other cells the periodic result is 86 % off. Reciprocity
  `Z(psi) = Z(-psi)^T` holds to 7.8e-5.
  Literature: Stark (1966) gives the scan resistance of half-wave dipoles a
  quarter wavelength over ground in closed form, `R = R_bs SF` (his eq. 20,
  Wheeler's broadside value times a scanning factor), from a sinusoidal
  current by induced EMF; without the image term the same expansion gives
  the free-space array. His figure 8 (a = b = 0.5 wavelengths) puts the
  dipoles end to end, a connected array, so the test uses 0.6 along and 0.5
  across the dipoles (radius 1e-5 wavelengths, 21 segments). Broadside is 3.1 %
  above Stark over ground and 3.3 % in free space, the moment-method current
  against the sinusoid (the isolated half-wave dipole is 6 % above its EMF
  value at this radius, 16 % at 1e-3). The scanning factor agrees to 0.4 % in
  free space (E, H and D planes to 40 degrees, H 40: 1.9 %) and to 1 to 6 %
  over ground (6.4 % at H 40). Beyond a grating-lobe onset Stark's curves
  part from the moment method: at 0.6 wavelengths over ground, H-plane 56
  degrees, the periodic solver gives `272.9 + j145.1` ohm against about 223
  ohm read from his figure 9, while the centre of a tapered finite array
  over the same ground goes from `249.7 + j156.6` (17 x 17) to `264.0 + j152.0`
  (25 x 25), towards the periodic value. Stark's crosses come from Carter's
  mutual impedances, which assume the same sinusoidal current.

The design decisions taken after the evaluation are collected in
[Decisions](#decisions). Where they change an earlier section, that section
says so. Terms follow [`GLOSSARY.md`](../GLOSSARY.md); the layered-stack route
is recorded in [ADR 0001](adr/0001-layered-stacks-in-matrix-fill.md).

## Goal

1. Define an antenna configuration (the unit cell) and a 2D lattice, and get
   back the scan impedance and scan admittance (Z and Y) of the unit-cell
   ports for given scan states.
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
- The repository had no complex error function (`erfc` of complex argument);
  the periodic kernel unit now provides one.
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
(`|k_t0| > k`), which is needed if the scan admittance is later integrated
over the Brillouin zone. (theta, phi) is a convenience on top. The phases are
always relative to the user's `a1`, `a2`; any internal basis reduction is
mapped back before results are returned.

### Lattice types

All five planar lattice types are special cases of the general `a1`, `a2`
above, so the kernel, the Floquet-mode indexing and the Bloch phase need no
per-type code. Named presets exist only in TypeScript.

| Lattice | `a1`, `a2` | Array-literature name |
|---|---|---|
| Square | `(d,0)`, `(0,d)` | square grid |
| Rectangular | `(dx,0)`, `(0,dy)` | rectangular grid |
| Centered rectangular | `(dx,0)`, `(dx/2,dy)` | staggered / offset-row grid |
| Hexagonal | `(d,0)`, `(d/2, d*sqrt(3)/2)` | equilateral triangular grid |
| Oblique | anything else | skewed grid |

Three implementation details depend on the lattice:

- Spatial and spectral sums are truncated by radius, not by an index box
  `|m|,|n| <= M`, which converges poorly for skewed lattices.
- A strongly skewed input basis is reduced internally (Lagrange/Gauss
  reduction) to keep the term count low.
- Clearance is checked as the distance from each conductor to the periodic
  images of the unit cell's conductors (its own and the others'), not to a
  cell wall, which has no unique shape for a non-rectangular lattice.

Honeycomb, kagome and dual-polarized arrays with offset sub-lattices are not
lattices; they are a lattice with several elements per unit cell. The
hexagonal lattice's six nearest Wood-anomaly circles sit further from the
visible region than the square lattice's four for the same element density,
which is the classic reason it allows about 13 % fewer elements for the same
grating-lobe-free scan range.

### Periodic Green's function

Spatial form (conditionally convergent, not usable directly):

    G_p(r, r') = sum_mn exp(-j k_t0 . rho_mn) exp(-j k R_mn) / (4 pi R_mn)
    R_mn = | r - r' - rho_mn |

Spectral (Floquet) form, with `k_tpq = k_t0 + p b1 + q b2` and
`kz_pq = sqrt(k^2 - |k_tpq|^2)` on the branch with `Im(kz) <= 0`:

    G_p = 1/(2 j A) * sum_pq exp(-j k_tpq . (rho - rho')) exp(-j kz_pq |z - z'|) / kz_pq

The spectral form converges exponentially only when `|z - z'| > 0`, so it is
useless for a planar or thin cell but is exactly what the Floquet port needs.

Ewald form, usable everywhere, with splitting parameter `E` (signs and
prefactors verified in the `[periodic_green]` suite):

    G_p = G_spat + G_spec

    G_spat = 1/(8 pi) * sum_mn exp(-j k_t0 . rho_mn) / R_mn *
             [ exp(-j k R_mn) erfc(R_mn E - j k/(2E))
             + exp(+j k R_mn) erfc(R_mn E + j k/(2E)) ]

    G_spec = 1/(4 j A) * sum_pq exp(-j k_tpq . (rho - rho')) / kz_pq *
             [ exp(-j kz_pq dz) erfc(j kz_pq/(2E) - dz E)
             + exp(+j kz_pq dz) erfc(j kz_pq/(2E) + dz E) ],   dz = z - z'

Both sums converge like a Gaussian. For cells larger than about one
wavelength the optimal `E = sqrt(pi / A)` causes loss of significance (terms
of size `exp((k/2E)^2)` cancelling); `E` must then be raised so that `k/(2E)`
stays bounded, at the cost of more spectral terms.

As implemented: `E = max(sqrt(pi / A), |Re(k)| / 4)`, so `k/(2E) <= 2`. Both
sums keep every term whose Gaussian factor exceeds `exp(-36)`: lattice points
within a radius of the observation point (spatial), and Floquet modes with
`|k_tpq| <= sqrt(|k|^2 + 144 E^2)` (spectral), enumerated over Gauss-reduced
lattice vectors. A half-wavelength cell then needs about 40 terms per sum
rather than 9 to 25; the fixed tolerance (issue #25) keeps the kernel at
`1e-10`, well inside it. The
complex error function uses Weideman's rational approximation of the
Faddeeva function (40 terms, about 1e-13 relative), with `exp(a) erfc(z)`
combined so neither factor overflows.

### Splitting off what NEC already does

Write

    G_p = G_free(0,0) + G_smooth
    G_smooth = G_spec + G_spat(without its (0,0) term) + [ G_spat(0,0) - G_free ]

The bracket is finite at `R -> 0` (the 1/R singularities cancel), so
`G_smooth` is smooth everywhere inside the cell. With
`f(R) = exp(jkR) erfc(RE + jk/(2E))` the bracket equals
`(f(R) - f(-R)) / (8 pi R)`; near `R = 0` the implementation uses its Taylor
series in `R^2` (odd derivatives of `f` through Hermite polynomials) instead
of the difference.

- `G_free(0,0)` is the existing NEC interaction, unchanged, including the
  self term, the extended thin-wire kernel and the far-segment lumped
  approximation.
- `G_smooth` is the only new physics. Because it is smooth, the field it
  produces can be computed with a low-order Gauss rule per source segment
  (as implemented: 6 points, see below).

If conductors come close to a cell wall, the nearest images make `G_smooth`
nearly singular. The remedy is to move the nearest images out of `G_smooth`
and evaluate them through the existing `efld_compute` with a displaced source
and a phase factor, the same way the ground image is handled today. Those
image fields are scan-independent apart from the phase factor. As
implemented (issue #24), the images moved out are chosen by distance per
observation point and source segment rather than as a fixed 3x3 ring; in
practice the thin-wire kernel, not the Gauss rule, is what the close images
need.

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

Verified (issue #21): fed with the plain free-space kernel, the routine
matches `efld_compute` (exact thin-wire branch) to 5.5e-11 for the sine and
cosine terms and the transverse part of the constant term in parallel,
collinear, skewed, near and far geometries. The axial part of the constant
term agrees to about 1e-5, the accuracy of NEC's own Romberg integral
(`intx`, tolerance 1e-4). Two details came out of that comparison:

- `eta` must be 376.73 ohm, the value fixed in `eksc`/`ekscx`
  (`j 4.771341189 = j eta / (8 pi^2)`), not `em::impedance()` (about
  376.7343). The two differ by 1.1e-5, and the smooth correction is added
  to the `eksc` fill.
- Under the smooth kernel the Gauss rule converges spectrally. Six points
  keep the error near 2e-11 for segments up to a tenth of a wavelength. On
  short segments the charge and end-charge terms cancel to about `(kL)^2`,
  which amplifies kernel rounding. To keep that rounding near 1e-11, the
  origin term of `G_smooth` uses its Taylor series through `R^14` up to
  `R (E + |k|) = 0.3`.

### Ground

- **Perfect ground:** the image source gets the same treatment as the direct
  source (free-space image term from existing code, plus a smooth correction
  for the image lattice).
- **Finite ground** (soil of infinite extent, `GroundModel` `kind: "finite"`):
  not in stage 2. It arrives in stage 3b as one case of a layered stack: in
  the spectral domain each Floquet mode sees an exact Fresnel coefficient, so
  no Sommerfeld integrals are needed.

### Layered stacks (stage 3b)

Decided in [ADR 0001](adr/0001-layered-stacks-in-matrix-fill.md). The wires
live in an air region. Above and below it, layered stacks that are uniform in
the lattice plane (radome, substrate below the wires, finite ground) act on
each Floquet mode `(p, q)` only through a TE and a TM reflection coefficient
from a transmission-line model of the stack. Such stacks do not couple
Floquet modes.

Each mode leaves a source segment, reflects off the stack and returns to an
observation segment, which adds

    Z_refl = sum_pq U_pq Gamma_pq V_pq^T

a sum of rank-2 (TE + TM) terms. `V_pq` is the modal segment integral the
Floquet port already computes in stage 3, so the code is shared. The terms
decay like `exp(-|kz_pq| * 2 g)` over the air gap `g`, so they need no Ewald
treatment. Perfect ground stays on the image route, because reflection terms
converge badly for wires close to the ground.

- A conductor that enters a stack is rejected.
- The mode count is chosen from the decay against the fixed tolerance; above a
  mode cap the configuration is refused, never silently truncated. The gap and
  mode count are reported in the diagnostics.
- With a stack above the array, the embedded (0,0) amplitude is the wave
  transmitted through the stack.

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
7. **TypeScript:** a separate `PeriodicModel` type (decided), worker protocol
   entries, lattice presets, and a scan sweep over caller-given scan states
   that runs on the worker pool, can be cancelled and delivers results in
   chunks.
8. **Wood anomalies:** Floquet modes near cut-off are split out of the
   spectral sum. Their singular part tends to `(2/gamma)` times a separable
   rank-2 (TE + TM) term, independent of `dz`; solving with a low-rank
   (Woodbury) update on the LU keeps port quantities finite and smooth in
   `gamma`, including `gamma = 0` exactly. The per-point status marks "on or
   near cut-off"; NaN is reserved for genuine failure.
9. **Tolerance:** one fixed internal tolerance for Ewald sums, mode truncation
   and stack modes. No truncation parameters in the API; each result carries
   an estimated error. A configuration that cannot reach the tolerance is
   refused.

Everything downstream of the matrix (loads, port definition, Y by unit-voltage
solves, Z by inversion, power budget) works unchanged. The result at each scan
point is the P x P scan admittance of the P unit-cell ports.

### Restrictions for a first version

- 2D lattice in the xy-plane only, parallel to any ground. A 1D (linear)
  periodic array needs a different Green's function and would get its own
  entry points; 3D stacking is out of scope.
- Wires only; no surface patches.
- No conductor may touch its own periodic image, checked by image distance
  (see connected arrays).
- Free space or perfect ground only; layered stacks and finite ground follow
  in stage 3b.
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
  already exported by `getCurrentDistribution`. **Decided:** the amplitudes are
  nevertheless computed in C++, because the stage 3b matrix fill needs the
  same modal segment integrals and sweeps run to thousands of scan points.
- Amplitudes per port are normalized as `EmbeddedFieldNormalization`: unit
  voltage with the other ports shorted, or unit current with them open.
  Generator-referred, terminated versions are derived in TypeScript from the
  scan impedance.

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

### Finite-array pattern from the periodic result

A windowed array (a finite block of driven elements inside the infinite array,
all other elements present and terminated) has the pattern

    E(theta, phi) = g_inf(theta, phi) * sum_mn a_mn exp(+j k r_hat . rho_mn)
    a_mn = w_mn exp(-j k_t0 . rho_mn)

exactly, where `g_inf(theta, phi)` is the scan element pattern: the (0,0)
Floquet amplitude at the scan state `k_t = k sin(theta) (cos(phi), sin(phi))`.
It therefore needs a scan sweep over the visible region, not only the steering
state. Only truncation (edge effects) is left out; a direct finite solve with
`array-solver.ts` is the exact reference.

- **Approximation, flagged:** every driven element is taken to see the scan
  impedance of the steering direction. Per-element active impedances of the
  windowed array need the Brillouin-zone mutual coupling below and come later.
  Until then, the finite-array solve gives exact per-element active impedances
  for arrays of moderate size without a radome.
- **Sampling:** `g_inf` comes from a sweep on an `auto` u-v grid inside the
  unit circle (spacing from the unit-cell size, with a `manual` override),
  refined along both sides of the Wood-anomaly circles. These are known in
  advance: unit circles centred on the reciprocal-lattice points scaled by
  `1/k`. Interpolation never crosses a circle.
- **API:** the package exposes the result as a scan element pattern object
  that can be evaluated at any `(u, v)`, so any consumer field grid and
  display frame works. The array factor stays with the consumer.
- **Termination consistency:** the windowed model is exactly periodic only if
  the passive elements' termination equals the generators' internal impedance
  (short with ideal voltage drive, open with ideal current drive, or a common
  generator impedance).
- **What stays honest:** the infinite model overstates scan blindness. A
  radome guided wave needs many cells to build up, so a small real array
  shows a shallower, wider and shifted dip. The notch also appears in every
  steered pattern, because `g_inf` multiplies them all.

### Mutual coupling from the periodic result

The coupling between the reference element and element (m, n) in the infinite
array is the Fourier coefficient of the scan admittance over the Brillouin
zone:

    Y_mn = 1/(4 pi^2) * double integral over psi1, psi2 of
           Y(psi1, psi2) exp(-j (m psi1 + n psi2))      [verify sign convention]

The integrand stays finite on the Wood-anomaly curves but has square-root
kinks there, so a uniform grid converges slowly in the far couplings and the
quadrature needs care. A uniform N x N grid followed by a 2D FFT gives the
couplings of an array that repeats every N cells (aliased), which is a usable
first approximation. This is optional and purely a TS-side feature.

**Why deferred (stage 5):** the existing finite-array solve already answers
"what does each element of my array see?" for arrays of moderate size, and it
does better: real edges, no aliasing, scan blindness damped correctly. The
Brillouin route gives a windowed array (elements outside the window present
and shorted), not a finite one, and costs a full scan-phase sweep including
invisible space. It only becomes worthwhile where the finite solve cannot go:

- **Layered stacks** (after stage 3b): NEC-2 has no dielectric layers, so
  this is the only way to get element-to-element coupling and per-element
  active impedance with a radome or substrate included.
- **Very large arrays**, where the finite MoM becomes too slow. One sweep then
  serves every window size, shape and taper.
- **Isolating edge effects**, by comparing the finite array against the
  windowed array of the same size.

## Risks and open questions

| Risk | Consequence | Mitigation |
|---|---|---|
| Sign / normalization mismatch with NEC's field routines | Wrong Z that looks plausible | Free-space-kernel comparison test against `efld_compute` |
| Wood anomalies (`kz_pq = 0`) | Kernel diverges; ill-conditioned matrix | Split near-cut-off modes out as rank-2 terms and solve with a low-rank update, so results stay finite; flag the point's status |
| Ewald breakdown for large cells or high frequency | Loss of accuracy | Bound `k/(2E)`; test with cells of several wavelengths |
| Conductors near the cell wall | Low-order quadrature of `G_smooth` inaccurate | Nearest-image ring through `efld_compute`; clearance check |
| Code assuming symmetric Z | Wrong results outside the engine core | Audit stateful model, ABI and TS for symmetry assumptions |
| Complex `erfc` implementation | Accuracy and licence | Use a known algorithm; unit-test against reference values |
| Scan-sweep run time | Slow visualizer interaction | Free-space matrix cache, worker pool, later kernel interpolation |
| Connected arrays requested early | Changes basis-function handling in stage 2 | Decided: not in stage 2 (see below) |
| Stack too close to the wires | Too many Floquet modes for the tolerance | Mode cap; refuse rather than truncate; report gap and mode count |

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
| 3 | Floquet transmit amplitudes (C++), TE/TM normalization, scan element pattern object, finite-array pattern support, power check | 2 | small to medium |
| 3b | Layered stacks above and below the wires (radome, substrate, finite ground) through per-mode reflection terms in the matrix fill | 3 | medium |
| 4 | Floquet-mode excitation, full generalized S-matrix, lower port | 3 | medium |
| 5 | Connected arrays; sweep acceleration (scan-space symmetry, adaptive refinement); Brillouin-zone mutual coupling and per-element windowed active impedance | 2 to 4 | open-ended |

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
- **Lattice types:** centre-element active impedance of large finite
  hexagonal and centered-rectangular arrays from `array-solver.ts` against the
  periodic scan impedance.
- **Windowed pattern:** against direct finite solves at 8x8, 16x16 and 32x32,
  showing the edge error shrinking.
- **Wood anomalies:** circle positions predicted from the reciprocal lattice
  against the observed kinks in the scan impedance; finite values exactly on
  a circle.
- **Layered stacks:** an `eps_r = 1` layer changes nothing; thin-layer limit;
  power closure including dielectric loss; a published wide-angle impedance
  matching (WAIM) sheet case (Magill and Wheeler, from memory **[verify]**).
- **Finite ground:** against NEC's existing reflection-coefficient ground in
  the large-spacing limit.

## Decisions

Taken 2026-11-18. Terms as in [`GLOSSARY.md`](../GLOSSARY.md).

**Scope**

1. The first target is phased-array scan impedance. Frequency-selective
   surfaces follow with the Floquet excitation in stage 4. Work is in the
   necpp backend only (engine, ABI, `necpp-wasm`).

**Lattice**

2. One general lattice given by `a1`, `a2` in the engine and ABI; named
   presets only in TypeScript. No `latticeType` enum.
3. Honeycomb and sub-lattice arrangements are a lattice with several elements
   per unit cell, not a lattice type.
4. 2D periodicity in the xy-plane only, parallel to any ground. No 1D or 3D
   periodicity, and no ABI placeholders for them.

**Scan and API**

5. Scan phases `(psi1, psi2)` along the user's `a1`, `a2` are the primary
   input; `(theta, phi)` is a convenience. Internal basis reduction is mapped
   back.
6. A separate `PeriodicModel` type in TypeScript, without far-field calls.
7. The P x P result is the scan impedance / scan admittance; active impedance
   keeps its per-drive meaning.
8. Floquet amplitudes are computed in C++, normalized as
   `EmbeddedFieldNormalization`; terminated versions are derived in
   TypeScript.
9. Wood anomalies return finite values through a low-rank split of
   near-cut-off modes; the status flags them and NaN means genuine failure.
10. One fixed internal tolerance, no truncation parameters, an estimated error
    in the diagnostics, and refusal when the tolerance cannot be met.

**Physics scope**

11. No connected arrays in stage 2; clearance is checked by image distance.
12. Stage 2 supports free space and perfect ground (image route) only.
13. Layered stacks (radome, substrate, finite ground) enter through per-mode
    TE/TM reflection terms in the matrix fill, in a new stage 3b
    ([ADR 0001](adr/0001-layered-stacks-in-matrix-fill.md)). Conductors may
    not enter a stack; too small a gap is refused.

**Finite-array pattern**

14. Version 1 is the windowed array: array factor times scan element pattern,
    with the steering-direction scan impedance for every element flagged as an
    approximation. Per-element windowed active impedance follows the
    Brillouin-zone work.
15. The scan element pattern comes from an `auto` u-v sweep (with `manual`
    override) refined along the Wood circles, exposed as an object
    evaluable at any `(u, v)`.
16. Sweeps run on the worker pool, can be cancelled and deliver results in
    chunks.

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
- L. Stark, "Radiation impedance of a dipole in an infinite planar phased
  array," Radio Science, vol. 1 (new series), no. 3, pp. 361-377, March 1966
  (checked; used by the issue #26 literature test).
- H. A. Wheeler, "The radiation resistance of an antenna in an infinite
  array or waveguide," Proc. IRE, vol. 36, pp. 478-487, April 1948 (as cited
  by Stark).
- NEC-2 manual Part I (theory) and Part III (cards):
  https://www.nec2.org/other/nec2prt3.pdf
