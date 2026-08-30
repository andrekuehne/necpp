/*
  Copyright (C) 2026  NEC2++ contributors

  Stable C ABI used by the Emscripten module.  This header is intentionally
  valid C: callers never see a C++ class, exception, or standard-library type.
*/
#ifndef NECPP_WASM_V1_H
#define NECPP_WASM_V1_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct necpp_wasm_v1_model necpp_wasm_v1_model;
typedef struct necpp_wasm_v1_deck necpp_wasm_v1_deck;

enum necpp_wasm_v1_status {
  NECPP_WASM_V1_OK = 0,
  NECPP_WASM_V1_STATE_ERROR = 1,
  NECPP_WASM_V1_INPUT_ERROR = 2,
  NECPP_WASM_V1_GEOMETRY_ERROR = 3,
  NECPP_WASM_V1_PORT_ERROR = 4,
  NECPP_WASM_V1_CONDITIONING_ERROR = 5,
  NECPP_WASM_V1_SOLVER_ERROR = 6,
  NECPP_WASM_V1_RUNTIME_ERROR = 7
};

enum necpp_wasm_v1_model_state {
  NECPP_WASM_V1_STATE_INVALID = -1,
  NECPP_WASM_V1_STATE_EMPTY = 0,
  NECPP_WASM_V1_STATE_GEOMETRY_BUILDING = 1,
  NECPP_WASM_V1_STATE_GEOMETRY_COMPLETE = 2,
  NECPP_WASM_V1_STATE_PREPARED = 3,
  NECPP_WASM_V1_STATE_SOLVED = 4
};

enum necpp_wasm_v1_ground_connection {
  NECPP_WASM_V1_GROUND_CONNECTION_NONE = 0,
  NECPP_WASM_V1_GROUND_CONNECTION_INTERPOLATE = 1,
  NECPP_WASM_V1_GROUND_CONNECTION_ZERO_CURRENT = 2
};

/*
 * Geometry-symmetry values are additive ABI v1 symbols.  Existing v1
 * function signatures, status values, and enum values remain unchanged.
 */
enum necpp_wasm_v1_symmetry_kind {
  NECPP_WASM_V1_SYMMETRY_NONE = 0,
  NECPP_WASM_V1_SYMMETRY_REFLECTION = 1,
  NECPP_WASM_V1_SYMMETRY_ROTATIONAL = 2
};

enum necpp_wasm_v1_reflection_plane {
  NECPP_WASM_V1_REFLECTION_PLANE_X = 1,
  NECPP_WASM_V1_REFLECTION_PLANE_Y = 2,
  NECPP_WASM_V1_REFLECTION_PLANE_Z = 4
};

enum necpp_wasm_v1_load_kind {
  NECPP_WASM_V1_LOAD_SERIES_RLC = 0,
  NECPP_WASM_V1_LOAD_PARALLEL_RLC = 1,
  NECPP_WASM_V1_LOAD_DISTRIBUTED_SERIES_RLC = 2,
  NECPP_WASM_V1_LOAD_DISTRIBUTED_PARALLEL_RLC = 3,
  NECPP_WASM_V1_LOAD_IMPEDANCE = 4,
  NECPP_WASM_V1_LOAD_CONDUCTIVITY = 5
};

enum necpp_wasm_v1_ground_kind {
  NECPP_WASM_V1_GROUND_FREE_SPACE = 0,
  NECPP_WASM_V1_GROUND_PERFECT = 1,
  NECPP_WASM_V1_GROUND_FINITE_REFLECTION_COEFFICIENT = 2,
  NECPP_WASM_V1_GROUND_FINITE_SOMMERFELD_NORTON = 3
};

enum necpp_wasm_v1_drive {
  NECPP_WASM_V1_DRIVE_VOLTAGE = 0,
  NECPP_WASM_V1_DRIVE_CURRENT = 1
};

enum necpp_wasm_v1_embedded_normalization {
  NECPP_WASM_V1_UNIT_VOLTAGE = 0,
  NECPP_WASM_V1_UNIT_CURRENT = 1
};

/*
 * Borrowed double buffers returned by necpp_wasm_v1_result_buffer().  A
 * successful operation replacing a result of the same category may invalidate
 * its pointers.  Callers crossing the WASM boundary must copy immediately.
 */
