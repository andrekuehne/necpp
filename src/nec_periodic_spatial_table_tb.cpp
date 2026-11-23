/*
  The spatial Ewald term from tables in the distance
  (nec_periodic_spatial_table.h) against periodic_green::spatial_term.
*/
#include <catch2/catch_test_macros.hpp>

#include "nec_periodic_accuracy.h"
#include "nec_periodic_green.h"
#include "nec_periodic_spatial_table.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <vector>

using nec_periodic::complex_d;
using nec_periodic::green_value;
using nec_periodic::point;
using nec_periodic::vec2;

namespace {
constexpr double pi = 3.141592653589793238462643383279502884;
constexpr double k = 2 * pi;

// Value and gradient error at distance R from the lattice point, relative to
// the free-space term 1 / (4 pi R) the image stands for and its gradient
// (k + 1 / R) / (4 pi R); at the origin's smooth term, R at least 1 / k.
double error_of(const green_value& value, const green_value& reference, double distance) {
  double gradient = 0;
  for(int axis = 0; axis < 3; ++axis)
    gradient = std::max(gradient, std::abs(value.gradient[size_t(axis)] - reference.gradient[size_t(axis)]));
  const double r = std::max(distance, 1 / k);
  const double size = 1 / (4 * pi * r);
  return std::max(std::abs(value.value - reference.value) / size, gradient / ((k + 1 / r) * size));
}

double distance_from(vec2 rho, const point& r) { return std::hypot(r[0] - rho.x, r[1] - rho.y, r[2]); }

struct table_case {
  const char* name;
  vec2 a1, a2;
  double kappa;  // k / 2E, 0 automatic
};

std::vector<table_case> cases() {
  return {{"square 0.5", {0.5, 0}, {0, 0.5}, 0},
          {"square 0.5, k/2E = 3", {0.5, 0}, {0, 0.5}, 3},
          {"hexagonal 0.8", {0.8, 0}, {0.4, 0.8 * std::sqrt(3.0) / 2}, 0},
          {"oblique, k/2E = 2.5", {0.55, 0.1}, {0.2, 0.62}, 2.5}};
}

nec_periodic::periodic_green green_of(const table_case& c) {
  return nec_periodic::periodic_green(nec_periodic::lattice_2d(c.a1, c.a2), k, {1.1, -0.4},
                                      c.kappa > 0 ? k / (2 * c.kappa) : 0.0);
}

// Points at distances from 0 to range from rho, in varied directions.
std::vector<point> points_around(vec2 rho, double range) {
  std::vector<point> points;
  for(int i = 0; i <= 400; ++i) {
    const double distance = range * i / 400.0;
    const double polar = 0.37 * i, azimuth = 1.71 * i;
    points.push_back({rho.x + distance * std::sin(polar) * std::cos(azimuth),
                      rho.y + distance * std::sin(polar) * std::sin(azimuth), distance * std::cos(polar)});
  }
  return points;
}
}

TEST_CASE("The spatial term from tables in the distance equals the direct term", "[periodic_green]") {
  for(const table_case& c : cases()) {
    INFO(c.name);
    const nec_periodic::periodic_green green = green_of(c);
    const double range = green.spatial_radius() + 0.2;
    const nec_periodic::spatial_table table(green, range, 1.5);
    REQUIRE(table.full_tabulated());
    REQUIRE(table.smooth_tabulated());
    INFO("interpolation error " << table.interpolation_error());
    CHECK(table.interpolation_error() < nec_periodic::kernel_error / 4);
    const vec2 rho = green.lattice().a1();
    double full = 0, origin = 0, close = 0;
    for(const point& r : points_around(rho, range)) {
      if(distance_from(rho, r) < 0.02) continue;
      full = std::max(full, error_of(table.term(rho, r, false), green.spatial_term(rho, r, false), distance_from(rho, r)));
    }
    for(const point& r : points_around({0, 0}, 1.5))
      origin = std::max(origin, error_of(table.term({0, 0}, r, true), green.spatial_term({0, 0}, r, true),
                                         distance_from({0, 0}, r)));
    // A close image: the full term minus the free-space term.
    for(const point& r : points_around(rho, 0.3)) {
      if(distance_from(rho, r) < 0.05) continue;
      green_value reference = green.spatial_term(rho, r, false);
      const green_value free = nec_periodic::free_space_green({r[0] - rho.x, r[1] - rho.y, r[2]}, k);
      reference.value -= free.value;
      for(int axis = 0; axis < 3; ++axis) reference.gradient[size_t(axis)] -= free.gradient[size_t(axis)];
      close = std::max(close, error_of(table.term(rho, r, true), reference, distance_from(rho, r)));
    }
    INFO("full " << full << ", origin " << origin << ", close " << close);
    CHECK(full < 1e-11);
    CHECK(origin < 1e-11);
    CHECK(close < 1e-11);
  }
}

TEST_CASE("The spatial term is evaluated directly beyond the tables' range or size", "[periodic_green]") {
  const nec_periodic::periodic_green green = green_of(cases().front());
  const vec2 rho = green.lattice().a1();
  const point far = {rho.x + 0.9, rho.y, 0.3}, near_origin = {0.9, 0.2, 0.3};
  const nec_periodic::spatial_table short_tables(green, 0.5, 0.5);
  CHECK(short_tables.term(rho, far, false).value == green.spatial_term(rho, far, false).value);
  CHECK(short_tables.term({0, 0}, near_origin, true).value == green.spatial_term({0, 0}, near_origin, true).value);
  const nec_periodic::spatial_table bounded(green, 3.0, 3.0, 10);
  CHECK(!bounded.full_tabulated());
  CHECK(!bounded.smooth_tabulated());
  CHECK(bounded.interpolation_error() == 0);
  CHECK(bounded.term(rho, far, false).value == green.spatial_term(rho, far, false).value);
}

// Timing, not a gate: run with "[periodic_fill_bench]".
TEST_CASE("Spatial table timing against the direct term", "[.][periodic_fill_bench]") {
  const nec_periodic::periodic_green green = green_of(cases()[1]);
  const nec_periodic::spatial_table table(green, green.spatial_radius() + 0.2, 1.5);
  const vec2 rho = green.lattice().a1();
  const std::vector<point> points = points_around(rho, green.spatial_radius());
  using clock = std::chrono::steady_clock;
  complex_d sink = 0;
  auto start = clock::now();
  const int repeats = 2000;
  for(int r = 0; r < repeats; ++r)
    for(const point& p : points) sink += table.term(rho, p, false).value;
  const double tabulated = std::chrono::duration<double>(clock::now() - start).count() / (repeats * points.size());
  start = clock::now();
  for(int r = 0; r < repeats / 20; ++r)
    for(const point& p : points) sink += green.spatial_term(rho, p, false).value;
  const double direct = std::chrono::duration<double>(clock::now() - start).count() / (repeats / 20 * points.size());
  WARN("spatial term: table " << 1e9 * tabulated << " ns, direct " << 1e9 * direct << " ns (" << std::abs(sink) << ")");
}
