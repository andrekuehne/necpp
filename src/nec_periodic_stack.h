#pragma once
// A layered stack above or below the wires of a periodic unit cell (a radome,
// a substrate, finite ground), as one Floquet mode sees it: layers uniform in
// the lattice plane act on each mode only through a transmission line per
// polarization, TE or TM with respect to z (docs/periodic-floquet-evaluation.md,
// ADR 0001).
//
// The line's voltage is the tangential electric field. Its characteristic
// admittance is kz / k for TE and impedance kz / (eps k) for TM, so neither
// becomes infinite when a mode in air reaches cut-off (kz = 0). Time
// dependence exp(+jwt): a lossy layer has eps = eps_r (1 - j tan_delta), and
// every kz takes the branch Im(kz) <= 0.
#include <cmath>
#include <complex>
#include <limits>
#include <vector>

namespace nec_periodic {
using complex_d = std::complex<double>;

struct dielectric_layer {
  // In the length unit of 1 / k.
  double thickness = 0;
  // Relative permittivity (mu_r = 1).
  complex_d permittivity = 1.0;
};

enum class polarization { te, tm };

// With a stack present, a mode exactly at cut-off (kz = 0) is evaluated at the
// nearest representable state, |kz| = sqrt(eps) k: there the stack's terms
// nearly cancel the kernel's singular part, which is infinite at kz = 0.
inline complex_d stack_cutoff_kz(complex_d kz, double k) {
  return kz == complex_d(0.0, 0.0)
    ? complex_d(std::sqrt(std::numeric_limits<double>::epsilon()) * k, 0.0) : kz;
}

// What lies beyond the stack's far face: a half-space of the given
// permittivity (air by default; finite ground), or a perfect conductor.
struct stack_termination {
  complex_d permittivity = 1.0;
  bool perfect_conductor = false;
};

// One mode incident from the air on the stack's near face. A stack below the
// wires is the mirror image of one above, so both list their layers from the
// near face outward.
struct stack_response {
  // The reflected over the incident voltage, both at the near face.
  complex_d reflection;
  // The outgoing voltage at the far face over the incident one at the near
  // face, with air beyond the stack; equal to the field amplitude ratio,
  // since that air has the same kz as the air in front. Zero for any other
  // termination.
  complex_d transmission;
  // Power that does not come back, less what is transmitted into air: the
  // power left in the layers, and in a half-space beyond them all that
  // enters it. As a fraction of |a|^2 / 2 with a the incident wave's
  // power-normalized amplitude at the near face: for a propagating mode the
  // absorbed fraction of the incident power. Zero exactly at cut-off.
  double absorbed = 0;
};

// Layers from the near face outward. k is the wavenumber in air and kz the
// mode's sqrt(k^2 - |kt|^2) in air (Im(kz) <= 0), the caller's value, so that
// an exact cut-off stays exact.
stack_response stack_response_of(const std::vector<dielectric_layer>& layers,
  double k, complex_d kz, polarization mode, const stack_termination& beyond = {});
}
