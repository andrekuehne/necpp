#include "nec_periodic_green.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <stdexcept>
#include <utility>

namespace nec_periodic {
namespace {
constexpr double pi = 3.141592653589793238462643383279502884;
const complex_d j(0.0, 1.0);

// Faddeeva function w(z) = exp(-z^2) erfc(-jz) for Im z >= 0, by Weideman's
// rational approximation (J.A.C. Weideman, "Computation of the complex error
// function", SIAM J. Numer. Anal. 31 (1994) 1497-1518):
//   w(z) = 2 p(Z) / (L - jz)^2 + (1/sqrt(pi)) / (L - jz),  Z = (L + jz)/(L - jz)
// with the polynomial coefficients from a cosine transform of
// exp(-t^2)(L^2 + t^2) at t = L tan(theta/2).
constexpr int weideman_terms = 40;

struct weideman_table {
  double length;
  std::array<double, weideman_terms> coefficient;  // coefficient[m-1] multiplies Z^(m-1)
  weideman_table() {
    const int samples = 2 * weideman_terms;  // M in Weideman's notation
    length = std::sqrt(weideman_terms / std::sqrt(2.0));
    std::array<double, 2 * samples> f{};
    for(int k = -samples + 1; k < samples; ++k) {
      const double t = length * std::tan(pi * k / (2.0 * samples));
      f[k + samples] = std::exp(-t * t) * (length * length + t * t);
    }
    for(int m = 1; m <= weideman_terms; ++m) {
      double sum = 0;
      for(int k = -samples + 1; k < samples; ++k)
        sum += f[k + samples] * std::cos(pi * k * m / samples);
      coefficient[m - 1] = sum / (2.0 * samples);
    }
  }
};

complex_d faddeeva_upper(complex_d z) {
  static const weideman_table table;
  const complex_d denominator = table.length - j * z;
  const complex_d big_z = (table.length + j * z) / denominator;
  complex_d p = table.coefficient[weideman_terms - 1];
  for(int m = weideman_terms - 2; m >= 0; --m) p = p * big_z + table.coefficient[m];
  return 2.0 * p / (denominator * denominator) + 1.0 / (std::sqrt(pi) * denominator);
}
}

complex_d exp_erfc(complex_d a, complex_d z) {
  // erfc(z) = exp(-z^2) w(jz) needs Im(jz) = Re z >= 0; otherwise reflect with
  // erfc(z) = 2 - erfc(-z).
  if(z.real() >= 0) return std::exp(a - z * z) * faddeeva_upper(j * z);
  return 2.0 * std::exp(a) - std::exp(a - z * z) * faddeeva_upper(-j * z);
}

namespace {
double dot(vec2 a, vec2 b) { return a.x * b.x + a.y * b.y; }
double norm(vec2 a) { return std::hypot(a.x, a.y); }
vec2 operator-(vec2 a, vec2 b) { return {a.x - b.x, a.y - b.y}; }
vec2 operator*(double s, vec2 a) { return {s * a.x, s * a.y}; }

struct reciprocal_pair {
  vec2 b1, b2;
};
// Reciprocal vectors of a1, a2: a_i . b_j = 2 pi delta_ij.
reciprocal_pair reciprocal(vec2 a1, vec2 a2) {
  const double det = a1.x * a2.y - a1.y * a2.x;
  return {{2 * pi * a2.y / det, -2 * pi * a2.x / det}, {-2 * pi * a1.y / det, 2 * pi * a1.x / det}};
}

struct index_range {
  long first, last;
};
// Every integer index i with |i - centre| <= half_width.
index_range indices_within(double centre, double half_width) {
  return {long(std::ceil(centre - half_width)), long(std::floor(centre + half_width))};
}

// A radially symmetric term g(R) = c(R) / (8 pi R) and its derivative
// divided by R, for the gradient g'(R) (r - rho) / R.
struct radial_term {
  complex_d value, derivative_over_distance;
};
radial_term over_eight_pi_r(complex_d c, complex_d c_prime, double distance) {
  return {c / (8 * pi * distance), (c_prime * distance - c) / (8 * pi * distance * distance * distance)};
}

// Exponent beyond which a Gaussian-decaying Ewald term is dropped:
// exp(-36) is about 2e-16.
constexpr double gaussian_cutoff = 36;
// Automatic splitting keeps k/(2E) at most this large, bounding the
// cancellation between Ewald terms of size exp((k/2E)^2) (cells larger than
// about a wavelength).
constexpr double max_kappa = 2;
// Below this R (E + |k|), the origin term uses its Taylor series (through
// R^6, truncation error about (0.05 * 2)^8 / 9! < 1e-13) instead of a
// difference of nearly equal values, whose error grows like 1/R^2 in the
// gradient.
constexpr double origin_series_limit = 0.05;
}

lattice_2d::lattice_2d(vec2 a1, vec2 a2) {
  const double det = a1.x * a2.y - a1.y * a2.x;
  if(!std::isfinite(det) || std::abs(det) <= 1e-12 * norm(a1) * norm(a2))
    throw std::invalid_argument("Lattice vectors must be finite and not parallel");
  area_ = std::abs(det);
  const reciprocal_pair given = reciprocal(a1, a2);
  b1_ = given.b1;
  b2_ = given.b2;
  // Lagrange/Gauss reduction: shortest vector first, the second as short as
  // the first allows. Terminates in a few steps for any non-degenerate pair.
  vec2 shorter = a1, longer = a2;
  if(norm(shorter) > norm(longer)) std::swap(shorter, longer);
  for(int step = 0; step < 200; ++step) {
    longer = longer - std::round(dot(shorter, longer) / dot(shorter, shorter)) * shorter;
    if(norm(longer) >= norm(shorter)) break;
    std::swap(shorter, longer);
  }
  reduced_a1_ = shorter;
  reduced_a2_ = longer;
  const reciprocal_pair reduced = reciprocal(reduced_a1_, reduced_a2_);
  reduced_b1_ = reduced.b1;
  reduced_b2_ = reduced.b2;
}

vec2 lattice_2d::scan_wavevector(double psi1, double psi2) const {
  return {-(psi1 * b1_.x + psi2 * b2_.x) / (2 * pi), -(psi1 * b1_.y + psi2 * b2_.y) / (2 * pi)};
}

periodic_green::periodic_green(const lattice_2d& lattice, complex_d k, vec2 scan_wavevector, double splitting)
  : lattice_(lattice), k_(k), kt0_(scan_wavevector) {
  splitting_ = splitting > 0 ? splitting
                             : std::max(std::sqrt(pi / lattice.cell_area()), std::abs(k.real()) / (2 * max_kappa));
  const double e = splitting_;
  kappa_ = k_ / (2 * e);
  spatial_radius_ = std::sqrt(gaussian_cutoff + std::norm(kappa_)) / e;
  spectral_radius_ = std::sqrt(std::norm(k_) + 4 * e * e * gaussian_cutoff);
  // Origin term T(R) = (f(R) - f(-R)) / (8 pi R), f(R) = exp(jkR) erfc(RE + j kappa),
  // so T = (1/4pi) sum over odd n of f^(n)(0) R^(n-1) / n!. With w = RE + j kappa,
  // h(R) = erfc(w): h^(i)(0) = -(2/sqrt pi) E^i (-1)^(i-1) H_(i-1)(j kappa) exp(kappa^2).
  // Stored as f^(n)(0) / n! for n = 1, 3, 5, 7.
  constexpr int highest = 2 * origin_series_terms - 1;
  const complex_d w0 = j * kappa_;
  complex_d hermite[highest] = {1.0, 2.0 * w0};
  for(int m = 1; m + 1 < highest; ++m) hermite[m + 1] = 2.0 * w0 * hermite[m] - 2.0 * double(m) * hermite[m - 1];
  complex_d h[highest + 1];
  h[0] = erfc_complex(w0);
  for(int i = 1; i <= highest; ++i)
    h[i] = -(2 / std::sqrt(pi)) * std::pow(e, i) * (i % 2 ? 1.0 : -1.0) * hermite[i - 1] * std::exp(kappa_ * kappa_);
  for(int slot = 0; slot < origin_series_terms; ++slot) {
    const int n = 2 * slot + 1;
    complex_d f = 0;
    double binomial = 1;  // n choose i
    for(int i = 0; i <= n; ++i) {
      f += binomial * std::pow(j * k_, n - i) * h[i];
      binomial = binomial * (n - i) / (i + 1);
    }
    double factorial = 1;
    for(int i = 2; i <= n; ++i) factorial *= i;
    origin_series_[slot] = f / factorial;
  }
}

void periodic_green::add_spatial(const point& r, bool subtract_origin_free_term, green_value& sum) const {
  const vec2 a1 = lattice_.reduced_a1(), a2 = lattice_.reduced_a2();
  const vec2 b1 = lattice_.reduced_b1(), b2 = lattice_.reduced_b2();
  const vec2 centre{r[0], r[1]};
  index_range m_range = indices_within(dot(centre, b1) / (2 * pi), spatial_radius_ * norm(b1) / (2 * pi));
  index_range n_range = indices_within(dot(centre, b2) / (2 * pi), spatial_radius_ * norm(b2) / (2 * pi));
  // The origin term is always needed when its free-space part is subtracted.
  if(subtract_origin_free_term) {
    m_range = {std::min(m_range.first, 0L), std::max(m_range.last, 0L)};
    n_range = {std::min(n_range.first, 0L), std::max(n_range.last, 0L)};
  }
  const double e = splitting_;
  const complex_d two_over_root_pi = 2 / std::sqrt(pi);
  for(long m = m_range.first; m <= m_range.last; ++m)
    for(long n = n_range.first; n <= n_range.last; ++n) {
      const bool origin = m == 0 && n == 0;
      const vec2 rho{m * a1.x + n * a2.x, m * a1.y + n * a2.y};
      const point d = {r[0] - rho.x, r[1] - rho.y, r[2]};
      const double distance = std::sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
      if(distance > spatial_radius_ && !(origin && subtract_origin_free_term)) continue;
      const complex_d phase = std::exp(-j * dot(kt0_, rho));
      const complex_d gauss = std::exp(-distance * distance * e * e + kappa_ * kappa_);
      radial_term term;
      if(origin && subtract_origin_free_term) {
        if(distance * (e + std::abs(k_)) < origin_series_limit) {
          // T = (1/4pi) sum_n c_n R^(n-1), T'/R = (1/4pi) sum_n c_n (n-1) R^(n-3),
          // n = 1, 3, 5, 7, c_n = f^(n)(0) / n!.
          const double distance2 = distance * distance;
          complex_d value = 0, derivative = 0;
          for(int slot = origin_series_terms - 1; slot >= 0; --slot) {
            value = value * distance2 + origin_series_[slot];
            if(slot > 0) derivative = derivative * distance2 + double(2 * slot) * origin_series_[slot];
          }
          term = {value / (4 * pi), derivative / (4 * pi)};
        } else {
          // (f(R) - f(-R)) / (8 pi R): the spatial origin term minus exp(-jkR)/(4 pi R).
          const complex_d f_plus = exp_erfc(j * k_ * distance, distance * e + j * kappa_);
          const complex_d f_minus = exp_erfc(-j * k_ * distance, -distance * e + j * kappa_);
          term = over_eight_pi_r(f_plus - f_minus, j * k_ * (f_plus + f_minus) - 2.0 * e * two_over_root_pi * gauss,
                                 distance);
        }
      } else {
        const complex_d outgoing = exp_erfc(-j * k_ * distance, distance * e - j * kappa_);
        const complex_d incoming = exp_erfc(j * k_ * distance, distance * e + j * kappa_);
        term = over_eight_pi_r(outgoing + incoming,
                               j * k_ * (incoming - outgoing) - 2.0 * e * two_over_root_pi * gauss, distance);
      }
      sum.value += phase * term.value;
      for(int i = 0; i < 3; ++i) sum.gradient[i] += phase * term.derivative_over_distance * d[i];
    }
}

void periodic_green::add_spectral(const point& r, green_value& sum) const {
  const vec2 a1 = lattice_.reduced_a1(), a2 = lattice_.reduced_a2();
  const vec2 b1 = lattice_.reduced_b1(), b2 = lattice_.reduced_b2();
  // Floquet modes kt = kt0 + p b1 + q b2 with |kt| <= spectral_radius_.
  const index_range p_range = indices_within(-dot(kt0_, a1) / (2 * pi), spectral_radius_ * norm(a1) / (2 * pi));
  const index_range q_range = indices_within(-dot(kt0_, a2) / (2 * pi), spectral_radius_ * norm(a2) / (2 * pi));
  const double e = splitting_, dz = r[2];
  const complex_d scale = 1.0 / (4.0 * j * lattice_.cell_area());
  for(long p = p_range.first; p <= p_range.last; ++p)
    for(long q = q_range.first; q <= q_range.last; ++q) {
      const vec2 kt{kt0_.x + p * b1.x + q * b2.x, kt0_.y + p * b1.y + q * b2.y};
      if(norm(kt) > spectral_radius_) continue;
      complex_d kz = std::sqrt(k_ * k_ - dot(kt, kt));
      if(kz.imag() > 0) kz = -kz;
      const complex_d alpha = j * kz / (2 * e);
      const complex_d below = exp_erfc(-j * kz * dz, alpha - dz * e);
      const complex_d above = exp_erfc(j * kz * dz, alpha + dz * e);
      const complex_d mode = scale * std::exp(-j * (kt.x * r[0] + kt.y * r[1]));
      const complex_d value = mode * (below + above) / kz;
      sum.value += value;
      sum.gradient[0] += -j * kt.x * value;
      sum.gradient[1] += -j * kt.y * value;
      // The Gaussian parts of d/dz cancel between the two terms.
      sum.gradient[2] += mode * j * (above - below);
    }
}

green_value periodic_green::smooth(const point& r) const {
  green_value sum{};
  add_spatial(r, true, sum);
  add_spectral(r, sum);
  return sum;
}

green_value periodic_green::full(const point& r) const {
  green_value sum{};
  add_spatial(r, false, sum);
  add_spectral(r, sum);
  return sum;
}
}