enum necpp_wasm_v1_result_buffer_kind {
  NECPP_WASM_V1_IMPEDANCE_REAL = 0,
  NECPP_WASM_V1_IMPEDANCE_IMAG = 1,
  NECPP_WASM_V1_ADMITTANCE_REAL = 2,
  NECPP_WASM_V1_ADMITTANCE_IMAG = 3,
  NECPP_WASM_V1_SOLUTION_REQUESTED_REAL = 4,
  NECPP_WASM_V1_SOLUTION_REQUESTED_IMAG = 5,
  NECPP_WASM_V1_SOLUTION_VOLTAGES_REAL = 6,
  NECPP_WASM_V1_SOLUTION_VOLTAGES_IMAG = 7,
  NECPP_WASM_V1_SOLUTION_CURRENTS_REAL = 8,
  NECPP_WASM_V1_SOLUTION_CURRENTS_IMAG = 9,
  NECPP_WASM_V1_SOLUTION_ACTIVE_IMPEDANCES_REAL = 10,
  NECPP_WASM_V1_SOLUTION_ACTIVE_IMPEDANCES_IMAG = 11,
  NECPP_WASM_V1_SOLUTION_POWERS_W = 12,
  NECPP_WASM_V1_FAR_FIELD_THETA_DEG = 13,
  NECPP_WASM_V1_FAR_FIELD_PHI_DEG = 14,
  NECPP_WASM_V1_FAR_FIELD_E_THETA_REAL = 15,
  NECPP_WASM_V1_FAR_FIELD_E_THETA_IMAG = 16,
  NECPP_WASM_V1_FAR_FIELD_E_PHI_REAL = 17,
  NECPP_WASM_V1_FAR_FIELD_E_PHI_IMAG = 18,
  NECPP_WASM_V1_EMBEDDED_THETA_DEG = 19,
  NECPP_WASM_V1_EMBEDDED_PHI_DEG = 20,
  NECPP_WASM_V1_EMBEDDED_E_THETA_REAL = 21,
  NECPP_WASM_V1_EMBEDDED_E_THETA_IMAG = 22,
  NECPP_WASM_V1_EMBEDDED_E_PHI_REAL = 23,
  NECPP_WASM_V1_EMBEDDED_E_PHI_IMAG = 24
};

uint32_t necpp_wasm_v1_abi_version(void);
const char* necpp_wasm_v1_engine_version(void);

necpp_wasm_v1_model* necpp_wasm_v1_model_create(void);
void necpp_wasm_v1_model_delete(necpp_wasm_v1_model* model);
int32_t necpp_wasm_v1_model_state(const necpp_wasm_v1_model* model);
int32_t necpp_wasm_v1_last_status(const necpp_wasm_v1_model* model);
const char* necpp_wasm_v1_last_error(const necpp_wasm_v1_model* model);

int32_t necpp_wasm_v1_add_wire(
  necpp_wasm_v1_model* model,
  int32_t tag, int32_t segments,
  double x1, double y1, double z1,
  double x2, double y2, double z2,
  double radius_m);
int32_t necpp_wasm_v1_complete_geometry(
  necpp_wasm_v1_model* model, int32_t ground_connection);
/*
 * Complete a fundamental section with one final symmetry operation.
 * parameter is a reflection-plane bit mask or the total rotational order.
 */
int32_t necpp_wasm_v1_complete_geometry_symmetric(
  necpp_wasm_v1_model* model,
  int32_t ground_connection,
  int32_t symmetry_kind,
  int32_t parameter,
  int32_t tag_increment);
int32_t necpp_wasm_v1_define_ports(
  necpp_wasm_v1_model* model,
  const int32_t* tags, const int32_t* segments, size_t count);
int32_t necpp_wasm_v1_add_load(
  necpp_wasm_v1_model* model,
  int32_t kind, int32_t tag, int32_t first_segment, int32_t last_segment,
  double value1, double value2, double value3);
int32_t necpp_wasm_v1_clear_loads(necpp_wasm_v1_model* model);
int32_t necpp_wasm_v1_set_ground(
  necpp_wasm_v1_model* model,
  int32_t kind, double relative_permittivity, double conductivity_s_per_m);
int32_t necpp_wasm_v1_prepare(
  necpp_wasm_v1_model* model, double frequency_mhz);
int32_t necpp_wasm_v1_compute_impedance(necpp_wasm_v1_model* model);
int32_t necpp_wasm_v1_solve_voltages(
  necpp_wasm_v1_model* model,
  const double* real, const double* imag, size_t count);
int32_t necpp_wasm_v1_solve_currents(
  necpp_wasm_v1_model* model,
  const double* real, const double* imag, size_t count);
