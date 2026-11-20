/*
  Contract tests for the periodic (infinite-array) entry points of the
  stateful model: argument validation, lifecycle and refusals. The physics of
  the scan impedance is tested at the WASM package seam.
*/
#include <catch2/catch_test_macros.hpp>

#include "c_geometry.h"
#include "electromag.h"
#include "math_util.h"
#include "nec_context.h"
#include "nec_exception.h"
#include "nec_periodic_accuracy.h"
#include "nec_periodic_green.h"
#include "nec_stateful_model.h"

#include <cmath>
#include <limits>
#include <string>
#include <vector>

// Declared a friend of nec_stateful_model and nec_context: the internal test
// seam of the low-rank update, which widens the split of Floquet modes near
// cut-off.
struct nec_periodic_split_access {
  static void set_near_cutoff(nec_stateful_model& model, nec_float ratio)
  {
    model.m_context->m_periodic_near_cutoff = ratio;
  }
  static size_t split_mode_count(const nec_stateful_model& model)
  {
    return model.m_context->m_periodic_green->split_modes().size();
  }
};

namespace {

constexpr nec_float frequency_mhz = 299.792458;  // one metre wavelength

nec_wire_definition half_wave_dipole(int tag = 1)
{
  return {tag, 11, 0.0, 0.0, -0.24, 0.0, 0.0, 0.24, 0.001};
}

void build_dipole_cell(nec_stateful_model& model)
{
  model.add_wire(half_wave_dipole());
  model.complete_geometry();
  model.define_ports({{1, 6}});
}

nec_lattice_definition square_lattice(nec_float spacing_m)
{
  return {spacing_m, 0.0, 0.0, spacing_m};
}

nec_complex port_impedance(nec_stateful_model& model)
{
  model.prepare(frequency_mhz);
  return model.compute_impedance_matrix().impedance.at(0, 0);
}

nec_far_field_grid one_direction()
{
  nec_far_field_grid grid;
  grid.theta_start_deg = 90.0;
  return grid;
}

// The reason of the refusal the operation must raise as an Exception.
template <typename Exception, typename Operation>
std::string refusal(Operation operation)
{
  try {
    operation();
  } catch (const Exception& error) {
    return error.get_message();
  }
  FAIL("the operation was not refused");
  return {};
}

bool mentions(const std::string& reason, const char* text)
{
  return reason.find(text) != std::string::npos;
}

} // namespace

TEST_CASE("Periodic setters validate their state and arguments", "[periodic_model]")
{
  nec_stateful_model model;
  REQUIRE_THROWS_AS(model.set_lattice(square_lattice(0.7)), nec_exception);

  build_dipole_cell(model);
  REQUIRE_FALSE(model.periodic());
  REQUIRE_THROWS_AS(model.set_scan_phases(0.5, 0.0), nec_exception);

  const nec_float nan = std::numeric_limits<nec_float>::quiet_NaN();
  REQUIRE_THROWS_AS(model.set_lattice({0.7, 0.0, 1.4, 0.0}), nec_exception);
  REQUIRE_THROWS_AS(model.set_lattice({nan, 0.0, 0.0, 0.7}), nec_exception);
  REQUIRE_FALSE(model.periodic());

  model.set_lattice(square_lattice(0.7));
  REQUIRE(model.periodic());
  REQUIRE_THROWS_AS(model.set_scan_phases(nan, 0.0), nec_exception);
  REQUIRE_THROWS_AS(
    model.set_scan_phases(0.0, std::numeric_limits<nec_float>::infinity()),
    nec_exception);
  model.set_scan_phases(0.5, -0.25);

  model.clear_lattice();
  REQUIRE_FALSE(model.periodic());
  REQUIRE_THROWS_AS(model.set_scan_phases(0.5, 0.0), nec_exception);
}

