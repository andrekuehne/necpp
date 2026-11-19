/*
  Contract tests for the periodic (infinite-array) entry points of the
  stateful model: argument validation, lifecycle and refusals. The physics of
  the scan impedance is tested at the WASM package seam.
*/
#include <catch2/catch_test_macros.hpp>

#include "nec_exception.h"
#include "nec_stateful_model.h"

#include <cmath>
#include <limits>
#include <vector>

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

TEST_CASE("Periodic mode refuses symmetry, ground and single-cell fields", "[periodic_model]")
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

  SECTION("ground")
  {
    nec_stateful_model model;
    build_dipole_cell(model);
    nec_ground_definition perfect;
    perfect.kind = nec_ground_kind::perfect;
    model.set_ground(perfect);
    REQUIRE_THROWS_AS(model.set_lattice(square_lattice(0.7)), nec_exception);

    model.set_ground(nec_ground_definition{});
    model.set_lattice(square_lattice(0.7));
    REQUIRE_THROWS_AS(model.set_ground(perfect), nec_exception);
  }

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
