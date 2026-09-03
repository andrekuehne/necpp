#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include "current_quadrature_fixtures.h"
#include "electromag.h"
#include "nec_exception.h"
#include "nec_stateful_model.h"

#include <algorithm>
#include <cmath>
#include <complex>
#include <iterator>
#include <limits>
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
  30.0, 5, 30.0,
  0.0, 3, 90.0,
};

const nec_far_field_grid kCoarseGrid{
  1.0,
  0.0, 3, 45.0,
  0.0, 2, 90.0,
};

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
    nec_prepared_quadrature_images::physical_only,
  const nec_far_field_grid& grid = kFieldGrid)
{
  nec_isolated_element_request request;
  request.quadrature = four_node_request(images);
  request.grid = grid;
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

void require_packed_equal(
  const nec_prepared_current_quadrature& first,
  const nec_prepared_current_quadrature& second)
{
  REQUIRE(first.byte_length() == second.byte_length());
  REQUIRE(first.packed == second.packed);
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
  REQUIRE(left.flags == right.flags);
  REQUIRE(left.frequency_mhz == Catch::Approx(right.frequency_mhz));
  REQUIRE(left.wavelength_m == Catch::Approx(right.wavelength_m));
  REQUIRE(left.geometry_count == right.geometry_count);
  REQUIRE(left.current_count == right.current_count);
  for (size_t index = 0; index < left.n_segments; ++index) {
    REQUIRE(left.tag[index] == right.tag[index]);
    REQUIRE(left.segment[index] == right.segment[index]);
    REQUIRE(left.native_index[index] == right.native_index[index]);
  }
  nec_float geometry_difference = 0.0;
  nec_float geometry_scale = 0.0;
  for (size_t index = 0; index < left.geometry_count; ++index) {
    const nec_float values[9] = {
      left.x[index], left.y[index], left.z[index],
      left.tx[index], left.ty[index], left.tz[index],
      left.radius_m[index], left.length_m[index], left.ds_weight[index],
    };
    const nec_float other[9] = {
      right.x[index], right.y[index], right.z[index],
      right.tx[index], right.ty[index], right.tz[index],
      right.radius_m[index], right.length_m[index], right.ds_weight[index],
    };
    for (size_t plane = 0; plane < 9; ++plane) {
      geometry_difference += (values[plane] - other[plane]) * (values[plane] - other[plane]);
      geometry_scale += values[plane] * values[plane] + other[plane] * other[plane];
    }
  }
  REQUIRE(std::sqrt(geometry_difference) /
    std::max(nec_float(1.0), std::sqrt(geometry_scale)) < kRelativeL2SamePath);

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

  const nec_embedded_far_field_result embedded =
    reference.compute_embedded_far_fields(
      request.grid, nec_embedded_field_normalization::unit_current);
  require_fields_match(characterized.embedded_field, embedded, kRelativeL2Embedded);
  REQUIRE(characterized.embedded_field.normalization ==
    nec_embedded_field_normalization::unit_current);
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

void require_plane_separation(const nec_prepared_quadrature_view& view)
{
  REQUIRE(view.n_image_planes == 2);
  for (size_t segment = 0; segment < view.n_segments; ++segment) {
    for (size_t node = 0; node < view.n_nodes; ++node) {
      const size_t physical = view.geometry_index(0, segment, node);
      const size_t image = view.geometry_index(1, segment, node);
      REQUIRE(view.z[image] == Catch::Approx(-view.z[physical]));
      REQUIRE(view.tz[image] == Catch::Approx(-view.tz[physical]));
      for (size_t mode = 0; mode < view.n_modes; ++mode) {
        const nec_complex physical_i = view.current_at(mode, 0, segment, node);
        const nec_complex image_i = view.current_at(mode, 1, segment, node);
        REQUIRE(relative_error(image_i, -physical_i) < kRelativeL2SamePath);
      }
    }
  }
}

std::vector<nec_wire_definition> scaled_dipole_wires(nec_float wavelength_m)
{
  return {{
    1, 11,
    0.0, 0.0, -0.25 * wavelength_m,
    0.0, 0.0, 0.25 * wavelength_m,
    0.001 * wavelength_m,
  }};
}

std::vector<nec_wire_definition> scaled_turnstile_wires(nec_float wavelength_m)
{
  return {
    {
      1, 11,
      -0.25 * wavelength_m, 0.0, 0.001 * wavelength_m,
      0.25 * wavelength_m, 0.0, 0.001 * wavelength_m,
      0.001 * wavelength_m,
    },
    {
      2, 11,
      0.0, -0.25 * wavelength_m, -0.001 * wavelength_m,
      0.0, 0.25 * wavelength_m, -0.001 * wavelength_m,
      0.001 * wavelength_m,
    },
  };
}

std::vector<nec_complex> wavelength_scaled(
  const std::vector<nec_complex>& values, nec_float wavelength_m)
{
  std::vector<nec_complex> scaled(values);
  for (nec_complex& value : scaled)
    value *= wavelength_m;
  return scaled;
}

nec_stateful_model scaled_dipole_array(
  int rows, int columns, nec_float spacing_wavelengths,
  nec_float frequency_mhz)
{
  const nec_float wavelength_m =
    em::get_wavelength(frequency_mhz * 1.0e6);
  nec_stateful_model model;
  std::vector<nec_port_definition> ports;
  int tag = 1;
  for (int row = 0; row < rows; ++row) {
    for (int column = 0; column < columns; ++column) {
      const nec_float x = column * spacing_wavelengths * wavelength_m;
      const nec_float y = row * spacing_wavelengths * wavelength_m;
      model.add_wire({
        tag, 11,
        x, y, -0.25 * wavelength_m,
        x, y, 0.25 * wavelength_m,
        0.001 * wavelength_m,
      });
      ports.push_back({tag, 6});
      ++tag;
    }
  }
  model.complete_geometry(nec_ground_connection::none);
  model.define_ports(ports);
  model.prepare(frequency_mhz);
  return model;
}

void require_reciprocal_and_passive(const nec_complex_matrix& impedance)
{
  REQUIRE(impedance.rows == impedance.columns);
  const size_t order = impedance.rows;
  std::vector<nec_float> resistance(order * order);
  nec_float reciprocity_defect_squared = 0.0;
  nec_float impedance_squared = 0.0;
  for (size_t row = 0; row < order; ++row) {
    for (size_t column = 0; column < order; ++column) {
      const nec_complex forward = impedance.at(row, column);
      const nec_complex reverse = impedance.at(column, row);
      reciprocity_defect_squared += std::norm(forward - reverse);
      impedance_squared += std::norm(forward);
      resistance[row * order + column] =
        0.5 * (forward.real() + reverse.real());
    }
  }
  REQUIRE(std::sqrt(reciprocity_defect_squared) /
    std::max(nec_float(1.0), std::sqrt(impedance_squared)) < 1.0e-5);
  // Jacobi rotations are sufficient for these small real-symmetric matrices and
  // keep this regression independent of the engine's matrix implementation.
  for (size_t iteration = 0; iteration < 100 * order * order; ++iteration) {
    size_t pivot_row = 0;
    size_t pivot_column = 0;
    nec_float largest_off_diagonal = 0.0;
    for (size_t row = 0; row < order; ++row) {
      for (size_t column = row + 1; column < order; ++column) {
        const nec_float magnitude =
          std::abs(resistance[row * order + column]);
        if (magnitude > largest_off_diagonal) {
          largest_off_diagonal = magnitude;
          pivot_row = row;
          pivot_column = column;
        }
      }
    }
    if (largest_off_diagonal < 1.0e-12)
      break;

    const nec_float diagonal_row =
      resistance[pivot_row * order + pivot_row];
    const nec_float diagonal_column =
      resistance[pivot_column * order + pivot_column];
    const nec_float off_diagonal =
      resistance[pivot_row * order + pivot_column];
    const nec_float angle = 0.5 * std::atan2(
      2.0 * off_diagonal, diagonal_column - diagonal_row);
    const nec_float cosine = std::cos(angle);
    const nec_float sine = std::sin(angle);

    for (size_t index = 0; index < order; ++index) {
      if (index == pivot_row || index == pivot_column)
        continue;
      const nec_float row_value = resistance[index * order + pivot_row];
      const nec_float column_value =
        resistance[index * order + pivot_column];
      const nec_float rotated_row = cosine * row_value - sine * column_value;
      const nec_float rotated_column = sine * row_value + cosine * column_value;
      resistance[index * order + pivot_row] = rotated_row;
      resistance[pivot_row * order + index] = rotated_row;
      resistance[index * order + pivot_column] = rotated_column;
      resistance[pivot_column * order + index] = rotated_column;
    }
    resistance[pivot_row * order + pivot_row] =
      cosine * cosine * diagonal_row -
      2.0 * sine * cosine * off_diagonal +
      sine * sine * diagonal_column;
    resistance[pivot_column * order + pivot_column] =
      sine * sine * diagonal_row +
      2.0 * sine * cosine * off_diagonal +
      cosine * cosine * diagonal_column;
    resistance[pivot_row * order + pivot_column] = 0.0;
    resistance[pivot_column * order + pivot_row] = 0.0;
  }
  nec_float minimum_eigenvalue = resistance[0];
  nec_float maximum_eigenvalue = resistance[0];
  for (size_t index = 1; index < order; ++index) {
    minimum_eigenvalue = std::min(
      minimum_eigenvalue, resistance[index * order + index]);
    maximum_eigenvalue = std::max(
      maximum_eigenvalue, resistance[index * order + index]);
  }
  REQUIRE(minimum_eigenvalue >= -1.0e-8 * std::max(nec_float(1.0), maximum_eigenvalue));
}

} // namespace

TEST_CASE("Frequency-scaled unit-current characterization is dimensionally invariant",
          "[wasm_api][current_quadrature][frequency_scaling]")
{
  constexpr nec_float frequencies_mhz[] = {
    30.0, 300.0, 1000.0, 1379.0, 10000.0,
  };
  nec_complex reference_impedance;
  std::vector<nec_complex> reference_currents;
  std::vector<nec_complex> reference_e_theta_times_wavelength;
  std::vector<nec_complex> reference_e_phi_times_wavelength;
  nec_float reference_radiated_power = 0.0;

  for (const nec_float frequency_mhz : frequencies_mhz) {
    const nec_float wavelength_m =
      em::get_wavelength(frequency_mhz * 1.0e6);
    nec_stateful_model model;
    build_stateful(
      model, scaled_dipole_wires(wavelength_m), {{1, 6}},
      nec_ground_connection::none, nec_ground_kind::free_space, frequency_mhz);

    nec_isolated_element_request request;
    request.quadrature.nodes = { -0.5, 0.0, 0.5 };
    request.quadrature.weights = { 0.4, 1.2, 0.4 };
    request.quadrature.images =
      nec_prepared_quadrature_images::physical_only;
    request.quadrature.modes = nec_current_mode_kind::unit_current;
    request.grid = {
      10.0 * wavelength_m,
      30.0, 3, 30.0,
      0.0, 2, 90.0,
    };
    const nec_isolated_element_characterization characterized =
      model.characterize_isolated_element(request);
    const nec_prepared_quadrature_view view =
      nec_view_prepared_quadrature(characterized.quadrature);

    REQUIRE(view.wavelength_m == Catch::Approx(wavelength_m));
    REQUIRE(view.current_at(0, 0, 5, 1).real() == Catch::Approx(1.0).margin(1.0e-7));
    REQUIRE(view.current_at(0, 0, 5, 1).imag() == Catch::Approx(0.0).margin(1.0e-7));
    const size_t feed_geometry = view.geometry_index(0, 5, 1);
    REQUIRE(view.length_m[feed_geometry] / wavelength_m ==
      Catch::Approx(0.5 / 11.0));
    REQUIRE(view.radius_m[feed_geometry] / wavelength_m ==
      Catch::Approx(0.001));
    REQUIRE(view.ds_weight[feed_geometry] / wavelength_m ==
      Catch::Approx(0.5 * (0.5 / 11.0) * 1.2));

    const nec_port_solution solved =
      model.solve_port_currents({ nec_complex(1.0, 0.0) });
    REQUIRE(relative_error(solved.currents[0], nec_complex(1.0, 0.0)) <
      kRelativeL2UnitCurrent);
    const nec_current_distribution latest =
      model.get_current_distribution(nec_current_mode_kind::latest_solution);
    REQUIRE(relative_error(
      latest.a_at(0, 5) + latest.c_at(0, 5), solved.currents[0]) < 1.0e-7);

    std::vector<nec_complex> packed_currents;
    packed_currents.reserve(view.current_count);
    for (size_t index = 0; index < view.current_count; ++index)
      packed_currents.emplace_back(view.i_real[index], view.i_imag[index]);
    const std::vector<nec_complex> e_theta_times_wavelength = wavelength_scaled(
      characterized.embedded_field.e_theta, wavelength_m);
    const std::vector<nec_complex> e_phi_times_wavelength = wavelength_scaled(
      characterized.embedded_field.e_phi, wavelength_m);

    if (reference_currents.empty()) {
      reference_impedance = characterized.matrices.impedance.at(0, 0);
      reference_currents = packed_currents;
      reference_e_theta_times_wavelength = e_theta_times_wavelength;
      reference_e_phi_times_wavelength = e_phi_times_wavelength;
      reference_radiated_power = solved.power_budget.radiated_power_w;
    } else {
      REQUIRE(relative_error(
        characterized.matrices.impedance.at(0, 0), reference_impedance) <
        1.0e-10);
      REQUIRE(relative_error(packed_currents, reference_currents) < 1.0e-10);
      REQUIRE(relative_error(
        e_theta_times_wavelength, reference_e_theta_times_wavelength) <
        kRelativeL2Embedded);
      REQUIRE(relative_error(
        e_phi_times_wavelength, reference_e_phi_times_wavelength) <
        kRelativeL2Embedded);
      REQUIRE(solved.power_budget.radiated_power_w ==
        Catch::Approx(reference_radiated_power).epsilon(1.0e-10));
    }
    REQUIRE(solved.power_budget.input_power_w ==
      Catch::Approx(solved.power_budget.radiated_power_w).epsilon(1.0e-8));
  }
}

TEST_CASE("Frequency-scaled multiport modes keep selected and idle feeds normalized",
          "[wasm_api][current_quadrature][frequency_scaling]")
{
  for (const nec_float frequency_mhz : { 30.0, 300.0, 1000.0, 10000.0 }) {
    const nec_float wavelength_m =
      em::get_wavelength(frequency_mhz * 1.0e6);
    nec_stateful_model model;
    build_stateful(
      model, scaled_turnstile_wires(wavelength_m), {{1, 6}, {2, 6}},
      nec_ground_connection::none, nec_ground_kind::free_space, frequency_mhz);
    const nec_current_distribution unit =
      model.get_current_distribution(nec_current_mode_kind::unit_current);
    REQUIRE(unit.mode_count == 2);
    for (size_t mode = 0; mode < 2; ++mode) {
      for (size_t port = 0; port < 2; ++port) {
        const size_t feed_segment = port * 11 + 5;
        const nec_complex feed = unit.a_at(mode, feed_segment) +
          unit.c_at(mode, feed_segment);
        const nec_complex expected = mode == port
          ? nec_complex(1.0, 0.0)
          : nec_complex(0.0, 0.0);
        REQUIRE(relative_error(feed, expected) < 1.0e-7);
      }
    }
  }
}

TEST_CASE("Frequency-scaled dipole arrays preserve mutual impedance passivity and reciprocity",
          "[wasm_api][current_quadrature][frequency_scaling]")
{
  for (const auto dimensions : {
         std::pair<int, int>{2, 2}, std::pair<int, int>{4, 4},
       }) {
    nec_complex_matrix reference;
    const std::vector<nec_float> frequencies = dimensions.first == 2
      ? std::vector<nec_float>{30.0, 300.0, 1000.0, 10000.0}
      : std::vector<nec_float>{300.0, 10000.0};
    for (const nec_float frequency_mhz : frequencies) {
      nec_stateful_model model = scaled_dipole_array(
        dimensions.first, dimensions.second, 0.5, frequency_mhz);
      const nec_complex_matrix impedance =
        model.compute_impedance_matrix().impedance;
      require_reciprocal_and_passive(impedance);
      if (reference.values.empty()) {
        reference = impedance;
      } else {
        REQUIRE(relative_error(impedance.values, reference.values) < 1.0e-9);
      }
    }
  }
}

TEST_CASE("WP3 characterization dipole matches Z/Y, quadrature, and fields",
          "[wasm_api][current_quadrature][wp3_current]")
{
  nec_stateful_model model;
  build_stateful(model, dipole_wires(), {{1, 6}});
  nec_stateful_model reference;
  build_stateful(reference, dipole_wires(), {{1, 6}});
  const auto request = characterization_request();

  const nec_isolated_element_characterization prepared =
    model.characterize_isolated_element(request);
  REQUIRE(model.state() == nec_model_state::prepared);
  REQUIRE(model.solve_generation() == 0);
  REQUIRE(prepared.embedded_field.ports.size() == 1);
  REQUIRE(prepared.embedded_field.samples_per_port == 15);
  const nec_prepared_quadrature_view view =
    nec_view_prepared_quadrature(prepared.quadrature);
  REQUIRE(view.n_modes == 1);
  REQUIRE(view.n_segments == 11);
  REQUIRE(view.n_image_planes == 1);
  REQUIRE(view.tag[0] == 1);
  REQUIRE(view.segment[0] == 1);
  require_matches_second_model(reference, prepared, request);
  require_unit_current_achieved(reference, 1);

  nec_stateful_model solved;
  build_stateful(solved, dipole_wires(), {{1, 6}});
  solved.solve_port_voltages_detailed({ nec_complex(1.0, 0.0) });
  const nec_isolated_element_characterization from_solved =
    solved.characterize_isolated_element(request);
  REQUIRE(solved.state() == nec_model_state::solved);
  require_quadrature_match(prepared.quadrature, from_solved.quadrature);
  require_fields_match(
    prepared.embedded_field, from_solved.embedded_field, kRelativeL2SamePath);
}

TEST_CASE("WP3 characterization rooted monopole keeps images off plane 0",
          "[wasm_api][current_quadrature][wp3_current]")
{
  nec_stateful_model model;
  build_stateful(
    model, monopole_wires(), {{1, 1}},
    nec_ground_connection::interpolate, nec_ground_kind::perfect);
  nec_stateful_model reference;
  build_stateful(
    reference, monopole_wires(), {{1, 1}},
    nec_ground_connection::interpolate, nec_ground_kind::perfect);
  const auto physical = characterization_request();
  const nec_isolated_element_characterization characterized =
    model.characterize_isolated_element(physical);
  const nec_prepared_quadrature_view physical_view =
    nec_view_prepared_quadrature(characterized.quadrature);
  REQUIRE(physical_view.n_image_planes == 1);
  REQUIRE_FALSE(physical_view.has_images());
  require_matches_second_model(reference, characterized, physical);

  const auto images = characterization_request(
    nec_prepared_quadrature_images::perfect_ground_images);
  const nec_isolated_element_characterization imaged =
    model.characterize_isolated_element(images);
  const nec_prepared_quadrature_view image_view =
    nec_view_prepared_quadrature(imaged.quadrature);
  REQUIRE(image_view.n_image_planes == 2);
  REQUIRE(image_view.has_images());
  require_plane_separation(image_view);
  REQUIRE(imaged.embedded_field.samples_per_port ==
    characterized.embedded_field.samples_per_port);
  require_fields_match(
    imaged.embedded_field, characterized.embedded_field, kRelativeL2SamePath);
}

TEST_CASE("WP3 characterization bent multiwire uses public junction tags",
          "[wasm_api][current_quadrature][wp3_current]")
{
  nec_stateful_model model;
  build_stateful(model, bent_wires(), {{1, kArmSegments}});
  nec_stateful_model reference;
  build_stateful(reference, bent_wires(), {{1, kArmSegments}});
  const auto request = characterization_request();
  const nec_isolated_element_characterization characterized =
    model.characterize_isolated_element(request);
  const nec_prepared_quadrature_view view =
    nec_view_prepared_quadrature(characterized.quadrature);
  REQUIRE(view.n_segments == 10);
  REQUIRE(view.tag[0] == 1);
  REQUIRE(view.tag[5] == 2);
  REQUIRE(view.segment[4] == kArmSegments);
  REQUIRE(view.native_index[4] == kArmSegments - 1);
  require_matches_second_model(reference, characterized, request);
}

TEST_CASE("WP3 characterization insulated turnstile superposes +90 drive",
          "[wasm_api][current_quadrature][wp3_current]")
{
  nec_stateful_model model;
  build_stateful(model, insulated_turnstile_wires(), {{1, 6}, {2, 6}});
  nec_stateful_model reference;
  build_stateful(reference, insulated_turnstile_wires(), {{1, 6}, {2, 6}});
  const auto request = characterization_request();
  const nec_isolated_element_characterization characterized =
    model.characterize_isolated_element(request);

  REQUIRE(std::abs(characterized.matrices.impedance.at(0, 1))
    < 1.0e-6 * std::abs(characterized.matrices.impedance.at(0, 0)));
  const nec_prepared_quadrature_view view =
    nec_view_prepared_quadrature(characterized.quadrature);
  REQUIRE(view.n_modes == 2);
  REQUIRE(view.n_segments == 22);
  require_matches_second_model(reference, characterized, request);
  require_unit_current_achieved(reference, 2);

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

TEST_CASE("WP3 characterization connected turnstile keeps hub coupling",
          "[wasm_api][current_quadrature][wp3_current]")
{
  nec_stateful_model model;
  build_stateful(model, connected_turnstile_wires(), {
    {1, kArmSegments}, {3, kArmSegments},
  });
  nec_stateful_model reference;
  build_stateful(reference, connected_turnstile_wires(), {
    {1, kArmSegments}, {3, kArmSegments},
  });
  const auto request = characterization_request();
  const nec_isolated_element_characterization characterized =
    model.characterize_isolated_element(request);

  REQUIRE(std::abs(characterized.matrices.impedance.at(0, 1))
    > 0.1 * std::abs(characterized.matrices.impedance.at(0, 0)));
  const nec_prepared_quadrature_view view =
    nec_view_prepared_quadrature(characterized.quadrature);
  REQUIRE(view.n_modes == 2);
  REQUIRE(view.n_segments == 20);
  REQUIRE(view.tag[4] == 1);
  REQUIRE(view.tag[10] == 3);
  require_matches_second_model(reference, characterized, request);

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

TEST_CASE("WP3 characterization performs one unit-current solve per port",
          "[wasm_api][current_quadrature][wp3_current]")
{
  nec_stateful_model model;
  build_stateful(model, insulated_turnstile_wires(), {{1, 6}, {2, 6}});
  model.compute_impedance_matrix();
  const uint64_t before = model.unit_current_basis_solve_count();
  model.characterize_isolated_element(characterization_request());
  REQUIRE(model.unit_current_basis_solve_count() == before + 2);
  REQUIRE(model.state() == nec_model_state::prepared);
  REQUIRE(model.solve_generation() == 0);
}

TEST_CASE("WP3 characterization restores the consumer solution",
          "[wasm_api][current_quadrature][wp3_current]")
{
  nec_stateful_model model;
  build_stateful(model, insulated_turnstile_wires(), {{1, 6}, {2, 6}});
  const nec_port_solution solution = model.solve_port_voltages_detailed({
    nec_complex(1.0, 0.0), nec_complex(0.5, -0.25),
  });
  const uint64_t generation = model.solve_generation();
  const nec_far_field_result before = model.compute_far_field(kFieldGrid);

  model.characterize_isolated_element(characterization_request());
  REQUIRE(model.state() == nec_model_state::solved);
  REQUIRE(model.solve_generation() == generation);
  REQUIRE(model.last_port_solution().currents == solution.currents);
  REQUIRE(model.last_port_solution().voltages == solution.voltages);

  const nec_far_field_result after = model.compute_far_field(kFieldGrid);
  REQUIRE(relative_error(after.e_theta, before.e_theta) < kRelativeL2SamePath);
  REQUIRE(relative_error(after.e_phi, before.e_phi) < kRelativeL2SamePath);
}

TEST_CASE("WP3 characterization is keyed by grid and quadrature rule",
          "[wasm_api][current_quadrature][wp3_current]")
{
  nec_stateful_model model;
  build_stateful(model, dipole_wires(), {{1, 6}});
  const auto request = characterization_request();
  const nec_isolated_element_characterization first =
    model.characterize_isolated_element(request);
  const nec_isolated_element_characterization second =
    model.characterize_isolated_element(request);
  require_packed_equal(first.quadrature, second.quadrature);
  require_fields_match(first.embedded_field, second.embedded_field, kRelativeL2SamePath);
  require_matrix_match(first.matrices.impedance, second.matrices.impedance);

  const auto other_grid = characterization_request(
    nec_prepared_quadrature_images::physical_only, kCoarseGrid);
  const nec_isolated_element_characterization grid_changed =
    model.characterize_isolated_element(other_grid);
  require_packed_equal(first.quadrature, grid_changed.quadrature);
  REQUIRE(grid_changed.embedded_field.samples_per_port !=
    first.embedded_field.samples_per_port);

  nec_isolated_element_request other_nodes = request;
  other_nodes.quadrature.nodes = { -1.0, 0.0, 1.0 };
  const nec_isolated_element_characterization nodes_changed =
    model.characterize_isolated_element(other_nodes);
  REQUIRE(nodes_changed.quadrature.byte_length() != first.quadrature.byte_length());
  REQUIRE(nodes_changed.embedded_field.samples_per_port ==
    first.embedded_field.samples_per_port);
  REQUIRE(nodes_changed.embedded_field.theta_deg == first.embedded_field.theta_deg);
  require_fields_match(
    first.embedded_field, nodes_changed.embedded_field, kRelativeL2SamePath);
}

TEST_CASE("WP3 characterization rejects illegal requests",
          "[wasm_api][current_quadrature][wp3_current]")
{
  nec_stateful_model empty;
  REQUIRE_THROWS_AS(
    empty.characterize_isolated_element(characterization_request()),
    nec_exception);

  nec_stateful_model model;
  build_stateful(model, dipole_wires(), {{1, 6}});

  nec_isolated_element_request latest = characterization_request();
  latest.quadrature.modes = nec_current_mode_kind::latest_solution;
  REQUIRE_THROWS_AS(model.characterize_isolated_element(latest), nec_exception);

  nec_isolated_element_request empty_nodes = characterization_request();
  empty_nodes.quadrature.nodes.clear();
  REQUIRE_THROWS_AS(
    model.characterize_isolated_element(empty_nodes), nec_exception);

  nec_isolated_element_request mismatched = characterization_request();
  mismatched.quadrature.weights = { 1.0 };
  REQUIRE_THROWS_AS(
    model.characterize_isolated_element(mismatched), nec_exception);

  nec_isolated_element_request outside = characterization_request();
  outside.quadrature.nodes.back() = 1.5;
  REQUIRE_THROWS_AS(
    model.characterize_isolated_element(outside), nec_exception);

  nec_isolated_element_request nonfinite = characterization_request();
  nonfinite.grid.radius_m = std::numeric_limits<nec_float>::quiet_NaN();
  REQUIRE_THROWS_AS(
    model.characterize_isolated_element(nonfinite), nec_exception);

  nec_isolated_element_request images = characterization_request(
    nec_prepared_quadrature_images::perfect_ground_images);
  REQUIRE_THROWS_AS(model.characterize_isolated_element(images), nec_exception);
}
