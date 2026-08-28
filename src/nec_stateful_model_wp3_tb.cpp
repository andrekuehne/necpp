#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include "electromag.h"
#include "nec_exception.h"
#include "nec_stateful_model.h"

#include <algorithm>
#include <cmath>
#include <complex>
#include <vector>

namespace {

constexpr nec_float kFrequencyMHz = 300.0;
constexpr int kSegments = 11;
constexpr int kFeedSegment = 6;

nec_wire_definition dipole_wire(int tag, nec_float x_m)
{
  return {
    tag, kSegments,
    x_m, 0.0, -0.25,
    x_m, 0.0, 0.25,
    0.001,
  };
}

void build_dipoles(nec_stateful_model& model, size_t count)
{
  for (size_t index = 0; index < count; ++index)
    model.add_wire(dipole_wire(static_cast<int>(index + 1), 0.20 * index));
  model.complete_geometry();

  std::vector<nec_port_definition> ports;
  for (size_t index = 0; index < count; ++index)
    ports.push_back({static_cast<int>(index + 1), kFeedSegment});
  model.define_ports(ports);
  model.prepare(kFrequencyMHz);
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
    std::max({nec_float(1.0), std::sqrt(first_squared), std::sqrt(second_squared)});
}

std::vector<nec_complex> superpose(
  const std::vector<nec_complex>& embedded,
  size_t samples_per_port,
  const std::vector<nec_complex>& weights)
{
  std::vector<nec_complex> combined(
    samples_per_port, nec_complex(0.0, 0.0));
  for (size_t port = 0; port < weights.size(); ++port) {
    for (size_t sample = 0; sample < samples_per_port; ++sample)
      combined[sample] +=
        weights[port] * embedded[port * samples_per_port + sample];
  }
  return combined;
}

const nec_far_field_grid kFieldGrid{
  1.0,
  30.0, 5, 30.0,
  0.0, 3, 90.0,
};

} // namespace

TEST_CASE("WP3 copied far fields retain axes, theta-fast order, and range phase",
          "[wasm_api][wp3][far_field]")
{
  nec_stateful_model model;
  build_dipoles(model, 1);
  model.solve_port_voltages({nec_complex(1.0, 0.0)});

  const nec_far_field_result field_1 = model.compute_far_field({
    1.0,
    30.0, 3, 30.0,
    10.0, 2, 40.0,
  });
  REQUIRE(field_1.radius_m == 1.0);
  REQUIRE(field_1.frequency_mhz == kFrequencyMHz);
  const std::vector<nec_float> expected_theta{30.0, 60.0, 90.0};
  const std::vector<nec_float> expected_phi{10.0, 50.0};
  REQUIRE(field_1.theta_deg == expected_theta);
  REQUIRE(field_1.phi_deg == expected_phi);
  REQUIRE(field_1.e_theta.size() == 6);
  REQUIRE(field_1.e_phi.size() == 6);
  for (size_t phi = 0; phi < field_1.phi_deg.size(); ++phi) {
    for (size_t theta = 0; theta < field_1.theta_deg.size(); ++theta) {
      const size_t sample = phi * field_1.theta_deg.size() + theta;
      REQUIRE(field_1.e_theta_at(theta, phi) == field_1.e_theta[sample]);
      REQUIRE(field_1.e_phi_at(theta, phi) == field_1.e_phi[sample]);
      REQUIRE(finite_complex(field_1.e_theta[sample]));
      REQUIRE(finite_complex(field_1.e_phi[sample]));
    }
  }
  REQUIRE_THROWS_AS(field_1.e_theta_at(3, 0), std::out_of_range);
  REQUIRE_THROWS_AS(field_1.e_phi_at(0, 2), std::out_of_range);

  const nec_far_field_result field_2 = model.compute_far_field({
    2.0,
    30.0, 3, 30.0,
    10.0, 2, 40.0,
  });
  const nec_float wavelength_m =
    em::get_wavelength(kFrequencyMHz * 1.0e6);
  const nec_complex expected_ratio =
    0.5 * std::polar<nec_float>(1.0, -two_pi() / wavelength_m);
  for (size_t sample = 0; sample < field_1.sample_count(); ++sample) {
    if (std::abs(field_1.e_theta[sample]) > 1.0e-12)
      REQUIRE(std::abs(
        field_2.e_theta[sample] / field_1.e_theta[sample] -
        expected_ratio) < 1.0e-10);
    if (std::abs(field_1.e_phi[sample]) > 1.0e-12)
      REQUIRE(std::abs(
        field_2.e_phi[sample] / field_1.e_phi[sample] -
        expected_ratio) < 1.0e-10);
  }
  REQUIRE(model.factorization_generation() == 1);
  REQUIRE(model.solve_generation() == 1);
}