int32_t necpp_wasm_v1_compute_far_field(
  necpp_wasm_v1_model* model,
  double radius_m,
  double theta_start_deg, int32_t theta_count, double theta_step_deg,
  double phi_start_deg, int32_t phi_count, double phi_step_deg);
int32_t necpp_wasm_v1_compute_embedded_far_fields(
  necpp_wasm_v1_model* model,
  double radius_m,
  double theta_start_deg, int32_t theta_count, double theta_step_deg,
  double phi_start_deg, int32_t phi_count, double phi_step_deg,
  int32_t normalization);

size_t necpp_wasm_v1_port_count(const necpp_wasm_v1_model* model);
const int32_t* necpp_wasm_v1_port_tags(const necpp_wasm_v1_model* model);
const int32_t* necpp_wasm_v1_port_segments(const necpp_wasm_v1_model* model);

/*
 * Scalar completion metadata has no borrowed-pointer lifetime.  Before a
 * successful completion, kind is -1 and all other values are zero.
 */
int32_t necpp_wasm_v1_geometry_symmetry_kind(
  const necpp_wasm_v1_model* model);
int32_t necpp_wasm_v1_geometry_section_count(
  const necpp_wasm_v1_model* model);
int64_t necpp_wasm_v1_geometry_fundamental_segment_count(
  const necpp_wasm_v1_model* model);
int64_t necpp_wasm_v1_geometry_full_segment_count(
  const necpp_wasm_v1_model* model);

size_t necpp_wasm_v1_impedance_order(const necpp_wasm_v1_model* model);
double necpp_wasm_v1_impedance_frequency_mhz(
  const necpp_wasm_v1_model* model);
double necpp_wasm_v1_impedance_condition_estimate(
  const necpp_wasm_v1_model* model);
double necpp_wasm_v1_impedance_factorization_generation(
  const necpp_wasm_v1_model* model);

size_t necpp_wasm_v1_solution_count(const necpp_wasm_v1_model* model);
int32_t necpp_wasm_v1_solution_drive(const necpp_wasm_v1_model* model);
double necpp_wasm_v1_solution_frequency_mhz(
  const necpp_wasm_v1_model* model);
double necpp_wasm_v1_solution_factorization_generation(
  const necpp_wasm_v1_model* model);
double necpp_wasm_v1_solution_generation(
  const necpp_wasm_v1_model* model);

double necpp_wasm_v1_far_field_radius_m(const necpp_wasm_v1_model* model);
double necpp_wasm_v1_far_field_frequency_mhz(
  const necpp_wasm_v1_model* model);
size_t necpp_wasm_v1_far_field_theta_count(
  const necpp_wasm_v1_model* model);
size_t necpp_wasm_v1_far_field_phi_count(
  const necpp_wasm_v1_model* model);

double necpp_wasm_v1_embedded_radius_m(const necpp_wasm_v1_model* model);
double necpp_wasm_v1_embedded_frequency_mhz(
  const necpp_wasm_v1_model* model);
size_t necpp_wasm_v1_embedded_theta_count(
  const necpp_wasm_v1_model* model);
size_t necpp_wasm_v1_embedded_phi_count(
  const necpp_wasm_v1_model* model);
size_t necpp_wasm_v1_embedded_port_count(
  const necpp_wasm_v1_model* model);
size_t necpp_wasm_v1_embedded_samples_per_port(
  const necpp_wasm_v1_model* model);
int32_t necpp_wasm_v1_embedded_normalization(
  const necpp_wasm_v1_model* model);

const double* necpp_wasm_v1_result_buffer(
  const necpp_wasm_v1_model* model, int32_t kind);
size_t necpp_wasm_v1_result_buffer_length(
  const necpp_wasm_v1_model* model, int32_t kind);

/* Complete-deck compatibility path, independent of a stateful model. */
necpp_wasm_v1_deck* necpp_wasm_v1_deck_create(void);
void necpp_wasm_v1_deck_delete(necpp_wasm_v1_deck* deck);
int32_t necpp_wasm_v1_deck_process(
  necpp_wasm_v1_deck* deck, const char* utf8, size_t length);
int32_t necpp_wasm_v1_deck_last_status(const necpp_wasm_v1_deck* deck);
const char* necpp_wasm_v1_deck_last_error(const necpp_wasm_v1_deck* deck);
const char* necpp_wasm_v1_deck_output(const necpp_wasm_v1_deck* deck);
size_t necpp_wasm_v1_deck_output_length(const necpp_wasm_v1_deck* deck);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* NECPP_WASM_V1_H */
