#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include "c_geometry.h"
#include "electromag.h"
#include "nec_context.h"
#include "nec_radiation_pattern.h"
#include "nec_results.h"
#include "nec_structure_currents.h"

#include <array>
#include <cmath>
#include <complex>
#include <vector>

namespace {

constexpr nec_float kFrequencyMHz = 300.0;
constexpr nec_float kWireRadiusM = 0.001;
constexpr int kSegments = 11;
constexpr int kFeedSegment = 6;

void add_z_dipole(nec_context& model, int tag, nec_float x_m)
{
  model.get_geometry()->wire(
    tag,
    kSegments,
    x_m, 0.0, -0.25,
    x_m, 0.0,  0.25,
    kWireRadiusM,
    1.0,
    1.0);
}

void finish_free_space_geometry(nec_context& model)
{
  model.geometry_complete(0);
  model.fr_card(0, 1, kFrequencyMHz, 0.0);
}

void add_voltage_source(nec_context& model, int tag, nec_complex voltage)
{
  model.ex_card(
    EXCITATION_VOLTAGE,
    tag,
    kFeedSegment,
    0,
    voltage.real(),
    voltage.imag(),
    0.0,
    0.0,
    0.0,
    0.0);
}

bool finite_complex(nec_complex value)
{
  return std::isfinite(value.real()) && std::isfinite(value.imag());
}

void solve_center_fed_dipole(nec_context& model)
{
  model.initialize();
  add_z_dipole(model, 1, 0.0);
  finish_free_space_geometry(model);
  add_voltage_source(model, 1, nec_complex(1.0, 0.0));
  model.xq_card(0);
}

} // namespace

TEST_CASE("WP0 canonical center-fed dipole runs through the native API",
          "[wasm_api][canonical]")
{
  nec_context model;
  solve_center_fed_dipole(model);

  nec_antenna_input* input = model.get_input_parameters(0);
  REQUIRE(input != nullptr);
  const std::vector<int> expected_tags{1};
  const std::vector<int> expected_segments{kFeedSegment};
  REQUIRE(input->get_tag() == expected_tags);
  REQUIRE(input->get_segment() == expected_segments);
  REQUIRE(input->get_voltage().size() == 1);
  REQUIRE(input->get_current().size() == 1);
  REQUIRE(finite_complex(input->get_current()[0]));
  REQUIRE(model.get_impedance_real() > 0.0);
  REQUIRE(std::isfinite(model.get_impedance_imag()));
}

TEST_CASE("WP0 canonical coupled dipoles run through the native API",
          "[wasm_api][canonical]")
{
  nec_context model;
  model.initialize();
  add_z_dipole(model, 1, 0.0);
  add_z_dipole(model, 2, 0.20);
  finish_free_space_geometry(model);
  add_voltage_source(model, 1, nec_complex(1.0, 0.0));
  model.xq_card(0);

  nec_structure_currents* currents = model.get_structure_currents(0);
  REQUIRE(currents != nullptr);
  REQUIRE(currents->get_current().size() == 2 * kSegments);

  const nec_complex driven_current = currents->get_current()[kFeedSegment - 1];
  const nec_complex coupled_current = currents->get_current()[kSegments + kFeedSegment - 1];
  REQUIRE(finite_complex(driven_current));
  REQUIRE(finite_complex(coupled_current));
  REQUIRE(std::abs(driven_current) > 1.0e-8);
  REQUIRE(std::abs(coupled_current) > 1.0e-8);
}

