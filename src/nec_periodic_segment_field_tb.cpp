// Native seam for the field of a segment under the periodic kernel (stage 1
// of the periodic solver): the sign and normalization guard against NEC's
// own segment field, and convergence of the Gauss rule under the smooth
// periodic kernel.
#include <catch2/catch_test_macros.hpp>
#include "nec_context.h"
#include "nec_periodic_green.h"
#include <algorithm>
#include <array>
#include <cmath>

using nec_periodic::complex_d;
using nec_periodic::green_value;
using nec_periodic::point;
using nec_periodic::segment_field;
using nec_periodic::source_segment;

// Declared a friend of nec_context: calls the private efld_compute.
struct nec_context_segment_field_access {
  // NEC's segment field (exact thin-wire branch, lumped-element approximation
  // disabled) of the current terms 1, sin(ks), cos(ks) on one segment, in NEC's
  // normalization: lengths in wavelengths, k = 2 pi.
  static segment_field field(const source_segment& segment, const point& observation, double radius) {
    nec_context nec;
    nec.initialize();
    nec.cabj = segment.direction[0];
    nec.sabj = segment.direction[1];
    nec.salpj = segment.direction[2];
    nec.m_s = segment.length;
    nec.m_b = radius;
    nec.m_use_exk = false;
    nec.rkh = 1e9;
    nec_complex e[9];
    nec.efld_compute(observation[0] - segment.centre[0], observation[1] - segment.centre[1], radius,
                     segment.direction[2], observation[2] - segment.centre[2], true, e);
    return {{e[0], e[1], e[2]}, {e[3], e[4], e[5]}, {e[6], e[7], e[8]}};
  }
};

namespace {
const complex_d j(0.0, 1.0);
using field_vector = std::array<complex_d, 3>;

point point_sum(const point& a, const point& b) { return {a[0] + b[0], a[1] + b[1], a[2] + b[2]}; }
point scaled(double s, const point& a) { return {s * a[0], s * a[1], s * a[2]}; }
point unit(double x, double y, double z) { return scaled(1 / std::sqrt(x * x + y * y + z * z), {x, y, z}); }

double size(const field_vector& v) { return std::sqrt(std::norm(v[0]) + std::norm(v[1]) + std::norm(v[2])); }
field_vector difference(const field_vector& a, const field_vector& b) { return {a[0] - b[0], a[1] - b[1], a[2] - b[2]}; }
double vector_error(const field_vector& value, const field_vector& reference) {
  return size(difference(value, reference)) / size(reference);
}

complex_d along(const field_vector& v, const point& u) { return v[0] * u[0] + v[1] * u[1] + v[2] * u[2]; }
field_vector across(const field_vector& v, const point& u) {
  const complex_d a = along(v, u);
  return {v[0] - a * u[0], v[1] - a * u[1], v[2] - a * u[2]};
}

double field_error(const segment_field& value, const segment_field& reference) {
  return std::max({vector_error(value.constant, reference.constant), vector_error(value.sine, reference.sine),
                   vector_error(value.cosine, reference.cosine)});
}
}

TEST_CASE("Segment field of the free-space kernel matches NEC's segment field", "[periodic_green]") {
  const double k = 2 * pi(), radius = 1e-7;
  // G = exp(-jkR)/(4 pi R) with the thin-wire distance R = sqrt(|r|^2 + a^2).
  const auto free_space = [&](const point& r) {
    const double distance = std::sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2] + radius * radius);
    green_value g{};
    g.value = std::exp(-j * k * distance) / (4 * pi() * distance);
    const complex_d derivative_over_distance = -g.value * (1.0 + j * k * distance) / (distance * distance);
    for(int i = 0; i < 3; ++i) g.gradient[i] = derivative_over_distance * r[i];
    return g;
  };
  struct geometry {
    const char* name;
    point direction, offset;  // observation = centre + offset
  };
  const point skewed_axis = unit(1, 2, 0.5);
  const geometry geometries[] = {
    {"parallel, near", {0, 0, 1}, {0.06, 0.0, 0.01}},
    {"parallel, far", {0, 0, 1}, {1.3, -0.8, 0.6}},
    {"collinear", {0, 0, 1}, {0.0, 0.0, 0.12}},
    {"collinear, skewed axis", skewed_axis, scaled(0.2, skewed_axis)},
    {"skewed, near", skewed_axis, {0.07, -0.11, 0.04}},
    {"skewed, far", unit(-0.3, 1, -2), {0.9, 0.4, -1.1}},
    {"horizontal, beside", {1, 0, 0}, {0.01, 0.08, -0.03}},
  };
  const point centre{0.1, -0.2, 0.3};
  for(const double length : {0.1, 0.05, 0.02}) {
    for(const geometry& g : geometries) {
      INFO(g.name << ", segment length " << length);
      const source_segment segment{centre, g.direction, length};
      const point observation = point_sum(centre, g.offset);
      const auto reference = nec_context_segment_field_access::field(segment, observation, radius);
      const auto value = nec_periodic::segment_field_of_kernel(free_space, segment, observation, k, 32);
      // NEC's sine and cosine terms and the transverse part of its constant
      // term are closed form; the axial part of the constant term comes from a
      // Romberg integral with tolerance 1e-4.
      CHECK(vector_error(value.sine, reference.sine) < 1e-9);
      CHECK(vector_error(value.cosine, reference.cosine) < 1e-9);
      const double constant_size = size(reference.constant);
      CHECK(size(difference(across(value.constant, g.direction), across(reference.constant, g.direction))) / constant_size
            < 1e-9);
      CHECK(std::abs(along(value.constant, g.direction) - along(reference.constant, g.direction)) / constant_size
            < 1e-4);
    }
  }
}

