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
#include "nec_stateful_model.h"

#include <chrono>
#include <cmath>
#include <complex>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

using current_quadrature_fixtures::kArmSegments;
using current_quadrature_fixtures::bent_wires;
using current_quadrature_fixtures::build_stateful;
using current_quadrature_fixtures::connected_turnstile_wires;
using current_quadrature_fixtures::dipole_wires;
using current_quadrature_fixtures::insulated_turnstile_wires;
using current_quadrature_fixtures::monopole_wires;

namespace {

constexpr nec_float kRelativeL2SamePath = 1.0e-12;
constexpr nec_float kRelativeL2Embedded = 1.0e-7;
constexpr nec_float kFourNodes[] = { -1.0, -1.0 / 3.0, 1.0 / 3.0, 1.0 };

const nec_far_field_grid kPublishedGrid{
  1.0,
  0.0, 5, 45.0,
  0.0, 3, 90.0,
};

const nec_far_field_grid kWp0Grid{
  1.0,
  0.0, 19, 10.0,
  0.0, 37, 10.0,
};

struct Fixture {
  const char* id;
  std::vector<nec_wire_definition> wires;
  std::vector<nec_port_definition> ports;
  nec_ground_connection connection;
  nec_ground_kind ground;
  size_t segment_count;
};

const Fixture kFixtures[] = {
  { "dipole", dipole_wires(), {{1, 6}},
    nec_ground_connection::none, nec_ground_kind::free_space, 11 },
  { "rooted-monopole", monopole_wires(), {{1, 1}},
    nec_ground_connection::interpolate, nec_ground_kind::perfect, 11 },
  { "bent-multiwire", bent_wires(), {{1, kArmSegments}},
    nec_ground_connection::none, nec_ground_kind::free_space, 10 },
  { "turnstile-insulated", insulated_turnstile_wires(), {{1, 6}, {2, 6}},
    nec_ground_connection::none, nec_ground_kind::free_space, 22 },
  { "turnstile-connected", connected_turnstile_wires(),
    {{1, kArmSegments}, {3, kArmSegments}},
    nec_ground_connection::none, nec_ground_kind::free_space, 20 },
};

void build_fixture(nec_stateful_model& model, const Fixture& fixture)
{
  build_stateful(
    model, fixture.wires, fixture.ports, fixture.connection, fixture.ground);
}

nec_prepared_quadrature_request four_node_request()
{
  nec_prepared_quadrature_request request;
  request.nodes.assign(std::begin(kFourNodes), std::end(kFourNodes));
  request.images = nec_prepared_quadrature_images::physical_only;
  request.modes = nec_current_mode_kind::unit_current;
  return request;
}

nec_isolated_element_request characterization_request(const nec_far_field_grid& grid)
{
  nec_isolated_element_request request;
  request.quadrature = four_node_request();
  request.grid = grid;
  return request;
}

size_t expected_necf_bytes(size_t n_ports, size_t n_theta, size_t n_phi)
{
  const size_t samples_per_port = n_theta * n_phi;
  return 64 + (n_theta + n_phi + 4 * n_ports * samples_per_port) * 8;
}

bool finite_complex(nec_complex value)
{
  return std::isfinite(value.real()) && std::isfinite(value.imag());
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

void require_matrix_match(
  const nec_complex_matrix& first, const nec_complex_matrix& second)
{
  REQUIRE(first.rows == second.rows);
  REQUIRE(first.columns == second.columns);
  REQUIRE(first.values.size() == second.values.size());
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
  REQUIRE(first.theta_deg.size() == second.theta_deg.size());
  REQUIRE(first.phi_deg.size() == second.phi_deg.size());
  REQUIRE(relative_error(first.e_theta, second.e_theta) < tolerance);
  REQUIRE(relative_error(first.e_phi, second.e_phi) < tolerance);
}

void require_hot_path_frozen(const nec_prepared_current_quadrature& prepared)
{
  const auto before = prepared.diagnostics;
  REQUIRE(before.geometry_walks >= 1);
  REQUIRE(before.trigonometry_evaluations >= 1);
  REQUIRE(before.interpolations >= 1);
  REQUIRE(before.growing_allocations == 1);
  for (int pass = 0; pass < 100; ++pass) {
    const nec_prepared_quadrature_view view =
      nec_view_prepared_quadrature(prepared);
    REQUIRE(view.n_segments > 0);
    REQUIRE(prepared.byte_length() == prepared.packed.size());
    REQUIRE(prepared.data() == prepared.packed.data());
    volatile nec_float sink = view.i_real[0] + view.x[0];
    (void)sink;
  }
  REQUIRE(prepared.diagnostics.geometry_walks == before.geometry_walks);
  REQUIRE(prepared.diagnostics.trigonometry_evaluations ==
    before.trigonometry_evaluations);
  REQUIRE(prepared.diagnostics.interpolations == before.interpolations);
  REQUIRE(prepared.diagnostics.growing_allocations == before.growing_allocations);
}

void require_packed_size(
  const nec_isolated_element_characterization& characterized,
  size_t n_modes, size_t n_segments, size_t n_theta, size_t n_phi)
{
  REQUIRE(characterized.quadrature.byte_length() ==
    nec_prepared_quadrature_packed_bytes(n_modes, n_segments, 4, 1));
  REQUIRE(characterized.embedded_field.ports.size() == n_modes);
  REQUIRE(characterized.embedded_field.theta_deg.size() == n_theta);
  REQUIRE(characterized.embedded_field.phi_deg.size() == n_phi);
  REQUIRE(characterized.embedded_field.samples_per_port == n_theta * n_phi);
  REQUIRE(characterized.embedded_field.e_theta.size() ==
    n_modes * n_theta * n_phi);
  REQUIRE(characterized.embedded_field.e_phi.size() ==
    n_modes * n_theta * n_phi);
  REQUIRE(expected_necf_bytes(n_modes, n_theta, n_phi) ==
    64 + (n_theta + n_phi + 4 * n_modes * n_theta * n_phi) * 8);
}

} // namespace

TEST_CASE("WP6 published 5x3 fixtures lock packed NECQ and NECF envelope sizes",
          "[wasm_api][current_quadrature][wp6_current]")
{
  const auto request = characterization_request(kPublishedGrid);
  for (const Fixture& fixture : kFixtures) {
    nec_stateful_model model;
    build_fixture(model, fixture);
    model.compute_impedance_matrix();
    const size_t n_ports = fixture.ports.size();
    const nec_isolated_element_characterization characterized =
      model.characterize_isolated_element(request);
    require_packed_size(characterized, n_ports, fixture.segment_count, 5, 3);
    require_hot_path_frozen(characterized.quadrature);
    if (std::string(fixture.id) == "dipole") {
      REQUIRE(characterized.quadrature.byte_length() == 4072);
      REQUIRE(expected_necf_bytes(1, 5, 3) == 608);
    }
  }
}

TEST_CASE("WP6 dipole and insulated turnstile 19x37 characterization size and solves",
          "[wasm_api][current_quadrature][wp6_current]")
{
  const auto request = characterization_request(kWp0Grid);

  nec_stateful_model dipole;
  build_stateful(dipole, dipole_wires(), {{1, 6}});
  dipole.compute_impedance_matrix();
  const uint64_t dipole_before = dipole.unit_current_basis_solve_count();
  const nec_isolated_element_characterization dipole_result =
    dipole.characterize_isolated_element(request);
  REQUIRE(dipole.unit_current_basis_solve_count() == dipole_before + 1);
  require_packed_size(dipole_result, 1, 11, 19, 37);
  require_hot_path_frozen(dipole_result.quadrature);

  nec_stateful_model turnstile;
  build_stateful(turnstile, insulated_turnstile_wires(), {{1, 6}, {2, 6}});
  turnstile.compute_impedance_matrix();
  const uint64_t turnstile_before = turnstile.unit_current_basis_solve_count();
  const nec_isolated_element_characterization turnstile_result =
    turnstile.characterize_isolated_element(request);
  REQUIRE(turnstile.unit_current_basis_solve_count() == turnstile_before + 2);
  require_packed_size(turnstile_result, 2, 22, 19, 37);
  require_hot_path_frozen(turnstile_result.quadrature);
}

TEST_CASE("WP6 characterization shares the unit-current loop versus split APIs",
          "[wasm_api][current_quadrature][wp6_current]")
{
  const auto request = characterization_request(kWp0Grid);

  nec_stateful_model characterized_model;
  build_stateful(characterized_model, insulated_turnstile_wires(), {{1, 6}, {2, 6}});
  characterized_model.compute_impedance_matrix();
  const uint64_t before = characterized_model.unit_current_basis_solve_count();
  const nec_isolated_element_characterization characterized =
    characterized_model.characterize_isolated_element(request);
  REQUIRE(characterized_model.unit_current_basis_solve_count() == before + 2);

  nec_stateful_model split;
  build_stateful(split, insulated_turnstile_wires(), {{1, 6}, {2, 6}});
  const nec_impedance_result matrices = split.compute_impedance_matrix();
  const uint64_t split_before = split.unit_current_basis_solve_count();
  const nec_current_distribution currents =
    split.get_current_distribution(nec_current_mode_kind::unit_current);
  const nec_embedded_far_field_result fields = split.compute_embedded_far_fields(
    request.grid, nec_embedded_field_normalization::unit_current);
  REQUIRE(split.unit_current_basis_solve_count() == split_before + 4);
  REQUIRE(currents.mode_count == 2);

  require_matrix_match(characterized.matrices.impedance, matrices.impedance);
  require_matrix_match(characterized.matrices.admittance, matrices.admittance);
  require_fields_match(characterized.embedded_field, fields, kRelativeL2Embedded);
}

TEST_CASE("WP6 native baseline JSON is recorded",
          "[wasm_api][current_quadrature][wp6_current][baseline]")
{
  const auto request = characterization_request(kWp0Grid);

  nec_stateful_model dipole;
  build_stateful(dipole, dipole_wires(), {{1, 6}});
  dipole.compute_impedance_matrix();
  const auto dipole_started = std::chrono::steady_clock::now();
  const nec_isolated_element_characterization dipole_result =
    dipole.characterize_isolated_element(request);
  const nec_float dipole_characterize_ms =
    std::chrono::duration<nec_float, std::milli>(
      std::chrono::steady_clock::now() - dipole_started).count();
  const auto dipole_retrieve_started = std::chrono::steady_clock::now();
  volatile size_t dipole_bytes = 0;
  for (int pass = 0; pass < 1000; ++pass) {
    const nec_prepared_quadrature_view view =
      nec_view_prepared_quadrature(dipole_result.quadrature);
    dipole_bytes = view.geometry_count + dipole_result.quadrature.byte_length();
  }
  const nec_float dipole_retrieve_ms =
    std::chrono::duration<nec_float, std::milli>(
      std::chrono::steady_clock::now() - dipole_retrieve_started).count() /
    1000.0;
  (void)dipole_bytes;

  nec_stateful_model split;
  build_stateful(split, dipole_wires(), {{1, 6}});
  split.compute_impedance_matrix();
  const auto split_started = std::chrono::steady_clock::now();
  (void)split.get_current_distribution(nec_current_mode_kind::unit_current);
  (void)split.compute_embedded_far_fields(
    request.grid, nec_embedded_field_normalization::unit_current);
  const nec_float dipole_split_ms =
    std::chrono::duration<nec_float, std::milli>(
      std::chrono::steady_clock::now() - split_started).count();

  nec_stateful_model turnstile;
  build_stateful(turnstile, insulated_turnstile_wires(), {{1, 6}, {2, 6}});
  turnstile.compute_impedance_matrix();
  const auto turnstile_started = std::chrono::steady_clock::now();
  const nec_isolated_element_characterization turnstile_result =
    turnstile.characterize_isolated_element(request);
  const nec_float turnstile_characterize_ms =
    std::chrono::duration<nec_float, std::milli>(
      std::chrono::steady_clock::now() - turnstile_started).count();
  const auto turnstile_retrieve_started = std::chrono::steady_clock::now();
  volatile size_t turnstile_bytes = 0;
  for (int pass = 0; pass < 1000; ++pass) {
    const nec_prepared_quadrature_view view =
      nec_view_prepared_quadrature(turnstile_result.quadrature);
    turnstile_bytes = view.geometry_count + turnstile_result.quadrature.byte_length();
  }
  const nec_float turnstile_retrieve_ms =
    std::chrono::duration<nec_float, std::milli>(
      std::chrono::steady_clock::now() - turnstile_retrieve_started).count() /
    1000.0;
  (void)turnstile_bytes;

  const std::filesystem::path destination =
    std::filesystem::path(__FILE__).parent_path().parent_path()
    / "packages" / "necpp-wasm" / "bench" / "evidence"
    / "current-quadrature-wp6" / "native-baseline.json";
  std::filesystem::create_directories(destination.parent_path());
  std::ofstream output(destination, std::ios::trunc);
  REQUIRE(output.good());
  output << "{\n"
    << "  \"type\": \"current-quadrature-wp6-native-baseline\",\n"
    << "  \"schemaVersion\": 1,\n"
    << "  \"host\": \"windows-msvc-release\",\n"
    << "  \"nodes\": 4,\n"
    << "  \"grid\": { \"thetaCount\": 19, \"phiCount\": 37 },\n"
    << "  \"budgets\": {\n"
    << "    \"preparedGeometryBytes\": \"9 * nSeg * nNodes * nImagePlanes * 8\",\n"
    << "    \"preparedCurrentBytes\": \"nModes * nSeg * nNodes * nImagePlanes * 16\",\n"
    << "    \"embeddedFieldBytes\": \"4 * nPorts * nTheta * nPhi * 8\",\n"
    << "    \"necfEnvelopeBytes\": \"64 + (nTheta + nPhi + 4 * nPorts * nTheta * nPhi) * 8\"\n"
    << "  },\n"
    << "  \"dipole\": {\n"
    << "    \"segmentCount\": 11,\n"
    << "    \"portCount\": 1,\n"
    << "    \"packedNceqBytes\": " << dipole_result.quadrature.byte_length() << ",\n"
    << "    \"expectedNecfBytes\": " << expected_necf_bytes(1, 19, 37) << ",\n"
    << "    \"characterizeMs\": " << dipole_characterize_ms << ",\n"
    << "    \"splitCurrentAndFieldMs\": " << dipole_split_ms << ",\n"
    << "    \"retrieveMs\": " << dipole_retrieve_ms << ",\n"
    << "    \"geometryWalks\": "
    << dipole_result.quadrature.diagnostics.geometry_walks << ",\n"
    << "    \"growingAllocations\": "
    << dipole_result.quadrature.diagnostics.growing_allocations << "\n"
    << "  },\n"
    << "  \"turnstile-insulated\": {\n"
    << "    \"segmentCount\": 22,\n"
    << "    \"portCount\": 2,\n"
    << "    \"packedNceqBytes\": " << turnstile_result.quadrature.byte_length() << ",\n"
    << "    \"expectedNecfBytes\": " << expected_necf_bytes(2, 19, 37) << ",\n"
    << "    \"characterizeMs\": " << turnstile_characterize_ms << ",\n"
    << "    \"retrieveMs\": " << turnstile_retrieve_ms << ",\n"
    << "    \"geometryWalks\": "
    << turnstile_result.quadrature.diagnostics.geometry_walks << ",\n"
    << "    \"growingAllocations\": "
    << turnstile_result.quadrature.diagnostics.growing_allocations << "\n"
    << "  }\n"
    << "}\n";
}
