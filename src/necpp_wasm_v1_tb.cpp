#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include "nec_stateful_model.h"
#include "necpp_wasm_v1.h"

#include <memory>
#include <vector>

extern "C" int necpp_wasm_v1_run_c_contract_test(void);
extern "C" int necpp_wasm_v1_run_c_symmetry_contract_test(void);
extern "C" int necpp_wasm_v1_run_c_periodic_contract_test(void);

TEST_CASE("WP4 versioned ABI is consumable from C", "[wp4][wasm_abi]")
{
  const int failed_line = necpp_wasm_v1_run_c_contract_test();
  INFO("C ABI contract check failed at necpp_wasm_v1_c_tb.c line "
       << failed_line);
  REQUIRE(failed_line == 0);
}

TEST_CASE("WP-S3 additive symmetry ABI is consumable from pure C",
          "[wp_s3][wasm_abi][symmetry]")
{
  const int failed_line = necpp_wasm_v1_run_c_symmetry_contract_test();
  INFO("C symmetry ABI contract check failed at necpp_wasm_v1_c_tb.c line "
       << failed_line);
  REQUIRE(failed_line == 0);
}

TEST_CASE("Additive periodic ABI is consumable from pure C",
          "[periodic_model][wasm_abi]")
{
  const int failed_line = necpp_wasm_v1_run_c_periodic_contract_test();
  INFO("C periodic ABI contract check failed at necpp_wasm_v1_c_tb.c line "
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

namespace {

// Two tilted, unequal wires over perfect ground, the same through the stateful
// model and through the ABI.
void build_floquet_cell(nec_stateful_model& model)
{
  model.add_wire({1, 21, -0.2, -0.05, 0.12, 0.2, 0.05, 0.36, 0.001});
  model.add_wire({2, 17, 0.1, 0.15, 0.3, 0.3, 0.35, 0.15, 0.001});
  model.complete_geometry();
  model.define_ports({{1, 11}, {2, 9}});
  model.set_ground({nec_ground_kind::perfect});
  model.set_lattice({0.8, 0.0, 0.1, 0.7});
  model.set_scan_phases(1.1, -0.4);
  model.prepare(299.792458);
}

void build_floquet_cell(necpp_wasm_v1_model* model)
{
  static const int32_t tags[] = {1, 2};
  static const int32_t segments[] = {11, 9};
  REQUIRE(necpp_wasm_v1_add_wire(model, 1, 21, -0.2, -0.05, 0.12, 0.2, 0.05, 0.36, 0.001) ==
          NECPP_WASM_V1_OK);
  REQUIRE(necpp_wasm_v1_add_wire(model, 2, 17, 0.1, 0.15, 0.3, 0.3, 0.35, 0.15, 0.001) ==
          NECPP_WASM_V1_OK);
  REQUIRE(necpp_wasm_v1_complete_geometry(model, NECPP_WASM_V1_GROUND_CONNECTION_NONE) ==
          NECPP_WASM_V1_OK);
  REQUIRE(necpp_wasm_v1_define_ports(model, tags, segments, 2) == NECPP_WASM_V1_OK);
  REQUIRE(necpp_wasm_v1_set_ground(model, NECPP_WASM_V1_GROUND_PERFECT, 0, 0) == NECPP_WASM_V1_OK);
  REQUIRE(necpp_wasm_v1_set_lattice(model, 0.8, 0.0, 0.1, 0.7) == NECPP_WASM_V1_OK);
  REQUIRE(necpp_wasm_v1_set_scan_phases(model, 1.1, -0.4) == NECPP_WASM_V1_OK);
  REQUIRE(necpp_wasm_v1_prepare(model, 299.792458) == NECPP_WASM_V1_OK);
}

} // namespace

TEST_CASE("Floquet-amplitude ABI buffers reproduce the stateful model", "[periodic_floquet][wasm_abi]")
{
  nec_stateful_model native;
  build_floquet_cell(native);
  const nec_floquet_result expected = native.compute_floquet_amplitudes(
    nec_embedded_field_normalization::unit_current, {{1, 0}, {-1, 1}});

  std::unique_ptr<necpp_wasm_v1_model, decltype(&necpp_wasm_v1_model_delete)> owner(
    necpp_wasm_v1_model_create(), necpp_wasm_v1_model_delete);
  necpp_wasm_v1_model* model = owner.get();
  build_floquet_cell(model);
  const int32_t evanescent_p[] = {1, -1};
  const int32_t evanescent_q[] = {0, 1};
  REQUIRE(necpp_wasm_v1_compute_floquet_amplitudes(
    model, NECPP_WASM_V1_UNIT_CURRENT, evanescent_p, evanescent_q, 2) == NECPP_WASM_V1_OK);

  const size_t modes = expected.modes.size();
  const size_t ports = 2;
  REQUIRE(modes > 2);
  REQUIRE(necpp_wasm_v1_floquet_mode_count(model) == modes);
  REQUIRE(necpp_wasm_v1_floquet_port_count(model) == ports);
  REQUIRE(necpp_wasm_v1_floquet_normalization(model) == NECPP_WASM_V1_UNIT_CURRENT);
  const int32_t* p = necpp_wasm_v1_int32_result_buffer(model, NECPP_WASM_V1_FLOQUET_P);
  const int32_t* q = necpp_wasm_v1_int32_result_buffer(model, NECPP_WASM_V1_FLOQUET_Q);
  const int32_t* side = necpp_wasm_v1_int32_result_buffer(model, NECPP_WASM_V1_FLOQUET_SIDE);
  const int32_t* propagating =
    necpp_wasm_v1_int32_result_buffer(model, NECPP_WASM_V1_FLOQUET_PROPAGATING);
  const double* kt_x = necpp_wasm_v1_result_buffer(model, NECPP_WASM_V1_FLOQUET_KT_X);
  const double* kt_y = necpp_wasm_v1_result_buffer(model, NECPP_WASM_V1_FLOQUET_KT_Y);
  REQUIRE(p != nullptr);
  REQUIRE(q != nullptr);
  REQUIRE(side != nullptr);
  REQUIRE(propagating != nullptr);
  REQUIRE(kt_x != nullptr);
  REQUIRE(kt_y != nullptr);
  std::vector<nec_complex> kz, te, tm;
  std::vector<double> power;
  for (size_t mode = 0; mode < modes; ++mode) {
    const nec_floquet_mode& m = expected.modes[mode];
    REQUIRE(p[mode] == m.p);
    REQUIRE(q[mode] == m.q);
    REQUIRE(side[mode] == static_cast<int32_t>(m.side));
    REQUIRE(propagating[mode] == (m.propagating ? 1 : 0));
    REQUIRE(kt_x[mode] == m.kt_x_rad_per_m);
    REQUIRE(kt_y[mode] == m.kt_y_rad_per_m);
    kz.push_back(m.kz_rad_per_m);
    for (size_t port = 0; port < ports; ++port) {
      te.push_back(m.te[port]);
      tm.push_back(m.tm[port]);
      power.push_back(m.power_w[port]);
    }
  }
  // Amplitude buffers are mode-major: mode * ports + port.
  require_complex_buffer_matches(model, NECPP_WASM_V1_FLOQUET_KZ_REAL, NECPP_WASM_V1_FLOQUET_KZ_IMAG, kz);
  require_complex_buffer_matches(model, NECPP_WASM_V1_FLOQUET_TE_REAL, NECPP_WASM_V1_FLOQUET_TE_IMAG, te);
  require_complex_buffer_matches(model, NECPP_WASM_V1_FLOQUET_TM_REAL, NECPP_WASM_V1_FLOQUET_TM_IMAG, tm);
  const double* mode_power = necpp_wasm_v1_result_buffer(model, NECPP_WASM_V1_FLOQUET_MODE_POWER_W);
  REQUIRE(necpp_wasm_v1_result_buffer_length(model, NECPP_WASM_V1_FLOQUET_MODE_POWER_W) == power.size());
  for (size_t index = 0; index < power.size(); ++index)
    REQUIRE(mode_power[index] == power[index]);
  const double* input = necpp_wasm_v1_result_buffer(model, NECPP_WASM_V1_FLOQUET_INPUT_POWER_W);
  const double* propagating_power = necpp_wasm_v1_result_buffer(model, NECPP_WASM_V1_FLOQUET_PROPAGATING_POWER_W);
  const double* loss = necpp_wasm_v1_result_buffer(model, NECPP_WASM_V1_FLOQUET_LOSS_W);
  REQUIRE(input != nullptr);
  REQUIRE(propagating_power != nullptr);
  REQUIRE(loss != nullptr);
  for (size_t port = 0; port < ports; ++port) {
    REQUIRE(input[port] == expected.power[port].input_w);
    REQUIRE(propagating_power[port] == expected.power[port].propagating_w);
    REQUIRE(loss[port] == expected.power[port].loss_w);
  }
}

TEST_CASE("WP-S3 ABI completion metadata matches the stateful model",
          "[wp_s3][wasm_abi][symmetry]")
{
  nec_geometry_symmetry symmetry;
  symmetry.kind = nec_geometry_symmetry_kind::reflection;
  symmetry.reflection_plane_mask =
    nec_reflection_plane_x | nec_reflection_plane_y;
  symmetry.tag_increment = 1;

  nec_stateful_model native;
  native.add_wire({1, 11, 0.25, 0.25, 0.1, 0.25, 0.25, 0.4, 0.001});
  const nec_geometry_completion_result& expected =
    native.complete_geometry(symmetry);

  std::unique_ptr<necpp_wasm_v1_model, decltype(&necpp_wasm_v1_model_delete)>
    abi(necpp_wasm_v1_model_create(), &necpp_wasm_v1_model_delete);
  REQUIRE(abi != nullptr);
  REQUIRE(necpp_wasm_v1_solution_input_power_w(abi.get()) == 0.0);
  REQUIRE(necpp_wasm_v1_solution_radiated_power_w(abi.get()) == 0.0);
  REQUIRE(necpp_wasm_v1_solution_structure_loss_w(abi.get()) == 0.0);
  REQUIRE(necpp_wasm_v1_solution_network_loss_w(abi.get()) == 0.0);
  REQUIRE(necpp_wasm_v1_add_wire(
    abi.get(), 1, 11,
    0.25, 0.25, 0.1,
    0.25, 0.25, 0.4,
    0.001) == NECPP_WASM_V1_OK);
  REQUIRE(necpp_wasm_v1_complete_geometry_symmetric(
    abi.get(), NECPP_WASM_V1_GROUND_CONNECTION_NONE,
    NECPP_WASM_V1_SYMMETRY_REFLECTION,
    NECPP_WASM_V1_REFLECTION_PLANE_X |
      NECPP_WASM_V1_REFLECTION_PLANE_Y,
    1) == NECPP_WASM_V1_OK);
  REQUIRE(necpp_wasm_v1_geometry_symmetry_kind(abi.get()) ==
          static_cast<int32_t>(expected.symmetry.kind));
  REQUIRE(necpp_wasm_v1_geometry_section_count(abi.get()) ==
          expected.section_count);
  REQUIRE(necpp_wasm_v1_geometry_fundamental_segment_count(abi.get()) ==
          expected.fundamental_segment_count);
  REQUIRE(necpp_wasm_v1_geometry_full_segment_count(abi.get()) ==
          expected.full_segment_count);
}

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
  REQUIRE(necpp_wasm_v1_solution_input_power_w(abi.get()) == Catch::Approx(
    native_solution.power_budget.input_power_w).epsilon(1.0e-12));
  REQUIRE(necpp_wasm_v1_solution_radiated_power_w(abi.get()) == Catch::Approx(
    native_solution.power_budget.radiated_power_w).epsilon(1.0e-12));
  REQUIRE(necpp_wasm_v1_solution_structure_loss_w(abi.get()) == Catch::Approx(
    native_solution.power_budget.structure_loss_w).margin(1.0e-15));
  REQUIRE(necpp_wasm_v1_solution_network_loss_w(abi.get()) == Catch::Approx(
    native_solution.power_budget.network_loss_w).margin(1.0e-15));
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
