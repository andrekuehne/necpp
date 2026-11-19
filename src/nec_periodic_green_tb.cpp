// Native seam for the periodic Green's function kernel (stage 1 of the
// periodic solver). Reference values come from independent sources: a
// high-precision series evaluation for erfc, and direct spatial or spectral
// lattice sums for the Ewald kernel. The direct sums deliberately repeat the
// reciprocal-lattice arithmetic instead of calling the unit under test.
#include <catch2/catch_test_macros.hpp>
#include "nec_periodic_green.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <stdexcept>
#include <vector>

using nec_periodic::complex_d;
using nec_periodic::green_value;
using nec_periodic::point;
using nec_periodic::vec2;

namespace {
constexpr double pi = 3.141592653589793238462643383279502884;
const complex_d j(0.0, 1.0);

double relative_error(complex_d value, complex_d reference) {
  return std::abs(value - reference) / std::abs(reference);
}

// Gradient error relative to the gradient's size, or to |k| |G| where symmetry
// makes the gradient vanish.
double gradient_error(const green_value& value, const green_value& reference, complex_d k) {
  double difference = 0, size = 0;
  for(int i = 0; i < 3; ++i) {
    difference += std::norm(value.gradient[i] - reference.gradient[i]);
    size += std::norm(reference.gradient[i]);
  }
  return std::sqrt(difference) / std::max(std::sqrt(size), std::abs(k) * std::abs(reference.value));
}

// Lattice vectors a1, a2 (wavelength 1), close enough to orthogonal for the
// plain index boxes of the direct sums below.
struct lattice_case {
  const char* name;
  vec2 a1, a2;
};
// The five planar lattice types.
const lattice_case lattice_cases[] = {
  {"square", {0.5, 0.0}, {0.0, 0.5}},
  {"rectangular", {0.6, 0.0}, {0.0, 0.45}},
  {"centered rectangular", {0.6, 0.0}, {0.3, 0.5}},
  {"hexagonal", {0.55, 0.0}, {0.275, 0.4763139720814413}},
  {"oblique", {0.5, 0.0}, {0.17, 0.43}},
};
// Broadside, a visible scan state and one in invisible space (|kt0| > k).
const vec2 scan_cases[] = {{0.0, 0.0}, {1.7, -0.9}, {8.0, 2.0}};
// Cells several wavelengths across, where the automatic splitting switches to
// E = k/4. Broadside on the 3-wavelength square lies on a Wood anomaly, so
// these use their own scan states (all at least 0.39 from one).
const lattice_case large_cells[] = {
  {"square, 3 wavelengths", {3.0, 0.0}, {0.0, 3.0}},
  {"hexagonal, 2.5 wavelengths", {2.5, 0.0}, {1.25, 2.1650635094610964}},
};
const vec2 large_cell_scans[] = {{0.9, -0.4}, {1.7, -0.9}, {8.0, 2.0}};

struct lattice_and_scan {
  lattice_case lattice;
  vec2 kt0;
};
std::vector<lattice_and_scan> all_lattices_and_scans() {
  std::vector<lattice_and_scan> cases;
  for(const lattice_case& c : lattice_cases)
    for(const vec2 kt0 : scan_cases) cases.push_back({c, kt0});
  for(const lattice_case& c : large_cells)
    for(const vec2 kt0 : large_cell_scans) cases.push_back({c, kt0});
  return cases;
}

vec2 reciprocal_1(const lattice_case& c) {
  const double det = c.a1.x * c.a2.y - c.a1.y * c.a2.x;
  return {2 * pi * c.a2.y / det, -2 * pi * c.a2.x / det};
}
vec2 reciprocal_2(const lattice_case& c) {
  const double det = c.a1.x * c.a2.y - c.a1.y * c.a2.x;
  return {-2 * pi * c.a1.y / det, 2 * pi * c.a1.x / det};
}

// Smallest |kz| over the Floquet modes near the visible region: a distance
// from the nearest Wood anomaly.
double smallest_kz(const lattice_case& c, complex_d k, vec2 kt0) {
  const vec2 b1 = reciprocal_1(c), b2 = reciprocal_2(c);
  const int range = 40;
  double smallest = 1e300;
  for(int p = -range; p <= range; ++p)
    for(int q = -range; q <= range; ++q) {
      const vec2 kt{kt0.x + p * b1.x + q * b2.x, kt0.y + p * b1.y + q * b2.y};
      smallest = std::min(smallest, std::abs(std::sqrt(k * k - (kt.x * kt.x + kt.y * kt.y))));
    }
  return smallest;
}

// Direct spatial sum of exp(-j kt0.rho_mn) exp(-jkR)/(4 pi R) over every
// lattice point except the origin, for lossy k: G_p minus the origin cell's
// free-space term.
green_value direct_smooth_sum(const lattice_case& c, complex_d k, vec2 kt0, point r) {
  const double radius = 40.0 / -k.imag() + std::hypot(r[0], r[1]);
  const double det = std::abs(c.a1.x * c.a2.y - c.a1.y * c.a2.x);
  const int m_max = int(radius * std::hypot(c.a2.x, c.a2.y) / det) + 2;
  const int n_max = int(radius * std::hypot(c.a1.x, c.a1.y) / det) + 2;
  green_value sum{};
  for(int m = -m_max; m <= m_max; ++m)
    for(int n = -n_max; n <= n_max; ++n) {
      if(m == 0 && n == 0) continue;
      const double rho_x = m * c.a1.x + n * c.a2.x, rho_y = m * c.a1.y + n * c.a2.y;
      const point d = {r[0] - rho_x, r[1] - rho_y, r[2]};
      const double distance = std::sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
      if(distance > radius) continue;
      const complex_d phase = std::exp(-j * (kt0.x * rho_x + kt0.y * rho_y));
      const complex_d g = phase * std::exp(-j * k * distance) / (4 * pi * distance);
      sum.value += g;
      const complex_d derivative = -g * (1.0 + j * k * distance) / distance;
      for(int i = 0; i < 3; ++i) sum.gradient[i] += derivative * d[i] / distance;
    }
  return sum;
}

// Spectral (Floquet) series of the full G_p for dz != 0:
//   G_p = 1/(2jA) sum_pq exp(-j kt_pq . rho) exp(-j kz_pq |dz|) / kz_pq,
// Im kz <= 0. The series itself is singular at Wood anomalies.
green_value direct_spectral_sum(const lattice_case& c, complex_d k, vec2 kt0, point r) {
  const double area = std::abs(c.a1.x * c.a2.y - c.a1.y * c.a2.x);
  const vec2 b1 = reciprocal_1(c), b2 = reciprocal_2(c);
  const double dz = std::abs(r[2]), sign = r[2] > 0 ? 1.0 : -1.0;
  const double radius = std::abs(k) + 40.0 / dz;
  const double reach = radius + std::hypot(kt0.x, kt0.y);
  const int p_max = int(reach * std::hypot(c.a1.x, c.a1.y) / (2 * pi)) + 2;
  const int q_max = int(reach * std::hypot(c.a2.x, c.a2.y) / (2 * pi)) + 2;
  green_value sum{};
  for(int p = -p_max; p <= p_max; ++p)
    for(int q = -q_max; q <= q_max; ++q) {
      const vec2 kt{kt0.x + p * b1.x + q * b2.x, kt0.y + p * b1.y + q * b2.y};
      if(std::hypot(kt.x, kt.y) > radius) continue;
      complex_d kz = std::sqrt(k * k - (kt.x * kt.x + kt.y * kt.y));
      if(kz.imag() > 0) kz = -kz;
      const complex_d wave = std::exp(-j * (kt.x * r[0] + kt.y * r[1])) * std::exp(-j * kz * dz) / (2.0 * j * area);
      sum.value += wave / kz;
      sum.gradient[0] += -j * kt.x * wave / kz;
      sum.gradient[1] += -j * kt.y * wave / kz;
      sum.gradient[2] += -j * sign * wave;
    }
  return sum;
}
}

