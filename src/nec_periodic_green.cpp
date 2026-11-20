#include "nec_periodic_green.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

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
// R^14, truncation error about (2 * 0.3)^16 / 17! ~ 1e-18) instead of the
// difference (f(R) - f(-R)) / (8 pi R). That difference loses accuracy like
// 1/R^2 in the gradient, about 1e-10 relative at 0.05 but 1e-12 at 0.3.
constexpr double origin_series_limit = 0.3;
}

lattice_2d::lattice_2d(vec2 a1, vec2 a2) {
  const double det = a1.x * a2.y - a1.y * a2.x;
  if(!std::isfinite(det) || std::abs(det) <= 1e-12 * norm(a1) * norm(a2))
    throw std::invalid_argument("Lattice vectors must be finite and not parallel");
  area_ = std::abs(det);
  a1_ = a1;
  a2_ = a2;
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

periodic_green::periodic_green(const lattice_2d& lattice, complex_d k, vec2 scan_wavevector, double splitting,
                               double near_cutoff_ratio)
  : lattice_(lattice), k_(k), kt0_(scan_wavevector), near_cutoff_ratio_(near_cutoff_ratio) {
  splitting_ = splitting > 0 ? splitting
                             : std::max(std::sqrt(pi / lattice.cell_area()), std::abs(k.real()) / (2 * max_kappa));
  const double e = splitting_;
  kappa_ = k_ / (2 * e);
  spatial_radius_ = std::sqrt(gaussian_cutoff + std::norm(kappa_)) / e;
  spectral_radius_ = std::sqrt(std::norm(k_) + 4 * e * e * gaussian_cutoff);
  // Origin term T(R) = (f(R) - f(-R)) / (8 pi R), f(R) = exp(jkR) erfc(RE + j kappa),
  // so T = (1/4pi) sum over odd n of f^(n)(0) R^(n-1) / n!. With w = RE + j kappa,
  // h(R) = erfc(w): h^(i)(0) = -(2/sqrt pi) E^i (-1)^(i-1) H_(i-1)(j kappa) exp(kappa^2).
  // Stored as f^(n)(0) / n! for n = 1, 3, ..., 2 origin_series_terms - 1.
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
  // Modes at cut-off have |kt| = |Re k|; twice that covers every candidate.
  for_each_mode(2 * std::abs(k_), [&](vec2 kt, complex_d kz) {
    if(!is_split(kz)) return;
    const vec2 step = kt - kt0_;
    split_modes_.push_back(
      {std::lround(dot(step, lattice_.a1()) / (2 * pi)), std::lround(dot(step, lattice_.a2()) / (2 * pi)), kt, kz});
  });
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
          // n odd, c_n = f^(n)(0) / n!.
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

// Calls visit(kt, kz) for every Floquet mode kt = kt0 + p b1 + q b2 (reduced
// reciprocal vectors) with |kt| <= radius, kz = sqrt(k^2 - kt^2), Im kz <= 0.
template <typename Visit>
void periodic_green::for_each_mode(double radius, Visit visit) const {
  const vec2 a1 = lattice_.reduced_a1(), a2 = lattice_.reduced_a2();
  const vec2 b1 = lattice_.reduced_b1(), b2 = lattice_.reduced_b2();
  const index_range p_range = indices_within(-dot(kt0_, a1) / (2 * pi), radius * norm(a1) / (2 * pi));
  const index_range q_range = indices_within(-dot(kt0_, a2) / (2 * pi), radius * norm(a2) / (2 * pi));
  for(long p = p_range.first; p <= p_range.last; ++p)
    for(long q = q_range.first; q <= q_range.last; ++q) {
      const vec2 kt{kt0_.x + p * b1.x + q * b2.x, kt0_.y + p * b1.y + q * b2.y};
      if(norm(kt) > radius) continue;
      complex_d kz = std::sqrt(k_ * k_ - dot(kt, kt));
      if(kz.imag() > 0) kz = -kz;
      visit(kt, kz);
    }
}

double periodic_green::spectral_mode_count() const {
  return spectral_radius_ * spectral_radius_ * lattice_.cell_area() / (4 * pi);
}

floquet_cutoff periodic_green::nearest_cutoff() const {
  // Modes at cut-off have |kt| = |Re k|; twice that covers every candidate.
  const double magnitude = std::abs(k_);
  floquet_cutoff nearest;
  nearest.kz_over_k = std::numeric_limits<double>::infinity();
  for_each_mode(2 * magnitude, [&](vec2 kt, complex_d kz) {
    const double ratio = std::abs(kz) / magnitude;
    if(ratio >= nearest.kz_over_k) return;
    // Indices along the given lattice vectors' reciprocal vectors.
    const vec2 step = kt - kt0_;
    nearest = {std::lround(dot(step, lattice_.a1()) / (2 * pi)), std::lround(dot(step, lattice_.a2()) / (2 * pi)),
               ratio};
  });
  return nearest;
}

namespace {
// Below this |kz| (|dz| + 1/E), the remainder (f(kz) - 2) / kz of a split mode
// uses its Taylor series through kz^3 (truncation about 1e-3^4 / 5!) instead
// of the difference, which loses eps / (|kz| (|dz| + 1/E)).
constexpr double remainder_series_limit = 1e-3;

// (f(kz) - 2) / kz for the spectral factor
//   f(kz) = exp(-j kz dz) erfc(j kz / 2E - dz E) + exp(j kz dz) erfc(j kz / 2E + dz E),
// which tends to 2 at cut-off.
complex_d spectral_remainder(complex_d kz, double dz, double e, complex_d below, complex_d above) {
  if(std::abs(kz) * (std::abs(dz) + 1 / e) >= remainder_series_limit) return (below + above - 2.0) / kz;
  // f^(n)(0) = sum over both terms g(kz) = exp(s j kz dz) erfc(x0 + j kz / 2E),
  // x0 = s dz E: sum_i C(n, i) (s j dz)^(n-i) (j / 2E)^i erfc^(i)(x0), with
  // erfc^(i)(x) = -(2 / sqrt pi) (-1)^(i-1) H_(i-1)(x) exp(-x^2) for i >= 1.
  constexpr int orders = 4;
  complex_d derivative[orders + 1] = {};
  for(const double s : {-1.0, 1.0}) {
    const double x0 = s * dz * e;
    double hermite[orders] = {1, 2 * x0};
    for(int m = 1; m + 1 < orders; ++m) hermite[m + 1] = 2 * x0 * hermite[m] - 2 * m * hermite[m - 1];
    double erfc_derivative[orders + 1];
    erfc_derivative[0] = std::erfc(x0);
    for(int i = 1; i <= orders; ++i)
      erfc_derivative[i] = -(2 / std::sqrt(pi)) * (i % 2 ? 1.0 : -1.0) * hermite[i - 1] * std::exp(-x0 * x0);
    // Powers (s j dz)^m and (j / 2E)^m by products: std::pow(0, 0) is NaN in
    // some standard libraries, and dz = 0 is common.
    complex_d phase_power[orders + 1], shift_power[orders + 1];
    phase_power[0] = shift_power[0] = 1.0;
    for(int m = 1; m <= orders; ++m) {
      phase_power[m] = phase_power[m - 1] * (s * j * dz);
      shift_power[m] = shift_power[m - 1] * (j / (2 * e));
    }
    for(int n = 1; n <= orders; ++n) {
      double binomial = 1;  // n choose i
      for(int i = 0; i <= n; ++i) {
        derivative[n] += binomial * phase_power[n - i] * shift_power[i] * erfc_derivative[i];
        binomial = binomial * (n - i) / (i + 1);
      }
    }
  }
  // (f - 2) / kz = sum_n f^(n)(0) kz^(n-1) / n!.
  complex_d remainder = 0;
  double factorial = 1;
  for(int n = 1; n <= orders; ++n) factorial *= n;
  for(int n = orders; n >= 1; --n) {
    remainder = remainder * kz + derivative[n] / factorial;
    factorial /= n;
  }
  return remainder;
}
}

green_value periodic_green::singular_part(const floquet_mode& mode, const point& r) const {
  const complex_d value =
    std::exp(-j * (mode.kt.x * r[0] + mode.kt.y * r[1])) / (2.0 * j * lattice_.cell_area() * mode.kz);
  return {value, {-j * mode.kt.x * value, -j * mode.kt.y * value, 0.0}};
}

void periodic_green::add_spectral(const point& r, green_value& sum) const {
  const double e = splitting_, dz = r[2];
  const complex_d scale = 1.0 / (4.0 * j * lattice_.cell_area());
  for_each_mode(spectral_radius_, [&](vec2 kt, complex_d kz) {
    const complex_d alpha = j * kz / (2 * e);
    const complex_d below = exp_erfc(-j * kz * dz, alpha - dz * e);
    const complex_d above = exp_erfc(j * kz * dz, alpha + dz * e);
    const complex_d mode = scale * std::exp(-j * (kt.x * r[0] + kt.y * r[1]));
    // A split mode leaves out its singular part 2 mode / kz.
    const complex_d value =
      is_split(kz) ? mode * spectral_remainder(kz, dz, e, below, above) : mode * (below + above) / kz;
    sum.value += value;
    sum.gradient[0] += -j * kt.x * value;
    sum.gradient[1] += -j * kt.y * value;
    // The Gaussian parts of d/dz cancel between the two terms.
    sum.gradient[2] += mode * j * (above - below);
  });
}

green_value periodic_green::smooth(const point& r) const {
  green_value sum{};
  add_spatial(r, true, sum);
  add_spectral(r, sum);
  return sum;
}

green_value free_space_green(const point& r, complex_d k) {
  const double distance = std::sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2]);
  const complex_d value = std::exp(-j * k * distance) / (4 * pi * distance);
  // d/dR (exp(-jkR) / R) / R = -(1 + jkR) exp(-jkR) / R^3.
  const complex_d derivative_over_distance = -(1.0 + j * k * distance) * value / (distance * distance);
  return {value, {derivative_over_distance * r[0], derivative_over_distance * r[1], derivative_over_distance * r[2]}};
}