TEST_CASE("A scan change invalidates the factorization", "[periodic_model]")
{
  nec_stateful_model model;
  build_dipole_cell(model);
  model.set_lattice(square_lattice(0.7));
  model.prepare(frequency_mhz);
  REQUIRE(model.state() == nec_model_state::prepared);
  const uint64_t generation = model.factorization_generation();

  model.set_scan_phases(1.0, 0.0);
  REQUIRE(model.state() == nec_model_state::geometry_complete);
  REQUIRE_THROWS_AS(model.compute_impedance_matrix(), nec_exception);

  model.prepare(frequency_mhz);
  REQUIRE(model.factorization_generation() == generation + 1);
}

TEST_CASE("The lattice changes the port impedance until it is cleared", "[periodic_model]")
{
  nec_stateful_model model;
  build_dipole_cell(model);
  const nec_complex isolated = port_impedance(model);

  model.set_lattice(square_lattice(0.7));
  const nec_complex periodic = port_impedance(model);
  REQUIRE(std::isfinite(periodic.real()));
  REQUIRE(std::isfinite(periodic.imag()));
  REQUIRE(std::abs(periodic - isolated) > 1.0);

  model.clear_lattice();
  REQUIRE(port_impedance(model) == isolated);
}

TEST_CASE("A lattice under which a conductor touches its image is refused without effect", "[periodic_model]")
{
  nec_stateful_model model;
  build_dipole_cell(model);
  model.set_lattice(square_lattice(0.7));
  const nec_complex before = port_impedance(model);

  // The vertical dipoles of 1 mm radius would stand 1.5 mm apart along y.
  REQUIRE_THROWS_AS(model.set_lattice({0.7, 0.0, 0.0, 0.0015}), nec_geometry_exception);
  REQUIRE(model.periodic());
  REQUIRE(model.state() == nec_model_state::prepared);
  REQUIRE(port_impedance(model) == before);
}

TEST_CASE("Periodic mode refuses symmetry and finite ground", "[periodic_model]")
{
  SECTION("symmetric geometry")
  {
    nec_stateful_model model;
    model.add_wire({1, 5, 0.0, 0.0, 0.0, 0.0, 0.0, 0.24, 0.001});
    nec_geometry_symmetry symmetry;
    symmetry.kind = nec_geometry_symmetry_kind::reflection;
    symmetry.reflection_plane_mask = nec_reflection_plane_z;
    symmetry.tag_increment = 1;
    model.complete_geometry(symmetry);
    REQUIRE_THROWS_AS(model.set_lattice(square_lattice(0.7)), nec_exception);
    REQUIRE_FALSE(model.periodic());
  }

  SECTION("finite ground")
  {
    nec_stateful_model model;
    build_dipole_cell(model);
    nec_ground_definition finite;
    finite.kind = nec_ground_kind::finite_reflection_coefficient;
    finite.relative_permittivity = 13.0;
    finite.conductivity_s_per_m = 0.005;
    model.set_ground(finite);
    REQUIRE(mentions(refusal<nec_geometry_exception>(
      [&] { model.set_lattice(square_lattice(0.7)); }), "FINITE GROUND"));

    model.set_ground(nec_ground_definition{});
    model.set_lattice(square_lattice(0.7));
    REQUIRE(mentions(refusal<nec_geometry_exception>(
      [&] { model.set_ground(finite); }), "FINITE GROUND"));
  }
}

