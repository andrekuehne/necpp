#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include "nec_context.h"
#include "nec_exception.h"
#include "nec_port_matrix.h"
#include "nec_stateful_model.h"

#include <algorithm>
#include <cmath>
#include <complex>
#include <limits>
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

std::vector<nec_complex> multiply(
  const nec_complex_matrix& matrix,
  const std::vector<nec_complex>& vector)
{
  std::vector<nec_complex> product(matrix.rows, nec_complex(0.0, 0.0));
  for (size_t row = 0; row < matrix.rows; ++row)
    for (size_t column = 0; column < matrix.columns; ++column)
      product[row] += matrix.at(row, column) * vector[column];
  return product;
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
    difference_squared += std::norm(first[index] - second[index]);
    first_squared += std::norm(first[index]);
    second_squared += std::norm(second[index]);
  }
  return std::sqrt(difference_squared) /
    std::max({nec_float(1.0), std::sqrt(first_squared), std::sqrt(second_squared)});
}

nec_complex legacy_dipole_impedance()
{
  nec_context model;
  model.initialize();
  model.wire(
    1, kSegments,
    0.0, 0.0, -0.25,
    0.0, 0.0, 0.25,
    0.001, 1.0, 1.0);
  model.geometry_complete(0);
  model.fr_card(0, 1, kFrequencyMHz, 0.0);
  model.ex_card(
    EXCITATION_VOLTAGE,
    1, kFeedSegment, 0,
    1.0, 0.0, 0.0, 0.0, 0.0, 0.0);
  model.xq_card(0);
  return nec_complex(model.get_impedance_real(), model.get_impedance_imag());
}

} // namespace

TEST_CASE("WP2 one-port Z agrees with the legacy NEC input impedance",
          "[wasm_api][wp2][matrix]")
{
  nec_stateful_model model;
  build_dipoles(model, 1);

  const nec_impedance_result& matrices = model.compute_impedance_matrix();
  REQUIRE(model.state() == nec_model_state::prepared);
  REQUIRE(model.factorization_generation() == 1);
  REQUIRE(model.solve_generation() == 0);
  REQUIRE(model.retained_result_count() == 0);
  REQUIRE(matrices.impedance.rows == 1);
  REQUIRE(matrices.impedance.columns == 1);
  REQUIRE(matrices.admittance.rows == 1);
  REQUIRE(matrices.condition_estimate == Catch::Approx(1.0).epsilon(1.0e-14));

  const nec_complex expected = legacy_dipole_impedance();
  REQUIRE(matrices.impedance.at(0, 0).real() ==
    Catch::Approx(expected.real()).epsilon(1.0e-12));
  REQUIRE(matrices.impedance.at(0, 0).imag() ==
    Catch::Approx(expected.imag()).epsilon(1.0e-12));

  const nec_complex impedance_at_300_mhz = matrices.impedance.at(0, 0);
  model.prepare(kFrequencyMHz);
  REQUIRE(model.factorization_generation() == 1);
  REQUIRE(&model.compute_impedance_matrix() == &matrices);
  model.prepare(301.0);
  const nec_impedance_result& changed = model.compute_impedance_matrix();
  REQUIRE(changed.factorization_generation == 2);
  REQUIRE(changed.frequency_mhz == 301.0);
  REQUIRE(changed.impedance.at(0, 0) != impedance_at_300_mhz);
}

TEST_CASE("WP2 coupled-port matrices are reciprocal inverses in row-major order",
          "[wasm_api][wp2][matrix]")
{
  nec_stateful_model model;
  build_dipoles(model, 2);
  const nec_impedance_result& matrices = model.compute_impedance_matrix();

  REQUIRE(matrices.impedance.rows == 2);
  REQUIRE(matrices.impedance.columns == 2);
  REQUIRE(matrices.impedance.values.size() == 4);
  REQUIRE(std::abs(matrices.impedance.at(0, 1) - matrices.impedance.at(1, 0)) /
    std::max(nec_float(1.0), std::abs(matrices.impedance.at(0, 1))) < 1.0e-8);

  for (size_t column = 0; column < 2; ++column) {
    const std::vector<nec_complex> admittance_column{
      matrices.admittance.at(0, column),
      matrices.admittance.at(1, column),
    };
    std::vector<nec_complex> identity_column(2, nec_complex(0.0, 0.0));
    identity_column[column] = nec_complex(1.0, 0.0);
    REQUIRE(relative_error(
      multiply(matrices.impedance, admittance_column),
      identity_column) < 1.0e-7);
  }

  REQUIRE(matrices.factorization_generation == 1);
  REQUIRE(matrices.frequency_mhz == kFrequencyMHz);
  REQUIRE(model.factorization_generation() == 1);
  REQUIRE(model.solve_generation() == 0);
}