green_value periodic_green::full(const point& r) const {
  green_value sum{};
  add_spatial(r, false, sum);
  add_spectral(r, sum);
  return sum;
}

namespace {
struct gauss_rule {
  std::vector<double> node, weight;  // on [-1, 1]
};

// Gauss-Legendre rules of every order up to max_segment_gauss_order, by Newton
// iteration on the Legendre polynomial.
const gauss_rule& gauss_legendre(int order) {
  static const std::vector<gauss_rule> rules = [] {
    std::vector<gauss_rule> all(max_segment_gauss_order + 1);
    for(int n = 1; n <= max_segment_gauss_order; ++n) {
      gauss_rule& rule = all[n];
      for(int i = 0; i < n; ++i) {
        double x = std::cos(pi * (i + 0.75) / (n + 0.5)), derivative = 1;
        for(int iteration = 0; iteration < 100; ++iteration) {
          double p0 = 1, p1 = x;
          for(int m = 2; m <= n; ++m) {
            const double p2 = ((2 * m - 1) * x * p1 - (m - 1) * p0) / m;
            p0 = p1;
            p1 = p2;
          }
          derivative = n * (x * p1 - p0) / (x * x - 1);
          const double step = p1 / derivative;
          x -= step;
          if(std::abs(step) < 1e-15) break;
        }
        rule.node.push_back(x);
        rule.weight.push_back(2 / ((1 - x * x) * derivative * derivative));
      }
    }
    return all;
  }();
  return rules[order];
}

std::array<complex_d, 3> axial(const point& direction, complex_d scale) {
  return {scale * direction[0], scale * direction[1], scale * direction[2]};
}
}

