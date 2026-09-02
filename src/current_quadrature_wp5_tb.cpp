/*
  Copyright (C) 2026  NEC2++ contributors

  This program is free software; you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation; either version 2 of the License, or
  (at your option) any later version.
*/
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include "current_quadrature_fixtures.h"
#include "nec_exception.h"
#include "nec_stateful_model.h"

#include <cmath>
#include <complex>
#include <iterator>
#include <vector>

using current_quadrature_fixtures::kArmSegments;
using current_quadrature_fixtures::bent_wires;
using current_quadrature_fixtures::build_stateful;
using current_quadrature_fixtures::connected_turnstile_wires;
using current_quadrature_fixtures::dipole_wires;
using current_quadrature_fixtures::insulated_turnstile_wires;
using current_quadrature_fixtures::monopole_wires;

namespace {

constexpr nec_float kRelativeL2UnitCurrent = 1.0e-7;
constexpr nec_float kRelativeL2SamePath = 1.0e-12;
constexpr nec_float kRelativeL2Embedded = 1.0e-7;
constexpr nec_float kFourNodes[] = { -1.0, -1.0 / 3.0, 1.0 / 3.0, 1.0 };

const nec_far_field_grid kFieldGrid{
  1.0,
  0.0, 5, 45.0,
  0.0, 3, 90.0,
};

struct Fixture {
  const char* id;
  std::vector<nec_wire_definition> wires;
  std::vector<nec_port_definition> ports;
  nec_ground_connection connection;
  nec_ground_kind ground;
};

const Fixture kFixtures[] = {
  { "dipole", dipole_wires(), {{1, 6}},
    nec_ground_connection::none, nec_ground_kind::free_space },
  { "rooted-monopole", monopole_wires(), {{1, 1}},
    nec_ground_connection::interpolate, nec_ground_kind::perfect },
  { "bent-multiwire", bent_wires(), {{1, kArmSegments}},
    nec_ground_connection::none, nec_ground_kind::free_space },
  { "turnstile-insulated", insulated_turnstile_wires(), {{1, 6}, {2, 6}},
    nec_ground_connection::none, nec_ground_kind::free_space },
  { "turnstile-connected", connected_turnstile_wires(),
    {{1, kArmSegments}, {3, kArmSegments}},
    nec_ground_connection::none, nec_ground_kind::free_space },
};

void build_fixture(nec_stateful_model& model, const Fixture& fixture)
{
  build_stateful(
    model, fixture.wires, fixture.ports, fixture.connection, fixture.ground);
}

nec_prepared_quadrature_request four_node_request(
  nec_prepared_quadrature_images images =
    nec_prepared_quadrature_images::physical_only)
{
  nec_prepared_quadrature_request request;
  request.nodes.assign(std::begin(kFourNodes), std::end(kFourNodes));
  request.images = images;
  request.modes = nec_current_mode_kind::unit_current;
  return request;
}

nec_isolated_element_request characterization_request(
  nec_prepared_quadrature_images images =
    nec_prepared_quadrature_images::physical_only)
{
  nec_isolated_element_request request;
  request.quadrature = four_node_request(images);
  request.grid = kFieldGrid;
  return request;
}

bool finite_complex(nec_complex value)
{
  return std::isfinite(value.real()) && std::isfinite(value.imag());
}

nec_float relative_error(nec_complex first, nec_complex second)
{
  REQUIRE(finite_complex(first));
  REQUIRE(finite_complex(second));
  const nec_float difference = std::abs(first - second);
  const nec_float scale = std::max(
    { nec_float(1.0), std::abs(first), std::abs(second) });
  return difference / scale;
}

nec_float relative_error(
  const std::vector<nec_complex>& first,
  const std::vector<nec_complex>& second)
{
  REQUIRE(first.size() == second.size());
  nec_float difference_squared = 0.0;
  nec_float first_squared = 0.0;
  nec_float second_squared = 0.0;
  for (size_t index = 0; index < first.size(); ++index) {
    REQUIRE(finite_complex(first[index]));
    REQUIRE(finite_complex(second[index]));
    difference_squared += std::norm(first[index] - second[index]);
    first_squared += std::norm(first[index]);
    second_squared += std::norm(second[index]);
  }
  return std::sqrt(difference_squared) /
    std::max({ nec_float(1.0), std::sqrt(first_squared), std::sqrt(second_squared) });
}

nec_float coefficient_plane_error(
  const nec_current_distribution& left,
  size_t left_mode,
  const nec_current_distribution& right,
  size_t right_mode)
{
  REQUIRE(left.segment_count() == right.segment_count());
  nec_float difference_squared = 0.0;
  nec_float left_squared = 0.0;
  nec_float right_squared = 0.0;
  for (size_t segment = 0; segment < left.segment_count(); ++segment) {
    const nec_complex values[6] = {
      left.a_at(left_mode, segment), right.a_at(right_mode, segment),
      left.b_at(left_mode, segment), right.b_at(right_mode, segment),
      left.c_at(left_mode, segment), right.c_at(right_mode, segment),
    };
    for (size_t pair = 0; pair < 3; ++pair) {
      const nec_complex first = values[2 * pair];
      const nec_complex second = values[2 * pair + 1];
      REQUIRE(finite_complex(first));
      REQUIRE(finite_complex(second));
      difference_squared += std::norm(first - second);
      left_squared += std::norm(first);
      right_squared += std::norm(second);
    }
  }
  return std::sqrt(difference_squared) /
    std::max({ nec_float(1.0), std::sqrt(left_squared), std::sqrt(right_squared) });
}

void require_public_wire_order(
  const nec_current_distribution& distribution,
  const std::vector<nec_wire_definition>& wires)
{
  size_t index = 0;
  for (const nec_wire_definition& item : wires) {
    for (int segment = 1; segment <= item.segments; ++segment) {
      REQUIRE(index < distribution.segments.size());
      REQUIRE(distribution.segments[index].tag == item.tag);
      REQUIRE(distribution.segments[index].segment == segment);
      ++index;
    }
  }
  REQUIRE(index == distribution.segments.size());
}

void require_matches_snapshot(
  const nec_current_distribution& distribution,
  size_t mode,
  const nec_far_field_snapshot& snapshot)
{
  REQUIRE(distribution.segment_count() == snapshot.segment_count());
  REQUIRE(distribution.wavelength_m == Catch::Approx(snapshot.wavelength_m));
  const nec_float wavelength_m = distribution.wavelength_m;
  REQUIRE(wavelength_m > 0.0);
  for (size_t index = 0; index < snapshot.segment_count(); ++index) {
    REQUIRE(relative_error(
      distribution.a_at(mode, index),
      nec_complex(snapshot.air[index], snapshot.aii[index])) < kRelativeL2SamePath);
    REQUIRE(relative_error(
      distribution.b_at(mode, index),
      nec_complex(snapshot.bir[index], snapshot.bii[index])) < kRelativeL2SamePath);
    REQUIRE(relative_error(
      distribution.c_at(mode, index),
      nec_complex(snapshot.cir[index], snapshot.cii[index])) < kRelativeL2SamePath);
    const nec_complex centre =
      distribution.a_at(mode, index) + distribution.c_at(mode, index);
    const nec_complex snapshot_centre(
      snapshot.air[index] + snapshot.cir[index],
      snapshot.aii[index] + snapshot.cii[index]);
    REQUIRE(relative_error(centre, snapshot_centre) < kRelativeL2SamePath);

    const size_t xyz = 3 * index;
    REQUIRE(distribution.centres_m[xyz] ==
      Catch::Approx(snapshot.x[index] * wavelength_m));
    REQUIRE(distribution.centres_m[xyz + 1] ==
      Catch::Approx(snapshot.y[index] * wavelength_m));
    REQUIRE(distribution.centres_m[xyz + 2] ==
      Catch::Approx(snapshot.z[index] * wavelength_m));
    REQUIRE(distribution.tangents[xyz] == Catch::Approx(snapshot.cab[index]));
    REQUIRE(distribution.tangents[xyz + 1] == Catch::Approx(snapshot.sab[index]));
    REQUIRE(distribution.tangents[xyz + 2] == Catch::Approx(snapshot.salp[index]));
  }
}

void require_matches_scalar(
  const nec_prepared_quadrature_view& view,
  const nec_current_distribution& distribution,
  const std::vector<nec_float>& nodes)
{
  REQUIRE(view.n_modes == distribution.mode_count);
  REQUIRE(view.n_nodes == nodes.size());
  REQUIRE(view.n_segments == distribution.segment_count());
  nec_float difference_squared = 0.0;
  nec_float prepared_squared = 0.0;
  nec_float scalar_squared = 0.0;
  for (size_t mode = 0; mode < view.n_modes; ++mode) {
    for (size_t segment = 0; segment < view.n_segments; ++segment) {
      for (size_t node = 0; node < view.n_nodes; ++node) {
        const nec_complex prepared = view.current_at(mode, 0, segment, node);
        const nec_complex scalar = nec_evaluate_quadrature_current(
          distribution, mode, segment, nodes[node]);
        difference_squared += std::norm(prepared - scalar);
        prepared_squared += std::norm(prepared);
        scalar_squared += std::norm(scalar);
      }
    }
  }
  const nec_float scale = std::max(
    { nec_float(1.0), std::sqrt(prepared_squared), std::sqrt(scalar_squared) });
  REQUIRE(std::sqrt(difference_squared) / scale < kRelativeL2SamePath);
}

void require_plane_separation(const nec_prepared_quadrature_view& view)
{
  REQUIRE(view.n_image_planes == 2);
  for (size_t segment = 0; segment < view.n_segments; ++segment) {
    for (size_t node = 0; node < view.n_nodes; ++node) {
      const size_t physical = view.geometry_index(0, segment, node);
      const size_t image = view.geometry_index(1, segment, node);
      REQUIRE(view.x[image] == Catch::Approx(view.x[physical]));
      REQUIRE(view.y[image] == Catch::Approx(view.y[physical]));
      REQUIRE(view.z[image] == Catch::Approx(-view.z[physical]));
      REQUIRE(view.tx[image] == Catch::Approx(view.tx[physical]));
      REQUIRE(view.ty[image] == Catch::Approx(view.ty[physical]));
      REQUIRE(view.tz[image] == Catch::Approx(-view.tz[physical]));
      for (size_t mode = 0; mode < view.n_modes; ++mode) {
        const nec_complex physical_i = view.current_at(mode, 0, segment, node);
        const nec_complex image_i = view.current_at(mode, 1, segment, node);
        REQUIRE(relative_error(image_i, -physical_i) < kRelativeL2SamePath);
      }
    }
  }
}

void require_matrix_match(
  const nec_complex_matrix& first, const nec_complex_matrix& second)
{
  REQUIRE(first.rows == second.rows);
  REQUIRE(first.columns == second.columns);
  REQUIRE(relative_error(first.values, second.values) < kRelativeL2SamePath);
}

void require_fields_match(
  const nec_embedded_far_field_result& first,
  const nec_embedded_far_field_result& second,
  nec_float tolerance)
{
  REQUIRE(first.normalization == second.normalization);
  REQUIRE(first.samples_per_port == second.samples_per_port);
  REQUIRE(first.ports.size() == second.ports.size());
  REQUIRE(relative_error(first.e_theta, second.e_theta) < tolerance);
  REQUIRE(relative_error(first.e_phi, second.e_phi) < tolerance);
}

void require_quadrature_match(
  const nec_prepared_current_quadrature& first,
  const nec_prepared_current_quadrature& second)
{
  const nec_prepared_quadrature_view left = nec_view_prepared_quadrature(first);
  const nec_prepared_quadrature_view right = nec_view_prepared_quadrature(second);
  REQUIRE(left.n_segments == right.n_segments);
  REQUIRE(left.n_nodes == right.n_nodes);
  REQUIRE(left.n_modes == right.n_modes);
  REQUIRE(left.n_image_planes == right.n_image_planes);
  std::vector<nec_complex> left_currents;
  std::vector<nec_complex> right_currents;
  left_currents.reserve(left.current_count);
  right_currents.reserve(right.current_count);
  for (size_t index = 0; index < left.current_count; ++index)
    left_currents.emplace_back(left.i_real[index], left.i_imag[index]);
  for (size_t index = 0; index < right.current_count; ++index)
    right_currents.emplace_back(right.i_real[index], right.i_imag[index]);
  REQUIRE(relative_error(left_currents, right_currents) < kRelativeL2SamePath);
}

void require_matches_second_model(
  nec_stateful_model& reference,
  const nec_isolated_element_characterization& characterized,
  const nec_isolated_element_request& request)
{
  const nec_impedance_result matrices = reference.compute_impedance_matrix();
  require_matrix_match(characterized.matrices.impedance, matrices.impedance);
  require_matrix_match(characterized.matrices.admittance, matrices.admittance);

  const nec_prepared_current_quadrature prepared =
    reference.prepare_current_quadrature(request.quadrature);
  require_quadrature_match(characterized.quadrature, prepared);

  const nec_current_distribution unit =
    reference.get_current_distribution(nec_current_mode_kind::unit_current);
  require_matches_scalar(
    nec_view_prepared_quadrature(characterized.quadrature),
    unit,
    request.quadrature.nodes);

  const nec_embedded_far_field_result embedded =
    reference.compute_embedded_far_fields(
      request.grid, nec_embedded_field_normalization::unit_current);
  require_fields_match(characterized.embedded_field, embedded, kRelativeL2Embedded);
}

void require_unit_current_achieved(nec_stateful_model& model, size_t port_count)
{
  for (size_t mode = 0; mode < port_count; ++mode) {
    std::vector<nec_complex> currents(
      port_count, nec_complex(0.0, 0.0));
    currents[mode] = nec_complex(1.0, 0.0);
    const nec_port_solution solved = model.solve_port_currents(currents);
    REQUIRE(relative_error(solved.currents[mode], nec_complex(1.0, 0.0))
      < kRelativeL2UnitCurrent);
    for (size_t other = 0; other < port_count; ++other) {
      if (other == mode)
        continue;
      REQUIRE(relative_error(solved.currents[other], nec_complex(0.0, 0.0))
        < kRelativeL2UnitCurrent);
    }
  }
}

std::vector<nec_complex> superpose(
  const nec_embedded_far_field_result& embedded,
  const std::vector<nec_complex>& weights)
{
  REQUIRE(weights.size() == embedded.ports.size());
  std::vector<nec_complex> combined(
    embedded.samples_per_port, nec_complex(0.0, 0.0));
  for (size_t port = 0; port < weights.size(); ++port) {
    for (size_t sample = 0; sample < embedded.samples_per_port; ++sample)
      combined[sample] +=
        weights[port] * embedded.e_theta[port * embedded.samples_per_port + sample];
  }
  return combined;
}

std::vector<nec_complex> superpose_phi(
  const nec_embedded_far_field_result& embedded,
  const std::vector<nec_complex>& weights)
{
  REQUIRE(weights.size() == embedded.ports.size());
  std::vector<nec_complex> combined(
    embedded.samples_per_port, nec_complex(0.0, 0.0));
  for (size_t port = 0; port < weights.size(); ++port) {
    for (size_t sample = 0; sample < embedded.samples_per_port; ++sample)
      combined[sample] +=
        weights[port] * embedded.e_phi[port * embedded.samples_per_port + sample];
  }
  return combined;
}

void require_turnstile_superposition(
  nec_stateful_model& reference,
  const nec_isolated_element_characterization& characterized)
{
  const std::vector<nec_complex> drive{
    nec_complex(1.0, 0.0), nec_complex(0.0, 1.0),
  };
  reference.solve_port_currents(drive);
  const nec_far_field_result combined = reference.compute_far_field(kFieldGrid);
  REQUIRE(relative_error(
    superpose(characterized.embedded_field, drive), combined.e_theta)
    < kRelativeL2Embedded);
  REQUIRE(relative_error(
    superpose_phi(characterized.embedded_field, drive), combined.e_phi)
    < kRelativeL2Embedded);
}

} // namespace