TEST_CASE("Over perfect ground, a conductor on or through the ground plane is refused", "[periodic_model]")
{
  nec_ground_definition perfect;
  perfect.kind = nec_ground_kind::perfect;

  // A vertical dipole from z = z1 to z1 + 0.48 m, 11 segments of 1 mm radius.
  const auto refused = [&](nec_float z1) {
    nec_stateful_model model;
    model.add_wire({1, 11, 0.0, 0.0, z1, 0.0, 0.0, z1 + 0.48, 0.001});
    model.complete_geometry();
    model.define_ports({{1, 6}});
    model.set_lattice(square_lattice(0.7));
    const nec_complex before = port_impedance(model);
    const std::string reason = refusal<nec_geometry_exception>(
      [&] { model.set_ground(perfect); });
    // Refused without effect, also in the other order.
    REQUIRE(model.state() == nec_model_state::prepared);
    REQUIRE(port_impedance(model) == before);
    model.clear_lattice();
    model.set_ground(perfect);
    REQUIRE(refusal<nec_geometry_exception>(
      [&] { model.set_lattice(square_lattice(0.7)); }) == reason);
    REQUIRE_FALSE(model.periodic());
    return reason;
  };
  REQUIRE(mentions(refused(-0.24), "GROUND PLANE"));
  REQUIRE(mentions(refused(0.0), "GROUND PLANE"));
  REQUIRE(mentions(refused(0.001), "GROUND PLANE"));

  nec_stateful_model clear;
  clear.add_wire({1, 11, 0.0, 0.0, 0.0011, 0.0, 0.0, 0.4811, 0.001});
  clear.complete_geometry();
  clear.define_ports({{1, 6}});
  clear.set_lattice(square_lattice(0.7));
  clear.set_ground(perfect);
  const nec_complex impedance = port_impedance(clear);
  REQUIRE(std::isfinite(impedance.real()));
  REQUIRE(std::isfinite(impedance.imag()));
}

TEST_CASE("Periodic mode refuses single-cell fields", "[periodic_model]")
{

  SECTION("far fields")
  {
    nec_stateful_model model;
    build_dipole_cell(model);
    model.set_lattice(square_lattice(0.7));
    model.prepare(frequency_mhz);
    REQUIRE_THROWS_AS(
      model.compute_embedded_far_fields(one_direction()), nec_exception);
    model.solve_port_voltages({nec_complex(1.0, 0.0)});
    REQUIRE_THROWS_AS(model.compute_far_field(one_direction()), nec_exception);
    REQUIRE(model.capture_far_field_snapshot().capability !=
            nec_far_field_snapshot_capability::supported);
    nec_isolated_element_request request;
    REQUIRE_THROWS_AS(model.characterize_isolated_element(request), nec_exception);
  }
}

TEST_CASE("Periodic scan impedances carry an estimated error and a point status", "[periodic_model]")
{
  nec_stateful_model model;
  build_dipole_cell(model);
  model.prepare(frequency_mhz);
  REQUIRE_FALSE(model.compute_impedance_matrix().periodic.has_value());

  model.set_lattice(square_lattice(0.7));
  model.set_scan_phases(0.8, 0.3);
  model.prepare(frequency_mhz);
  const nec_impedance_result& result = model.compute_impedance_matrix();
  REQUIRE(result.periodic.has_value());
  REQUIRE(result.periodic->estimated_error > 0.0);
  REQUIRE(result.periodic->estimated_error <= nec_periodic::tolerance);
  REQUIRE(result.periodic->status == nec_periodic_point_status::ok);
}