TEST_CASE("Segment field of the smooth periodic kernel converges with the Gauss order", "[periodic_green]") {
  const double k = 2 * pi();
  struct lattice_case {
    const char* name;
    nec_periodic::vec2 a1, a2;
    complex_d k;
  };
  const lattice_case lattices[] = {
    {"square", {0.5, 0.0}, {0.0, 0.5}, k},
    {"hexagonal, lossy", {0.55, 0.0}, {0.275, 0.4763139720814413}, k * complex_d(1.0, -0.05)},
    {"oblique, lossy", {0.5, 0.0}, {0.17, 0.43}, k * complex_d(1.0, -0.05)},
  };
  const point centre{0.02, -0.03, 0.01}, direction = unit(0.3, 1, 0.2);
  for(const lattice_case& c : lattices) {
    const nec_periodic::periodic_green green({c.a1, c.a2}, c.k, {1.7, -0.9});
    const auto smooth = [&](const point& r) { return green.smooth(r); };
    for(const double length : {0.1, 0.05, 0.025}) {
      const source_segment segment{centre, direction, length};
      // Observation on the source segment itself (centre and end), on a
      // neighbouring segment, and towards the cell wall.
      const point offsets[] = {{0.0, 0.0, 0.0}, scaled(length / 2, direction), {0.12, 0.05, 0.0}, {0.2, -0.1, 0.05}};
      for(const point& offset : offsets) {
        const point observation = point_sum(centre, offset);
        const auto reference = nec_periodic::segment_field_of_kernel(smooth, segment, observation, k, 48);
        // Rounding floor: two converged rules differ only by rounding, which on
        // short segments is raised by the cancellation between the charge and
        // end-charge terms (about 1/(kL)^2).
        const double floor =
          10 * field_error(nec_periodic::segment_field_of_kernel(smooth, segment, observation, k, 40), reference);
        double previous = 1e300;
        for(int order = 1; order <= 8; ++order) {
          const double error =
            field_error(nec_periodic::segment_field_of_kernel(smooth, segment, observation, k, order), reference);
          INFO(c.name << ", segment length " << length << ", offset (" << offset[0] << ", " << offset[1] << ", "
               << offset[2] << "), order " << order << ", error " << error << ", rounding floor " << floor);
          CHECK(floor < 1e-10);
          CHECK((error < previous || error < floor));  // converges down to the rounding floor
          if(order == nec_periodic::default_segment_gauss_order) CHECK(error < 1e-10);
          previous = error;
        }
      }
    }
  }
}

TEST_CASE("Segment field refuses Gauss orders outside the supported range", "[periodic_green]") {
  const auto zero = [](const point&) { return green_value{}; };
  const source_segment segment{{0, 0, 0}, {0, 0, 1}, 0.1};
  CHECK_THROWS_AS(nec_periodic::segment_field_of_kernel(zero, segment, {0.1, 0, 0}, 2 * pi(), 0),
                  std::invalid_argument);
  CHECK_THROWS_AS(nec_periodic::segment_field_of_kernel(zero, segment, {0.1, 0, 0}, 2 * pi(),
                                                        nec_periodic::max_segment_gauss_order + 1),
                  std::invalid_argument);
}