TEST_CASE("WP5 latest-solution coefficients match NEC snapshot internals",
          "[wasm_api][current_quadrature][wp5_current]")
{
  for (const Fixture& fixture : kFixtures) {
    INFO(fixture.id);
    nec_stateful_model model;
    build_fixture(model, fixture);
    std::vector<nec_complex> voltages(
      fixture.ports.size(), nec_complex(1.0, 0.0));
    model.solve_port_voltages_detailed(voltages);

    const nec_current_distribution latest =
      model.get_current_distribution(nec_current_mode_kind::latest_solution);
    const nec_far_field_snapshot snapshot = model.capture_far_field_snapshot();
    REQUIRE(latest.mode_kind == nec_current_mode_kind::latest_solution);
    REQUIRE(latest.mode_count == 1);
    require_public_wire_order(latest, fixture.wires);
    require_matches_snapshot(latest, 0, snapshot);
  }
}

TEST_CASE("WP5 unit-current planes and packed samples match NEC internals",
          "[wasm_api][current_quadrature][wp5_current]")
{
  const auto request = four_node_request();
  for (const Fixture& fixture : kFixtures) {
    INFO(fixture.id);
    nec_stateful_model model;
    build_fixture(model, fixture);
    const nec_current_distribution unit =
      model.get_current_distribution(nec_current_mode_kind::unit_current);
    REQUIRE(unit.mode_kind == nec_current_mode_kind::unit_current);
    REQUIRE(unit.mode_count == fixture.ports.size());
    require_public_wire_order(unit, fixture.wires);

    for (size_t mode = 0; mode < unit.mode_count; ++mode) {
      std::vector<nec_complex> currents(
        unit.mode_count, nec_complex(0.0, 0.0));
      currents[mode] = nec_complex(1.0, 0.0);
      const nec_port_solution solved = model.solve_port_currents(currents);
      REQUIRE(relative_error(solved.currents[mode], nec_complex(1.0, 0.0))
        < kRelativeL2UnitCurrent);
      const nec_current_distribution latest =
        model.get_current_distribution(nec_current_mode_kind::latest_solution);
      REQUIRE(coefficient_plane_error(unit, mode, latest, 0) < kRelativeL2SamePath);
      require_matches_snapshot(latest, 0, model.capture_far_field_snapshot());
    }

    const nec_prepared_current_quadrature prepared =
      model.prepare_current_quadrature(request);
    require_matches_scalar(
      nec_view_prepared_quadrature(prepared), unit, request.nodes);
  }
}

