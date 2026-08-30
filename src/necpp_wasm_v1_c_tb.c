#include "necpp_wasm_v1.h"

#include <float.h>
#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#define CHECK(condition) do { if (!(condition)) return __LINE__; } while (0)

static int buffer_is_finite(
  const necpp_wasm_v1_model* model, int32_t kind, size_t expected_length)
{
  const double* values = necpp_wasm_v1_result_buffer(model, kind);
  size_t index;
  CHECK(necpp_wasm_v1_result_buffer_length(model, kind) == expected_length);
  CHECK(expected_length == 0 || values != NULL);
  for (index = 0; index < expected_length; ++index)
    CHECK(isfinite(values[index]));
  return 0;
}

static int check_symmetric_completion(
  int32_t symmetry_kind, int32_t parameter,
  int32_t expected_sections, int64_t expected_segments,
  double x, double y)
{
  necpp_wasm_v1_model* model = necpp_wasm_v1_model_create();
  CHECK(model != NULL);
  CHECK(necpp_wasm_v1_geometry_symmetry_kind(model) == -1);
  CHECK(necpp_wasm_v1_geometry_section_count(model) == 0);
  CHECK(necpp_wasm_v1_geometry_fundamental_segment_count(model) == 0);
  CHECK(necpp_wasm_v1_geometry_full_segment_count(model) == 0);
  CHECK(necpp_wasm_v1_add_wire(
    model, 1, 11, x, y, 0.1, x, y, 0.4, 0.001) ==
    NECPP_WASM_V1_OK);
  CHECK(necpp_wasm_v1_complete_geometry_symmetric(
    model, NECPP_WASM_V1_GROUND_CONNECTION_NONE,
    symmetry_kind, parameter, 1) == NECPP_WASM_V1_OK);
  CHECK(necpp_wasm_v1_geometry_symmetry_kind(model) == symmetry_kind);
  CHECK(necpp_wasm_v1_geometry_section_count(model) == expected_sections);
  CHECK(necpp_wasm_v1_geometry_fundamental_segment_count(model) == 11);
  CHECK(necpp_wasm_v1_geometry_full_segment_count(model) == expected_segments);
  necpp_wasm_v1_model_delete(model);
  return 0;
}