TEST_CASE("WP2 Y predicts arbitrary simultaneous voltage-source currents",
          "[wasm_api][wp2][voltage]")
{
  nec_stateful_model model;
  build_dipoles(model, 2);
  const std::vector<nec_complex> voltages{
    nec_complex(0.73, -0.19),
    nec_complex(-0.28, 0.41),
  };
  const nec_port_solution& direct = model.solve_port_voltages_detailed(voltages);
  const std::vector<nec_complex> direct_currents = direct.currents;
  REQUIRE(direct.drive == nec_port_drive::voltage);
  REQUIRE(direct.requested == voltages);
  REQUIRE(direct.solve_generation == 1);

  // Matrix extraction performs internal unit solves, then restores the exact
  // consumer-visible solution and its public generation.
  const nec_complex_matrix& admittance = model.compute_admittance_matrix();
  const std::vector<nec_complex> predicted = multiply(admittance, voltages);
  REQUIRE(relative_error(predicted, direct_currents) < 1.0e-7);
  REQUIRE(model.state() == nec_model_state::solved);
  REQUIRE(model.solve_generation() == 1);
  REQUIRE(model.last_port_solution().currents == direct_currents);
  REQUIRE(model.retained_result_count() == 1);
}

TEST_CASE("WP2 current drive applies ZI in one consumer solve",
          "[wasm_api][wp2][current]")
{
  nec_stateful_model model;
  build_dipoles(model, 2);
  const std::vector<nec_complex> requested{
    nec_complex(0.011, -0.003),
    nec_complex(-0.004, 0.008),
  };

  const nec_port_solution& solution = model.solve_port_currents(requested);
  REQUIRE(solution.drive == nec_port_drive::current);
  REQUIRE(solution.requested == requested);
  REQUIRE(solution.solve_generation == 1);
  REQUIRE(relative_error(solution.currents, requested) < 1.0e-7);
  REQUIRE(relative_error(
    solution.voltages,
    multiply(model.compute_impedance_matrix().impedance, requested)) < 1.0e-7);
  REQUIRE(model.factorization_generation() == 1);
  REQUIRE(model.solve_generation() == 1);

  for (size_t index = 0; index < requested.size(); ++index) {
    REQUIRE(solution.active_impedances[index] ==
      solution.voltages[index] / solution.currents[index]);
    REQUIRE(solution.powers_w[index] == Catch::Approx(
      0.5 * std::real(
        solution.voltages[index] * std::conj(solution.currents[index])))
      .epsilon(1.0e-12));
  }
}

TEST_CASE("WP2 active impedance follows simultaneous array weights",
          "[wasm_api][wp2][active_impedance]")
{
  nec_stateful_model model;
  build_dipoles(model, 2);

  const nec_port_solution first = model.solve_port_voltages_detailed({
    nec_complex(1.0, 0.0), nec_complex(0.0, 0.0),
  });
  const nec_port_solution second = model.solve_port_voltages_detailed({
    nec_complex(1.0, 0.0), nec_complex(0.0, 1.0),
  });

  REQUIRE(std::abs(first.active_impedances[0] - second.active_impedances[0]) > 1.0e-6);
  REQUIRE(std::abs(first.active_impedances[1] - second.active_impedances[1]) > 1.0e-6);
  REQUIRE(model.factorization_generation() == 1);
  REQUIRE(model.solve_generation() == 2);
}

TEST_CASE("WP2 zero-current drive reports the documented NaN active impedance",
          "[wasm_api][wp2][current][zero]")
{
  nec_stateful_model model;
  build_dipoles(model, 1);

  REQUIRE_THROWS_AS(model.solve_port_currents({}), nec_exception);
  REQUIRE_THROWS_AS(model.solve_port_currents({nec_complex(
    std::numeric_limits<nec_float>::infinity(), 0.0)}), nec_exception);
  REQUIRE(model.state() == nec_model_state::prepared);
  REQUIRE(model.factorization_generation() == 1);
  REQUIRE(model.solve_generation() == 0);

  const nec_port_solution& zero =
    model.solve_port_currents({nec_complex(0.0, 0.0)});
  REQUIRE(zero.currents[0] == nec_complex(0.0, 0.0));
  REQUIRE(zero.voltages[0] == nec_complex(0.0, 0.0));
  REQUIRE(std::isnan(zero.active_impedances[0].real()));
  REQUIRE(std::isnan(zero.active_impedances[0].imag()));
  REQUIRE(zero.powers_w[0] == 0.0);
  REQUIRE(model.retained_result_count() == 1);
}

TEST_CASE("WP2 singular and badly conditioned matrices fail diagnostically",
          "[wasm_api][wp2][conditioning]")
{
  REQUIRE_THROWS_AS(
    nec_invert_port_matrix({
      nec_complex(1.0, 0.0), nec_complex(2.0, 0.0),
      nec_complex(2.0, 0.0), nec_complex(4.0, 0.0),
    }, 2),
    nec_exception);

  REQUIRE_THROWS_AS(
    nec_invert_port_matrix({
      nec_complex(1.0, 0.0), nec_complex(0.0, 0.0),
      nec_complex(0.0, 0.0), nec_complex(1.0e-13, 0.0),
    }, 2),
    nec_exception);
}
