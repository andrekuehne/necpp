/*
  The spectral Ewald sum's share of the periodic fill, evaluated per Floquet
  mode from tables in dz (nec_periodic_spectral_fill.h), against the route it
  replaces: the segment field of periodic_green::spectral, pair by pair.
*/
#include <catch2/catch_test_macros.hpp>

#include "nec_periodic_accuracy.h"
#include "nec_periodic_green.h"
#include "nec_periodic_spectral_fill.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <stdexcept>
#include <vector>

using nec_periodic::complex_d;
using nec_periodic::point;
using nec_periodic::source_segment;
using nec_periodic::spectral_fill;
using nec_periodic::vec2;

namespace {
constexpr double pi = 3.141592653589793238462643383279502884;
constexpr double k = 2 * pi;  // lengths in wavelengths

std::vector<source_segment> wire(point a, point b, int count) {
  const double length = std::hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const point u = {(b[0] - a[0]) / length, (b[1] - a[1]) / length, (b[2] - a[2]) / length};
  std::vector<source_segment> segments;
  for(int i = 0; i < count; ++i) {
    const double t = (i + 0.5) / count;
    segments.push_back(
      {{a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])}, u, length / count});
  }
  return segments;
}

// Crossed half-wave dipoles, 2 x 11 segments, a quarter wavelength high.
std::vector<source_segment> crossed_dipole() {
  std::vector<source_segment> cell = wire({-0.24, 0, 0.25}, {0.24, 0, 0.25}, 11);
  const std::vector<source_segment> second = wire({0, -0.24, 0.27}, {0, 0.24, 0.27}, 11);
  cell.insert(cell.end(), second.begin(), second.end());
  return cell;
}

// An axial-mode helix, 84 segments in 7 turns of circumference 1.
std::vector<source_segment> helix() {
  std::vector<source_segment> cell;
  const auto at = [](int i) {
    const double angle = 2 * pi * i / 12;
    return point{0.159 * std::cos(angle), 0.159 * std::sin(angle), 0.03 + 0.23 * i / 12.0};
  };
  for(int i = 0; i < 84; ++i) cell.push_back(wire(at(i), at(i + 1), 1).front());
  return cell;
}

spectral_fill::geometry cell_of(const std::vector<source_segment>& segments, bool ground) {
  spectral_fill::geometry cell;
  cell.sources = segments;
  for(const source_segment& segment : segments) cell.observations.push_back(segment.centre);
  cell.ground_image = ground;
  return cell;
}

// The route the fill replaces: segment_field_of_kernel under the spectral
// sum, per pair, with the ground image mirrored and of opposite sign.
std::vector<nec_periodic::segment_field_components> reference_fields(const nec_periodic::periodic_green& green,
                                                                     const spectral_fill::geometry& cell) {
  std::vector<nec_periodic::segment_field_components> fields;
  for(const point& observation : cell.observations)
    for(const source_segment& source : cell.sources) {
      nec_periodic::segment_field_components sum{};
      for(int image = 0; image < (cell.ground_image ? 2 : 1); ++image) {
        source_segment segment = source;
        if(image) {
          segment.centre[2] = -segment.centre[2];
          segment.direction[2] = -segment.direction[2];
        }
        const nec_periodic::segment_field field = nec_periodic::segment_field_of_kernel(
          [&green](const point& r) { return green.spectral(r); }, segment, observation, k);
        const double sign = image ? -1.0 : 1.0;
        for(int c = 0; c < 3; ++c) {
          sum[size_t(c)] += sign * field.constant[size_t(c)];
          sum[3 + size_t(c)] += sign * field.sine[size_t(c)];
          sum[6 + size_t(c)] += sign * field.cosine[size_t(c)];
        }
      }
      fields.push_back(sum);
    }
  return fields;
}

// Largest difference of any component, relative to the largest component.
double difference(const std::vector<nec_periodic::segment_field_components>& value,
                  const std::vector<nec_periodic::segment_field_components>& reference) {
  double largest = 0, worst = 0;
  for(size_t pair = 0; pair < reference.size(); ++pair)
    for(size_t c = 0; c < 9; ++c) {
      largest = std::max(largest, std::abs(reference[pair][c]));
      worst = std::max(worst, std::abs(value[pair][c] - reference[pair][c]));
    }
  return worst / largest;
}

struct fill_case {
  const char* name;
  std::vector<source_segment> segments;
  bool ground;
  vec2 a1, a2;
  vec2 scan;  // kt0
  double kappa;  // k / 2E, 0 for the automatic splitting
};

vec2 direction(double theta_deg, double phi_deg) {
  const double theta = theta_deg * pi / 180, phi = phi_deg * pi / 180;
  return {k * std::sin(theta) * std::cos(phi), k * std::sin(theta) * std::sin(phi)};
}