TEST_CASE("WP5 characterization matches second-model Z/Y, quadrature, and fields",
          "[wasm_api][current_quadrature][wp5_current]")
{
  const auto request = characterization_request();
  for (const Fixture& fixture : kFixtures) {
    INFO(fixture.id);
    nec_stateful_model model;
    build_fixture(model, fixture);
    nec_stateful_model reference;
    build_fixture(reference, fixture);
    const nec_isolated_element_characterization characterized =
      model.characterize_isolated_element(request);
    REQUIRE(characterized.embedded_field.ports.size() == fixture.ports.size());
    REQUIRE(characterized.embedded_field.samples_per_port == 15);
    REQUIRE(characterized.embedded_field.normalization ==
      nec_embedded_field_normalization::unit_current);
    require_matches_second_model(reference, characterized, request);
    require_unit_current_achieved(reference, fixture.ports.size());
  }
}

TEST_CASE("WP5 rooted monopole image plane stays out of plane 0",
          "[wasm_api][current_quadrature][wp5_current]")
{
  nec_stateful_model model;
  build_stateful(
    model, monopole_wires(), {{1, 1}},
    nec_ground_connection::interpolate, nec_ground_kind::perfect);
  const auto physical = characterization_request();
  const nec_isolated_element_characterization characterized =
    model.characterize_isolated_element(physical);
  const nec_prepared_quadrature_view physical_view =
    nec_view_prepared_quadrature(characterized.quadrature);
  REQUIRE(physical_view.n_image_planes == 1);
  REQUIRE_FALSE(physical_view.has_images());

  const auto images = characterization_request(
    nec_prepared_quadrature_images::perfect_ground_images);
  const nec_isolated_element_characterization imaged =
    model.characterize_isolated_element(images);
  const nec_prepared_quadrature_view image_view =
    nec_view_prepared_quadrature(imaged.quadrature);
  REQUIRE(image_view.n_image_planes == 2);
  REQUIRE(image_view.has_images());
  require_plane_separation(image_view);
  require_fields_match(
    imaged.embedded_field, characterized.embedded_field, kRelativeL2SamePath);
}

