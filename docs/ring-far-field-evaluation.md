# Ring far-field evaluation: analysis and opt-in integration

The current, unreleased implementation is described under
[Production integration](#production-integration-unreleased). It adds an opt-in
ring evaluator while preserving exact defaults and goldens.

The sections below through “Original analysis reproduction” record the original
**bench-only** experiment committed as `970d1ed` on
`bench/ring-far-field-evaluation`. That commit changed no production source,
package API, WASM asset, version, or golden. Its source baseline was
`09e4d413d835285a6631216baf8b2172f08651e5` (package 0.7.1).

## Original analysis decision

**Go for an opt-in approximate evaluator; retain the current exact paths.**
On the four requested PEC arrays, far-field work is **99.37–99.96% of
re-steer time** and 72.03–89.47% of cold engine time. The ring method is
**2.83–7.68× faster in WASM against the same-build direct tile kernel**
(2.97–7.82× native). The free-space and additional geometry checks also
improve, with a minimum measured WASM gain of 2.52×.

All **84 solved-field comparisons** meet the 1e-7 target. The largest
component error divided by the global vector peak is **3.855e-11**; using
each component's own peak instead gives at most 4.612e-11. Ring interpolation
alone differs from the standalone tile reference by at most **5.665e-15**.
The largest radiated-power closure change is **2.476e-11**, with direct and
ring closure values identical when rounded to nine decimal places.

Timings include interpolation, allocation, centroid handling, and 72 extra
direct scout directions. This is evidence for the tested ordinary-wire
cases, not a production rollout or a universal floating-point accuracy
guarantee. The standalone tile comparison separates the interpolation gain
from existing differences between the two direct paths.

## What the source actually does

- `packages/necpp-wasm/package.json` is 0.7.1. This checkout does not contain
  the consumer's source, so its vendored tarball, auto-grid implementation,
  retained-solver usage, and quoted 972-site NumPy result cannot be verified.
- `nec_stateful_model::prepare()` fills and factors; voltage solves retain LU.
  The benchmark asserts `factorization_generation() == 1` after every solve.
  `solveCurrents()` additionally needs the port impedance matrix: its first
  call can run a unit-voltage solve per port to construct it. The measurements
  here use simultaneous **voltage RHS** changes, not that optional cold
  port-matrix extraction. Construction, module startup, workers and transfer
  costs are excluded. A retained current solve adds the cached V=ZI operation.
- `computeFarField()` reaches `src/nec_far_field.cpp` through the stateful
  model. The TypeScript tile implementation is in `src/field-evaluator.ts`
  under the WASM package, and the standalone compiled tile kernel is
  `src/nec_field_evaluator_wasm.cpp`. The tile types/helpers and snapshot
  machinery are internal package modules, not exports of the package root.
- Output index is `phiIndex * thetaCount + thetaIndex` (theta fast).
  Each direction sums all segments, then PEC images. The selected stateful
  path caches direction trigonometry and reuses output storage; it does not
  factor contributions across a ring. Counts include both ground passes:
  `segmentDirectionContributions = directions * segments * images`.
- Snapshots store wavelength-normalized centers and direction cosines in
  separate arrays, exact A/B/C current coefficients, and
  `segmentHalfLengths = π * segmentLengthInWavelengths`. The latter is an
  electrical half-length, **not metres**.
- The sign convention agrees with exp(+jωt): source position phase is
  exp(+jk r·rhat), propagation is exp(-jkR)/R. Radius 1 m here uses this
  far-zone formula; it is not a claim that 1 m lies in the physical far zone
  of the large arrays.
- “Exact binary64” identifies direct evaluation without angular truncation;
  it is not bitwise identity across the two existing evaluators. Legacy
  `math_util.h::pi()` is 3.1415926536; the standalone tile uses full binary64
  π, also for angles and impedance. This accounts for a pre-existing small
  discrepancy. We preserve it and report both reference comparisons.

The specified counts and exact endpoints cannot all use one identical step:
`ceil()` generally overshoots θ=90° if the raw step is retained. We use the
specified counts, with θ step `90/(thetaCount-1)` and periodic φ step
`360/phiCount`, avoiding duplicate φ=360° and above-ground clipping of the
last θ sample. Exactly D=26λ gives 370×1476; the quoted 367×1462 is consistent
with an approximately 25.77λ aperture. The consumer's precise rounding needs
confirmation before integration. The quoted scalar error is normalized to
each ring's peak, whereas this experiment reports a global peak; those
numbers are not directly comparable. A scalar array factor also omits the
segment integral, polarization projection, and solved-current conditioning.

## Fixtures and measurement protocol

Frequency 300 MHz; length 0.47λ; 11 segments per dipole; radius 0.001λ;
center height 0.5λ; feed segment 6; explicit geometry with no symmetry
reduction. Regular arrays have 0.5λ spacing. The 256-element sunflower has
`r_i = 0.5 sqrt(i/π) λ`, `phi_i = i π(3-sqrt(5))`, i=0…255 (comparable
area density, radius about 4.505λ). Every array is translated by
(+0.37, -0.21)λ to exercise centroid phase restoration. All ordinary fixtures
have vertical wires over PEC. Additional cases:

- `free4`: regular 4×4, free space.
- `heights4`: regular 4×4, PEC, center heights `0.5+0.11 sin(1.7i)`λ.
- `tilted4`: regular 4×4, PEC, wire directions
  `(0.8 cos(1.3i), 0.8 sin(1.3i), 0.6)`; both polarizations are nonzero.

The auto-grid uses the xy **element-center** bounding-box diagonal plus
0.47λ, with s=8 and the 5° cap. For the tilted validation fixture we keep this
same conservative element-length allowance. Two drive vectors per fresh
model use unit amplitudes and phases
`-2π[x_i(0.12+0.03*steer)+0.19*y_i]`.

Three fresh models per case per runtime; one cold solve/field and one new-RHS
solve/field per model. Reported phase and retained-field times are medians
of three measurements. Accuracy maxima cover all six fields per runtime.
The first model includes runtime warm-up effects; there is no discarded
warm-up or JIT tuning. Native and WASM cases run serially, after all builds
and preliminary profiling have stopped. No threads, WASM SIMD, fast math, or
`-march=native` flags are enabled; GCC may auto-vectorize for its baseline
x86-64 target. Timing is not CPU pinned;
this laptop's scheduling, power state, and thermal behavior limit precision.

The real engine sources are built into an isolated C++ executable and a
Node-executed WASM harness (`-O3 -flto`, GCC 15.2.0 / Emscripten 4.0.10,
Node 24.20.0, Intel Core i7-1355U). `build.py` derives the source list from
`src/CMakeLists.txt` and selects the same default direction-cache/output-reuse
flags. It adds steady-clock probes around `cmset` and `factrs` **only in a
copied source file in the build directory**. The public API remains unchanged.
This measures full NEC, not a scalar array-factor substitute. These WASM
phase tables time C++ engine work in V8; JS/C-ABI result-copy overhead is
outside them. The repository's Docker scripts pin Emscripten 4.0.7; the
isolated bench uses 4.0.10, so it is not the byte-identical release artifact.
The initial public-package probe below uses the existing shipped binary.
The shipped binary's disassembly contains no SIMD instructions (recorded in
`evidence/package-inspection.json`). Its 4×4 wall time differs from the
source harness, so use the paired, within-build comparisons below rather
than mixing a shipped-package baseline with prototype timings.
Shipped-package
profiling was also used first to establish relevance; the final tables use
this isolated instrumented build so fill and factor can be separated.