std::vector<fill_case> cases() {
  const std::vector<source_segment> tilted = wire({-0.2, -0.05, 0.1}, {0.2, 0.08, 0.35}, 15);
  const double h = 0.6;
  // (-1, 0) of the 0.7 x 0.6 lattice 1e-7 inside cut-off: |kz| / k about 4.5e-4, split.
  const double b1 = 2 * pi / 0.7;
  const vec2 near_wood{b1 - k * (1 - 1e-7), 0.0};
  return {
    {"crossed dipole over ground, square 0.5", crossed_dipole(), true, {0.5, 0}, {0, 0.5}, direction(30, 20), 0},
    {"crossed dipole over ground, square 0.5, k/2E = 3", crossed_dipole(), true, {0.5, 0}, {0, 0.5},
     direction(30, 20), 3},
    {"helix over ground, square 0.8", helix(), true, {0.8, 0}, {0, 0.8}, direction(30, 20), 0},
    {"helix over ground, square 0.8, k/2E = 3", helix(), true, {0.8, 0}, {0, 0.8}, direction(30, 20), 3},
    {"tilted wire, hexagonal 0.6, oblique scan", tilted, false, {h, 0}, {h / 2, h * std::sqrt(3.0) / 2},
     direction(40, -35), 0},
    {"tilted wire over ground, hexagonal 0.6, k/2E = 3", tilted, true, {h, 0}, {h / 2, h * std::sqrt(3.0) / 2},
     direction(40, -35), 3},
    {"tilted wire, oblique lattice, invisible space", tilted, false, {0.55, 0.1}, {0.2, 0.62}, {1.3 * k, 0.2 * k}, 2},
    {"tilted wire near a Wood anomaly", tilted, false, {0.7, 0}, {0, 0.6}, near_wood, 0},
    {"tilted wire over ground near a Wood anomaly, k/2E = 3", tilted, true, {0.7, 0}, {0, 0.6}, near_wood, 3},
  };
}

nec_periodic::periodic_green green_of(const fill_case& c) {
  const nec_periodic::lattice_2d lattice(c.a1, c.a2);
  return nec_periodic::periodic_green(lattice, k, c.scan, c.kappa > 0 ? k / (2 * c.kappa) : 0.0);
}
}

TEST_CASE("The spectral fill from tables in dz equals the segment fields of the spectral sum", "[periodic_green]") {
  for(const fill_case& c : cases()) {
    INFO(c.name);
    const nec_periodic::periodic_green green = green_of(c);
    const spectral_fill::geometry cell = cell_of(c.segments, c.ground);
    const spectral_fill fill(green, cell);
    std::vector<nec_periodic::segment_field_components> fields;
    const double estimate = fill.evaluate(green, fields);
    const double measured = difference(fields, reference_fields(green, cell));
    INFO("route " << int(fill.chosen_route()) << ", nodes " << fill.node_count() << ", estimate " << estimate
                  << ", difference " << measured);
    CHECK(measured < 1e-11);
    // The table stays well within the kernel's own accuracy.
    CHECK(estimate < nec_periodic::kernel_error / 4);
  }
}

TEST_CASE("A planar cell evaluates its few distinct height differences exactly", "[periodic_green]") {
  const fill_case planar = cases().front();
  const nec_periodic::periodic_green green = green_of(planar);
  const spectral_fill fill(green, cell_of(planar.segments, true));
  CHECK(fill.chosen_route() == spectral_fill::route::distinct);
  // 0, +-0.02 between the dipoles, and 0.5, 0.52, 0.54 to the images.
  CHECK(fill.node_count() == 6);
  std::vector<nec_periodic::segment_field_components> fields;
  CHECK(fill.evaluate(green, fields) == 0);
  CHECK(difference(fields, reference_fields(green, cell_of(planar.segments, true))) < 1e-13);
}

TEST_CASE("A cell whose table exceeds the size bound evaluates every kernel sample directly", "[periodic_green]") {
  const fill_case tall = cases()[4];
  const nec_periodic::periodic_green green = green_of(tall);
  const spectral_fill::geometry cell = cell_of(tall.segments, tall.ground);
  CHECK(spectral_fill(green, cell).chosen_route() == spectral_fill::route::table);
  const spectral_fill bounded(green, cell, 100);
  CHECK(bounded.chosen_route() == spectral_fill::route::direct);
  std::vector<nec_periodic::segment_field_components> fields;
  CHECK(bounded.evaluate(green, fields) == 0);
  CHECK(difference(fields, reference_fields(green, cell)) < 1e-14);
}

TEST_CASE("The spectral fill refuses a kernel of another splitting", "[periodic_green]") {
  const fill_case c = cases()[4];
  const nec_periodic::periodic_green green = green_of(c);
  const spectral_fill fill(green, cell_of(c.segments, c.ground));
  const nec_periodic::periodic_green other(green.lattice(), k, c.scan, green.splitting() * 1.5);
  std::vector<nec_periodic::segment_field_components> fields;
  CHECK_THROWS_AS(fill.evaluate(other, fields), std::invalid_argument);
}

// Timing, not a gate: run with "[periodic_fill_bench]".
TEST_CASE("Spectral fill timing against the per-pair route", "[.][periodic_fill_bench]") {
  using clock = std::chrono::steady_clock;
  const auto seconds = [](clock::time_point start) {
    return std::chrono::duration<double>(clock::now() - start).count();
  };
  for(const size_t index : {size_t(0), size_t(1), size_t(2), size_t(3)}) {
    const fill_case c = cases()[index];
    const nec_periodic::periodic_green green = green_of(c);
    const spectral_fill::geometry cell = cell_of(c.segments, c.ground);
    auto start = clock::now();
    const auto reference = reference_fields(green, cell);
    const double per_pair = seconds(start);
    start = clock::now();
    const spectral_fill fill(green, cell);
    const double prepare = seconds(start);
    std::vector<nec_periodic::segment_field_components> fields;
    start = clock::now();
    const int repeats = 5;
    for(int r = 0; r < repeats; ++r) fill.evaluate(green, fields);
    const double per_mode = seconds(start) / repeats;
    WARN(c.name << ": modes " << green.spectral_modes().size() << ", per pair " << 1e3 * per_pair
                << " ms, per mode " << 1e3 * per_mode << " ms (prepare " << 1e3 * prepare << " ms), speed-up "
                << per_pair / per_mode);
  }
}
