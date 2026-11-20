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
#include <vector>

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
  vec2 a1() const { return a1_; }
  vec2 a2() const { return a2_; }
  // Reciprocal vectors of the given lattice vectors: a_i . b_j = 2 pi delta_ij.
  vec2 b1() const { return b1_; }
  vec2 b2() const { return b2_; }
  // Reduced lattice vectors (shortest first) and their reciprocal vectors.
  vec2 reduced_a1() const { return reduced_a1_; }
  vec2 reduced_a2() const { return reduced_a2_; }
  vec2 reduced_b1() const { return reduced_b1_; }
  vec2 reduced_b2() const { return reduced_b2_; }

private:
  vec2 a1_, a2_;
  vec2 b1_, b2_;  // reciprocal to the given lattice vectors: a_i . b_j = 2 pi delta_ij
  vec2 reduced_a1_, reduced_a2_, reduced_b1_, reduced_b2_;
  double area_ = 0;
};

struct green_value {
  complex_d value;
  std::array<complex_d, 3> gradient;  // with respect to the observation point
};

// A Floquet mode kt = kt0 + p b1 + q b2, indexed along the reciprocal vectors
// of the given lattice vectors, with |kz| / |k| (zero at cut-off).
struct floquet_cutoff {
  long p = 0, q = 0;
  double kz_over_k = 0;
};

// A Floquet mode kt = kt0 + p b1 + q b2, indexed along the reciprocal vectors
// of the given lattice vectors, with kz = sqrt(k^2 - kt^2), Im kz <= 0.
struct floquet_mode {
  long p = 0, q = 0;
  vec2 kt;
  complex_d kz;
};

// Floquet modes with |kz| below this fraction of |k| are split out of the
// spectral sum (periodic_green::split_modes): the results that need them are
// on or near a Wood anomaly.
constexpr double near_cutoff = 1e-3;

// Periodic Green's function of one lattice, wavenumber and scan state,
// evaluated by Ewald splitting. Both sums are truncated by radius: the
// spatial sum over lattice points near the observation point, the spectral
// sum over Floquet modes with transverse wavevector |kt| below a bound.
//
// At a Wood anomaly (kz = 0 for some mode) the spectral sum is singular: the
// term of a mode tends to its singular part exp(-j kt . r) / (2 j A kz), A
// the cell area. The modes within near_cutoff_ratio |k| of cut-off are split
// out: smooth() and full() leave out their singular parts, which stay finite
// through and exactly on cut-off, and the caller adds the singular parts in a
// form that cancels 1 / kz (the matrix solve's low-rank update).
class periodic_green {
public:
  // k may be complex (Im k <= 0 for loss). splitting = 0 selects the Ewald
  // splitting parameter automatically; a positive value overrides it.
  periodic_green(const lattice_2d& lattice, complex_d k, vec2 scan_wavevector, double splitting = 0,
                 double near_cutoff_ratio = near_cutoff);
  double splitting() const { return splitting_; }
  const lattice_2d& lattice() const { return lattice_; }
  // G_p minus the free-space term of the origin cell, exp(-jkR)/(4 pi R) with
  // R = |r|, and minus the singular parts of the split modes. Finite
  // everywhere except at other lattice points.
  green_value smooth(const point& r) const;
  // G_p minus the singular parts of the split modes; singular at every
  // lattice point including the origin.
  green_value full(const point& r) const;
  // The modes with |kz| < near_cutoff_ratio |k|, whose singular parts smooth()
  // and full() leave out.
  const std::vector<floquet_mode>& split_modes() const { return split_modes_; }
  // The singular part exp(-j kt . r) / (2 j A kz) of a mode and its gradient;
  // needs kz != 0.
  green_value singular_part(const floquet_mode& mode, const point& r) const;
  // Number of Floquet modes in the spectral sum, the work of one evaluation
  // (estimated from the spectral radius and the cell area).
  double spectral_mode_count() const;
  // The Floquet mode nearest to cut-off, split or not.
  floquet_cutoff nearest_cutoff() const;

private:
  template <typename Visit> void for_each_mode(double radius, Visit visit) const;
  void add_spatial(const point& r, bool subtract_origin_free_term, green_value& sum) const;
  void add_spectral(const point& r, green_value& sum) const;
  bool is_split(complex_d kz) const { return std::abs(kz) < near_cutoff_ratio_ * std::abs(k_); }
  lattice_2d lattice_;
  complex_d k_;
  complex_d kappa_;  // k / (2 E), E the splitting parameter
  vec2 kt0_;
  double splitting_ = 0, spatial_radius_ = 0, spectral_radius_ = 0;
  double near_cutoff_ratio_ = 0;
  std::vector<floquet_mode> split_modes_;
  static constexpr int origin_series_terms = 8;
  complex_d origin_series_[origin_series_terms];  // f^(n)(0) / n!, n = 1, 3, ..., 15, of the origin term
};

// The free-space kernel exp(-jkR)/(4 pi R), R = |r| > 0, and its gradient.
green_value free_space_green(const point& r, complex_d k);

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

// Impedance in NEC's thin-wire segment field (eksc, ekscx): their fixed
// prefactor j 4.771341189 = j eta / (8 pi^2) gives eta = 376.73 ohm,
// independent of em::impedance() (about 376.7343). The periodic correction is
// added to that free-space fill, so it uses the same value.
constexpr double nec_segment_field_impedance =
  4.771341189 * 8 * 3.141592653589793238462643383279502884 * 3.141592653589793238462643383279502884;

// Integrals of NEC's current terms against the transverse phase of a Floquet
// mode over a straight segment:
//   int {1, sin(ks), cos(ks)} exp(j kt . (centre + s u)) ds,  -length/2 <= s <= length/2,
// with kt in the lattice plane (z does not enter). They couple a segment's
// current to the singular part of the mode.
struct floquet_moments {
  complex_d constant, sine, cosine;
};
floquet_moments segment_floquet_moments(const source_segment& segment, vec2 kt, double k);

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
