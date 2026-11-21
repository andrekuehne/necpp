# NEC2++

A method-of-moments wire antenna engine (NEC-2 lineage) with a stateful multi-port model and a WASM/TypeScript package. This glossary covers port quantities and the periodic (infinite-array) extension.

## Ground

**Finite ground**:
A ground half-space below `z = 0` with finite conductivity and permittivity. Infinite in extent, like perfect ground.
_Avoid_: lossy ground, real ground; never use for a ground plate of finite size

## Ports and drives

**Active impedance**:
The ratio `V_i / I_i` at one port while all ports are driven with one specific set of voltages or currents. One value per port per drive.
_Avoid_: input impedance (when other ports are driven), scan impedance

## Periodic arrays

**Lattice**:
The set of in-plane translations under which an infinite array repeats. Always lies in a plane parallel to xy. One of five types: square, rectangular, centered rectangular, hexagonal, oblique.
_Avoid_: grid (except in "triangular grid" when quoting array literature)

**Lattice vectors**:
The two in-plane vectors `a1`, `a2` that generate the lattice, as chosen by the user. Their choice fixes the meaning of the scan phases.
_Avoid_: basis vectors, primitive vectors

**Hexagonal lattice**:
The lattice whose lattice vectors have equal length at 60°. Array literature calls it the equilateral triangular grid. A honeycomb arrangement is not a lattice: it is a hexagonal lattice with two elements per unit cell.
_Avoid_: triangular lattice, honeycomb lattice

**Unit cell**:
The conductors, ports and loads that repeat at every lattice point. May contain any number of elements and ports.
_Avoid_: element (one radiator; a unit cell can hold several), reference element

**Periodic image**:
The copy of a unit-cell conductor in another cell of the infinite array, displaced by a lattice translation. Not the ground image of a conductor over perfect ground.

**Close image**:
A periodic image of a source segment near enough to an observation point that it is evaluated with the finite model's thin-wire kernel rather than the smooth part of the periodic Green's function. Chosen per observation point and source segment.
_Avoid_: near image, image ring

**Estimated error**:
The numerical error a periodic result carries in its diagnostics, relative to the largest scan-impedance entry: periodic Green's function, quadrature and rounding near a Wood anomaly. Thin-wire modelling error is not included.
_Avoid_: accuracy, error bound

**Periodic tolerance**:
The one fixed internal tolerance (1e-5) that governs the periodic solver. A configuration whose estimated error would exceed it is refused with a reason, never solved with a looser one; there are no numerical parameters in the API.
_Avoid_: precision setting, truncation parameter

**Point status**:
How one periodic result relates to the periodic tolerance, reported with its estimated error. Every returned result is within the tolerance: `near-cutoff` on or near a Wood anomaly (a Floquet mode within `|kz| < 1e-3 k` of cut-off, split out of the kernel), otherwise `ok`.

**Clearance**:
The separation between the unit cell's conductors and the periodic images of all of them. A lattice under which a conductor touches or nearly touches a periodic image is refused: that would be a connected array.
_Avoid_: distance to the cell wall (no unique shape for a non-rectangular lattice)

**Connected array**:
An infinite array whose conductors join their periodic images, so current crosses from cell to cell (tightly coupled dipoles, wire grids). Not supported.

**Scan state**:
The common transverse wavevector of an infinite array's excitation, which fixes the phase relation between all cells. Expressed either as scan phases or, within visible space, as a scan direction.

**Scan phases**:
The excitation phase steps `(psi1, psi2)` between neighbouring cells along `a1` and `a2`. The primary way to state a scan state; they also cover invisible space.
_Avoid_: inter-element phases (ambiguous with several elements per cell)

**Scan direction**:
The angles `(theta, phi)` of the main beam that correspond to a scan state in visible space. A convenience equivalent of the scan phases.

**Scan impedance** / **Scan admittance**:
The P x P port impedance / admittance matrix of the unit cell inside the infinite array, at one scan state and frequency. Consumers of the package may use other words for it.
_Avoid_: active impedance, active admittance, periodic impedance

**Scan sweep**:
Many scan states at one frequency in one request, solved on a pool of workers that each hold a copy of the unit cell, and delivered in chunks as they finish.

**Floquet mode**:
One of the discrete plane waves, indexed `(p, q)` on the reciprocal lattice and split into TE and TM with respect to z, into which the field above or below an infinite array decomposes. Either propagating or evanescent.
_Avoid_: grating lobe (that is only a propagating Floquet mode other than (0,0))

**Floquet port**:
A plane parallel to the lattice, clear of all conductors, on which Floquet-mode amplitudes are defined.

**Floquet-mode amplitude**:
The TE and TM amplitude of one Floquet mode radiated by the unit cell when one port is driven at unit voltage (others shorted) or unit current (others open), power-normalized so that a propagating mode carries half its squared magnitude in watts per cell.

**Terminated amplitude**:
A Floquet-mode amplitude with every port terminated in a generator impedance and one port driven with 1 W of available power, derived from the raw amplitudes and the scan impedance.
_Avoid_: realized amplitude

**Wood anomaly**:
A scan state and frequency at which one Floquet mode grazes the lattice plane (`kz = 0`): the boundary where a grating lobe appears or disappears.
_Avoid_: Rayleigh anomaly, grating-lobe onset (as a noun for the singular point)

**Wood circle**:
The Wood anomalies of one Floquet mode at one frequency, seen in the plane of the scan wavevector: the circle of radius `k` around that mode's reciprocal-lattice point. The scan impedance has a square-root kink along it, so sampling and interpolation should not cross it.

**Scan element pattern**:
The far-field pattern of one unit-cell port inside the infinite array, with the other ports shorted or open. In each direction it equals the (0,0) Floquet-mode amplitude at the scan state pointing that way.
_Avoid_: embedded pattern (reserved for finite models), active element pattern

**Interpolation error**:
What a scan element pattern states for a direction between its sweep points: an estimate from leave-one-out errors and the spread of alternative interpolants, not a bound. Adaptive refinement adds sweep points where it exceeds a tolerance.
_Avoid_: estimated error (that is the solver's, of one periodic result)

**Scan blindness**:
A scan state at which the scan element pattern drops to (nearly) zero because a guided wave along the array or its layered stacks is phase-matched to a Floquet mode.

**Windowed array**:
A finite block of driven elements inside an infinite array whose remaining elements are present and terminated. Its pattern is exactly the array factor times the scan element pattern.
_Avoid_: finite array (that has no elements outside the block)

**Layered stack**:
A region above or below the wires made of layers that are uniform in the lattice plane (radome, substrate, finite ground). It acts on each Floquet mode only through a TE and a TM reflection coefficient.