TEST_CASE("WP3 voltage-normalized embedded fields superpose to the direct field",
          "[wasm_api][wp3][embedded][voltage]")
{
  nec_stateful_model model;
  build_dipoles(model, 2);

  const nec_embedded_far_field_result embedded =
    model.compute_embedded_far_fields(kFieldGrid);
  REQUIRE(model.state() == nec_model_state::prepared);
  REQUIRE(model.factorization_generation() == 1);
  REQUIRE(model.solve_generation() == 0);
  REQUIRE(model.retained_result_count() == 0);
  REQUIRE(embedded.normalization ==
    nec_embedded_field_normalization::unit_voltage);
  REQUIRE(embedded.ports.size() == 2);
  REQUIRE(embedded.samples_per_port == 15);
  REQUIRE(embedded.e_theta.size() == 30);
  REQUIRE(embedded.e_phi.size() == 30);
  REQUIRE(embedded.e_theta_at(1, 2, 1) ==
    embedded.e_theta[embedded.samples_per_port + 7]);

  const std::vector<nec_complex> voltages{
    nec_complex(0.73, -0.19),
    nec_complex(-0.28, 0.41),
  };
  model.solve_port_voltages_detailed(voltages);
  const nec_far_field_result direct = model.compute_far_field(kFieldGrid);
  REQUIRE(relative_error(
    superpose(embedded.e_theta, embedded.samples_per_port, voltages),
    direct.e_theta) < 1.0e-7);
  REQUIRE(relative_error(
    superpose(embedded.e_phi, embedded.samples_per_port, voltages),
    direct.e_phi) < 1.0e-7);
  REQUIRE(model.factorization_generation() == 1);
  REQUIRE(model.solve_generation() == 1);
}

TEST_CASE("WP3 current-normalized embedded fields preserve and reproduce a solution",
          "[wasm_api][wp3][embedded][current]")
{
  nec_stateful_model model;
  build_dipoles(model, 2);
  const std::vector<nec_complex> currents{
    nec_complex(0.011, -0.003),
    nec_complex(-0.004, 0.008),
  };
  const nec_port_solution saved = model.solve_port_currents(currents);
  const nec_far_field_result direct = model.compute_far_field(kFieldGrid);

  const nec_embedded_far_field_result embedded =
    model.compute_embedded_far_fields(
      kFieldGrid, nec_embedded_field_normalization::unit_current);
  REQUIRE(embedded.normalization ==
    nec_embedded_field_normalization::unit_current);
  REQUIRE(model.state() == nec_model_state::solved);
  REQUIRE(model.factorization_generation() == 1);
  REQUIRE(model.solve_generation() == 1);
  REQUIRE(model.last_port_solution().requested == saved.requested);
  REQUIRE(model.last_port_solution().voltages == saved.voltages);
  REQUIRE(model.last_port_solution().currents == saved.currents);
  REQUIRE(model.retained_result_count() == 1);

  REQUIRE(relative_error(
    superpose(embedded.e_theta, embedded.samples_per_port, currents),
    direct.e_theta) < 1.0e-7);
  REQUIRE(relative_error(
    superpose(embedded.e_phi, embedded.samples_per_port, currents),
    direct.e_phi) < 1.0e-7);
}

TEST_CASE("WP3 exact-zero excitation returns finite exact-zero fields",
          "[wasm_api][wp3][far_field][zero]")
{
  nec_stateful_model model;
  build_dipoles(model, 1);
  model.solve_port_voltages({nec_complex(0.0, 0.0)});

  const nec_far_field_result& field = model.compute_far_field(kFieldGrid);
  REQUIRE(field.sample_count() == 15);
  REQUIRE(std::all_of(
    field.e_theta.begin(), field.e_theta.end(),
    [](nec_complex value) { return value == nec_complex(0.0, 0.0); }));
  REQUIRE(std::all_of(
    field.e_phi.begin(), field.e_phi.end(),
    [](nec_complex value) { return value == nec_complex(0.0, 0.0); }));
  REQUIRE(model.factorization_generation() == 1);
  REQUIRE(model.solve_generation() == 1);
  REQUIRE(model.retained_result_count() == 1);
}

TEST_CASE("WP3 center-fed dipole fields have axial nulls and mirror symmetry",
          "[wasm_api][wp3][far_field][symmetry]")
{
  nec_stateful_model model;
  build_dipoles(model, 1);
  model.solve_port_voltages({nec_complex(1.0, 0.0)});
  const nec_far_field_result& field = model.compute_far_field({
    1.0,
    0.0, 5, 45.0,
    0.0, 1, 0.0,
  });

  const nec_float broadside = std::abs(field.e_theta_at(2, 0));
  REQUIRE(broadside > 1.0e-8);
  REQUIRE(std::abs(field.e_theta_at(0, 0)) < broadside * 1.0e-10);
  REQUIRE(std::abs(field.e_theta_at(4, 0)) < broadside * 1.0e-10);
  REQUIRE(std::abs(field.e_theta_at(1, 0) - field.e_theta_at(3, 0)) <
    broadside * 1.0e-8);
  for (const nec_complex e_phi : field.e_phi)
    REQUIRE(std::abs(e_phi) < broadside * 1.0e-10);
}

TEST_CASE("WP3 ground-skipped angles have deterministic zero field entries",
          "[wasm_api][wp3][far_field][ground]")
{
  nec_stateful_model model;
  model.add_wire({
    1, kSegments,
    0.0, 0.0, 0.0,
    0.0, 0.0, 0.25,
    0.001,
  });
  model.complete_geometry(nec_ground_connection::interpolate);
  model.define_ports({{1, kFeedSegment}});
  model.set_ground({nec_ground_kind::perfect, 0.0, 0.0});
  model.prepare(kFrequencyMHz);
  model.solve_port_voltages({nec_complex(1.0, 0.0)});

  const nec_far_field_result& field = model.compute_far_field({
    1.0,
    80.0, 2, 40.0,
    0.0, 1, 0.0,
  });
  REQUIRE(std::abs(field.e_theta_at(0, 0)) > 1.0e-12);
  REQUIRE(field.e_theta_at(1, 0) == nec_complex(0.0, 0.0));
  REQUIRE(field.e_phi_at(1, 0) == nec_complex(0.0, 0.0));
}