TEST_CASE("Ewald kernel matches the spectral series for nonzero vertical offset", "[periodic_green]") {
  const complex_d k = 2 * pi;  // lossless, wavelength 1
  const point points[] = {{0.1, 0.05, 0.25}, {0.21, -0.13, -0.4}, {0.0, 0.0, 0.15}, {0.3, 0.2, 1.3}};
  for(const auto& c : all_lattices_and_scans()) {
    REQUIRE(smallest_kz(c.lattice, k, c.kt0) > 0.3);  // the series is singular at Wood anomalies
    const nec_periodic::periodic_green green({c.lattice.a1, c.lattice.a2}, k, c.kt0);
    for(const point& r : points) {
      INFO(c.lattice.name << ", kt0 = (" << c.kt0.x << ", " << c.kt0.y << "), r = (" << r[0] << ", " << r[1] << ", " << r[2] << ")");
      const auto reference = direct_spectral_sum(c.lattice, k, c.kt0, r);
      const auto value = green.full(r);
      CHECK(relative_error(value.value, reference.value) < 1e-10);
      CHECK(gradient_error(value, reference, k) < 1e-10);
    }
  }
}

TEST_CASE("Ewald smooth kernel matches a direct lattice sum with loss", "[periodic_green]") {
  const complex_d k = 2 * pi * complex_d(1.0, -0.08);  // wavelength 1, slight loss
  // Includes points inside and on both sides of the switch from the origin
  // term's Taylor series to its closed form (R (E + |k|) = 0.05: about
  // R = 5e-3 for the half-wavelength cells, 6.4e-3 for the large cells).
  const point points[] = {
    {0.0, 0.0, 0.0}, {1e-4, 0.0, 5e-5}, {2e-4, -3e-4, 0.0}, {0.003, 0.0, 0.001}, {4.6e-3, 0.0, 1e-3},
    {0.0, 5.3e-3, 0.0}, {4.4e-3, 4.4e-3, 0.0}, {0.008, -0.002, 0.0}, {0.1, 0.05, 0.0}, {0.21, -0.13, 0.07},
    {0.4, 0.3, -0.2},
  };
  for(const auto& c : all_lattices_and_scans()) {
    const nec_periodic::periodic_green green({c.lattice.a1, c.lattice.a2}, k, c.kt0);
    for(const point& r : points) {
      INFO(c.lattice.name << ", kt0 = (" << c.kt0.x << ", " << c.kt0.y << "), r = (" << r[0] << ", " << r[1] << ", " << r[2] << ")");
      const auto reference = direct_smooth_sum(c.lattice, k, c.kt0, r);
      const auto value = green.smooth(r);
      CHECK(relative_error(value.value, reference.value) < 1e-10);
      CHECK(gradient_error(value, reference, k) < 1e-10);
    }
  }
}

