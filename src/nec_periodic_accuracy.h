#pragma once
// The accuracy policy of the periodic (infinite-array) solver. One fixed
// tolerance governs it: every scan impedance carries an estimated error, and
// a configuration whose estimate exceeds the tolerance is refused with a
// reason, never loosened. Nothing here is exposed as a parameter.
//
// The estimated error covers the solver's numerics, relative to the largest
// scan-impedance entry: the Ewald kernel, the Gauss rule over each source
// segment and the rounding near a Wood anomaly. Thin-wire modelling error is
// not included; in particular, NEC's thin-wire kernel (used for close images)
// and the filament of the smooth kernel (used for the other images) differ by
// about k a^2 / (2 d), which reaches 1e-5 to 3e-4 for tightly packed or thick
// wires. See docs/periodic-floquet-evaluation.md, issue #25.
#include <algorithm>
#include <cmath>

namespace nec_periodic {
// Largest estimated error of a result.
constexpr double tolerance = 1e-5;

// The Ewald kernel, as measured by the kernel tests against a direct lattice
// sum and the spectral series.
constexpr double kernel_error = 1e-10;

// The default Gauss rule over a source segment of the given length in
// wavelengths. Measured on lattices of 0.5, 1 and 3 wavelengths: at most
// 2e-11 up to a tenth of a wavelength, then growing like length^10 (fastest
// in small cells); this bound is at least four times the measurement.
inline double gauss_error(double length) {
  return 1e-10 * std::max(1.0, std::pow(length / 0.1, 10));
}

// Work bound of the spectral sum: the Floquet modes of one kernel evaluation.
// The kernel keeps its accuracy by widening the spectral sum as the cell
// grows (about 31 modes per square wavelength above a few wavelengths), so a
// larger cell cannot reach the tolerance within this bound.
constexpr double max_spectral_modes = 10000;
}