Raw observations and binary/environment hashes are in
[`bench/ring-far-field/evidence`](../bench/ring-far-field/evidence).
The largest solved cases are 256 dipoles / 2816 unknowns. They already take
tens of seconds per direct field; larger matrices, the 972-element example,
and browser runtimes were not measured. No estimate for them is presented as
a measurement.

<!-- BEGIN sizes -->
| Case | Segments | θ × φ | Directions | segmentDirectionContributions |
| --- | --- | --- | --- | --- |
| regular4 | 176 | 38 × 148 | 5,624 | 1,979,648 |
| regular8 | 704 | 78 × 308 | 24,024 | 33,825,792 |
| regular16 | 2816 | 159 × 629 | 100,011 | 563,261,952 |
| sunflower256 | 2816 | 187 × 741 | 138,567 | 780,409,344 |
| free4 | 176 | 38 × 148 | 5,624 | 989,824 |
| heights4 | 176 | 38 × 148 | 5,624 | 1,979,648 |
| tilted4 | 176 | 38 × 148 | 5,624 | 1,979,648 |
<!-- END sizes -->

The initial unmodified-package 4×4 probe measured median prepare 12.712 ms,
retained solve 0.637 ms and retained field 77.253 ms (99.18% far-field share;
three fresh models and nine retained solves). Those raw rows are retained in
`evidence/package-initial.ndjson`. It used origin-centered geometry and the
same element length, height, grid and drive gradients; the main experiment
adds horizontal translation to test phase restoration. Larger preliminary
runs overlapped toolchain setup and are excluded from reported timing tables.

## WASM phase profile

All times below are milliseconds. Cold FF share is
`field/(prepare + coldSolve + field)` using the phase medians; prepare also
includes setup beyond fill and factor. Re-steer share is
`field/(retainedSolve + field)`. Re-steers perform **zero fill/factor work**.
The table measures the default stateful far-field path, not the prototype.

<!-- BEGIN profile -->
| Case | Fill ms | Factor ms | Cold solve ms | Cold field ms | Cold FF share | Re-solve ms | Re-field ms | Re-steer FF share |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| regular4 | 8.217 | 3.647 | 1.372 | 111.995 | 89.47% | 0.706 | 110.564 | 99.37% |
| regular8 | 96.204 | 192.393 | 1.791 | 1977.062 | 87.22% | 2.056 | 1975.841 | 99.90% |
| regular16 | 1706.798 | 11694.820 | 19.040 | 34555.625 | 72.03% | 18.782 | 34544.604 | 99.95% |
| sunflower256 | 1696.400 | 12173.117 | 19.378 | 48136.280 | 77.55% | 18.833 | 48078.559 | 99.96% |
| free4 | 5.688 | 3.676 | 1.321 | 55.861 | 83.93% | 0.712 | 55.450 | 98.73% |
| heights4 | 8.523 | 3.670 | 1.426 | 111.335 | 89.09% | 0.825 | 110.572 | 99.26% |
| tilted4 | 8.437 | 3.650 | 1.332 | 110.348 | 89.15% | 0.704 | 110.375 | 99.37% |
<!-- END profile -->

## Bandwidth and error derivation