TEST_CASE("Lattice vectors that span no cell are refused", "[periodic_green]") {
  using nec_periodic::lattice_2d;
  CHECK_THROWS_AS(lattice_2d({0.5, 0.0}, {1.0, 0.0}), std::invalid_argument);
  CHECK_THROWS_AS(lattice_2d({0.0, 0.0}, {0.0, 0.5}), std::invalid_argument);
  CHECK_THROWS_AS(lattice_2d({0.5, 0.0}, {0.0, std::nan("")}), std::invalid_argument);
  const lattice_2d hexagonal({0.55, 0.0}, {0.275, 0.4763139720814413});
  CHECK(std::abs(hexagonal.cell_area() - 0.55 * 0.4763139720814413) < 1e-15);
}

TEST_CASE("Strongly skewed lattice vectors give the same kernel as the lattice they span", "[periodic_green]") {
  const complex_d k = 2 * pi * complex_d(1.0, -0.08);
  const point points[] = {{0.0, 0.0, 0.0}, {0.21, -0.13, 0.07}, {0.3, 0.2, 1.3}};
  for(const lattice_case& c : lattice_cases) {
    // The same lattice spanned by a1' = 22 a1 + 3 a2, a2' = 7 a1 + a2
    // (determinant 1). The same scan state then has psi1' = 22 psi1 + 3 psi2
    // and psi2' = 7 psi1 + psi2.
    const vec2 skewed_a1{22 * c.a1.x + 3 * c.a2.x, 22 * c.a1.y + 3 * c.a2.y};
    const vec2 skewed_a2{7 * c.a1.x + c.a2.x, 7 * c.a1.y + c.a2.y};
    const nec_periodic::lattice_2d plain(c.a1, c.a2), skewed(skewed_a1, skewed_a2);
    const double psi1 = -0.8, psi2 = 1.3;
    const vec2 kt0 = plain.scan_wavevector(psi1, psi2);
    const vec2 skewed_kt0 = skewed.scan_wavevector(22 * psi1 + 3 * psi2, 7 * psi1 + psi2);
    INFO(c.name);
    CHECK(std::abs(kt0.x * c.a1.x + kt0.y * c.a1.y + psi1) < 1e-12);  // psi_i = -kt0 . a_i
    CHECK(std::abs(kt0.x * c.a2.x + kt0.y * c.a2.y + psi2) < 1e-12);
    CHECK(std::abs(kt0.x - skewed_kt0.x) < 1e-11);
    CHECK(std::abs(kt0.y - skewed_kt0.y) < 1e-11);
    // Compared with the direct sum over the plain vectors, not with the plain
    // lattice's own Ewald result.
    const nec_periodic::periodic_green skewed_green(skewed, k, skewed_kt0);
    for(const point& r : points) {
      const auto reference = direct_smooth_sum(c, k, kt0, r);
      CHECK(relative_error(skewed_green.smooth(r).value, reference.value) < 1e-10);
    }
  }
}