TEST_CASE("WP5 bent multiwire packed identity uses public tags",
          "[wasm_api][current_quadrature][wp5_current]")
{
  nec_stateful_model model;
  build_stateful(model, bent_wires(), {{1, kArmSegments}});
  const nec_isolated_element_characterization characterized =
    model.characterize_isolated_element(characterization_request());
  const nec_prepared_quadrature_view view =
    nec_view_prepared_quadrature(characterized.quadrature);
  REQUIRE(view.n_segments == 10);
  REQUIRE(view.tag[0] == 1);
  REQUIRE(view.tag[5] == 2);
  REQUIRE(view.segment[4] == kArmSegments);
  REQUIRE(view.native_index[4] == kArmSegments - 1);
  for (size_t index = 0; index < view.n_segments; ++index) {
    REQUIRE(view.tag[index] > 0);
    REQUIRE(view.segment[index] > 0);
  }
}

TEST_CASE("WP5 insulated turnstile superposes +90 drive",
          "[wasm_api][current_quadrature][wp5_current]")
{
  nec_stateful_model model;
  build_stateful(model, insulated_turnstile_wires(), {{1, 6}, {2, 6}});
  nec_stateful_model reference;
  build_stateful(reference, insulated_turnstile_wires(), {{1, 6}, {2, 6}});
  const nec_isolated_element_characterization characterized =
    model.characterize_isolated_element(characterization_request());
  REQUIRE(std::abs(characterized.matrices.impedance.at(0, 1))
    < 1.0e-6 * std::abs(characterized.matrices.impedance.at(0, 0)));
  require_matches_second_model(
    reference, characterized, characterization_request());
  require_turnstile_superposition(reference, characterized);
}

TEST_CASE("WP5 connected turnstile keeps hub coupling",
          "[wasm_api][current_quadrature][wp5_current]")
{
  nec_stateful_model model;
  build_stateful(model, connected_turnstile_wires(), {
    {1, kArmSegments}, {3, kArmSegments},
  });
  nec_stateful_model reference;
  build_stateful(reference, connected_turnstile_wires(), {
    {1, kArmSegments}, {3, kArmSegments},
  });
  const nec_isolated_element_characterization characterized =
    model.characterize_isolated_element(characterization_request());
  REQUIRE(std::abs(characterized.matrices.impedance.at(0, 1))
    > 0.1 * std::abs(characterized.matrices.impedance.at(0, 0)));
  const nec_prepared_quadrature_view view =
    nec_view_prepared_quadrature(characterized.quadrature);
  REQUIRE(view.n_segments == 20);
  REQUIRE(view.tag[4] == 1);
  REQUIRE(view.tag[10] == 3);
  require_matches_second_model(
    reference, characterized, characterization_request());
  require_turnstile_superposition(reference, characterized);
}