The starting identities are the Bessel generating function and
[Jacobi–Anger expansion (NIST DLMF §10.12)](https://dlmf.nist.gov/10.12).
The following bound and segment extension are derived here from that
identity, not from a fitted scalar-array experiment.

For a point at horizontal radius ρ from the chosen centroid, let
A=kρ|sinθ|. Shift the periodic Fourier integral for exp(jA cosφ) by imaginary
height t>0. Its modulus is at most exp(A sinh t), hence

```
|J_n(A)| ≤ exp(A sinh(t) - |n| t)
T_N(A) := Σ_{|n|>N} |J_n(A)|
        ≤ 2 exp(A sinh(t) - (N+1)t) / (1-exp(-t)).
```

For N+1>A>0 choose `t=acosh((N+1)/A)` (minimizes the numerator); sum the
geometric majorant for the tail. `cutoff(A, ε)` returns the first N≥floor(A)
whose log bound is ≤log ε; `cutoff(0, ε)=0`. This avoids Bessel evaluations
and overflow. A fixed bandwidth independent of tolerance and source
cancellation cannot guarantee a relative-to-peak target.

### Sinusoidal-basis segment contribution

With u=ks along a segment and h=kℓ/2, the current is
`I(u)=A_s+B_s sin u+C_s cos u`. Its radiation integral is

```
∫[-h,h] I(u) exp(-j ω u) du = a A_s - j b B_s + c C_s,
ω = -rhat·u_s,
a = 2 sin(ωh)/ω,
b = h [sinc(h-ωh)-sinc(h+ωh)],
c = h [sinc(h-ωh)+sinc(h+ωh)].
```

These are the snapshot kernel's a/b/c expressions; at arguments below
1e-7 it uses small-argument Taylor branches to avoid unstable division.
The bound concerns the analytic integral, while the measured comparisons
include those branches and floating-point rounding. Thus the mathematical g_s is
entire with an **infinite**, rapidly decreasing azimuthal tail; it is not an
exact fixed-order polynomial. Instead bound the integral as a superposition
of point sources along the segment. Set

```
ρmax = max segment-center horizontal radius after centering
B    = max_s h_s sqrt(cab_s²+sab_s²)
A(θ) = 2π ρmax |sinθ|
A*(θ)= A(θ) + B |sinθ|
N0   = cutoff(A(θ), ε)
N*   = cutoff(A*(θ), ε)
p    = 0 for all-z wires; 1 otherwise
L(θ) = N* + p
Lseg(θ) = N* - N0 + p.
```

The triangle inequality bounds the horizontal radius of **every point** on
each segment by the center radius plus its projected half-length. Spherical
projection multiplies by at most first-order sinφ/cosφ terms, so p=1 covers
general orientations. Vertical wires have p=0 and B=0: Eθ's projection is
constant on the ring and Eφ is identically zero. For these 0.47λ/11 segments,
h≈0.1342 rad; the tested tilted case needs at most the small Lseg reported
below. There is no array-independent integer Lseg for arbitrary segment
length, tolerance, and current conditioning.

PEC images change signs of horizontal currents and reflect z. They leave
horizontal extent and Fourier order unchanged. Their z phase and the
original z phase are constant on each ring. They double the source-norm
bound, **not** Lseg. Only x/y are recentered; subtracting the z centroid and
restoring one common phase would be wrong for PEC images.

### Constants c and m: a sufficient envelope, not a fit

The familiar A+c A^(1/3)+m form follows from the contour bound. For a fixed
snapshot tolerance ε<1 and `Amax ≥ maxθ A*(θ)`, define

```
H = log(4/ε) + (1/3)log(max(1,Amax)),  H ≥ 1,
c = (6/5) H^(2/3),
m = (6/5) H.
```

Then `N = ceil(A + c A^(1/3) + m)` is sufficient for `T_N(A) ≤ ε` for
0≤A≤Amax. To see this, take `t=min(1,(H/A)^(1/3))`. For 0<t≤1,
`sinh t ≤ t+t³/5` (bound its positive Taylor series by its value at t=1)
and `1-exp(-t) ≥ t/2`. Therefore

```
log T_N ≤ log(4/t) + A t³/5 - (N+1-A)t.
```

Here `At³≤H`, `log(4/t)≤log4+(1/3)log(max(1,Amax))`, and
`(N+1-A)t≥6H/5`, proving the claim. This is a conservative, documented
choice of c and m; e.g. ε=1e-14 and Amax=60 give c≈12.84 and m≈41.98.
The implementation uses the **tighter direct inversion of the same tail
bound**, rather than paying for that sufficient envelope. It does not use
c=1.8,m=10 or assume that they achieve 1e-7 for real NEC fields.

### Relative budget, interpolation aliasing, and roundoff

Let W be a bound on the integrated source magnitudes in output units:

```
W = (η/(4π)) (λ/R) images
    × Σ_s 2 h_s (|A_s|+|B_s|+|C_s|).
```

The Laurent coefficient absolute sum of a spherical projection is ≤2.
Thus the projected tail is ≤2 W ε. Uniform sampling at M=2L+1 aliases
higher Fourier coefficients into the retained orders; interpolation is
exact for an order-L trigonometric polynomial, **not for the true field**.
Its error is bounded by twice the omitted coefficient sum, giving
`|ΔE_component| ≤ 4 W ε` in exact arithmetic. This bounds truncation of the
standalone evaluator's mathematical integral, not the separate discrepancy
between legacy and tile constants.

The prototype first evaluates 9×8 coarse directions to obtain a lower bound
P0 on the continuous-domain global vector-field peak. It selects
`ε=min(1e-13, 1e-12 P0/(4W))`; zero-field cases fall back to direct. A narrow
beam missed by scouts makes the bound more conservative. Scouts lie in the
requested domain for the full-hemisphere/full-sphere grids tested here;
this peak argument is not a guarantee for an arbitrary partial θ request.
Scouts need not coincide with the requested grid nodes. The reported error
norm and `tailBoundRelative` therefore use the actual reference-grid peak;
a production contract tied strictly to that sampled peak should scout a
subset of the requested nodes.
The analytic budget leaves headroom for binary64 evaluation, recurrences,
summation, and the existing legacy-vs-tile π discrepancy. It does not itself
bound roundoff under arbitrarily ill-conditioned cancellation.

## Prototype implementation

[`ring.hpp`](../bench/ring-far-field/ring.hpp) includes the unchanged
standalone C++ tile kernel and only adds bench-local functions. It copies
and horizontally centers the snapshot, evaluates sparse rings, calculates
an ordinary complex DFT, and synthesizes the requested φ samples with
rotation recurrences reseeded every 32 samples. M is odd; target φCount can
be arbitrary. Both complex polarizations are interpolated, then the common
centroid phase is restored. Results are scattered back to the original
theta-fast order.

A ring with M≥phiCount uses the unchanged direct kernel on original
coordinates. Nonperiodic φ requests use an all-direct fallback. Memory is
O(output directions + segments + phiCount + M); no dense segment-by-direction
matrix is built. Runtime is
`O(segments*images*ΣM + ΣM² + phiCount*ΣM)` plus scout work. DFT and synthesis
are deliberately single-threaded and use no external FFT dependency.
A prime-sized grid, nonzero φ origin, full sphere, zero currents, tiny grids,
nonperiodic fallback and deterministic repetition are covered by the
standalone test in both native and WASM builds.

## Counts and speed

Ring counts include all 72 scout directions; contributions multiply counts
by physical segments and image count. Count ranges reflect the two drives'
slightly different source-norm/error budgets. Output directions are unchanged.

<!-- BEGIN counts -->
| Case | Ring directions incl. scouts | Ring segment/image contributions | Direction reduction (minimum) | Max L | Max L_seg | Fallback rings |
| --- | --- | --- | --- | --- | --- | --- |
| regular4 | 1,756–1,760 | 618,112–619,520 | 3.20× | 28 | 0 | 0 |
| regular8 | 5,258–5,264 | 7,403,264–7,411,712 | 4.56× | 43 | 0 | 0 |
| regular16 | 16,265–16,269 | 91,604,480–91,627,008 | 6.15× | 69 | 0 | 0 |
| sunflower256 | 17,379–17,381 | 97,878,528–97,889,792 | 7.97× | 62 | 0 | 0 |
| free4 | 1,756 | 309,056 | 3.20× | 28 | 0 | 0 |
| heights4 | 1,762–1,766 | 620,224–621,632 | 3.18× | 28 | 0 | 0 |
| tilted4 | 1,960–1,962 | 689,920–690,624 | 2.87× | 31 | 2 | 0 |
<!-- END counts -->

Retained-state medians, milliseconds. Stateful direct is the production
`computeFarField` C++ path; tile direct is the existing standalone kernel
used by the prototype. Ring time includes snapshot copying/centering,
scouting, tail selection, sparse direct evaluation, DFT, synthesis,
restoration, and output allocation. Capturing the shared snapshot from the
model is outside **both** standalone field timings; solver work is outside
all three. No browser, message-transfer, or worker-pool acceleration is
included. Comparison against tile direct isolates the interpolation benefit
from the two direct kernels' different costs.

<!-- BEGIN speed -->
| Case | Runtime | Stateful direct ms | Tile direct ms | Ring ms | Vs stateful | Vs tile |
| --- | --- | --- | --- | --- | --- | --- |
| regular4 | native | 68.744 | 60.479 | 20.362 | 3.38× | 2.97× |
| regular4 | wasm | 110.564 | 64.125 | 22.650 | 4.88× | 2.83× |
| regular8 | native | 1177.236 | 1034.500 | 235.313 | 5.00× | 4.40× |
| regular8 | wasm | 1975.841 | 1111.493 | 259.776 | 7.61× | 4.28× |
| regular16 | native | 19446.392 | 17177.345 | 2863.201 | 6.79× | 6.00× |
| regular16 | wasm | 34544.604 | 19332.464 | 3265.709 | 10.58× | 5.92× |
| sunflower256 | native | 27526.747 | 24488.863 | 3130.878 | 8.79× | 7.82× |
| sunflower256 | wasm | 48078.559 | 26848.124 | 3497.494 | 13.75× | 7.68× |
| free4 | native | 34.060 | 30.148 | 11.105 | 3.07× | 2.71× |
| free4 | wasm | 55.450 | 32.328 | 12.830 | 4.32× | 2.52× |
| heights4 | native | 69.189 | 60.919 | 20.551 | 3.37× | 2.96× |
| heights4 | wasm | 110.572 | 65.160 | 22.857 | 4.84× | 2.85× |
| tilted4 | native | 69.831 | 60.963 | 23.511 | 2.97× | 2.59× |
| tilted4 | wasm | 110.375 | 63.695 | 25.287 | 4.36× | 2.52× |
<!-- END speed -->

## Accuracy and radiated power

Normalize ΔEθ and ΔEφ by the global peak
`max sqrt(|Eθ|²+|Eφ|²)` of the stateful exact output. Maxima span every grid
point, both drives, three fresh models, and both runtimes. The worst ring
columns are θ coordinates of the largest component error, not a local
relative error near a null. A second table also provides normalization by
each component's own global peak; an identically zero Eφ has zero absolute
error and is reported as zero rather than a 0/0 ratio.

<!-- BEGIN accuracy -->
| Case | Max ΔEθ / vector peak | Max ΔEφ / vector peak | Ring vs tile / peak | Max \|Δclosure\| | Worst θ ring (Eθ) | Worst θ ring (Eφ) |
| --- | --- | --- | --- | --- | --- | --- |
| regular4 | 2.817e-11 | 0.000e+00 | 2.503e-15 | 1.272e-11 | 87.567568° | all zero |
| regular8 | 2.514e-11 | 0.000e+00 | 2.760e-15 | 1.952e-11 | 46.753247° | all zero |
| regular16 | 3.215e-11 | 0.000e+00 | 3.996e-15 | 2.367e-11 | 19.367089° | all zero |
| sunflower256 | 2.919e-11 | 0.000e+00 | 5.664e-15 | 1.372e-11 | 19.354839° | all zero |
| free4 | 2.865e-11 | 0.000e+00 | 2.694e-15 | 1.970e-11 | 55.945946° | all zero |
| heights4 | 3.290e-11 | 0.000e+00 | 2.926e-15 | 1.547e-11 | 87.567568° | all zero |
| tilted4 | 2.752e-11 | 3.854e-11 | 3.105e-15 | 2.475e-11 | 48.648649° | 63.243243° |
<!-- END accuracy -->

Power is the trapezoidal θ / periodic φ sum of
`(|Eθ|²+|Eφ|²) sinθ /(2η)` at R=1. `closure=Pflux/PNEC` uses the current
solution's native radiated power. The free4 geometry has all vertical wires
at the same height, so intensity in the lower hemisphere is a reflection
of the upper hemisphere and its integral is doubled. No such doubling is
applied to PEC. Both methods use identical quadrature: the difference tests
the evaluator, not quadrature convergence or NEC's discretization error.

<!-- BEGIN closure -->
| Case | Direct Pflux / PNEC range | ΔEθ / Eθ peak | ΔEφ / Eφ peak | Direct tile vs stateful / vector peak |
| --- | --- | --- | --- | --- |
| regular4 | 0.997438722–0.997582327 | 2.817e-11 | 0.000e+00 | 2.817e-11 |
| regular8 | 0.996466104–0.996787546 | 2.514e-11 | 0.000e+00 | 2.514e-11 |
| regular16 | 0.995622847–0.996175861 | 3.215e-11 | 0.000e+00 | 3.215e-11 |
| sunflower256 | 0.996130450–0.996491249 | 2.919e-11 | 0.000e+00 | 2.919e-11 |
| free4 | 0.997842203–0.997868513 | 2.865e-11 | 0.000e+00 | 2.865e-11 |
| heights4 | 0.997254168–0.997370675 | 3.290e-11 | 0.000e+00 | 3.290e-11 |
| tilted4 | 0.997078537–0.997088866 | 4.247e-11 | 4.611e-11 | 3.854e-11 |
<!-- END closure -->

Direct and ring closure values agree at all nine decimal places shown in
the table; the summarizer checks this for every observation.

The repository does not define a public formatted “closure precision”. Its
existing WP3 power tests allow 0.4% for their free-space fixture and 0.2% for
their PEC monopole fixture (`src/nec_stateful_model_wp3_tb.cpp`). Those are
different geometries, not accuracy promises for these arrays. Reported
closure changes here should be compared with those tolerances and with the
raw direct/ring values; no claim is made about the unavailable visualizer's
number formatting. Existing power-budget outputs are never recomputed or
modified by this prototype.

## Original integration proposal (bench-only commit)

Expose a separate, explicit opt-in evaluator identity, for example
`ring-bandlimited-binary64-v1`, with an approximation tolerance and reported
actual source-norm/tail budget, sparse direction count, fallback count, and
reference evaluator identity. Existing `fieldBackend.backend` distinguishes
`serial` and `worker-pool`, not mathematical evaluator accuracy; preserve
that distinction rather than overloading it. Keep the current request behavior, evaluator
identity, direct binary64 outputs, and all NEC-derived goldens unchanged.
Do not relabel interpolation as “exact binary64”. An optional future request
flag could select that evaluator, but a new result metadata identity is
still needed so caches and callers cannot confuse methods.

Start with ordinary wires, free space/PEC, complete periodic φ rings and
explicit supported θ domains. Preserve direct fallback for unsupported
ground, patches, nonperiodic tiles, insufficient savings, or unusable error
budgets. A production implementation should validate finite conditioning,
guard cutoff growth, handle extreme cancellation, and define the requested
error norm before promising a tolerance. General worker tiles currently
cut through rings in theta-fast order; a ring job planner or gather/scatter
layer is needed. Each output must be associated with the same solution and
job generation as the existing snapshot protocol.

For the consumer, keep all NEC-derived reference generation and current
exact golden tests on the exact path. Add separate tolerance-based tests
for the opt-in evaluator, including complex phases, both polarizations,
nulls, ring boundaries, translated arrays, and power integration. Changing
the π constants is a separate compatibility decision and is not necessary
for this optimization. Validate the actual consumer auto-grid, current-drive
setup costs, browser behavior and worker scheduling before shipping.

## Original analysis reproduction

These commands reproduce the bench-only analysis at commit `970d1ed`. For the
current source tree, use the production integration commands below; the current
harness calls the shared production kernel.

Prerequisites: Python 3, g++, Node ≥24, an Emscripten 4.0.10 SDK, and the
repository's already-built 0.7.1 package for the initial package probe.
No Python or FFT packages are required. From the repository root:

```sh
# Optional initial public-package profile (4x4, 8x8, 16x16, sunflower256).
node bench/ring-far-field/profile-package.mjs > /tmp/ring-package.ndjson

# Optional inspection of the shipped artifact (used for the SIMD check).
/tmp/emsdk-4.0.10/upstream/bin/wasm-dis \
  packages/necpp-wasm/src/nec2pp.wasm -o /tmp/ring-package.wat
node packages/necpp-wasm/bench/inspect-far-field-wasm.mjs \
  --generated-js packages/necpp-wasm/src/nec2pp.generated.js \
  --wat /tmp/ring-package.wat --output /tmp/ring-package-inspection.json

# Build outside the checkout; supply your SDK path for em++.
python3 bench/ring-far-field/build.py --out /tmp/ring-native
python3 bench/ring-far-field/build.py \
  --compiler /tmp/emsdk-4.0.10/upstream/emscripten/em++ \
  --wasm --out /tmp/ring-wasm

# Run accuracy/edge-case tests in each runtime.
g++ -std=c++17 -O3 -Isrc -Isrc/eigen -I/tmp/ring-native \
  bench/ring-far-field/test.cpp -o /tmp/ring-test
/tmp/ring-test
/tmp/emsdk-4.0.10/upstream/emscripten/em++ -std=c++17 -O3 \
  -fexceptions -sDISABLE_EXCEPTION_CATCHING=0 \
  -Isrc -Isrc/eigen -I/tmp/ring-wasm \
  bench/ring-far-field/test.cpp -o /tmp/ring-test.js
node /tmp/ring-test.js

# Run after builds/probes finish; no concurrent native/WASM measurements.
python3 bench/ring-far-field/run.py \
  --native /tmp/ring-native/bench --wasm /tmp/ring-wasm/bench.js \
  --out /tmp/ring-evidence --rounds 3
python3 bench/ring-far-field/summarize.py /tmp/ring-evidence

# Regenerate this report's tables from the committed observations.
python3 bench/ring-far-field/summarize.py \
  bench/ring-far-field/evidence docs/ring-far-field-evaluation.md
```

One-case smoke commands: `/tmp/ring-native/bench tilted4 1` and
`node /tmp/ring-wasm/bench.js regular4 1`. All changes live in this report
and `bench/ring-far-field/`; there is no production build-system hook.

## Production integration (unreleased)

The implementation on `feat/ring-far-field-evaluator` promotes the shared C++
kernel behind an additive opt-in selection. The original tables above remain
archival evidence from the bench-only commit `970d1ed`; the tables below measure
the production integration using **Emscripten 4.0.7**, the repository's pinned
release compiler. The package now targets **0.8.0**; the measurements below were
recorded before the metadata-only version bump. No published artifact, visualizer
dependency, exact default, or NEC golden is changed by this integration.

**Go for opt-in integration.** The large-array stateful WASM comparisons improve
by 6.76× (regular 16×16) and 8.91× (256-element sunflower); the two-worker
comparisons improve by 5.64× and 7.54×. All 154 scalar, worker, embedded, and
packed-field comparisons meet the `1e-7` target. Their largest observed component
error relative to the reference field peak is `5.389e-10`. All 84 scalar
radiated-power closure comparisons agree to nine decimal places. This supports
the explicit approximation option while leaving the exact contract intact.

### Compatibility and implementation

Set `farFieldEvaluator: "ring"` on `createNecModel`, `createNecWorkerModel`, or
`createNecArraySolver`; use `evaluator: "exact"` on any field request to override
it. Existing options and exact ABI entry points continue to select the existing
code. Request axes, radius, complex-array ownership, theta-fast order, basis-major
embedded layout, port order, and normalization are preserved. The array facade
applies its symmetry-origin phase once, independently of the ring kernel's own
horizontal centroid phase.

The policy covers ordinary fields, both embedded normalizations, and embedded
fields produced by isolated-element characterization. Unit-current modes are
formed before evaluation, so an impedance-matrix multiplication cannot amplify
already interpolated voltage-basis errors. Internal basis solves restore the
consumer state and retain the factorization. The packed NECF/NECQ schemas and
quadrature values are unchanged. Evaluator provenance travels alongside NECF
buffers, including MessagePort handoffs; applications saving bare buffers should
also save the sidecar.

`fieldEvaluation` identifies `ring-bandlimited-v1`, reports actual `ring`, `mixed`,
or `exact` execution, counts interpolated/direct rings and direct directions
(including scouts), and reports an absolute analytical truncation bound. This is
separate from `fieldBackend`. The bound excludes floating-point error and the
legacy-versus-tile kernel discrepancy described above. Embedded counts sum across
bases; their bound is the largest per-basis bound. Exact requests retain their
previous result shape.

The dedicated WASM ABI creates a geometry context, creates a deterministic plan,
and evaluates one ring at a time. The full model uses the same kernel and caches
geometry by factorization generation. Both reuse centered coordinates and
interpolation scratch; the native serial path also caches theta trigonometry.
Current norms, scout peaks, and cutoffs are recomputed for every solution/basis.
The exact kernels and their differing pi constants have not been altered.

Workers receive complete rings and scatter results back into the original array
layout. One shared plan makes results independent of worker count and assignment.
Generation fencing, restart, current-only snapshot updates, and cancellation
remain supported. Cancellation cannot interrupt synchronous WASM within a ring;
its stale result is discarded. Automatic scheduling limits active workers using
the planned sparse contribution count, though startup still provisions the
existing configured pool size. Embedded basis solves remain sequential.

### Changes from the research prototype

The mathematical bound and `L_seg` derivation above still apply. Production uses
up to 9 × 8 **distinct requested-grid nodes** for scouts, making the measured peak
a lower bound on the requested grid's peak, including partial theta sweeps.
Only x/y are recentered. Cutoff searches stop before allocating an order larger
than the requested azimuth grid. Nonperiodic grids, unsupported models, invalid
numerical budgets, and rings without a useful reduction fall back to the original
backend's direct evaluator. Invalid public inputs still produce input errors.

A deterministic cost filter additionally requires
`segments * images * (P-M) > M*(M+P)/8` before interpolation. This is a conservative
work estimate, not an accuracy condition or a hardware-dependent timing fit.
A preliminary minimum-order check avoids scouting when no ring could pass it.
A separate roundoff-scale screen falls back when
`32*epsilon_binary64*(1 + 2*pi*coordinateScale + angleScale)*W/P0 > 1e-8`.
It guards extreme translations/angle arguments and cancellation; it is not a
proof of total binary64 error. The fixed engineering acceptance target remains
`1e-7`, with the much tighter analytical budget from the derivation.

### Production measurements

Evidence is in `bench/ring-far-field/evidence/production/`. The native/WASM harness
runs the same seven geometries, three fresh models and two drive states per model,
serially. Its `ringMs` measures the shared standalone kernel; `integratedRingMs`
also includes the stateful adapter and geometry-cache behavior. The integrated
result is checked against the shared kernel for every observation. Preparation,
module/process startup, and snapshot capture are excluded from field timings.

The package worker comparison uses the full original grids and two workers;
worker startup and initial snapshot broadcast are excluded from the reported
field wall times. Embedded comparisons use the same geometries on a compact
3 × 181 grid (theta 0/45/90 degrees, phi starting at 13 degrees). This keeps the
256-port basis output practical while exercising all normalized bases and both
polarizations. Those timings include the existing basis-solving/matrix work;
they are not isolated interpolation timings. Characterization checks compare
packed fields and require identical quadrature bytes.

<!-- BEGIN production -->
**NATIVE: retained-drive median field times (ms).**

| Case | Stateful exact | Stateful ring | Speedup | Tile exact | Ring kernel | Speedup |
| --- | --- | --- | --- | --- | --- | --- |
| regular4 | 68.451 | 19.985 | 3.43× | 59.441 | 20.124 | 2.95× |
| regular8 | 1167.102 | 229.504 | 5.09× | 1007.467 | 230.198 | 4.38× |
| regular16 | 19404.755 | 2793.899 | 6.95× | 16751.557 | 2798.107 | 5.99× |
| sunflower256 | 27428.972 | 3045.507 | 9.01× | 23809.683 | 3054.729 | 7.79× |
| free4 | 34.229 | 10.826 | 3.16× | 29.491 | 11.062 | 2.67× |
| heights4 | 68.764 | 20.065 | 3.43× | 59.625 | 20.270 | 2.94× |
| tilted4 | 69.186 | 23.006 | 3.01× | 59.606 | 23.108 | 2.58× |

**WASM: retained-drive median field times (ms).**

| Case | Stateful exact | Stateful ring | Speedup | Tile exact | Ring kernel | Speedup |
| --- | --- | --- | --- | --- | --- | --- |
| regular4 | 74.716 | 22.392 | 3.34× | 64.421 | 22.566 | 2.85× |
| regular8 | 1296.709 | 278.561 | 4.66× | 1958.165 | 260.923 | 7.50× |
| regular16 | 22335.282 | 3303.754 | 6.76× | 19509.232 | 3282.690 | 5.94× |
| sunflower256 | 31242.041 | 3504.962 | 8.91× | 27182.913 | 3507.652 | 7.75× |
| free4 | 37.269 | 12.505 | 2.98× | 32.467 | 12.464 | 2.60× |
| heights4 | 74.853 | 23.209 | 3.23× | 64.767 | 22.493 | 2.88× |
| tilted4 | 74.728 | 25.151 | 2.97× | 65.057 | 25.118 | 2.59× |

**Accuracy and work counts across both runtimes and both drive states.**

| Case | Segments | Output directions | Direct contributions | Ring directions incl. scouts | Ring contributions | Max ΔEθ / peak | Max ΔEφ / peak | Max closure change | Worst ring θ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| regular4 | 176 | 38×148=5,624 | 1,979,648 | 1,756–1,760 | 618,112–619,520 | 2.817e-11 | 0.000e+00 | 1.272e-11 | 87.5676° |
| regular8 | 704 | 78×308=24,024 | 33,825,792 | 5,256–5,274 | 7,400,448–7,425,792 | 2.514e-11 | 0.000e+00 | 1.952e-11 | 46.7532° |
| regular16 | 2816 | 159×629=100,011 | 563,261,952 | 16,299–16,299 | 91,795,968–91,795,968 | 3.215e-11 | 0.000e+00 | 2.367e-11 | 19.3671° |
| sunflower256 | 2816 | 187×741=138,567 | 780,409,344 | 17,387–17,391 | 97,923,584–97,946,112 | 2.919e-11 | 0.000e+00 | 1.372e-11 | 19.3548° |
| free4 | 176 | 38×148=5,624 | 989,824 | 1,756–1,756 | 309,056–309,056 | 2.865e-11 | 0.000e+00 | 1.970e-11 | 55.9459° |
| heights4 | 176 | 38×148=5,624 | 1,979,648 | 1,762–1,766 | 620,224–621,632 | 3.290e-11 | 0.000e+00 | 1.547e-11 | 87.5676° |
| tilted4 | 176 | 38×148=5,624 | 1,979,648 | 1,960–1,960 | 689,920–689,920 | 2.752e-11 | 3.854e-11 | 2.475e-11 | 63.2432° |

All 84 closure comparisons agree to nine decimal places.

**Packaged WASM, two workers: median field wall times (ms), full grids.**

| Case | Exact pool | Ring pool | Speedup | Ring directions | Max component error / peak |
| --- | --- | --- | --- | --- | --- |
| regular4 | 36.653 | 16.039 | 2.29× | 1756 | 2.089e-15 |
| regular8 | 591.469 | 159.390 | 3.71× | 5256 | 2.665e-15 |
| regular16 | 9903.456 | 1755.462 | 5.64× | 16299 | 4.029e-15 |
| sunflower256 | 16320.025 | 2163.884 | 7.54× | 17387 | 4.574e-15 |
| free4 | 21.077 | 9.135 | 2.31× | 1756 | 2.709e-15 |
| heights4 | 49.905 | 19.181 | 2.60× | 1762 | 2.517e-15 |
| tilted4 | 44.673 | 24.004 | 1.86× | 1960 | 2.854e-15 |

**Packaged embedded fields: median total call times (ms), compact 3×181 grid.**

| Case | Unit V exact | Unit V ring | Unit I exact | Unit I ring | Bases | Max error incl. packed fields |
| --- | --- | --- | --- | --- | --- | --- |
| regular4 | 115.717 | 26.077 | 119.053 | 29.240 | 16 | 1.330e-10 |
| regular8 | 1868.828 | 554.879 | 1978.829 | 652.987 | 64 | 2.767e-10 |
| regular16 | 35210.020 | 18042.270 | 35258.228 | 18092.234 | 256 | 5.389e-10 |
| sunflower256 | 35328.823 | 16996.094 | 35501.681 | 17064.309 | 256 | 4.869e-10 |
| free4 | 56.991 | 14.520 | 60.207 | 17.779 | 16 | 1.441e-10 |
| heights4 | 114.702 | 25.638 | 118.699 | 28.665 | 16 | 1.323e-10 |
| tilted4 | 119.486 | 30.408 | 124.394 | 33.602 | 16 | 1.239e-10 |

All seven characterization comparisons preserved quadrature bytes and consumer solution generation.
<!-- END production -->

### Verification and reproduction

The implementation passed all eight native CTest groups, all 160 package tests,
TypeScript checking, and all six tarball-consumer tests (including compilation of
the README examples). Browser checks passed for ring workers, exact workers, and
packed characterization transfer without cross-origin isolation. The dedicated
evaluator WASM is 43,793 bytes and its loader is 13,171 bytes, within the existing
64 KiB budgets. Existing goldens and recorded quadrature baselines are unchanged.

The regression gates cover unchanged exact/default behavior and goldens;
free/PEC fields; arbitrary and prime phi counts; nonzero phi origins; partial and
full theta domains; zero and very small currents; tilted and varying-height wires;
translated symmetry; both embedded normalizations and superposition; state
restoration; geometry-cache invalidation; unsupported-ground and missing-ABI
fallback; worker count determinism, restart, cancellation, and current-only
updates; packed provenance and transfer; tarball consumers; and browser workers
without cross-origin isolation.

Build the package artifacts with the existing pinned Docker build:

```sh
scripts/build_wasm_docker.sh
npm --prefix packages/necpp-wasm run build
npm --prefix packages/necpp-wasm test
npm --prefix packages/necpp-wasm run test:pack
npm --prefix packages/necpp-wasm run test:ring-browser
npm --prefix packages/necpp-wasm run test:field-worker-browser
npm --prefix packages/necpp-wasm run test:current-quadrature-browser

cmake -S . -B /tmp/necpp-ring-native -DBUILD_SHARED_LIBS=OFF -DNECPP_BUILD_TESTS=ON
cmake --build /tmp/necpp-ring-native -j3
ctest --test-dir /tmp/necpp-ring-native --output-on-failure
```

For the same scalar paired harness measurements, activate Emscripten **4.0.7**
and run these commands sequentially, with no other builds or benchmarks running:

```sh
python3 bench/ring-far-field/build.py --out /tmp/ring-production-native --jobs 3
python3 bench/ring-far-field/build.py --compiler em++ --wasm \
  --out /tmp/ring-production-wasm --jobs 3
python3 bench/ring-far-field/run.py \
  --native /tmp/ring-production-native/bench \
  --wasm /tmp/ring-production-wasm/bench.js \
  --out bench/ring-far-field/evidence/production --rounds 3
node bench/ring-far-field/package-production.mjs workers 3 \
  > bench/ring-far-field/evidence/production/workers.ndjson
node bench/ring-far-field/package-production.mjs embedded 3 \
  > bench/ring-far-field/evidence/production/embedded.ndjson
python3 bench/ring-far-field/summarize-production.py
```

No default flip or golden rebaseline is proposed. Publication and updating the
visualizer's vendored tarball are separate rollout steps; a consumer can opt in
with one configuration field and override any comparison request back to exact.