floquet_moments segment_floquet_moments(const source_segment& segment, vec2 kt, double k) {
  // The integrand is entire with phase rates up to |kt| + k (about 2k near
  // cut-off); 16 points integrate it to rounding over segments up to the
  // 0.3 wavelengths the periodic tolerance allows.
  const gauss_rule& rule = gauss_legendre(16);
  const point& u = segment.direction;
  const double half = segment.length / 2;
  const double centre_phase = kt.x * segment.centre[0] + kt.y * segment.centre[1];
  const double phase_rate = kt.x * u[0] + kt.y * u[1];
  floquet_moments moments{};
  for(size_t i = 0; i < rule.node.size(); ++i) {
    const double s = half * rule.node[i], w = half * rule.weight[i];
    const complex_d phase = w * std::exp(j * (centre_phase + phase_rate * s));
    moments.constant += phase;
    moments.sine += std::sin(k * s) * phase;
    moments.cosine += std::cos(k * s) * phase;
  }
  return moments;
}

segment_field segment_field_of_kernel(const kernel_function& kernel, const source_segment& segment,
                                      const point& observation, double k, int gauss_order) {
  if(gauss_order < 1 || gauss_order > max_segment_gauss_order)
    throw std::invalid_argument("Gauss order must be between 1 and " + std::to_string(max_segment_gauss_order));
  const gauss_rule& rule = gauss_legendre(gauss_order);
  const point& u = segment.direction;
  const double half = segment.length / 2;
  const auto kernel_at = [&](double s) {
    return kernel({observation[0] - (segment.centre[0] + s * u[0]), observation[1] - (segment.centre[1] + s * u[1]),
                   observation[2] - (segment.centre[2] + s * u[2])});
  };
  // int I G ds' for I = 1, sin, cos, and int I' grad G ds' for sin (I' = k cos)
  // and cos (I' = -k sin).
  complex_d potential_constant = 0, potential_sine = 0, potential_cosine = 0;
  std::array<complex_d, 3> charge_sine{}, charge_cosine{};
  for(size_t i = 0; i < rule.node.size(); ++i) {
    const double s = half * rule.node[i], w = half * rule.weight[i];
    const green_value g = kernel_at(s);
    const double sin_ks = std::sin(k * s), cos_ks = std::cos(k * s);
    potential_constant += w * g.value;
    potential_sine += w * sin_ks * g.value;
    potential_cosine += w * cos_ks * g.value;
    for(int c = 0; c < 3; ++c) {
      charge_sine[c] += w * k * cos_ks * g.gradient[c];
      charge_cosine[c] -= w * k * sin_ks * g.gradient[c];
    }
  }
  const green_value plus_end = kernel_at(half), minus_end = kernel_at(-half);
  const double sin_end = std::sin(k * half), cos_end = std::cos(k * half);
  const complex_d prefactor = -j * nec_segment_field_impedance / k;
  // (-j eta / k) [ k^2 s_hat potential + charge - (I(+h) grad G(+h) - I(-h) grad G(-h)) ]
  const auto field = [&](complex_d potential, const std::array<complex_d, 3>& charge, double i_plus, double i_minus) {
    const std::array<complex_d, 3> vector_part = axial(u, k * k * potential);
    std::array<complex_d, 3> e;
    for(int c = 0; c < 3; ++c)
      e[c] = prefactor * (vector_part[c] + charge[c] - (i_plus * plus_end.gradient[c] - i_minus * minus_end.gradient[c]));
    return e;
  };
  segment_field result;
  result.constant = field(potential_constant, {}, 1.0, 1.0);
  result.sine = field(potential_sine, charge_sine, sin_end, -sin_end);
  result.cosine = field(potential_cosine, charge_cosine, cos_end, cos_end);
  return result;
}
}

