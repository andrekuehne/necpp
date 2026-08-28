#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include "nec_stateful_model.h"
#include "necpp_wasm_v1.h"

#include <memory>
#include <vector>

extern "C" int necpp_wasm_v1_run_c_contract_test(void);

TEST_CASE("WP4 versioned ABI is consumable from C", "[wp4][wasm_abi]")
{
  const int failed_line = necpp_wasm_v1_run_c_contract_test();
  INFO("C ABI contract check failed at necpp_wasm_v1_c_tb.c line "
       << failed_line);
  REQUIRE(failed_line == 0);
}

namespace {

void build_one_port_model(nec_stateful_model& model)
{
  model.add_wire({
    1, 11,
    0.0, 0.0, -0.25,
    0.0, 0.0, 0.25,
    0.001,
  });
  model.complete_geometry();
  model.define_ports({{1, 6}});
  model.prepare(300.0);
}

void require_complex_buffer_matches(
  const necpp_wasm_v1_model* model,
  int32_t real_kind,
  int32_t imag_kind,
  const std::vector<nec_complex>& expected)
{
  const double* real = necpp_wasm_v1_result_buffer(model, real_kind);
  const double* imag = necpp_wasm_v1_result_buffer(model, imag_kind);
  REQUIRE(real != nullptr);
  REQUIRE(imag != nullptr);
  REQUIRE(necpp_wasm_v1_result_buffer_length(model, real_kind) ==
          expected.size());
  REQUIRE(necpp_wasm_v1_result_buffer_length(model, imag_kind) ==
          expected.size());
  for (size_t index = 0; index < expected.size(); ++index) {
    INFO("buffer index " << index);
    REQUIRE(real[index] == Catch::Approx(expected[index].real())
      .epsilon(1.0e-12).margin(1.0e-12));
    REQUIRE(imag[index] == Catch::Approx(expected[index].imag())
      .epsilon(1.0e-12).margin(1.0e-12));
  }
}

} // namespace

TEST_CASE("WP4 bulk ABI buffers reproduce native results",
          "[wp4][wasm_abi][numerical_contract]")
{
  nec_stateful_model native;
  build_one_port_model(native);
  const nec_impedance_result native_matrices =
    native.compute_impedance_matrix();
  const nec_port_solution native_solution =
    native.solve_port_voltages_detailed({nec_complex(1.0, 0.0)});
  nec_far_field_grid grid;
  grid.radius_m = 1.0;
  grid.theta_start_deg = 0.0;
  grid.theta_count = 3;
  grid.theta_step_deg = 45.0;
  grid.phi_start_deg = 0.0;
  grid.phi_count = 2;
  grid.phi_step_deg = 90.0;
  const nec_far_field_result native_field = native.compute_far_field(grid);

  std::unique_ptr<necpp_wasm_v1_model, decltype(&necpp_wasm_v1_model_delete)>
    abi(necpp_wasm_v1_model_create(), &necpp_wasm_v1_model_delete);
  REQUIRE(abi != nullptr);
  REQUIRE(necpp_wasm_v1_add_wire(
    abi.get(), 1, 11,
    0.0, 0.0, -0.25,
    0.0, 0.0, 0.25,
    0.001) == NECPP_WASM_V1_OK);
  REQUIRE(necpp_wasm_v1_complete_geometry(
    abi.get(), NECPP_WASM_V1_GROUND_CONNECTION_NONE) == NECPP_WASM_V1_OK);
  const int32_t tags[] = {1};
  const int32_t segments[] = {6};
  REQUIRE(necpp_wasm_v1_define_ports(
    abi.get(), tags, segments, 1) == NECPP_WASM_V1_OK);
  REQUIRE(necpp_wasm_v1_prepare(abi.get(), 300.0) == NECPP_WASM_V1_OK);
  REQUIRE(necpp_wasm_v1_compute_impedance(abi.get()) == NECPP_WASM_V1_OK);

  require_complex_buffer_matches(
    abi.get(),
    NECPP_WASM_V1_IMPEDANCE_REAL,
    NECPP_WASM_V1_IMPEDANCE_IMAG,
    native_matrices.impedance.values);
  require_complex_buffer_matches(
    abi.get(),
    NECPP_WASM_V1_ADMITTANCE_REAL,
    NECPP_WASM_V1_ADMITTANCE_IMAG,
    native_matrices.admittance.values);

  const double voltage_real[] = {1.0};
  const double voltage_imag[] = {0.0};
  REQUIRE(necpp_wasm_v1_solve_voltages(
    abi.get(), voltage_real, voltage_imag, 1) == NECPP_WASM_V1_OK);
  require_complex_buffer_matches(
    abi.get(),
    NECPP_WASM_V1_SOLUTION_CURRENTS_REAL,
    NECPP_WASM_V1_SOLUTION_CURRENTS_IMAG,
    native_solution.currents);

  REQUIRE(necpp_wasm_v1_compute_far_field(
    abi.get(),
    grid.radius_m,
    grid.theta_start_deg, grid.theta_count, grid.theta_step_deg,
    grid.phi_start_deg, grid.phi_count, grid.phi_step_deg) ==
    NECPP_WASM_V1_OK);
  require_complex_buffer_matches(
    abi.get(),
    NECPP_WASM_V1_FAR_FIELD_E_THETA_REAL,
    NECPP_WASM_V1_FAR_FIELD_E_THETA_IMAG,
    native_field.e_theta);
  require_complex_buffer_matches(
    abi.get(),
    NECPP_WASM_V1_FAR_FIELD_E_PHI_REAL,
    NECPP_WASM_V1_FAR_FIELD_E_PHI_IMAG,
    native_field.e_phi);
}