TEST_CASE("WP0 canonical four-element array runs through the native API",
          "[wasm_api][canonical]")
{
  nec_context model;
  model.initialize();

  constexpr std::array<nec_float, 4> x_positions{
    -0.45, -0.15, 0.15, 0.45,
  };
  for (std::size_t index = 0; index < x_positions.size(); ++index)
    add_z_dipole(model, static_cast<int>(index) + 1, x_positions[index]);

  finish_free_space_geometry(model);

  const nec_float phase_step_rad = pi() / 6.0;
  for (std::size_t index = 0; index < x_positions.size(); ++index) {
    add_voltage_source(
      model,
      static_cast<int>(index) + 1,
      std::polar<nec_float>(1.0, phase_step_rad * static_cast<nec_float>(index)));
  }
  model.xq_card(0);

  nec_antenna_input* input = model.get_input_parameters(0);
  REQUIRE(input != nullptr);
  const std::vector<int> expected_tags{1, 2, 3, 4};
  // The legacy result object reports absolute segment numbers even though the
  // EX inputs above are tag-relative. The future facade converts results back
  // to the stable PortDefinition order and addressing documented for WP0.
  const std::vector<int> expected_segments{6, 17, 28, 39};
  REQUIRE(input->get_tag() == expected_tags);
  REQUIRE(input->get_segment() == expected_segments);
  REQUIRE(input->get_voltage().size() == 4);
  REQUIRE(input->get_current().size() == 4);
  for (std::size_t index = 0; index < input->get_current().size(); ++index) {
    INFO("port index " << index);
    REQUIRE(finite_complex(input->get_voltage()[index]));
    REQUIRE(finite_complex(input->get_current()[index]));
    REQUIRE(std::abs(input->get_current()[index]) > 1.0e-8);
  }
}

TEST_CASE("WP0 port current is positive into the antenna",
          "[wasm_api][numerical_contract]")
{
  nec_context model;
  solve_center_fed_dipole(model);
  nec_antenna_input* input = model.get_input_parameters(0);
  REQUIRE(input != nullptr);

  const nec_complex voltage = input->get_voltage()[0];
  const nec_complex current = input->get_current()[0];
  const nec_float reported_power_w = input->get_power()[0];
  const nec_float contract_power_w =
    0.5 * std::real(voltage * std::conj(current));
  const nec_complex impedance = voltage / current;

  REQUIRE(voltage == nec_complex(1.0, 0.0));
  REQUIRE(current.real() > 0.0);
  REQUIRE(reported_power_w > 0.0);
  REQUIRE(reported_power_w == Catch::Approx(contract_power_w).epsilon(1.0e-12));
  REQUIRE(impedance.real() == Catch::Approx(model.get_impedance_real()).epsilon(1.0e-12));
  REQUIRE(impedance.imag() == Catch::Approx(model.get_impedance_imag()).epsilon(1.0e-12));
}

TEST_CASE("WP0 far-field range follows exp(-j k R) over R",
          "[wasm_api][numerical_contract]")
{
  nec_context model;
  model.initialize();
  add_z_dipole(model, 1, 0.0);
  finish_free_space_geometry(model);
  add_voltage_source(model, 1, nec_complex(1.0, 0.0));

  constexpr nec_float radius_1_m = 1.0;
  constexpr nec_float radius_2_m = 1.25;
  model.rp_card(
    0, 1, 1, 0, 0, 0, 0,
    90.0, 0.0, 0.0, 0.0, radius_1_m, 0.0);
  model.rp_card(
    0, 1, 1, 0, 0, 0, 0,
    90.0, 0.0, 0.0, 0.0, radius_2_m, 0.0);

  nec_radiation_pattern* field_1 = model.get_radiation_pattern(0);
  nec_radiation_pattern* field_2 = model.get_radiation_pattern(1);
  REQUIRE(field_1 != nullptr);
  REQUIRE(field_2 != nullptr);

  const nec_complex e_theta_1 = field_1->get_e_theta()(0, 0);
  const nec_complex e_theta_2 = field_2->get_e_theta()(0, 0);
  REQUIRE(std::abs(e_theta_1) > 1.0e-12);
  REQUIRE(finite_complex(e_theta_1));
  REQUIRE(finite_complex(e_theta_2));

  const nec_float wavelength_m = em::get_wavelength(kFrequencyMHz * 1.0e6);
  const nec_float phase_delta_rad =
    -two_pi() * (radius_2_m - radius_1_m) / wavelength_m;
  const nec_complex expected_ratio =
    (radius_1_m / radius_2_m) * std::polar<nec_float>(1.0, phase_delta_rad);
  const nec_complex actual_ratio = e_theta_2 / e_theta_1;

  REQUIRE(std::abs(actual_ratio - expected_ratio) < 1.0e-10);
}