TEST_CASE("A scan state exactly on a Wood anomaly is solved, flagged and continuous with its neighbours", "[periodic_model]")
{
  // At this frequency one metre is exactly one wavelength in the engine's
  // arithmetic, where k = two_pi(). Broadside, the Floquet mode along the
  // reciprocal vector 2 pi / d of a1 = (d, 0) is exactly at cut-off when
  // 2 pi / d rounds to k; search the spacings next to 2 pi / k for it.
  const nec_float frequency = em::speed_of_light() / 1.0e6;
  REQUIRE(1.0e6 * frequency / em::speed_of_light() == 1.0);
  const nec_float exact_two_pi = 2.0 * std::acos(-1.0);
  nec_float spacing = exact_two_pi / two_pi();
  bool on_cutoff = false;
  nec_float above = spacing, below = spacing;
  for (int step = 0; step < 256 && !on_cutoff; ++step) {
    for (const nec_float candidate : {above, below}) {
      const nec_periodic::lattice_2d lattice({candidate, 0.0}, {0.0, 0.5});
      if (nec_periodic::periodic_green(lattice, two_pi(), {0.0, 0.0})
            .nearest_cutoff().kz_over_k == 0.0) {
        spacing = candidate;
        on_cutoff = true;
        break;
      }
    }
    above = std::nextafter(above, 2.0);
    below = std::nextafter(below, 0.0);
  }
  REQUIRE(on_cutoff);

  const auto solve = [&](nec_float a1x) {
    nec_stateful_model model;
    build_dipole_cell(model);
    model.set_lattice({a1x, 0.0, 0.0, 0.5});
    model.prepare(frequency);
    return model.compute_impedance_matrix();
  };
  const nec_impedance_result on = solve(spacing);
  const nec_complex z_on = on.impedance.at(0, 0);
  REQUIRE(std::isfinite(z_on.real()));
  REQUIRE(std::isfinite(z_on.imag()));
  REQUIRE(on.periodic->status == nec_periodic_point_status::near_cutoff);
  REQUIRE(on.periodic->estimated_error <= nec_periodic::tolerance);

  // Stretching a1 by 1 + delta makes the modes (+-1, 0) propagating with
  // |kz| about sqrt(2 delta) k, shrinking it evanescent. The scan impedance
  // has a square-root kink: it approaches the value on cut-off like
  // sqrt(delta) from both sides (measured 24.7 sqrt(delta) on each side below
  // delta = 1e-6, 34 at 1e-4 on the evanescent side), through
  // the split boundary |kz| = 1e-3 k (delta = 5e-7). a2 = 0.5 keeps the modes
  // (0, +-1) far from cut-off, and its reciprocal vector exact.
  for (const nec_float side : {1.0, -1.0}) {
    INFO((side > 0 ? "propagating side" : "evanescent side"));
    nec_float previous = 0;
    for (const nec_float delta : {1e-4, 1e-6, 1e-8, 1e-10}) {
      INFO("delta = " << delta);
      const nec_impedance_result next = solve(spacing * (1 + side * delta));
      const nec_float change = std::abs(next.impedance.at(0, 0) - z_on) / std::abs(z_on);
      CHECK(change < 40 * std::sqrt(delta));
      if (previous > 0)
        CHECK(change < previous / 3);
      previous = change;
      CHECK(next.periodic->status == (delta < 5e-7 ? nec_periodic_point_status::near_cutoff
                                                  : nec_periodic_point_status::ok));
    }
  }
}

TEST_CASE("Splitting more Floquet modes into the low-rank update leaves the scan impedance unchanged", "[periodic_model]")
{
  // Two tilted wires, so that the TE, TM and longitudinal parts all couple,
  // each with a port. At this scan state four modes, the propagating (0, 0)
  // and (-1, 0) and the evanescent (0, 1) and (-1, 1), have |kz| < 1.3 k.
  // With the split widened to them, the low-rank update carries their
  // singular parts instead of the kernel, which must give the same scan
  // impedance.
  for (const bool perfect : {false, true}) {
    INFO((perfect ? "over perfect ground" : "in free space"));
    const auto solve = [&](nec_float near_cutoff, size_t& split) {
      nec_stateful_model model;
      model.add_wire({1, 11, -0.2, -0.05, 0.12, 0.2, 0.05, 0.36, 0.001});
      model.add_wire({2, 9, 0.1, 0.15, 0.3, 0.3, 0.35, 0.15, 0.001});
      model.complete_geometry();
      model.define_ports({{1, 6}, {2, 5}});
      if (perfect)
        model.set_ground({nec_ground_kind::perfect});
      model.set_lattice({0.8, 0.0, 0.0, 0.7});
      model.set_scan_phases(-3.2, 0.9);
      nec_periodic_split_access::set_near_cutoff(model, near_cutoff);
      model.prepare(frequency_mhz);
      split = nec_periodic_split_access::split_mode_count(model);
      return model.compute_impedance_matrix().impedance;
    };
    size_t unsplit_count = 0, split_count = 0;
    const nec_complex_matrix whole = solve(0.0, unsplit_count);
    const nec_complex_matrix split = solve(1.3, split_count);
    REQUIRE(unsplit_count == 0);
    REQUIRE(split_count == 4);
    nec_float difference = 0, size = 0;
    for (size_t row = 0; row < 2; ++row)
      for (size_t column = 0; column < 2; ++column) {
        difference = std::max(difference, std::abs(split.at(row, column) - whole.at(row, column)));
        size = std::max(size, std::abs(whole.at(row, column)));
      }
    // Measured 5e-14 (2e-14 over ground).
    CHECK(difference / size < 1e-11);
  }
}