int necpp_wasm_v1_run_c_symmetry_contract_test(void)
{
  static const int32_t tags[2] = {1, 2};
  static const int32_t segments[2] = {6, 6};
  necpp_wasm_v1_model* model;

  CHECK(NECPP_WASM_V1_SYMMETRY_NONE == 0);
  CHECK(NECPP_WASM_V1_SYMMETRY_REFLECTION == 1);
  CHECK(NECPP_WASM_V1_SYMMETRY_ROTATIONAL == 2);
  CHECK(NECPP_WASM_V1_REFLECTION_PLANE_X == 1);
  CHECK(NECPP_WASM_V1_REFLECTION_PLANE_Y == 2);
  CHECK(NECPP_WASM_V1_REFLECTION_PLANE_Z == 4);
  CHECK(necpp_wasm_v1_geometry_symmetry_kind(NULL) == -1);
  CHECK(necpp_wasm_v1_geometry_section_count(NULL) == 0);
  CHECK(necpp_wasm_v1_geometry_fundamental_segment_count(NULL) == 0);
  CHECK(necpp_wasm_v1_geometry_full_segment_count(NULL) == 0);

  CHECK(check_symmetric_completion(
    NECPP_WASM_V1_SYMMETRY_REFLECTION,
    NECPP_WASM_V1_REFLECTION_PLANE_X |
      NECPP_WASM_V1_REFLECTION_PLANE_Y,
    4, 44, 0.25, 0.25) == 0);
  CHECK(check_symmetric_completion(
    NECPP_WASM_V1_SYMMETRY_ROTATIONAL,
    4, 4, 44, 0.25, 0.0) == 0);

  model = necpp_wasm_v1_model_create();
  CHECK(model != NULL);
  CHECK(necpp_wasm_v1_complete_geometry_symmetric(
    model, NECPP_WASM_V1_GROUND_CONNECTION_NONE,
    NECPP_WASM_V1_SYMMETRY_REFLECTION,
    NECPP_WASM_V1_REFLECTION_PLANE_X, 1) ==
    NECPP_WASM_V1_STATE_ERROR);
  CHECK(necpp_wasm_v1_add_wire(
    model, 1, 11, 0.25, 0.0, 0.1, 0.25, 0.0, 0.4, 0.001) ==
    NECPP_WASM_V1_OK);
  CHECK(necpp_wasm_v1_complete_geometry_symmetric(
    model, NECPP_WASM_V1_GROUND_CONNECTION_NONE,
    99, 4, 1) == NECPP_WASM_V1_INPUT_ERROR);
  CHECK(necpp_wasm_v1_model_state(model) ==
    NECPP_WASM_V1_STATE_GEOMETRY_BUILDING);
  necpp_wasm_v1_model_delete(model);

  model = necpp_wasm_v1_model_create();
  CHECK(model != NULL);
  CHECK(necpp_wasm_v1_add_wire(
    model, 1, 11, 0.0, 0.25, 0.1, 0.0, 0.25, 0.4, 0.001) ==
    NECPP_WASM_V1_OK);
  CHECK(necpp_wasm_v1_complete_geometry_symmetric(
    model, NECPP_WASM_V1_GROUND_CONNECTION_NONE,
    NECPP_WASM_V1_SYMMETRY_REFLECTION,
    NECPP_WASM_V1_REFLECTION_PLANE_X, 1) ==
    NECPP_WASM_V1_GEOMETRY_ERROR);
  CHECK(necpp_wasm_v1_geometry_section_count(model) == 0);
  CHECK(necpp_wasm_v1_model_state(model) ==
    NECPP_WASM_V1_STATE_GEOMETRY_BUILDING);
  necpp_wasm_v1_model_delete(model);

  model = necpp_wasm_v1_model_create();
  CHECK(model != NULL);
  CHECK(necpp_wasm_v1_add_wire(
    model, 1, 11, 0.25, 0.25, 0.1, 0.25, 0.25, 0.4, 0.001) ==
    NECPP_WASM_V1_OK);
  CHECK(necpp_wasm_v1_complete_geometry_symmetric(
    model, NECPP_WASM_V1_GROUND_CONNECTION_NONE,
    NECPP_WASM_V1_SYMMETRY_REFLECTION,
    NECPP_WASM_V1_REFLECTION_PLANE_X, 1) == NECPP_WASM_V1_OK);
  CHECK(necpp_wasm_v1_define_ports(model, tags, segments, 2) ==
    NECPP_WASM_V1_OK);
  CHECK(necpp_wasm_v1_add_load(
    model, NECPP_WASM_V1_LOAD_IMPEDANCE,
    1, 6, 6, 10.0, 0.0, 0.0) == NECPP_WASM_V1_OK);
  CHECK(necpp_wasm_v1_prepare(model, 300.0) ==
    NECPP_WASM_V1_GEOMETRY_ERROR);
  CHECK(necpp_wasm_v1_impedance_order(model) == 0);
  necpp_wasm_v1_model_delete(model);

  model = necpp_wasm_v1_model_create();
  CHECK(model != NULL);
  CHECK(necpp_wasm_v1_add_wire(
    model, 1, 11, 0.25, 0.25, 0.1, 0.25, 0.25, 0.4, 0.001) ==
    NECPP_WASM_V1_OK);
  CHECK(necpp_wasm_v1_complete_geometry_symmetric(
    model, NECPP_WASM_V1_GROUND_CONNECTION_INTERPOLATE,
    NECPP_WASM_V1_SYMMETRY_REFLECTION,
    NECPP_WASM_V1_REFLECTION_PLANE_Z, 1) ==
    NECPP_WASM_V1_GEOMETRY_ERROR);
  necpp_wasm_v1_model_delete(model);

  return 0;
}