TEST_CASE("Ewald kernel does not depend on the splitting parameter", "[periodic_green]") {
  const complex_d k = 2 * pi;
  const point points[] = {{0.0, 0.0, 0.0}, {0.21, -0.13, 0.07}, {0.003, 0.0, 0.001}, {0.3, 0.2, 1.3}};
  // Smaller splitting on large cells raises k/(2E) and the Ewald terms cancel
  // with magnitude exp((k/2E)^2): about 1e-8 relative at k/(2E) = 3.3. The
  // automatic choice caps k/(2E) at 2; 0.8x stays near that bound.
  const double factors[] = {0.8, 1.5, 3.0};
  for(const auto& c : all_lattices_and_scans()) {
    REQUIRE(smallest_kz(c.lattice, k, c.kt0) > 0.3);
    const nec_periodic::lattice_2d lattice(c.lattice.a1, c.lattice.a2);
    const nec_periodic::periodic_green automatic(lattice, k, c.kt0);
    for(const double factor : factors) {
      const nec_periodic::periodic_green other(lattice, k, c.kt0, factor * automatic.splitting());
      for(const point& r : points) {
        INFO(c.lattice.name << ", kt0 = (" << c.kt0.x << ", " << c.kt0.y << "), splitting x" << factor
             << ", r = (" << r[0] << ", " << r[1] << ", " << r[2] << ")");
        const auto reference = automatic.smooth(r);
        const auto value = other.smooth(r);
        CHECK(relative_error(value.value, reference.value) < 1e-9);
        CHECK(gradient_error(value, reference, k) < 1e-9);
      }
    }
  }
}

TEST_CASE("Complex erfc matches high-precision reference values", "[periodic_green]") {
  // z.re, z.im, erfc(z).re, erfc(z).im: 50+ digit Maclaurin series of erf.
  const double cases[][4] = {
    {0.0, 0.0, 1.0, 0.0},
    {0.5, 0.0, 0.4795001221869535, 0.0},
    {-0.5, 0.0, 1.5204998778130465, 0.0},
    {1.0, 1.0, -0.31615128169794765, -0.19045346923783468},
    {-1.5, 0.5, 2.00760548622137, -0.041697093665554595},
    {2.0, -3.0, 21.829461427614568, 8.687318271470163},
    {0.3, 2.9, -849.4339214350009, 40.061826933266175},
    {5.0, 0.1, 8.135637230298416e-13, -1.3224158313587025e-12},
    {0.01, 6.0, -48528755243081.89, -408359969874301.75},
    {10.0, 10.0, 0.038350625727525144, 0.010987684608193988},
    {-8.0, 3.0, 2.0, 8.047951852515509e-26},
    {20.0, -1.0, -1.030180007969862e-175, 1.0415155073282036e-175},
    {3.0, 0.0, 2.209049699858544e-05, 0.0},
    {6.0, 0.0, 2.1519736712498913e-17, 0.0},
    {1e-08, 1e-08, 0.9999999887162083, -1.1283791670955125e-08},
    {6.5, -6.5, -0.055086584151028746, -0.02705162759393158},
    {0.0, 5.0, 1.0, -8298273880.676804},
    {-4.0, -4.0, 1.9785492330760819, 0.09733969063083187},
    {0.8, 3.0, 796.8918473625966, 167.24084958534834},
    {25.0, 0.5, 1.0587823237964947e-273, 1.1991376304540743e-274},
    {-0.2, 0.0, 1.2227025892104784, 0.0},
    {0.0, -2.5, 1.0, 130.39575501324694},
    {4.4, 6.3, 49084856.09101319, 7699482.339682955},
    {0.001, 0.0, 0.9988716212090307, 0.0},
    {-30.0, 2.0, 2.0, 0.0},
  };
  for(const auto& c : cases) {
    INFO("z = " << c[0] << " + " << c[1] << "j");
    const complex_d reference(c[2], c[3]);
    CHECK(relative_error(nec_periodic::erfc_complex({c[0], c[1]}), reference) < 1e-13);
  }
}

TEST_CASE("exp(a) erfc(z) stays finite where either factor alone overflows", "[periodic_green]") {
  // a.re, a.im, z.re, z.im, reference.re, reference.im
  const double cases[][6] = {
    {800.0, 0.0, 30.0, 0.0, 6.992213460131408e-46, 0.0},
    {-700.0, 3.0, -0.5, 26.0, -4.143502609347888e-13, 4.855833013922529e-13},
    {600.0, -1.0, 25.0, 2.0, 1.4541779475659382e-11, -8.890433919924914e-12},
    {0.0, 12.566370614359172, 2.0, -1.5, 0.036382419142707186, 0.011003373852137916},
    {-37.7, 0.0, -6.0, 0.0, 8.474772094993366e-17, 0.0},
  };
  for(const auto& c : cases) {
    INFO("a = " << c[0] << " + " << c[1] << "j, z = " << c[2] << " + " << c[3] << "j");
    const complex_d reference(c[4], c[5]);
    CHECK(relative_error(nec_periodic::exp_erfc({c[0], c[1]}, {c[2], c[3]}), reference) < 1e-12);
  }
}