TEST_CASE("A unit cell too large for the tolerance is refused with the reason", "[periodic_model]")
{
  // 400 square wavelengths: the spectral sum would need about 12600 modes.
  nec_stateful_model model;
  build_dipole_cell(model);
  model.set_lattice(square_lattice(20.0));
  REQUIRE(mentions(refusal<nec_geometry_exception>(
    [&] { model.prepare(frequency_mhz); }), "UNIT CELL TOO LARGE"));
}

TEST_CASE("Segments too long for the tolerance are refused with the reason", "[periodic_model]")
{
  // A vertical dipole of three 0.35 wavelength segments.
  nec_stateful_model model;
  model.add_wire({1, 3, 0.0, 0.0, -0.525, 0.0, 0.0, 0.525, 0.001});
  model.complete_geometry();
  model.define_ports({{1, 2}});
  model.set_lattice(square_lattice(0.7));
  REQUIRE(mentions(refusal<nec_geometry_exception>(
    [&] { model.prepare(frequency_mhz); }), "TOO LONG"));
}

TEST_CASE("The engine refuses patches, networks and transmission lines in periodic mode", "[periodic_model]")
{
  // The stateful model cannot express these; the engine refuses them should
  // a later entry point combine them with a lattice.
  nec_context nec;
  nec.initialize();
  c_geometry* geometry = nec.get_geometry();
  geometry->wire(1, 11, 0.0, 0.0, -0.24, 0.0, 0.0, 0.24, 0.001, 1.0, 1.0);
  geometry->wire(2, 11, 0.2, 0.0, -0.24, 0.2, 0.0, 0.24, 0.001, 1.0, 1.0);

  SECTION("surface patches")
  {
    nec.sp_card(0, 0.1, 0.3, 0.0, 90.0, 0.0, 0.01);
    nec.geometry_complete(0);
    nec.stateful_set_periodic(0.7, 0.0, 0.0, 0.7, 0.0, 0.0);
    REQUIRE(mentions(refusal<nec_geometry_exception>(
      [&] { nec.stateful_prepare_frequency(frequency_mhz); }), "SURFACE PATCHES"));
  }

  SECTION("networks")
  {
    nec.geometry_complete(0);
    nec.nt_card(1, 6, 2, 6, 0.0, -0.01, 0.0, 0.01, 0.0, -0.01);
    nec.stateful_set_periodic(0.7, 0.0, 0.0, 0.7, 0.0, 0.0);
    REQUIRE(mentions(refusal<nec_geometry_exception>(
      [&] { nec.stateful_prepare_frequency(frequency_mhz); }), "NETWORKS"));
  }

  SECTION("transmission lines")
  {
    nec.geometry_complete(0);
    nec.tl_card(1, 6, 2, 6, 50.0, 0.2, 0.0, 0.0, 0.0, 0.0);
    nec.stateful_set_periodic(0.7, 0.0, 0.0, 0.7, 0.0, 0.0);
    REQUIRE(mentions(refusal<nec_geometry_exception>(
      [&] { nec.stateful_prepare_frequency(frequency_mhz); }), "TRANSMISSION LINES"));
  }
}