int necpp_wasm_v1_run_c_contract_test(void)
{
  static const int32_t tags[2] = {1, 2};
  static const int32_t segments[2] = {6, 6};
  static const double voltage_real[2] = {1.0, 0.0};
  static const double voltage_imag[2] = {0.0, 0.0};
  static const double current_real[2] = {0.01, 0.0};
  static const double current_imag[2] = {0.0, 0.0};
  static const char valid_deck[] =
    "CM WP4 C ABI DECK TEST\n"
    "CE\n"
    "GW 1 11 0 0 -0.25 0 0 0.25 0.001\n"
    "GE 0\n"
    "FR 0 1 0 0 300\n"
    "EX 0 1 6 0 1 0\n"
    "XQ\n"
    "EN\n";
  static const char invalid_rp_deck[] =
    "CE\n"
    "GW 1 11 0 0 -0.25 0 0 0.25 0.001\n"
    "GE 0\n"
    "FR 0 1 0 0 300\n"
    "EX 0 1 6 0 1 0\n"
    "RP 0 -1 1 0 0 0 0 0 0 1\n"
    "EN\n";
  static const char blank_count_rp_deck[] =
    "CE\n"
    "GW 1 11 0 0 -0.25 0 0 0.25 0.001\n"
    "GE 0\n"
    "FR 0 1 0 0 300\n"
    "EX 0 1 6 0 1 0\n"
    "RP 0 0 0 0 90 0 0 0 1 0\n"
    "EN\n";
  static const char invalid_xq_deck[] =
    "CE\n"
    "GW 1 11 0 0 -0.25 0 0 0.25 0.001\n"
    "GE 0\n"
    "FR 0 1 0 0 300\n"
    "EX 0 1 6 0 1 0\n"
    "XQ 4\n"
    "EN\n";
  necpp_wasm_v1_model* model;
  necpp_wasm_v1_deck* deck;
  const int32_t* returned_tags;
  const int32_t* returned_segments;
  const double* copied_source;
  double copied_value;
  int index;

  CHECK(necpp_wasm_v1_abi_version() == 1);
  CHECK(necpp_wasm_v1_engine_version() != NULL);
  CHECK(strlen(necpp_wasm_v1_engine_version()) != 0);
  CHECK(necpp_wasm_v1_model_state(NULL) == NECPP_WASM_V1_STATE_INVALID);
  CHECK(necpp_wasm_v1_last_status(NULL) == NECPP_WASM_V1_RUNTIME_ERROR);
  CHECK(necpp_wasm_v1_last_error(NULL) != NULL);
  CHECK(necpp_wasm_v1_port_count(NULL) == 0);
  CHECK(necpp_wasm_v1_port_tags(NULL) == NULL);
  CHECK(necpp_wasm_v1_port_segments(NULL) == NULL);
  CHECK(necpp_wasm_v1_result_buffer(NULL, 0) == NULL);
  CHECK(necpp_wasm_v1_result_buffer_length(NULL, 0) == 0);
  necpp_wasm_v1_model_delete(NULL);

  model = necpp_wasm_v1_model_create();
  CHECK(model != NULL);
  CHECK(necpp_wasm_v1_model_state(model) == NECPP_WASM_V1_STATE_EMPTY);
  CHECK(necpp_wasm_v1_last_status(model) == NECPP_WASM_V1_OK);
  CHECK(strcmp(necpp_wasm_v1_last_error(model), "") == 0);

  CHECK(necpp_wasm_v1_prepare(model, 300.0) == NECPP_WASM_V1_STATE_ERROR);
  CHECK(necpp_wasm_v1_last_status(model) == NECPP_WASM_V1_STATE_ERROR);
  CHECK(strlen(necpp_wasm_v1_last_error(model)) != 0);
  CHECK(necpp_wasm_v1_add_wire(
    model, 1, 11, 0, 0, 0, 0, 0, 0, 0.001) ==
    NECPP_WASM_V1_INPUT_ERROR);
  CHECK(necpp_wasm_v1_add_wire(
    model, 1, 11, 0, 0, -0.25, 0, 0, 0.25, 0.001) ==
    NECPP_WASM_V1_OK);
  CHECK(necpp_wasm_v1_add_wire(
    model, 2, 11, 0.2, 0, -0.25, 0.2, 0, 0.25, 0.001) ==
    NECPP_WASM_V1_OK);
  CHECK(necpp_wasm_v1_model_state(model) ==
    NECPP_WASM_V1_STATE_GEOMETRY_BUILDING);
  CHECK(necpp_wasm_v1_complete_geometry(model, 99) ==
    NECPP_WASM_V1_INPUT_ERROR);
  CHECK(necpp_wasm_v1_complete_geometry(
    model, NECPP_WASM_V1_GROUND_CONNECTION_NONE) == NECPP_WASM_V1_OK);
  CHECK(necpp_wasm_v1_geometry_symmetry_kind(model) ==
    NECPP_WASM_V1_SYMMETRY_NONE);
  CHECK(necpp_wasm_v1_geometry_section_count(model) == 1);
  CHECK(necpp_wasm_v1_geometry_fundamental_segment_count(model) == 22);
  CHECK(necpp_wasm_v1_geometry_full_segment_count(model) == 22);
  CHECK(necpp_wasm_v1_model_state(model) ==
    NECPP_WASM_V1_STATE_GEOMETRY_COMPLETE);
  CHECK(necpp_wasm_v1_add_wire(
    model, 3, 11, 0.4, 0, -0.25, 0.4, 0, 0.25, 0.001) ==
    NECPP_WASM_V1_STATE_ERROR);

  CHECK(necpp_wasm_v1_define_ports(model, NULL, NULL, 2) ==
    NECPP_WASM_V1_INPUT_ERROR);
  {
    const int32_t invalid_segment[2] = {6, 999};
    CHECK(necpp_wasm_v1_define_ports(model, tags, invalid_segment, 2) ==
      NECPP_WASM_V1_PORT_ERROR);
  }
  CHECK(necpp_wasm_v1_define_ports(model, tags, segments, 2) ==
    NECPP_WASM_V1_OK);
  CHECK(necpp_wasm_v1_port_count(model) == 2);
  returned_tags = necpp_wasm_v1_port_tags(model);
  returned_segments = necpp_wasm_v1_port_segments(model);
  CHECK(returned_tags != NULL && returned_segments != NULL);
  CHECK(returned_tags[0] == 1 && returned_tags[1] == 2);
  CHECK(returned_segments[0] == 6 && returned_segments[1] == 6);

  CHECK(necpp_wasm_v1_add_load(
    model, 99, 1, 6, 6, 1.0, 0.0, 0.0) == NECPP_WASM_V1_INPUT_ERROR);
  CHECK(necpp_wasm_v1_add_load(
    model, NECPP_WASM_V1_LOAD_IMPEDANCE, 1, 6, 6, 1.0, 0.0, 0.0) ==
    NECPP_WASM_V1_OK);
  CHECK(necpp_wasm_v1_clear_loads(model) == NECPP_WASM_V1_OK);
  CHECK(necpp_wasm_v1_set_ground(
    model, NECPP_WASM_V1_GROUND_FINITE_REFLECTION_COEFFICIENT,
    -1.0, 0.01) == NECPP_WASM_V1_INPUT_ERROR);
  CHECK(necpp_wasm_v1_set_ground(
    model, NECPP_WASM_V1_GROUND_FREE_SPACE, 0.0, 0.0) ==
    NECPP_WASM_V1_OK);
  CHECK(necpp_wasm_v1_prepare(model, 0.0) == NECPP_WASM_V1_INPUT_ERROR);
  CHECK(necpp_wasm_v1_prepare(model, 300.0) == NECPP_WASM_V1_OK);
  CHECK(necpp_wasm_v1_model_state(model) == NECPP_WASM_V1_STATE_PREPARED);

  CHECK(necpp_wasm_v1_compute_impedance(model) == NECPP_WASM_V1_OK);
  CHECK(necpp_wasm_v1_impedance_order(model) == 2);
  CHECK(necpp_wasm_v1_impedance_frequency_mhz(model) == 300.0);
  CHECK(isfinite(necpp_wasm_v1_impedance_condition_estimate(model)));
  CHECK(necpp_wasm_v1_impedance_factorization_generation(model) == 1.0);
  CHECK(buffer_is_finite(model, NECPP_WASM_V1_IMPEDANCE_REAL, 4) == 0);
  CHECK(buffer_is_finite(model, NECPP_WASM_V1_IMPEDANCE_IMAG, 4) == 0);
  CHECK(buffer_is_finite(model, NECPP_WASM_V1_ADMITTANCE_REAL, 4) == 0);
  CHECK(buffer_is_finite(model, NECPP_WASM_V1_ADMITTANCE_IMAG, 4) == 0);
  CHECK(necpp_wasm_v1_result_buffer(model, 999) == NULL);
  CHECK(necpp_wasm_v1_result_buffer_length(model, 999) == 0);

  CHECK(necpp_wasm_v1_solve_voltages(model, NULL, NULL, 2) ==
    NECPP_WASM_V1_INPUT_ERROR);
  CHECK(necpp_wasm_v1_solve_voltages(
    model, voltage_real, voltage_imag, 2) == NECPP_WASM_V1_OK);
  CHECK(necpp_wasm_v1_model_state(model) == NECPP_WASM_V1_STATE_SOLVED);
  CHECK(necpp_wasm_v1_solution_count(model) == 2);
  CHECK(necpp_wasm_v1_solution_drive(model) == NECPP_WASM_V1_DRIVE_VOLTAGE);
  CHECK(necpp_wasm_v1_solution_frequency_mhz(model) == 300.0);
  CHECK(necpp_wasm_v1_solution_factorization_generation(model) == 1.0);
  CHECK(necpp_wasm_v1_solution_generation(model) == 1.0);
  for (index = NECPP_WASM_V1_SOLUTION_REQUESTED_REAL;
       index <= NECPP_WASM_V1_SOLUTION_POWERS_W; ++index)
    CHECK(buffer_is_finite(model, index, 2) == 0);

  CHECK(necpp_wasm_v1_compute_far_field(
    model, 0.0, 0.0, 1, 0.0, 0.0, 1, 0.0) ==
    NECPP_WASM_V1_INPUT_ERROR);
  CHECK(necpp_wasm_v1_compute_far_field(
    model, 1.0, DBL_MAX, 2, DBL_MAX, 0.0, 1, 0.0) ==
    NECPP_WASM_V1_INPUT_ERROR);
  CHECK(necpp_wasm_v1_compute_far_field(
    model, 1.0, 0.0, 3, 45.0, 0.0, 2, 90.0) == NECPP_WASM_V1_OK);
  CHECK(necpp_wasm_v1_far_field_radius_m(model) == 1.0);
  CHECK(necpp_wasm_v1_far_field_frequency_mhz(model) == 300.0);
  CHECK(necpp_wasm_v1_far_field_theta_count(model) == 3);
  CHECK(necpp_wasm_v1_far_field_phi_count(model) == 2);
  CHECK(buffer_is_finite(model, NECPP_WASM_V1_FAR_FIELD_THETA_DEG, 3) == 0);
  CHECK(buffer_is_finite(model, NECPP_WASM_V1_FAR_FIELD_PHI_DEG, 2) == 0);
  for (index = NECPP_WASM_V1_FAR_FIELD_E_THETA_REAL;
       index <= NECPP_WASM_V1_FAR_FIELD_E_PHI_IMAG; ++index)
    CHECK(buffer_is_finite(model, index, 6) == 0);

  copied_source = necpp_wasm_v1_result_buffer(
    model, NECPP_WASM_V1_FAR_FIELD_E_THETA_REAL);
  CHECK(copied_source != NULL);
  copied_value = copied_source[0];
  CHECK(necpp_wasm_v1_compute_embedded_far_fields(
    model, 1.0, 0.0, 2, 90.0, 0.0, 2, 90.0, 99) ==
    NECPP_WASM_V1_INPUT_ERROR);
  CHECK(necpp_wasm_v1_compute_embedded_far_fields(
    model, 1.0, 0.0, 2, 90.0, 0.0, 2, 90.0,
    NECPP_WASM_V1_UNIT_VOLTAGE) == NECPP_WASM_V1_OK);
  CHECK(copied_value == copied_source[0]);
  CHECK(necpp_wasm_v1_embedded_radius_m(model) == 1.0);
  CHECK(necpp_wasm_v1_embedded_frequency_mhz(model) == 300.0);
  CHECK(necpp_wasm_v1_embedded_theta_count(model) == 2);
  CHECK(necpp_wasm_v1_embedded_phi_count(model) == 2);
  CHECK(necpp_wasm_v1_embedded_port_count(model) == 2);
  CHECK(necpp_wasm_v1_embedded_samples_per_port(model) == 4);
  CHECK(necpp_wasm_v1_embedded_normalization(model) ==
    NECPP_WASM_V1_UNIT_VOLTAGE);
  CHECK(buffer_is_finite(model, NECPP_WASM_V1_EMBEDDED_THETA_DEG, 2) == 0);
  CHECK(buffer_is_finite(model, NECPP_WASM_V1_EMBEDDED_PHI_DEG, 2) == 0);
  for (index = NECPP_WASM_V1_EMBEDDED_E_THETA_REAL;
       index <= NECPP_WASM_V1_EMBEDDED_E_PHI_IMAG; ++index)
    CHECK(buffer_is_finite(model, index, 8) == 0);
  CHECK(necpp_wasm_v1_compute_embedded_far_fields(
    model, 1.0, 90.0, 1, 0.0, 0.0, 1, 0.0,
    NECPP_WASM_V1_UNIT_CURRENT) == NECPP_WASM_V1_OK);
  CHECK(necpp_wasm_v1_embedded_normalization(model) ==
    NECPP_WASM_V1_UNIT_CURRENT);

  CHECK(necpp_wasm_v1_solve_currents(
    model, current_real, current_imag, 2) == NECPP_WASM_V1_OK);
  CHECK(necpp_wasm_v1_solution_drive(model) == NECPP_WASM_V1_DRIVE_CURRENT);
  CHECK(necpp_wasm_v1_solution_generation(model) == 2.0);
  CHECK(necpp_wasm_v1_set_ground(
    model, NECPP_WASM_V1_GROUND_FREE_SPACE, 0.0, 0.0) ==
    NECPP_WASM_V1_OK);
  CHECK(necpp_wasm_v1_model_state(model) ==
    NECPP_WASM_V1_STATE_GEOMETRY_COMPLETE);
  CHECK(necpp_wasm_v1_solution_count(model) == 0);
  CHECK(necpp_wasm_v1_impedance_order(model) == 0);
  CHECK(necpp_wasm_v1_far_field_radius_m(model) == 0.0);
  CHECK(necpp_wasm_v1_embedded_radius_m(model) == 0.0);
  CHECK(necpp_wasm_v1_prepare(model, 300.0) == NECPP_WASM_V1_OK);
  necpp_wasm_v1_model_delete(model);

  for (index = 0; index < 100; ++index) {
    model = necpp_wasm_v1_model_create();
    CHECK(model != NULL);
    necpp_wasm_v1_model_delete(model);
  }
  for (index = 0; index < 5; ++index) {
    model = necpp_wasm_v1_model_create();
    CHECK(model != NULL);
    CHECK(necpp_wasm_v1_add_wire(
      model, 1, 11, 0, 0, -0.25, 0, 0, 0.25, 0.001) ==
      NECPP_WASM_V1_OK);
    CHECK(necpp_wasm_v1_complete_geometry(
      model, NECPP_WASM_V1_GROUND_CONNECTION_NONE) == NECPP_WASM_V1_OK);
    CHECK(necpp_wasm_v1_define_ports(model, tags, segments, 1) ==
      NECPP_WASM_V1_OK);
    CHECK(necpp_wasm_v1_prepare(model, 300.0) == NECPP_WASM_V1_OK);
    CHECK(necpp_wasm_v1_solve_voltages(
      model, voltage_real, voltage_imag, 1) == NECPP_WASM_V1_OK);
    necpp_wasm_v1_model_delete(model);
  }

  CHECK(necpp_wasm_v1_deck_last_status(NULL) ==
    NECPP_WASM_V1_RUNTIME_ERROR);
  CHECK(necpp_wasm_v1_deck_last_error(NULL) != NULL);
  CHECK(strcmp(necpp_wasm_v1_deck_output(NULL), "") == 0);
  CHECK(necpp_wasm_v1_deck_output_length(NULL) == 0);
  necpp_wasm_v1_deck_delete(NULL);
  deck = necpp_wasm_v1_deck_create();
  CHECK(deck != NULL);
  CHECK(necpp_wasm_v1_deck_process(deck, NULL, 0) ==
    NECPP_WASM_V1_INPUT_ERROR);
  CHECK(necpp_wasm_v1_deck_process(
    deck, valid_deck, sizeof(valid_deck) - 1) == NECPP_WASM_V1_OK);
  CHECK(necpp_wasm_v1_deck_last_status(deck) == NECPP_WASM_V1_OK);
  CHECK(necpp_wasm_v1_deck_output_length(deck) > 0);
  CHECK(strstr(necpp_wasm_v1_deck_output(deck), "WP4 C ABI DECK TEST") != NULL);
  CHECK(necpp_wasm_v1_deck_process(
    deck, "CE\nBOGUS\nEN\n", sizeof("CE\nBOGUS\nEN\n") - 1) ==
    NECPP_WASM_V1_INPUT_ERROR);
  CHECK(strlen(necpp_wasm_v1_deck_last_error(deck)) != 0);
  CHECK(necpp_wasm_v1_deck_output_length(deck) == 0);
  CHECK(necpp_wasm_v1_deck_process(
    deck, invalid_rp_deck, sizeof(invalid_rp_deck) - 1) ==
    NECPP_WASM_V1_INPUT_ERROR);
  CHECK(necpp_wasm_v1_deck_process(
    deck, invalid_xq_deck, sizeof(invalid_xq_deck) - 1) ==
    NECPP_WASM_V1_INPUT_ERROR);
  CHECK(necpp_wasm_v1_deck_process(
    deck, blank_count_rp_deck, sizeof(blank_count_rp_deck) - 1) ==
    NECPP_WASM_V1_OK);
  necpp_wasm_v1_deck_delete(deck);

  return 0;
}
