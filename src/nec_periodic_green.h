#pragma once
// Periodic Green's function kernel for infinite 2D arrays. The matrix fill
// (nec_context::cmww) adds the field of G_smooth in periodic mode.
//
// Conventions (see docs/periodic-floquet-evaluation.md): time dependence
// exp(+jwt), free-space kernel exp(-jkR)/(4 pi R). The current in cell
// (m, n) equals the unit-cell current times exp(-j kt0 . rho_mn), with
// rho_mn = m a1 + n a2, so
//
//   G_p(r) = sum_mn exp(-j kt0 . rho_mn) exp(-jk R_mn) / (4 pi R_mn),
//   R_mn = | r - rho_mn |,
//
// where r is observation minus source. The lattice lies in a plane parallel
// to xy. Lengths and wavenumbers may use any consistent unit.
#include <array>
#include <complex>
#include <functional>

namespace nec_periodic {
using complex_d = std::complex<double>;
using point = std::array<double, 3>;

// exp(a) * erfc(z) for complex a and z, combined so that neither factor
// overflows on its own.
complex_d exp_erfc(complex_d a, complex_d z);
inline complex_d erfc_complex(complex_d z) { return exp_erfc(0.0, z); }

struct vec2 {
  double x = 0, y = 0;
};

// A lattice given by its two lattice vectors. Scan phases always refer to the
// vectors as given; sums run over Gauss-reduced lattice vectors that span the
// same lattice.
class lattice_2d {
public:
  // Throws std::invalid_argument for non-finite or (nearly) parallel vectors.
  lattice_2d(vec2 a1, vec2 a2);
  double cell_area() const { return area_; }
  // Transverse wavevector kt0 of the scan state with scan phases
  // psi_i = -kt0 . a_i along the given lattice vectors.
  vec2 scan_wavevector(double psi1, double psi2) const;
  // Reciprocal vectors of the given lattice vectors: a_i . b_j = 2 pi delta_ij.
  vec2 b1() const { return b1_; }
  vec2 b2() const { return b2_; }
  // Reduced lattice vectors (shortest first) and their reciprocal vectors.
  vec2 reduced_a1() const { return reduced_a1_; }
  vec2 reduced_a2() const { return reduced_a2_; }
  vec2 reduced_b1() const { return reduced_b1_; }
  vec2 reduced_b2() const { return reduced_b2_; }

private:
  vec2 b1_, b2_;  // reciprocal to the given lattice vectors: a_i . b_j = 2 pi delta_ij
  vec2 reduced_a1_, reduced_a2_, reduced_b1_, reduced_b2_;
  double area_ = 0;
};

struct green_value {
  complex_d value;
  std::array<complex_d, 3> gradient;  // with respect to the observation point
};

// Periodic Green's function of one lattice, wavenumber and scan state,
// evaluated by Ewald splitting. Both sums are truncated by radius: the
// spatial sum over lattice points near the observation point, the spectral
// sum over Floquet modes with transverse wavevector |kt| below a bound.
// At a Wood anomaly (kz = 0 for some mode) the spectral sum is singular.
class periodic_green {
public:
  // k may be complex (Im k <= 0 for loss). splitting = 0 selects the Ewald
  // splitting parameter automatically; a positive value overrides it.
  periodic_green(const lattice_2d& lattice, complex_d k, vec2 scan_wavevector, double splitting = 0);
  double splitting() const { return splitting_; }
  // G_p minus the free-space term of the origin cell, exp(-jkR)/(4 pi R) with
  // R = |r|. Finite everywhere except at other lattice points.
  green_value smooth(const point& r) const;
  // The full G_p; singular at every lattice point including the origin.
  green_value full(const point& r) const;

private:
  void add_spatial(const point& r, bool subtract_origin_free_term, green_value& sum) const;
  void add_spectral(const point& r, green_value& sum) const;
  lattice_2d lattice_;
  complex_d k_;
  complex_d kappa_;  // k / (2 E), E the splitting parameter
  vec2 kt0_;
  double splitting_ = 0, spatial_radius_ = 0, spectral_radius_ = 0;
  static constexpr int origin_series_terms = 8;
  complex_d origin_series_[origin_series_terms];  // f^(n)(0) / n!, n = 1, 3, ..., 15, of the origin term
};

// One straight source segment: centre, unit direction and length.
struct source_segment {
  point centre;
  point direction;
  double length = 0;
};

// Electric field at one observation point of a source segment carrying each
// of NEC's three current terms I(s) = 1, sin(ks), cos(ks), with s measured
// from the segment centre along its direction. With lengths in wavelengths
// and k = 2 pi this is NEC's segment-field normalization (exk..ezc).
struct segment_field {
  std::array<complex_d, 3> constant, sine, cosine;
};

// A Green's function kernel G(r), r = observation minus source point, with
// G including the 1/(4 pi) of exp(-jkR)/(4 pi R).
using kernel_function = std::function<green_value(const point&)>;

// Six points keep the quadrature error near 2e-11 for segments up to a
// tenth of a wavelength, below the Ewald kernel's own accuracy (1e-10).
constexpr int default_segment_gauss_order = 6;
constexpr int max_segment_gauss_order = 64;

// Field of a segment under a smooth kernel:
//   E = (-j eta / k) [ k^2 s_hat int I G ds' + int I' grad G ds' - (I grad G) at the ends ],
// grad with respect to the observation point, eta as in NEC's segment field
// (376.73 ohm). The end terms carry the charge at the segment ends (NEC's
// current terms are nonzero there). The integrals use a Gauss-Legendre rule of
// the given order (1 to max_segment_gauss_order), so the kernel must be
// smooth along the segment.
segment_field segment_field_of_kernel(const kernel_function& kernel, const source_segment& segment,
                                      const point& observation, double k,
                                      int gauss_order = default_segment_gauss_order);
}
