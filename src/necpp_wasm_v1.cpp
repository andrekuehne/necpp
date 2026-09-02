/*
  Copyright (C) 2026  NEC2++ contributors

  Versioned exception-safe C/WASM boundary for the stateful NEC engine.
*/
#include "necpp_wasm_v1.h"

#include "config.h"
#include "nec_context.h"
#include "nec_deck.h"
#include "nec_exception.h"
#include "nec_output.h"
#include "nec_stateful_model.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <complex>
#include <cstring>
#include <exception>
#include <limits>
#include <memory>
#include <new>
#include <set>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

namespace {

struct split_complex_buffer {
  std::vector<double> real;
  std::vector<double> imag;

  void clear()
  {
    real.clear();
    imag.clear();
  }

  void assign(const std::vector<nec_complex>& values)
  {
    std::vector<double> next_real;
    std::vector<double> next_imag;
    next_real.reserve(values.size());
    next_imag.reserve(values.size());
    for (const nec_complex value : values) {
      next_real.push_back(value.real());
      next_imag.push_back(value.imag());
    }
    real = std::move(next_real);
    imag = std::move(next_imag);
  }

  void assign_reusing(const std::vector<nec_complex>& values)
  {
    real.resize(values.size());
    imag.resize(values.size());
    for (size_t index = 0; index < values.size(); ++index) {
      real[index] = values[index].real();
      imag[index] = values[index].imag();
    }
  }
};

struct impedance_buffers {
  split_complex_buffer impedance;
  split_complex_buffer admittance;
  size_t order = 0;
  double frequency_mhz = 0.0;
  double condition_estimate = 0.0;
  uint64_t factorization_generation = 0;
  bool available = false;

  void clear()
  {
    impedance.clear();
    admittance.clear();
    order = 0;
    frequency_mhz = 0.0;
    condition_estimate = 0.0;
    factorization_generation = 0;
    available = false;
  }
};

struct solution_buffers {
  split_complex_buffer requested;
  split_complex_buffer voltages;
  split_complex_buffer currents;
  split_complex_buffer active_impedances;
  std::vector<double> powers_w;
  int32_t drive = NECPP_WASM_V1_DRIVE_VOLTAGE;
  double frequency_mhz = 0.0;
  double input_power_w = 0.0;
  double radiated_power_w = 0.0;
  double structure_loss_w = 0.0;
  double network_loss_w = 0.0;
  uint64_t factorization_generation = 0;
  uint64_t solve_generation = 0;
  bool available = false;

  void clear()
  {
    requested.clear();
    voltages.clear();
    currents.clear();
    active_impedances.clear();
    powers_w.clear();
    drive = NECPP_WASM_V1_DRIVE_VOLTAGE;
    frequency_mhz = 0.0;
    input_power_w = 0.0;
    radiated_power_w = 0.0;
    structure_loss_w = 0.0;
    network_loss_w = 0.0;
    factorization_generation = 0;
    solve_generation = 0;
    available = false;
  }
};

struct far_field_buffers {
  std::vector<double> theta_deg;
  std::vector<double> phi_deg;
  split_complex_buffer e_theta;
  split_complex_buffer e_phi;
  double radius_m = 0.0;
  double frequency_mhz = 0.0;
  nec_far_field_phase_diagnostics diagnostics;
  double abi_result_copy_ms = 0.0;
  double native_abi_total_ms = 0.0;
  bool available = false;

  void clear()
  {
    theta_deg.clear();
    phi_deg.clear();
    e_theta.clear();
    e_phi.clear();
    radius_m = 0.0;
    frequency_mhz = 0.0;
    diagnostics = nec_far_field_phase_diagnostics();
    abi_result_copy_ms = 0.0;
    native_abi_total_ms = 0.0;
    available = false;
  }
};

struct embedded_buffers : far_field_buffers {
  size_t port_count = 0;
  size_t samples_per_port = 0;
  int32_t normalization = NECPP_WASM_V1_UNIT_VOLTAGE;

  void clear()
  {
    far_field_buffers::clear();
    port_count = 0;
    samples_per_port = 0;
    normalization = NECPP_WASM_V1_UNIT_VOLTAGE;
  }
};

struct far_field_snapshot_buffers {
  nec_far_field_snapshot value;
  bool available = false;

  void clear()
  {
    value = nec_far_field_snapshot();
    available = false;
  }
};

struct current_distribution_buffers {
  std::vector<double> centres;
  std::vector<double> starts;
  std::vector<double> ends;
  std::vector<double> tangents;
  std::vector<double> radii;
  std::vector<double> lengths;
  std::vector<double> a_real;
  std::vector<double> a_imag;
  std::vector<double> b_real;
  std::vector<double> b_imag;
  std::vector<double> c_real;
  std::vector<double> c_imag;
  std::vector<int32_t> tag;
  std::vector<int32_t> segment;
  std::vector<int32_t> native_index;
  std::vector<int32_t> start_kind;
  std::vector<int32_t> start_tag;
  std::vector<int32_t> start_segment;
  std::vector<int32_t> start_end;
  std::vector<int32_t> end_kind;
  std::vector<int32_t> end_tag;
  std::vector<int32_t> end_segment;
  std::vector<int32_t> end_end;
  size_t segment_count = 0;
  size_t mode_count = 0;
  int32_t mode_kind = NECPP_WASM_V1_CURRENT_LATEST_SOLUTION;
  double frequency_mhz = 0.0;
  double wavelength_m = 0.0;
  bool available = false;

  void clear()
  {
    centres.clear();
    starts.clear();
    ends.clear();
    tangents.clear();
    radii.clear();
    lengths.clear();
    a_real.clear();
    a_imag.clear();
    b_real.clear();
    b_imag.clear();
    c_real.clear();
    c_imag.clear();
    tag.clear();
    segment.clear();
    native_index.clear();
    start_kind.clear();
    start_tag.clear();
    start_segment.clear();
    start_end.clear();
    end_kind.clear();
    end_tag.clear();
    end_segment.clear();
    end_end.clear();
    segment_count = 0;
    mode_count = 0;
    mode_kind = NECPP_WASM_V1_CURRENT_LATEST_SOLUTION;
    frequency_mhz = 0.0;
    wavelength_m = 0.0;
    available = false;
  }
};

struct packed_result_buffers {
  std::vector<uint8_t> quadrature;
  std::vector<uint8_t> embedded_field;
  bool quadrature_available = false;
  bool embedded_available = false;

  void clear()
  {
    quadrature.clear();
    embedded_field.clear();
    quadrature_available = false;
    embedded_available = false;
  }

  void clear_quadrature()
  {
    quadrature.clear();
    quadrature_available = false;
  }

  void clear_embedded()
  {
    embedded_field.clear();
    embedded_available = false;
  }
};

} // namespace

struct necpp_wasm_v1_model {
  nec_stateful_model native;
  nec_geometry_completion_result geometry_completion;
  bool geometry_completion_available = false;
  int32_t last_status = NECPP_WASM_V1_OK;
  std::string last_error;
  std::vector<int32_t> port_tags;
  std::vector<int32_t> port_segments;
  impedance_buffers impedance;
  solution_buffers solution;
  far_field_buffers far_field;
  embedded_buffers embedded;
  far_field_snapshot_buffers field_snapshot;
  current_distribution_buffers current;
  packed_result_buffers packed;
};

struct necpp_wasm_v1_deck {
  int32_t last_status = NECPP_WASM_V1_OK;
  std::string last_error;
  std::string output;
};

namespace {

constexpr const char* kEmergencyError =
  "Unable to retain the native error message";

bool finite_value(double value)
{
  return std::isfinite(value);
}

template <typename Context>
int32_t set_error(
  Context* context, int32_t status, const char* message) noexcept
{
  if (context == nullptr)
    return status;
  context->last_status = status;
  try {
    context->last_error.assign(message == nullptr ? "" : message);
  } catch (...) {
    try {
      context->last_error.clear();
    } catch (...) {
    }
  }
  return status;
}

template <typename Context>
void clear_error(Context* context) noexcept
{
  if (context == nullptr)
    return;
  context->last_status = NECPP_WASM_V1_OK;
  try {
    context->last_error.clear();
  } catch (...) {
  }
}

template <typename Context>
const char* error_text(const Context* context) noexcept
{
  if (context == nullptr)
    return "Null NEC context";
  if (!context->last_error.empty())
    return context->last_error.c_str();
  return context->last_status == NECPP_WASM_V1_OK ? "" : kEmergencyError;
}

template <typename Function>
int32_t invoke(
  necpp_wasm_v1_model* model,
  int32_t failure_status,
  Function&& function) noexcept
{
  if (model == nullptr)
    return NECPP_WASM_V1_RUNTIME_ERROR;
  try {
    function();
    clear_error(model);
    return NECPP_WASM_V1_OK;
  } catch (const std::bad_alloc& error) {
    return set_error(model, NECPP_WASM_V1_RUNTIME_ERROR, error.what());
  } catch (const nec_geometry_exception& error) {
    try {
      return set_error(
        model, NECPP_WASM_V1_GEOMETRY_ERROR, error.get_message().c_str());
    } catch (...) {
      return set_error(model, NECPP_WASM_V1_GEOMETRY_ERROR,
        "NEC geometry exception");
    }
  } catch (const nec_exception& error) {
    try {
      return set_error(model, failure_status, error.get_message().c_str());
    } catch (...) {
      return set_error(model, failure_status, "NEC native exception");
    }
  } catch (const std::exception& error) {
    return set_error(model, failure_status, error.what());
  } catch (const char* error) {
    return set_error(model, failure_status, error);
  } catch (...) {
    return set_error(model, failure_status, "Unknown native exception");
  }
}

int32_t fail(
  necpp_wasm_v1_model* model, int32_t status, const char* message) noexcept
{
  return model == nullptr
    ? NECPP_WASM_V1_RUNTIME_ERROR
    : set_error(model, status, message);
}

bool is_state(
  const necpp_wasm_v1_model* model, nec_model_state expected) noexcept
{
  return model != nullptr && model->native.state() == expected;
}

bool is_configurable(const necpp_wasm_v1_model* model) noexcept
{
  if (model == nullptr)
    return false;
  const nec_model_state state = model->native.state();
  return state == nec_model_state::geometry_complete ||
    state == nec_model_state::prepared ||
    state == nec_model_state::solved;
}

bool is_prepared(const necpp_wasm_v1_model* model) noexcept
{
  if (model == nullptr)
    return false;
  const nec_model_state state = model->native.state();
  return state == nec_model_state::prepared || state == nec_model_state::solved;
}

void reconcile_consumer_results_after_failure(necpp_wasm_v1_model& model)
{
  if (model.native.state() != nec_model_state::solved) {
    model.solution.clear();
    model.far_field.clear();
    model.field_snapshot.clear();
  }
}

void clear_calculated_results(necpp_wasm_v1_model& model)
{
  model.impedance.clear();
  model.solution.clear();
  model.far_field.clear();
  model.embedded.clear();
  model.field_snapshot.clear();
  model.current.clear();
  model.packed.clear();
}

void sync_impedance(
  necpp_wasm_v1_model& model, const nec_impedance_result& result)
{
  impedance_buffers next;
  next.impedance.assign(result.impedance.values);
  next.admittance.assign(result.admittance.values);
  next.order = result.impedance.rows;
  next.frequency_mhz = result.frequency_mhz;
  next.condition_estimate = result.condition_estimate;
  next.factorization_generation = result.factorization_generation;
  next.available = true;
  model.impedance = std::move(next);
}

void sync_solution(
  necpp_wasm_v1_model& model, const nec_port_solution& result)
{
  solution_buffers next;
  next.requested.assign(result.requested);
  next.voltages.assign(result.voltages);
  next.currents.assign(result.currents);
  next.active_impedances.assign(result.active_impedances);
  next.powers_w.assign(result.powers_w.begin(), result.powers_w.end());
  next.drive = result.drive == nec_port_drive::current
    ? NECPP_WASM_V1_DRIVE_CURRENT
    : NECPP_WASM_V1_DRIVE_VOLTAGE;
  next.frequency_mhz = result.frequency_mhz;
  next.input_power_w = result.power_budget.input_power_w;
  next.radiated_power_w = result.power_budget.radiated_power_w;
  next.structure_loss_w = result.power_budget.structure_loss_w;
  next.network_loss_w = result.power_budget.network_loss_w;
  next.factorization_generation = result.factorization_generation;
  next.solve_generation = result.solve_generation;
  next.available = true;
  model.solution = std::move(next);
}

void sync_far_field(
  necpp_wasm_v1_model& model, const nec_far_field_result& result)
{
#ifdef NECPP_FAR_FIELD_REUSE_OUTPUTS
  far_field_buffers& next = model.far_field;
  next.theta_deg.assign(result.theta_deg.begin(), result.theta_deg.end());
  next.phi_deg.assign(result.phi_deg.begin(), result.phi_deg.end());
  next.e_theta.assign_reusing(result.e_theta);
  next.e_phi.assign_reusing(result.e_phi);
  next.radius_m = result.radius_m;
  next.frequency_mhz = result.frequency_mhz;
  next.diagnostics = result.diagnostics;
  next.available = true;
#else
  far_field_buffers next;
  next.theta_deg.assign(result.theta_deg.begin(), result.theta_deg.end());
  next.phi_deg.assign(result.phi_deg.begin(), result.phi_deg.end());
  next.e_theta.assign(result.e_theta);
  next.e_phi.assign(result.e_phi);
  next.radius_m = result.radius_m;
  next.frequency_mhz = result.frequency_mhz;
  next.diagnostics = result.diagnostics;
  next.available = true;
  model.far_field = std::move(next);
#endif
}

void sync_embedded(
  necpp_wasm_v1_model& model,
  const nec_embedded_far_field_result& result)
{
  embedded_buffers next;
  next.theta_deg.assign(result.theta_deg.begin(), result.theta_deg.end());
  next.phi_deg.assign(result.phi_deg.begin(), result.phi_deg.end());
  next.e_theta.assign(result.e_theta);
  next.e_phi.assign(result.e_phi);
  next.radius_m = result.radius_m;
  next.frequency_mhz = result.frequency_mhz;
  next.port_count = result.ports.size();
  next.samples_per_port = result.samples_per_port;
  next.normalization =
    result.normalization == nec_embedded_field_normalization::unit_current
      ? NECPP_WASM_V1_UNIT_CURRENT
      : NECPP_WASM_V1_UNIT_VOLTAGE;
  next.available = true;
  model.embedded = std::move(next);
}

constexpr size_t kNecfHeaderBytes = 64;
constexpr uint8_t kNecfMagic[4] = { 'N', 'E', 'C', 'F' };

void store_u32_le(uint8_t* dest, uint32_t value)
{
  dest[0] = static_cast<uint8_t>(value);
  dest[1] = static_cast<uint8_t>(value >> 8);
  dest[2] = static_cast<uint8_t>(value >> 16);
  dest[3] = static_cast<uint8_t>(value >> 24);
}

void store_u64_le(uint8_t* dest, uint64_t value)
{
  dest[0] = static_cast<uint8_t>(value);
  dest[1] = static_cast<uint8_t>(value >> 8);
  dest[2] = static_cast<uint8_t>(value >> 16);
  dest[3] = static_cast<uint8_t>(value >> 24);
  dest[4] = static_cast<uint8_t>(value >> 32);
  dest[5] = static_cast<uint8_t>(value >> 40);
  dest[6] = static_cast<uint8_t>(value >> 48);
  dest[7] = static_cast<uint8_t>(value >> 56);
}

void store_f64_le(uint8_t* dest, double value)
{
  uint64_t bits = 0;
  std::memcpy(&bits, &value, sizeof(bits));
  store_u64_le(dest, bits);
}

int32_t encode_end_kind(nec_segment_end_kind kind)
{
  switch (kind) {
  case nec_segment_end_kind::ground:
    return 1;
  case nec_segment_end_kind::segment:
    return 2;
  case nec_segment_end_kind::free:
  default:
    return 0;
  }
}

int32_t encode_end_side(nec_segment_end_side side)
{
  return side == nec_segment_end_side::end ? 1 : 0;
}

void encode_segment_end(
  const nec_segment_end& end,
  std::vector<int32_t>& kind,
  std::vector<int32_t>& tag,
  std::vector<int32_t>& segment,
  std::vector<int32_t>& side)
{
  kind.push_back(encode_end_kind(end.kind));
  if (end.kind == nec_segment_end_kind::segment) {
    tag.push_back(end.tag);
    segment.push_back(end.segment);
    side.push_back(encode_end_side(end.end));
  } else {
    tag.push_back(0);
    segment.push_back(0);
    side.push_back(0);
  }
}

void sync_current_distribution(
  necpp_wasm_v1_model& model, nec_current_distribution distribution)
{
  current_distribution_buffers next;
  next.centres.assign(
    distribution.centres_m.begin(), distribution.centres_m.end());
  next.starts.assign(distribution.starts_m.begin(), distribution.starts_m.end());
  next.ends.assign(distribution.ends_m.begin(), distribution.ends_m.end());
  next.tangents.assign(
    distribution.tangents.begin(), distribution.tangents.end());
  next.radii.assign(distribution.radii_m.begin(), distribution.radii_m.end());
  next.lengths.assign(
    distribution.lengths_m.begin(), distribution.lengths_m.end());
  next.a_real.assign(distribution.a_real.begin(), distribution.a_real.end());
  next.a_imag.assign(distribution.a_imag.begin(), distribution.a_imag.end());
  next.b_real.assign(distribution.b_real.begin(), distribution.b_real.end());
  next.b_imag.assign(distribution.b_imag.begin(), distribution.b_imag.end());
  next.c_real.assign(distribution.c_real.begin(), distribution.c_real.end());
  next.c_imag.assign(distribution.c_imag.begin(), distribution.c_imag.end());
  const size_t n_segments = distribution.segments.size();
  next.tag.reserve(n_segments);
  next.segment.reserve(n_segments);
  next.native_index.reserve(n_segments);
  next.start_kind.reserve(n_segments);
  next.start_tag.reserve(n_segments);
  next.start_segment.reserve(n_segments);
  next.start_end.reserve(n_segments);
  next.end_kind.reserve(n_segments);
  next.end_tag.reserve(n_segments);
  next.end_segment.reserve(n_segments);
  next.end_end.reserve(n_segments);
  for (size_t index = 0; index < n_segments; ++index) {
    next.tag.push_back(distribution.segments[index].tag);
    next.segment.push_back(distribution.segments[index].segment);
    next.native_index.push_back(distribution.segments[index].native_index);
    encode_segment_end(
      distribution.start_ends[index],
      next.start_kind, next.start_tag, next.start_segment, next.start_end);
    encode_segment_end(
      distribution.end_ends[index],
      next.end_kind, next.end_tag, next.end_segment, next.end_end);
  }
  next.segment_count = n_segments;
  next.mode_count = distribution.mode_count;
  next.mode_kind =
    distribution.mode_kind == nec_current_mode_kind::unit_current
      ? NECPP_WASM_V1_CURRENT_UNIT_CURRENT
      : NECPP_WASM_V1_CURRENT_LATEST_SOLUTION;
  next.frequency_mhz = distribution.frequency_mhz;
  next.wavelength_m = distribution.wavelength_m;
  next.available = true;
  model.current = std::move(next);
}

void append_f64_plane(std::vector<uint8_t>& packed, const std::vector<nec_float>& values)
{
  const size_t offset = packed.size();
  packed.resize(offset + values.size() * sizeof(double));
  uint8_t* dest = packed.data() + offset;
  for (size_t index = 0; index < values.size(); ++index)
    store_f64_le(dest + index * sizeof(double), values[index]);
}

void append_split_complex_plane(
  std::vector<uint8_t>& packed, const std::vector<nec_complex>& values, bool imag)
{
  const size_t offset = packed.size();
  packed.resize(offset + values.size() * sizeof(double));
  uint8_t* dest = packed.data() + offset;
  for (size_t index = 0; index < values.size(); ++index) {
    store_f64_le(
      dest + index * sizeof(double),
      imag ? values[index].imag() : values[index].real());
  }
}

std::vector<uint8_t> pack_embedded_field_envelope(
  const nec_embedded_far_field_result& field, uint64_t model_generation)
{
  std::vector<uint8_t> packed(kNecfHeaderBytes, 0);
  uint8_t* bytes = packed.data();
  bytes[0] = kNecfMagic[0];
  bytes[1] = kNecfMagic[1];
  bytes[2] = kNecfMagic[2];
  bytes[3] = kNecfMagic[3];
  store_u32_le(bytes + 4, 1);
  store_u32_le(bytes + 8, static_cast<uint32_t>(field.ports.size()));
  store_u32_le(bytes + 12, static_cast<uint32_t>(field.theta_deg.size()));
  store_u32_le(bytes + 16, static_cast<uint32_t>(field.phi_deg.size()));
  store_u32_le(bytes + 20, static_cast<uint32_t>(field.samples_per_port));
  store_u32_le(bytes + 24, 0);
  store_u32_le(bytes + 28, 0);
  store_f64_le(bytes + 32, field.frequency_mhz);
  store_f64_le(bytes + 40, field.radius_m);
  store_u64_le(bytes + 48, model_generation);
  store_u64_le(bytes + 56, 0);
  append_f64_plane(packed, field.theta_deg);
  append_f64_plane(packed, field.phi_deg);
  append_split_complex_plane(packed, field.e_theta, false);
  append_split_complex_plane(packed, field.e_theta, true);
  append_split_complex_plane(packed, field.e_phi, false);
  append_split_complex_plane(packed, field.e_phi, true);
  return packed;
}

bool valid_quadrature_input(
  const double* nodes, size_t node_count,
  const double* weights, size_t weight_count,
  int32_t images) noexcept
{
  if (node_count == 0 || nodes == nullptr)
    return false;
  if ((weight_count == 0) != (weights == nullptr))
    return false;
  if (weight_count != 0 && weight_count != node_count)
    return false;
  if (images != NECPP_WASM_V1_QUADRATURE_PHYSICAL_ONLY &&
      images != NECPP_WASM_V1_QUADRATURE_PERFECT_GROUND_IMAGES)
    return false;
  for (size_t index = 0; index < node_count; ++index) {
    if (!finite_value(nodes[index]) || nodes[index] < -1.0 || nodes[index] > 1.0)
      return false;
  }
  for (size_t index = 0; index < weight_count; ++index) {
    if (!finite_value(weights[index]))
      return false;
  }
  return true;
}

nec_prepared_quadrature_request make_quadrature_request(
  const double* nodes, size_t node_count,
  const double* weights, size_t weight_count,
  int32_t images, int32_t modes)
{
  nec_prepared_quadrature_request request;
  request.nodes.assign(nodes, nodes + node_count);
  if (weight_count != 0)
    request.weights.assign(weights, weights + weight_count);
  request.images = images == NECPP_WASM_V1_QUADRATURE_PERFECT_GROUND_IMAGES
    ? nec_prepared_quadrature_images::perfect_ground_images
    : nec_prepared_quadrature_images::physical_only;
  request.modes = modes == NECPP_WASM_V1_CURRENT_UNIT_CURRENT
    ? nec_current_mode_kind::unit_current
    : nec_current_mode_kind::latest_solution;
  return request;
}

bool valid_complex_input(
  const double* real, const double* imag, size_t count) noexcept
{
  if (count != 0 && (real == nullptr || imag == nullptr))
    return false;
  for (size_t index = 0; index < count; ++index) {
    if (!finite_value(real[index]) || !finite_value(imag[index]))
      return false;
  }
  return true;
}

std::vector<nec_complex> make_complex_input(
  const double* real, const double* imag, size_t count)
{
  std::vector<nec_complex> values;
  values.reserve(count);
  for (size_t index = 0; index < count; ++index)
    values.emplace_back(real[index], imag[index]);
  return values;
}

bool valid_grid(
  double radius_m,
  double theta_start_deg, int32_t theta_count, double theta_step_deg,
  double phi_start_deg, int32_t phi_count, double phi_step_deg) noexcept
{
  if (!finite_value(radius_m) || !(radius_m > 0.0) ||
      !finite_value(theta_start_deg) || !finite_value(theta_step_deg) ||
      !finite_value(phi_start_deg) || !finite_value(phi_step_deg) ||
      theta_count <= 0 || phi_count <= 0)
    return false;
  const size_t theta = static_cast<size_t>(theta_count);
  const size_t phi = static_cast<size_t>(phi_count);
  if (theta > std::numeric_limits<size_t>::max() / phi)
    return false;
  const size_t samples = theta * phi;
  if (samples > std::vector<nec_complex>().max_size())
    return false;
  const double theta_end = theta_start_deg +
    static_cast<double>(theta_count - 1) * theta_step_deg;
  const double phi_end = phi_start_deg +
    static_cast<double>(phi_count - 1) * phi_step_deg;
  return finite_value(theta_end) && finite_value(phi_end);
}

nec_far_field_grid make_grid(
  double radius_m,
  double theta_start_deg, int32_t theta_count, double theta_step_deg,
  double phi_start_deg, int32_t phi_count, double phi_step_deg)
{
  nec_far_field_grid grid;
  grid.radius_m = radius_m;
  grid.theta_start_deg = theta_start_deg;
  grid.theta_count = theta_count;
  grid.theta_step_deg = theta_step_deg;
  grid.phi_start_deg = phi_start_deg;
  grid.phi_count = phi_count;
  grid.phi_step_deg = phi_step_deg;
  return grid;
}

int32_t ensure_impedance(necpp_wasm_v1_model* model) noexcept
{
  if (model == nullptr)
    return NECPP_WASM_V1_RUNTIME_ERROR;
  int32_t status = invoke(
    model, NECPP_WASM_V1_SOLVER_ERROR,
    [&] { model->native.compute_admittance_matrix(); });
  if (status != NECPP_WASM_V1_OK) {
    reconcile_consumer_results_after_failure(*model);
    return status;
  }
  status = invoke(
    model, NECPP_WASM_V1_CONDITIONING_ERROR,
    [&] {
      const nec_impedance_result& result =
        model->native.compute_impedance_matrix();
      sync_impedance(*model, result);
    });
  if (status != NECPP_WASM_V1_OK)
    reconcile_consumer_results_after_failure(*model);
  return status;
}

const std::vector<double>* result_buffer(
  const necpp_wasm_v1_model* model, int32_t kind) noexcept
{
  if (model == nullptr)
    return nullptr;
  switch (kind) {
  case NECPP_WASM_V1_IMPEDANCE_REAL:
    return model->impedance.available ? &model->impedance.impedance.real : nullptr;
  case NECPP_WASM_V1_IMPEDANCE_IMAG:
    return model->impedance.available ? &model->impedance.impedance.imag : nullptr;
  case NECPP_WASM_V1_ADMITTANCE_REAL:
    return model->impedance.available ? &model->impedance.admittance.real : nullptr;
  case NECPP_WASM_V1_ADMITTANCE_IMAG:
    return model->impedance.available ? &model->impedance.admittance.imag : nullptr;
  case NECPP_WASM_V1_SOLUTION_REQUESTED_REAL:
    return model->solution.available ? &model->solution.requested.real : nullptr;
  case NECPP_WASM_V1_SOLUTION_REQUESTED_IMAG:
    return model->solution.available ? &model->solution.requested.imag : nullptr;
  case NECPP_WASM_V1_SOLUTION_VOLTAGES_REAL:
    return model->solution.available ? &model->solution.voltages.real : nullptr;
  case NECPP_WASM_V1_SOLUTION_VOLTAGES_IMAG:
    return model->solution.available ? &model->solution.voltages.imag : nullptr;
  case NECPP_WASM_V1_SOLUTION_CURRENTS_REAL:
    return model->solution.available ? &model->solution.currents.real : nullptr;
  case NECPP_WASM_V1_SOLUTION_CURRENTS_IMAG:
    return model->solution.available ? &model->solution.currents.imag : nullptr;
  case NECPP_WASM_V1_SOLUTION_ACTIVE_IMPEDANCES_REAL:
    return model->solution.available
      ? &model->solution.active_impedances.real : nullptr;
  case NECPP_WASM_V1_SOLUTION_ACTIVE_IMPEDANCES_IMAG:
    return model->solution.available
      ? &model->solution.active_impedances.imag : nullptr;
  case NECPP_WASM_V1_SOLUTION_POWERS_W:
    return model->solution.available ? &model->solution.powers_w : nullptr;
  case NECPP_WASM_V1_FAR_FIELD_THETA_DEG:
    return model->far_field.available ? &model->far_field.theta_deg : nullptr;
  case NECPP_WASM_V1_FAR_FIELD_PHI_DEG:
    return model->far_field.available ? &model->far_field.phi_deg : nullptr;
  case NECPP_WASM_V1_FAR_FIELD_E_THETA_REAL:
    return model->far_field.available ? &model->far_field.e_theta.real : nullptr;
  case NECPP_WASM_V1_FAR_FIELD_E_THETA_IMAG:
    return model->far_field.available ? &model->far_field.e_theta.imag : nullptr;
  case NECPP_WASM_V1_FAR_FIELD_E_PHI_REAL:
    return model->far_field.available ? &model->far_field.e_phi.real : nullptr;
  case NECPP_WASM_V1_FAR_FIELD_E_PHI_IMAG:
    return model->far_field.available ? &model->far_field.e_phi.imag : nullptr;
  case NECPP_WASM_V1_EMBEDDED_THETA_DEG:
    return model->embedded.available ? &model->embedded.theta_deg : nullptr;
  case NECPP_WASM_V1_EMBEDDED_PHI_DEG:
    return model->embedded.available ? &model->embedded.phi_deg : nullptr;
  case NECPP_WASM_V1_EMBEDDED_E_THETA_REAL:
    return model->embedded.available ? &model->embedded.e_theta.real : nullptr;
  case NECPP_WASM_V1_EMBEDDED_E_THETA_IMAG:
    return model->embedded.available ? &model->embedded.e_theta.imag : nullptr;
  case NECPP_WASM_V1_EMBEDDED_E_PHI_REAL:
    return model->embedded.available ? &model->embedded.e_phi.real : nullptr;
  case NECPP_WASM_V1_EMBEDDED_E_PHI_IMAG:
    return model->embedded.available ? &model->embedded.e_phi.imag : nullptr;
  case NECPP_WASM_V1_FF_SNAPSHOT_X:
    return model->field_snapshot.available ? &model->field_snapshot.value.x : nullptr;
  case NECPP_WASM_V1_FF_SNAPSHOT_Y:
    return model->field_snapshot.available ? &model->field_snapshot.value.y : nullptr;
  case NECPP_WASM_V1_FF_SNAPSHOT_Z:
    return model->field_snapshot.available ? &model->field_snapshot.value.z : nullptr;
  case NECPP_WASM_V1_FF_SNAPSHOT_CAB:
    return model->field_snapshot.available ? &model->field_snapshot.value.cab : nullptr;
  case NECPP_WASM_V1_FF_SNAPSHOT_SAB:
    return model->field_snapshot.available ? &model->field_snapshot.value.sab : nullptr;
  case NECPP_WASM_V1_FF_SNAPSHOT_SALP:
    return model->field_snapshot.available ? &model->field_snapshot.value.salp : nullptr;
  case NECPP_WASM_V1_FF_SNAPSHOT_HALF_LENGTH:
    return model->field_snapshot.available
      ? &model->field_snapshot.value.segment_half_lengths : nullptr;
  case NECPP_WASM_V1_FF_SNAPSHOT_AIR:
    return model->field_snapshot.available ? &model->field_snapshot.value.air : nullptr;
  case NECPP_WASM_V1_FF_SNAPSHOT_AII:
    return model->field_snapshot.available ? &model->field_snapshot.value.aii : nullptr;
  case NECPP_WASM_V1_FF_SNAPSHOT_BIR:
    return model->field_snapshot.available ? &model->field_snapshot.value.bir : nullptr;
  case NECPP_WASM_V1_FF_SNAPSHOT_BII:
    return model->field_snapshot.available ? &model->field_snapshot.value.bii : nullptr;
  case NECPP_WASM_V1_FF_SNAPSHOT_CIR:
    return model->field_snapshot.available ? &model->field_snapshot.value.cir : nullptr;
  case NECPP_WASM_V1_FF_SNAPSHOT_CII:
    return model->field_snapshot.available ? &model->field_snapshot.value.cii : nullptr;
  case NECPP_WASM_V1_CURRENT_CENTRES:
    return model->current.available ? &model->current.centres : nullptr;
  case NECPP_WASM_V1_CURRENT_STARTS:
    return model->current.available ? &model->current.starts : nullptr;
  case NECPP_WASM_V1_CURRENT_ENDS:
    return model->current.available ? &model->current.ends : nullptr;
  case NECPP_WASM_V1_CURRENT_TANGENTS:
    return model->current.available ? &model->current.tangents : nullptr;
  case NECPP_WASM_V1_CURRENT_RADII:
    return model->current.available ? &model->current.radii : nullptr;
  case NECPP_WASM_V1_CURRENT_LENGTHS:
    return model->current.available ? &model->current.lengths : nullptr;
  case NECPP_WASM_V1_CURRENT_A_REAL:
    return model->current.available ? &model->current.a_real : nullptr;
  case NECPP_WASM_V1_CURRENT_A_IMAG:
    return model->current.available ? &model->current.a_imag : nullptr;
  case NECPP_WASM_V1_CURRENT_B_REAL:
    return model->current.available ? &model->current.b_real : nullptr;
  case NECPP_WASM_V1_CURRENT_B_IMAG:
    return model->current.available ? &model->current.b_imag : nullptr;
  case NECPP_WASM_V1_CURRENT_C_REAL:
    return model->current.available ? &model->current.c_real : nullptr;
  case NECPP_WASM_V1_CURRENT_C_IMAG:
    return model->current.available ? &model->current.c_imag : nullptr;
  default:
    return nullptr;
  }
}

const std::vector<int32_t>* int32_result_buffer(
  const necpp_wasm_v1_model* model, int32_t kind) noexcept
{
  if (model == nullptr || !model->current.available)
    return nullptr;
  switch (kind) {
  case NECPP_WASM_V1_CURRENT_TAG:
    return &model->current.tag;
  case NECPP_WASM_V1_CURRENT_SEGMENT:
    return &model->current.segment;
  case NECPP_WASM_V1_CURRENT_NATIVE_INDEX:
    return &model->current.native_index;
  case NECPP_WASM_V1_CURRENT_START_KIND:
    return &model->current.start_kind;
  case NECPP_WASM_V1_CURRENT_START_TAG:
    return &model->current.start_tag;
  case NECPP_WASM_V1_CURRENT_START_SEGMENT:
    return &model->current.start_segment;
  case NECPP_WASM_V1_CURRENT_START_END:
    return &model->current.start_end;
  case NECPP_WASM_V1_CURRENT_END_KIND:
    return &model->current.end_kind;
  case NECPP_WASM_V1_CURRENT_END_TAG:
    return &model->current.end_tag;
  case NECPP_WASM_V1_CURRENT_END_SEGMENT:
    return &model->current.end_segment;
  case NECPP_WASM_V1_CURRENT_END_END:
    return &model->current.end_end;
  default:
    return nullptr;
  }
}

const std::vector<uint8_t>* packed_buffer(
  const necpp_wasm_v1_model* model, int32_t kind) noexcept
{
  if (model == nullptr)
    return nullptr;
  switch (kind) {
  case NECPP_WASM_V1_PACKED_QUADRATURE:
    return model->packed.quadrature_available ? &model->packed.quadrature : nullptr;
  case NECPP_WASM_V1_PACKED_EMBEDDED_FIELD:
    return model->packed.embedded_available ? &model->packed.embedded_field : nullptr;
  default:
    return nullptr;
  }
}

template <typename Function>
int32_t invoke_deck(
  necpp_wasm_v1_deck* deck,
  int32_t failure_status,
  Function&& function) noexcept
{
  if (deck == nullptr)
    return NECPP_WASM_V1_RUNTIME_ERROR;
  try {
    function();
    clear_error(deck);
    return NECPP_WASM_V1_OK;
  } catch (const std::bad_alloc& error) {
    return set_error(deck, NECPP_WASM_V1_RUNTIME_ERROR, error.what());
  } catch (const nec_deck_input_exception& error) {
    try {
      return set_error(
        deck, NECPP_WASM_V1_INPUT_ERROR, error.get_message().c_str());
    } catch (...) {
      return set_error(deck, NECPP_WASM_V1_INPUT_ERROR,
        "Invalid NEC deck");
    }
  } catch (const nec_exception& error) {
    try {
      return set_error(deck, failure_status, error.get_message().c_str());
    } catch (...) {
      return set_error(deck, failure_status, "NEC native exception");
    }
  } catch (const std::exception& error) {
    return set_error(deck, failure_status, error.what());
  } catch (const char* error) {
    return set_error(deck, failure_status, error);
  } catch (...) {
    return set_error(deck, failure_status, "Unknown native exception");
  }
}

} // namespace

extern "C" {

uint32_t necpp_wasm_v1_abi_version(void)
{
  return 1;
}

const char* necpp_wasm_v1_engine_version(void)
{
  return NECPP_VERSION;
}

necpp_wasm_v1_model* necpp_wasm_v1_model_create(void)
{
  try {
    return new necpp_wasm_v1_model();
  } catch (...) {
    return nullptr;
  }
}

void necpp_wasm_v1_model_delete(necpp_wasm_v1_model* model)
{
  try {
    delete model;
  } catch (...) {
  }
}

int32_t necpp_wasm_v1_model_state(const necpp_wasm_v1_model* model)
{
  if (model == nullptr)
    return NECPP_WASM_V1_STATE_INVALID;
  return static_cast<int32_t>(model->native.state());
}

int32_t necpp_wasm_v1_last_status(const necpp_wasm_v1_model* model)
{
  return model == nullptr ? NECPP_WASM_V1_RUNTIME_ERROR : model->last_status;
}

const char* necpp_wasm_v1_last_error(const necpp_wasm_v1_model* model)
{
  return error_text(model);
}

int32_t necpp_wasm_v1_add_wire(
  necpp_wasm_v1_model* model,
  int32_t tag, int32_t segments,
  double x1, double y1, double z1,
  double x2, double y2, double z2,
  double radius_m)
{
  if (model == nullptr)
    return NECPP_WASM_V1_RUNTIME_ERROR;
  const nec_model_state state = model->native.state();
  if (state != nec_model_state::empty &&
      state != nec_model_state::geometry_building)
    return fail(model, NECPP_WASM_V1_STATE_ERROR,
      "addWire is illegal after geometry completion");
  if (tag <= 0 || segments <= 0 ||
      !finite_value(x1) || !finite_value(y1) || !finite_value(z1) ||
      !finite_value(x2) || !finite_value(y2) || !finite_value(z2) ||
      !finite_value(radius_m) || !(radius_m > 0.0) ||
      (x1 == x2 && y1 == y2 && z1 == z2))
    return fail(model, NECPP_WASM_V1_INPUT_ERROR,
      "Invalid wire definition");

  return invoke(model, NECPP_WASM_V1_GEOMETRY_ERROR, [&] {
    nec_wire_definition wire;
    wire.tag = tag;
    wire.segments = segments;
    wire.x1 = x1;
    wire.y1 = y1;
    wire.z1 = z1;
    wire.x2 = x2;
    wire.y2 = y2;
    wire.z2 = z2;
    wire.radius_m = radius_m;
    model->native.add_wire(wire);
    clear_calculated_results(*model);
  });
}

int32_t necpp_wasm_v1_complete_geometry(
  necpp_wasm_v1_model* model, int32_t ground_connection)
{
  if (model == nullptr)
    return NECPP_WASM_V1_RUNTIME_ERROR;
  if (!is_state(model, nec_model_state::geometry_building))
    return fail(model, NECPP_WASM_V1_STATE_ERROR,
      "completeGeometry requires geometry-building state");
  if (ground_connection < NECPP_WASM_V1_GROUND_CONNECTION_NONE ||
      ground_connection > NECPP_WASM_V1_GROUND_CONNECTION_ZERO_CURRENT)
    return fail(model, NECPP_WASM_V1_INPUT_ERROR,
      "Unknown ground connection");
  return invoke(model, NECPP_WASM_V1_GEOMETRY_ERROR, [&] {
    model->native.complete_geometry(
      static_cast<nec_ground_connection>(ground_connection));
    model->geometry_completion = model->native.geometry_completion();
    model->geometry_completion_available = true;
    clear_calculated_results(*model);
  });
}

int32_t necpp_wasm_v1_complete_geometry_symmetric(
  necpp_wasm_v1_model* model,
  int32_t ground_connection,
  int32_t symmetry_kind,
  int32_t parameter,
  int32_t tag_increment)
{
  if (model == nullptr)
    return NECPP_WASM_V1_RUNTIME_ERROR;
  if (!is_state(model, nec_model_state::geometry_building))
    return fail(model, NECPP_WASM_V1_STATE_ERROR,
      "completeGeometry requires geometry-building state");
  if (ground_connection < NECPP_WASM_V1_GROUND_CONNECTION_NONE ||
      ground_connection > NECPP_WASM_V1_GROUND_CONNECTION_ZERO_CURRENT)
    return fail(model, NECPP_WASM_V1_INPUT_ERROR,
      "Unknown ground connection");
  const int32_t valid_planes =
    NECPP_WASM_V1_REFLECTION_PLANE_X |
    NECPP_WASM_V1_REFLECTION_PLANE_Y |
    NECPP_WASM_V1_REFLECTION_PLANE_Z;
  if (tag_increment <= 0 ||
      (symmetry_kind == NECPP_WASM_V1_SYMMETRY_REFLECTION &&
       (parameter <= 0 || (parameter & ~valid_planes) != 0)) ||
      (symmetry_kind == NECPP_WASM_V1_SYMMETRY_ROTATIONAL && parameter < 2) ||
      (symmetry_kind != NECPP_WASM_V1_SYMMETRY_REFLECTION &&
       symmetry_kind != NECPP_WASM_V1_SYMMETRY_ROTATIONAL))
    return fail(model, NECPP_WASM_V1_INPUT_ERROR,
      "Invalid geometry symmetry descriptor");

  nec_geometry_symmetry symmetry;
  symmetry.kind = static_cast<nec_geometry_symmetry_kind>(symmetry_kind);
  symmetry.tag_increment = tag_increment;
  if (symmetry.kind == nec_geometry_symmetry_kind::reflection)
    symmetry.reflection_plane_mask = static_cast<uint32_t>(parameter);
  else
    symmetry.rotational_order = parameter;

  return invoke(model, NECPP_WASM_V1_GEOMETRY_ERROR, [&] {
    model->geometry_completion = model->native.complete_geometry(
      symmetry, static_cast<nec_ground_connection>(ground_connection));
    model->geometry_completion_available = true;
    clear_calculated_results(*model);
  });
}

int32_t necpp_wasm_v1_define_ports(
  necpp_wasm_v1_model* model,
  const int32_t* tags, const int32_t* segments, size_t count)
{
  if (model == nullptr)
    return NECPP_WASM_V1_RUNTIME_ERROR;
  if (!is_state(model, nec_model_state::geometry_complete))
    return fail(model, NECPP_WASM_V1_STATE_ERROR,
      "definePorts requires geometry-complete state");
  if (count == 0)
    return fail(model, NECPP_WASM_V1_PORT_ERROR,
      "At least one port is required");
  if (tags == nullptr || segments == nullptr ||
      count > static_cast<size_t>(std::numeric_limits<int32_t>::max()))
    return fail(model, NECPP_WASM_V1_INPUT_ERROR,
      "Invalid port arrays");
  for (size_t index = 0; index < count; ++index) {
    if (tags[index] <= 0 || segments[index] <= 0)
      return fail(model, NECPP_WASM_V1_INPUT_ERROR,
        "Port tag and segment must be positive integers");
  }

  return invoke(model, NECPP_WASM_V1_PORT_ERROR, [&] {
    std::vector<nec_port_definition> ports;
    ports.reserve(count);
    for (size_t index = 0; index < count; ++index)
      ports.push_back({tags[index], segments[index]});
    model->native.define_ports(ports);
    model->port_tags.assign(tags, tags + count);
    model->port_segments.assign(segments, segments + count);
    clear_calculated_results(*model);
  });
}

int32_t necpp_wasm_v1_add_load(
  necpp_wasm_v1_model* model,
  int32_t kind, int32_t tag, int32_t first_segment, int32_t last_segment,
  double value1, double value2, double value3)
{
  if (model == nullptr)
    return NECPP_WASM_V1_RUNTIME_ERROR;
  if (!is_configurable(model))
    return fail(model, NECPP_WASM_V1_STATE_ERROR,
      "addLoad requires completed geometry");
  if (kind < NECPP_WASM_V1_LOAD_SERIES_RLC ||
      kind > NECPP_WASM_V1_LOAD_CONDUCTIVITY ||
      tag < 0 || first_segment < 0 || last_segment < 0 ||
      (first_segment == 0 && last_segment != 0) ||
      (first_segment != 0 && last_segment != 0 &&
       last_segment < first_segment) ||
      !finite_value(value1) || !finite_value(value2) || !finite_value(value3))
    return fail(model, NECPP_WASM_V1_INPUT_ERROR,
      "Invalid load definition");

  return invoke(model, NECPP_WASM_V1_GEOMETRY_ERROR, [&] {
    nec_load_definition load;
    load.kind = static_cast<nec_load_kind>(kind);
    load.tag = tag;
    load.first_segment = first_segment;
    load.last_segment = last_segment;
    load.value1 = value1;
    load.value2 = value2;
    load.value3 = value3;
    model->native.add_load(load);
    clear_calculated_results(*model);
  });
}

int32_t necpp_wasm_v1_clear_loads(necpp_wasm_v1_model* model)
{
  if (model == nullptr)
    return NECPP_WASM_V1_RUNTIME_ERROR;
  if (!is_configurable(model))
    return fail(model, NECPP_WASM_V1_STATE_ERROR,
      "clearLoads requires completed geometry");
  return invoke(model, NECPP_WASM_V1_GEOMETRY_ERROR, [&] {
    model->native.clear_loads();
    clear_calculated_results(*model);
  });
}

int32_t necpp_wasm_v1_set_ground(
  necpp_wasm_v1_model* model,
  int32_t kind, double relative_permittivity, double conductivity_s_per_m)
{
  if (model == nullptr)
    return NECPP_WASM_V1_RUNTIME_ERROR;
  if (!is_configurable(model))
    return fail(model, NECPP_WASM_V1_STATE_ERROR,
      "setGround requires completed geometry");
  if (kind < NECPP_WASM_V1_GROUND_FREE_SPACE ||
      kind > NECPP_WASM_V1_GROUND_FINITE_SOMMERFELD_NORTON)
    return fail(model, NECPP_WASM_V1_INPUT_ERROR, "Unknown ground kind");
  const bool finite_ground =
    kind == NECPP_WASM_V1_GROUND_FINITE_REFLECTION_COEFFICIENT ||
    kind == NECPP_WASM_V1_GROUND_FINITE_SOMMERFELD_NORTON;
  if (finite_ground &&
      (!finite_value(relative_permittivity) ||
       !finite_value(conductivity_s_per_m) ||
       !(relative_permittivity > 0.0) ||
       !(conductivity_s_per_m > 0.0)))
    return fail(model, NECPP_WASM_V1_INPUT_ERROR,
      "Finite-ground parameters must be positive and finite");

  return invoke(model, NECPP_WASM_V1_GEOMETRY_ERROR, [&] {
    nec_ground_definition ground;
    ground.kind = static_cast<nec_ground_kind>(kind);
    ground.relative_permittivity = relative_permittivity;
    ground.conductivity_s_per_m = conductivity_s_per_m;
    model->native.set_ground(ground);
    clear_calculated_results(*model);
  });
}

int32_t necpp_wasm_v1_prepare(
  necpp_wasm_v1_model* model, double frequency_mhz)
{
  if (model == nullptr)
    return NECPP_WASM_V1_RUNTIME_ERROR;
  if (!is_configurable(model))
    return fail(model, NECPP_WASM_V1_STATE_ERROR,
      "prepare requires completed geometry");
  if (model->port_tags.empty())
    return fail(model, NECPP_WASM_V1_PORT_ERROR,
      "Ports have not been defined");
  if (!finite_value(frequency_mhz) || !(frequency_mhz > 0.0))
    return fail(model, NECPP_WASM_V1_INPUT_ERROR,
      "Frequency must be positive and finite");

  const uint64_t generation_before = model->native.factorization_generation();
  const int32_t status = invoke(model, NECPP_WASM_V1_SOLVER_ERROR, [&] {
    model->native.prepare(frequency_mhz);
    if (model->native.factorization_generation() != generation_before)
      clear_calculated_results(*model);
  });
  if (status != NECPP_WASM_V1_OK)
    clear_calculated_results(*model);
  return status;
}

int32_t necpp_wasm_v1_compute_impedance(necpp_wasm_v1_model* model)
{
  if (model == nullptr)
    return NECPP_WASM_V1_RUNTIME_ERROR;
  if (!is_prepared(model))
    return fail(model, NECPP_WASM_V1_STATE_ERROR,
      "computeImpedanceMatrix requires a prepared model");
  return ensure_impedance(model);
}

int32_t necpp_wasm_v1_solve_voltages(
  necpp_wasm_v1_model* model,
  const double* real, const double* imag, size_t count)
{
  if (model == nullptr)
    return NECPP_WASM_V1_RUNTIME_ERROR;
  if (!is_prepared(model))
    return fail(model, NECPP_WASM_V1_STATE_ERROR,
      "solveVoltages requires a prepared model");
  if (count != model->port_tags.size() ||
      !valid_complex_input(real, imag, count))
    return fail(model, NECPP_WASM_V1_INPUT_ERROR,
      "Voltage arrays must be finite and match the port count");
  std::vector<nec_complex> voltages;
  try {
    voltages = make_complex_input(real, imag, count);
  } catch (const std::bad_alloc& error) {
    return set_error(model, NECPP_WASM_V1_RUNTIME_ERROR, error.what());
  }
  bool native_succeeded = false;
  const int32_t status = invoke(model, NECPP_WASM_V1_SOLVER_ERROR, [&] {
    const nec_port_solution& result =
      model->native.solve_port_voltages_detailed(voltages);
    native_succeeded = true;
    sync_solution(*model, result);
    model->far_field.clear();
    model->field_snapshot.clear();
  });
  if (status != NECPP_WASM_V1_OK && native_succeeded) {
    model->solution.clear();
    model->far_field.clear();
    model->field_snapshot.clear();
  } else if (status != NECPP_WASM_V1_OK) {
    reconcile_consumer_results_after_failure(*model);
  }
  return status;
}

int32_t necpp_wasm_v1_solve_currents(
  necpp_wasm_v1_model* model,
  const double* real, const double* imag, size_t count)
{
  if (model == nullptr)
    return NECPP_WASM_V1_RUNTIME_ERROR;
  if (!is_prepared(model))
    return fail(model, NECPP_WASM_V1_STATE_ERROR,
      "solveCurrents requires a prepared model");
  if (count != model->port_tags.size() ||
      !valid_complex_input(real, imag, count))
    return fail(model, NECPP_WASM_V1_INPUT_ERROR,
      "Current arrays must be finite and match the port count");
  std::vector<nec_complex> currents;
  try {
    currents = make_complex_input(real, imag, count);
  } catch (const std::bad_alloc& error) {
    return set_error(model, NECPP_WASM_V1_RUNTIME_ERROR, error.what());
  }
  const int32_t matrix_status = ensure_impedance(model);
  if (matrix_status != NECPP_WASM_V1_OK)
    return matrix_status;
  bool native_succeeded = false;
  const int32_t status = invoke(model, NECPP_WASM_V1_SOLVER_ERROR, [&] {
    const nec_port_solution& result =
      model->native.solve_port_currents(currents);
    native_succeeded = true;
    sync_solution(*model, result);
    model->far_field.clear();
    model->field_snapshot.clear();
  });
  if (status != NECPP_WASM_V1_OK && native_succeeded) {
    model->solution.clear();
    model->far_field.clear();
    model->field_snapshot.clear();
  } else if (status != NECPP_WASM_V1_OK) {
    reconcile_consumer_results_after_failure(*model);
  }
  return status;
}

int32_t necpp_wasm_v1_compute_far_field(
  necpp_wasm_v1_model* model,
  double radius_m,
  double theta_start_deg, int32_t theta_count, double theta_step_deg,
  double phi_start_deg, int32_t phi_count, double phi_step_deg)
{
  if (model == nullptr)
    return NECPP_WASM_V1_RUNTIME_ERROR;
  if (!is_state(model, nec_model_state::solved))
    return fail(model, NECPP_WASM_V1_STATE_ERROR,
      "computeFarField requires a consumer solution");
  if (!valid_grid(
        radius_m, theta_start_deg, theta_count, theta_step_deg,
        phi_start_deg, phi_count, phi_step_deg))
    return fail(model, NECPP_WASM_V1_INPUT_ERROR,
      "Invalid far-field grid");
  bool native_succeeded = false;
#ifdef NECPP_ENABLE_PERFORMANCE_DIAGNOSTICS
  const auto native_abi_started = std::chrono::steady_clock::now();
#endif
  const int32_t status = invoke(model, NECPP_WASM_V1_SOLVER_ERROR, [&] {
    const nec_far_field_result& result = model->native.compute_far_field(
      make_grid(
        radius_m, theta_start_deg, theta_count, theta_step_deg,
        phi_start_deg, phi_count, phi_step_deg));
    native_succeeded = true;
#ifdef NECPP_ENABLE_PERFORMANCE_DIAGNOSTICS
    const auto abi_copy_started = std::chrono::steady_clock::now();
#endif
    sync_far_field(*model, result);
#ifdef NECPP_ENABLE_PERFORMANCE_DIAGNOSTICS
    model->far_field.abi_result_copy_ms =
      std::chrono::duration<double, std::milli>(
        std::chrono::steady_clock::now() - abi_copy_started).count();
    model->far_field.native_abi_total_ms =
      std::chrono::duration<double, std::milli>(
        std::chrono::steady_clock::now() - native_abi_started).count();
#endif
  });
  if (status != NECPP_WASM_V1_OK && native_succeeded)
    model->far_field.clear();
  return status;
}

int32_t necpp_wasm_v1_compute_embedded_far_fields(
  necpp_wasm_v1_model* model,
  double radius_m,
  double theta_start_deg, int32_t theta_count, double theta_step_deg,
  double phi_start_deg, int32_t phi_count, double phi_step_deg,
  int32_t normalization)
{
  if (model == nullptr)
    return NECPP_WASM_V1_RUNTIME_ERROR;
  if (!is_prepared(model))
    return fail(model, NECPP_WASM_V1_STATE_ERROR,
      "computeEmbeddedFarFields requires a prepared model");
  if (!valid_grid(
        radius_m, theta_start_deg, theta_count, theta_step_deg,
        phi_start_deg, phi_count, phi_step_deg) ||
      (normalization != NECPP_WASM_V1_UNIT_VOLTAGE &&
       normalization != NECPP_WASM_V1_UNIT_CURRENT))
    return fail(model, NECPP_WASM_V1_INPUT_ERROR,
      "Invalid embedded far-field request");
  const size_t sample_count =
    static_cast<size_t>(theta_count) * static_cast<size_t>(phi_count);
  if (!model->port_tags.empty() &&
      sample_count > std::numeric_limits<size_t>::max() / model->port_tags.size())
    return fail(model, NECPP_WASM_V1_INPUT_ERROR,
      "Embedded field sample count overflows");
  const size_t embedded_sample_count = sample_count * model->port_tags.size();
  if (embedded_sample_count > std::vector<nec_complex>().max_size())
    return fail(model, NECPP_WASM_V1_INPUT_ERROR,
      "Embedded field sample count is too large");
  if (normalization == NECPP_WASM_V1_UNIT_CURRENT) {
    const int32_t matrix_status = ensure_impedance(model);
    if (matrix_status != NECPP_WASM_V1_OK)
      return matrix_status;
  }
  bool native_succeeded = false;
  const int32_t status = invoke(model, NECPP_WASM_V1_SOLVER_ERROR, [&] {
    const nec_embedded_far_field_result& result =
      model->native.compute_embedded_far_fields(
        make_grid(
          radius_m, theta_start_deg, theta_count, theta_step_deg,
          phi_start_deg, phi_count, phi_step_deg),
        static_cast<nec_embedded_field_normalization>(normalization));
    native_succeeded = true;
    sync_embedded(*model, result);
  });
  if (status != NECPP_WASM_V1_OK && native_succeeded) {
    model->embedded.clear();
  } else if (status != NECPP_WASM_V1_OK) {
    reconcile_consumer_results_after_failure(*model);
  }
  return status;
}

int32_t necpp_wasm_v1_capture_far_field_snapshot(necpp_wasm_v1_model* model)
{
  if (model == nullptr)
    return NECPP_WASM_V1_RUNTIME_ERROR;
  far_field_snapshot_buffers next;
  const int32_t status = invoke(model, NECPP_WASM_V1_RUNTIME_ERROR, [&] {
    next.value = model->native.capture_far_field_snapshot();
    next.available = true;
  });
  if (status == NECPP_WASM_V1_OK)
    model->field_snapshot = std::move(next);
  else
    model->field_snapshot.clear();
  return status;
}

int32_t necpp_wasm_v1_get_current_distribution(
  necpp_wasm_v1_model* model, int32_t mode)
{
  if (model == nullptr)
    return NECPP_WASM_V1_RUNTIME_ERROR;
  if (mode != NECPP_WASM_V1_CURRENT_LATEST_SOLUTION &&
      mode != NECPP_WASM_V1_CURRENT_UNIT_CURRENT)
    return fail(model, NECPP_WASM_V1_INPUT_ERROR, "Invalid current mode");
  if (mode == NECPP_WASM_V1_CURRENT_LATEST_SOLUTION) {
    if (!is_state(model, nec_model_state::solved))
      return fail(model, NECPP_WASM_V1_STATE_ERROR,
        "getCurrentDistribution latest-solution requires a consumer solution");
  } else if (!is_prepared(model)) {
    return fail(model, NECPP_WASM_V1_STATE_ERROR,
      "getCurrentDistribution requires a prepared model");
  }
  bool native_succeeded = false;
  const int32_t status = invoke(model, NECPP_WASM_V1_SOLVER_ERROR, [&] {
    nec_current_distribution distribution = model->native.get_current_distribution(
      mode == NECPP_WASM_V1_CURRENT_UNIT_CURRENT
        ? nec_current_mode_kind::unit_current
        : nec_current_mode_kind::latest_solution);
    native_succeeded = true;
    sync_current_distribution(*model, std::move(distribution));
  });
  if (status != NECPP_WASM_V1_OK && native_succeeded)
    model->current.clear();
  else if (status != NECPP_WASM_V1_OK)
    reconcile_consumer_results_after_failure(*model);
  return status;
}

int32_t necpp_wasm_v1_prepare_current_quadrature(
  necpp_wasm_v1_model* model,
  const double* nodes, size_t node_count,
  const double* weights, size_t weight_count,
  int32_t images,
  int32_t modes)
{
  if (model == nullptr)
    return NECPP_WASM_V1_RUNTIME_ERROR;
  if (modes != NECPP_WASM_V1_CURRENT_LATEST_SOLUTION &&
      modes != NECPP_WASM_V1_CURRENT_UNIT_CURRENT)
    return fail(model, NECPP_WASM_V1_INPUT_ERROR, "Invalid current mode");
  if (modes == NECPP_WASM_V1_CURRENT_LATEST_SOLUTION) {
    if (!is_state(model, nec_model_state::solved))
      return fail(model, NECPP_WASM_V1_STATE_ERROR,
        "prepareCurrentQuadrature latest-solution requires a consumer solution");
  } else if (!is_prepared(model)) {
    return fail(model, NECPP_WASM_V1_STATE_ERROR,
      "prepareCurrentQuadrature requires a prepared model");
  }
  if (!valid_quadrature_input(nodes, node_count, weights, weight_count, images))
    return fail(model, NECPP_WASM_V1_INPUT_ERROR,
      "Invalid prepared quadrature request");
  nec_prepared_quadrature_request request;
  try {
    request = make_quadrature_request(
      nodes, node_count, weights, weight_count, images, modes);
  } catch (const std::bad_alloc& error) {
    return set_error(model, NECPP_WASM_V1_RUNTIME_ERROR, error.what());
  }
  bool native_succeeded = false;
  const int32_t status = invoke(model, NECPP_WASM_V1_INPUT_ERROR, [&] {
    nec_prepared_current_quadrature prepared =
      model->native.prepare_current_quadrature(request);
    native_succeeded = true;
    model->packed.quadrature = std::move(prepared.packed);
    model->packed.quadrature_available = true;
  });
  if (status != NECPP_WASM_V1_OK && native_succeeded)
    model->packed.clear_quadrature();
  else if (status != NECPP_WASM_V1_OK)
    reconcile_consumer_results_after_failure(*model);
  return status;
}

int32_t necpp_wasm_v1_characterize_isolated_element(
  necpp_wasm_v1_model* model,
  const double* nodes, size_t node_count,
  const double* weights, size_t weight_count,
  int32_t images,
  double radius_m,
  double theta_start_deg, int32_t theta_count, double theta_step_deg,
  double phi_start_deg, int32_t phi_count, double phi_step_deg)
{
  if (model == nullptr)
    return NECPP_WASM_V1_RUNTIME_ERROR;
  if (!is_prepared(model))
    return fail(model, NECPP_WASM_V1_STATE_ERROR,
      "characterizeIsolatedElement requires a prepared model");
  if (!valid_quadrature_input(nodes, node_count, weights, weight_count, images) ||
      !valid_grid(
        radius_m, theta_start_deg, theta_count, theta_step_deg,
        phi_start_deg, phi_count, phi_step_deg))
    return fail(model, NECPP_WASM_V1_INPUT_ERROR,
      "Invalid isolated-element characterization request");
  nec_isolated_element_request request;
  try {
    request.quadrature = make_quadrature_request(
      nodes, node_count, weights, weight_count, images,
      NECPP_WASM_V1_CURRENT_UNIT_CURRENT);
    request.grid = make_grid(
      radius_m, theta_start_deg, theta_count, theta_step_deg,
      phi_start_deg, phi_count, phi_step_deg);
  } catch (const std::bad_alloc& error) {
    return set_error(model, NECPP_WASM_V1_RUNTIME_ERROR, error.what());
  }
  bool native_succeeded = false;
  const int32_t status = invoke(model, NECPP_WASM_V1_INPUT_ERROR, [&] {
    nec_isolated_element_characterization result =
      model->native.characterize_isolated_element(request);
    native_succeeded = true;
    sync_impedance(*model, result.matrices);
    model->packed.quadrature = std::move(result.quadrature.packed);
    model->packed.quadrature_available = true;
    model->packed.embedded_field = pack_embedded_field_envelope(
      result.embedded_field, result.matrices.factorization_generation);
    model->packed.embedded_available = true;
  });
  if (status != NECPP_WASM_V1_OK && native_succeeded) {
    model->packed.clear_quadrature();
    model->packed.clear_embedded();
  } else if (status != NECPP_WASM_V1_OK) {
    reconcile_consumer_results_after_failure(*model);
  }
  return status;
}

int32_t necpp_wasm_v1_far_field_snapshot_capability(
  const necpp_wasm_v1_model* model)
{
  return model != nullptr && model->field_snapshot.available
    ? static_cast<int32_t>(model->field_snapshot.value.capability)
    : NECPP_WASM_V1_FF_SNAPSHOT_NO_SOLUTION;
}

uint32_t necpp_wasm_v1_far_field_snapshot_schema_version(
  const necpp_wasm_v1_model* model)
{
  return model != nullptr && model->field_snapshot.available
    ? model->field_snapshot.value.schema_version : 0;
}

size_t necpp_wasm_v1_far_field_snapshot_segment_count(
  const necpp_wasm_v1_model* model)
{
  return model != nullptr && model->field_snapshot.available
    ? model->field_snapshot.value.segment_count() : 0;
}

double necpp_wasm_v1_far_field_snapshot_frequency_mhz(
  const necpp_wasm_v1_model* model)
{
  return model != nullptr && model->field_snapshot.available
    ? model->field_snapshot.value.frequency_mhz : 0.0;
}

double necpp_wasm_v1_far_field_snapshot_wavelength_m(
  const necpp_wasm_v1_model* model)
{
  return model != nullptr && model->field_snapshot.available
    ? model->field_snapshot.value.wavelength_m : 0.0;
}

double necpp_wasm_v1_far_field_snapshot_model_generation(
  const necpp_wasm_v1_model* model)
{
  return model != nullptr && model->field_snapshot.available
    ? static_cast<double>(model->field_snapshot.value.model_generation) : 0.0;
}

double necpp_wasm_v1_far_field_snapshot_solution_generation(
  const necpp_wasm_v1_model* model)
{
  return model != nullptr && model->field_snapshot.available
    ? static_cast<double>(model->field_snapshot.value.solution_generation) : 0.0;
}

int32_t necpp_wasm_v1_far_field_snapshot_perfect_ground(
  const necpp_wasm_v1_model* model)
{
  return model != nullptr && model->field_snapshot.available &&
    model->field_snapshot.value.perfect_ground ? 1 : 0;
}

size_t necpp_wasm_v1_port_count(const necpp_wasm_v1_model* model)
{
  return model == nullptr ? 0 : model->port_tags.size();
}

const int32_t* necpp_wasm_v1_port_tags(const necpp_wasm_v1_model* model)
{
  return model == nullptr || model->port_tags.empty()
    ? nullptr : model->port_tags.data();
}

const int32_t* necpp_wasm_v1_port_segments(const necpp_wasm_v1_model* model)
{
  return model == nullptr || model->port_segments.empty()
    ? nullptr : model->port_segments.data();
}

int32_t necpp_wasm_v1_geometry_symmetry_kind(
  const necpp_wasm_v1_model* model)
{
  return model != nullptr && model->geometry_completion_available
    ? static_cast<int32_t>(model->geometry_completion.symmetry.kind) : -1;
}

int32_t necpp_wasm_v1_geometry_section_count(
  const necpp_wasm_v1_model* model)
{
  return model != nullptr && model->geometry_completion_available
    ? model->geometry_completion.section_count : 0;
}

int64_t necpp_wasm_v1_geometry_fundamental_segment_count(
  const necpp_wasm_v1_model* model)
{
  return model != nullptr && model->geometry_completion_available
    ? model->geometry_completion.fundamental_segment_count : 0;
}

int64_t necpp_wasm_v1_geometry_full_segment_count(
  const necpp_wasm_v1_model* model)
{
  return model != nullptr && model->geometry_completion_available
    ? model->geometry_completion.full_segment_count : 0;
}

size_t necpp_wasm_v1_impedance_order(const necpp_wasm_v1_model* model)
{
  return model != nullptr && model->impedance.available
    ? model->impedance.order : 0;
}

double necpp_wasm_v1_impedance_frequency_mhz(
  const necpp_wasm_v1_model* model)
{
  return model != nullptr && model->impedance.available
    ? model->impedance.frequency_mhz : 0.0;
}

double necpp_wasm_v1_impedance_condition_estimate(
  const necpp_wasm_v1_model* model)
{
  return model != nullptr && model->impedance.available
    ? model->impedance.condition_estimate : 0.0;
}

double necpp_wasm_v1_impedance_factorization_generation(
  const necpp_wasm_v1_model* model)
{
  return model != nullptr && model->impedance.available
    ? static_cast<double>(model->impedance.factorization_generation) : 0.0;
}

size_t necpp_wasm_v1_solution_count(const necpp_wasm_v1_model* model)
{
  return model != nullptr && model->solution.available
    ? model->solution.voltages.real.size() : 0;
}

int32_t necpp_wasm_v1_solution_drive(const necpp_wasm_v1_model* model)
{
  return model != nullptr && model->solution.available
    ? model->solution.drive : -1;
}

double necpp_wasm_v1_solution_frequency_mhz(
  const necpp_wasm_v1_model* model)
{
  return model != nullptr && model->solution.available
    ? model->solution.frequency_mhz : 0.0;
}

double necpp_wasm_v1_solution_factorization_generation(
  const necpp_wasm_v1_model* model)
{
  return model != nullptr && model->solution.available
    ? static_cast<double>(model->solution.factorization_generation) : 0.0;
}

double necpp_wasm_v1_solution_generation(
  const necpp_wasm_v1_model* model)
{
  return model != nullptr && model->solution.available
    ? static_cast<double>(model->solution.solve_generation) : 0.0;
}

double necpp_wasm_v1_solution_input_power_w(
  const necpp_wasm_v1_model* model)
{
  return model != nullptr && model->solution.available
    ? model->solution.input_power_w : 0.0;
}

double necpp_wasm_v1_solution_radiated_power_w(
  const necpp_wasm_v1_model* model)
{
  return model != nullptr && model->solution.available
    ? model->solution.radiated_power_w : 0.0;
}

double necpp_wasm_v1_solution_structure_loss_w(
  const necpp_wasm_v1_model* model)
{
  return model != nullptr && model->solution.available
    ? model->solution.structure_loss_w : 0.0;
}

double necpp_wasm_v1_solution_network_loss_w(
  const necpp_wasm_v1_model* model)
{
  return model != nullptr && model->solution.available
    ? model->solution.network_loss_w : 0.0;
}

double necpp_wasm_v1_far_field_radius_m(const necpp_wasm_v1_model* model)
{
  return model != nullptr && model->far_field.available
    ? model->far_field.radius_m : 0.0;
}

double necpp_wasm_v1_far_field_frequency_mhz(
  const necpp_wasm_v1_model* model)
{
  return model != nullptr && model->far_field.available
    ? model->far_field.frequency_mhz : 0.0;
}

size_t necpp_wasm_v1_far_field_theta_count(
  const necpp_wasm_v1_model* model)
{
  return model != nullptr && model->far_field.available
    ? model->far_field.theta_deg.size() : 0;
}

size_t necpp_wasm_v1_far_field_phi_count(
  const necpp_wasm_v1_model* model)
{
  return model != nullptr && model->far_field.available
    ? model->far_field.phi_deg.size() : 0;
}

double necpp_wasm_v1_far_field_diagnostic(
  const necpp_wasm_v1_model* model, int32_t kind)
{
  if (model == nullptr || !model->far_field.available)
    return 0.0;
  const far_field_buffers& field = model->far_field;
  const nec_far_field_phase_diagnostics& diagnostics = field.diagnostics;
  switch (kind) {
  case NECPP_WASM_V1_FF_DIAGNOSTICS_ENABLED:
    return diagnostics.enabled ? 1.0 : 0.0;
  case NECPP_WASM_V1_FF_VALIDATION_ALLOCATION_MS:
    return diagnostics.validation_allocation_ms;
  case NECPP_WASM_V1_FF_RESULT_REPLACEMENT_MS:
    return diagnostics.result_replacement_ms;
  case NECPP_WASM_V1_FF_RAW_ACCUMULATION_MS:
    return diagnostics.raw_accumulation_ms;
  case NECPP_WASM_V1_FF_DERIVED_RP_WORK_MS:
    return diagnostics.derived_rp_work_ms;
  case NECPP_WASM_V1_FF_NATIVE_RESULT_COPY_MS:
    return diagnostics.native_result_copy_ms;
  case NECPP_WASM_V1_FF_NATIVE_TOTAL_MS:
    return diagnostics.native_total_ms;
  case NECPP_WASM_V1_FF_ABI_RESULT_COPY_MS:
    return field.abi_result_copy_ms;
  case NECPP_WASM_V1_FF_NATIVE_ABI_TOTAL_MS:
    return field.native_abi_total_ms;
  case NECPP_WASM_V1_FF_EVALUATED_DIRECTIONS:
    return static_cast<double>(diagnostics.evaluated_directions);
  case NECPP_WASM_V1_FF_SEGMENT_COUNT:
    return static_cast<double>(diagnostics.segment_count);
  case NECPP_WASM_V1_FF_GROUND_IMAGE_COUNT:
    return static_cast<double>(diagnostics.ground_image_count);
  case NECPP_WASM_V1_FF_SEGMENT_DIRECTION_CONTRIBUTIONS:
    return static_cast<double>(diagnostics.segment_direction_contributions);
  case NECPP_WASM_V1_FF_OUTPUT_BUFFER_ALLOCATIONS:
    return static_cast<double>(diagnostics.output_buffer_allocations);
  case NECPP_WASM_V1_FF_INTERMEDIATE_BUFFER_ALLOCATIONS:
    return static_cast<double>(diagnostics.intermediate_buffer_allocations);
  case NECPP_WASM_V1_FF_COMPLEX_SAMPLE_COPIES:
    return static_cast<double>(diagnostics.complex_sample_copies);
  default:
    return 0.0;
  }
}

double necpp_wasm_v1_embedded_radius_m(const necpp_wasm_v1_model* model)
{
  return model != nullptr && model->embedded.available
    ? model->embedded.radius_m : 0.0;
}

double necpp_wasm_v1_embedded_frequency_mhz(
  const necpp_wasm_v1_model* model)
{
  return model != nullptr && model->embedded.available
    ? model->embedded.frequency_mhz : 0.0;
}

size_t necpp_wasm_v1_embedded_theta_count(
  const necpp_wasm_v1_model* model)
{
  return model != nullptr && model->embedded.available
    ? model->embedded.theta_deg.size() : 0;
}

size_t necpp_wasm_v1_embedded_phi_count(
  const necpp_wasm_v1_model* model)
{
  return model != nullptr && model->embedded.available
    ? model->embedded.phi_deg.size() : 0;
}

size_t necpp_wasm_v1_embedded_port_count(
  const necpp_wasm_v1_model* model)
{
  return model != nullptr && model->embedded.available
    ? model->embedded.port_count : 0;
}

size_t necpp_wasm_v1_embedded_samples_per_port(
  const necpp_wasm_v1_model* model)
{
  return model != nullptr && model->embedded.available
    ? model->embedded.samples_per_port : 0;
}

int32_t necpp_wasm_v1_embedded_normalization(
  const necpp_wasm_v1_model* model)
{
  return model != nullptr && model->embedded.available
    ? model->embedded.normalization : -1;
}

const double* necpp_wasm_v1_result_buffer(
  const necpp_wasm_v1_model* model, int32_t kind)
{
  const std::vector<double>* buffer = result_buffer(model, kind);
  return buffer == nullptr || buffer->empty() ? nullptr : buffer->data();
}

size_t necpp_wasm_v1_result_buffer_length(
  const necpp_wasm_v1_model* model, int32_t kind)
{
  const std::vector<double>* buffer = result_buffer(model, kind);
  return buffer == nullptr ? 0 : buffer->size();
}

size_t necpp_wasm_v1_current_segment_count(const necpp_wasm_v1_model* model)
{
  return model != nullptr && model->current.available
    ? model->current.segment_count : 0;
}

size_t necpp_wasm_v1_current_mode_count(const necpp_wasm_v1_model* model)
{
  return model != nullptr && model->current.available
    ? model->current.mode_count : 0;
}

int32_t necpp_wasm_v1_current_mode_kind(const necpp_wasm_v1_model* model)
{
  return model != nullptr && model->current.available
    ? model->current.mode_kind : -1;
}

double necpp_wasm_v1_current_frequency_mhz(const necpp_wasm_v1_model* model)
{
  return model != nullptr && model->current.available
    ? model->current.frequency_mhz : 0.0;
}

double necpp_wasm_v1_current_wavelength_m(const necpp_wasm_v1_model* model)
{
  return model != nullptr && model->current.available
    ? model->current.wavelength_m : 0.0;
}

const int32_t* necpp_wasm_v1_int32_result_buffer(
  const necpp_wasm_v1_model* model, int32_t kind)
{
  const std::vector<int32_t>* buffer = int32_result_buffer(model, kind);
  return buffer == nullptr || buffer->empty() ? nullptr : buffer->data();
}

size_t necpp_wasm_v1_int32_result_buffer_length(
  const necpp_wasm_v1_model* model, int32_t kind)
{
  const std::vector<int32_t>* buffer = int32_result_buffer(model, kind);
  return buffer == nullptr ? 0 : buffer->size();
}

const uint8_t* necpp_wasm_v1_packed_buffer(
  const necpp_wasm_v1_model* model, int32_t kind)
{
  const std::vector<uint8_t>* buffer = packed_buffer(model, kind);
  return buffer == nullptr || buffer->empty() ? nullptr : buffer->data();
}

size_t necpp_wasm_v1_packed_buffer_length(
  const necpp_wasm_v1_model* model, int32_t kind)
{
  const std::vector<uint8_t>* buffer = packed_buffer(model, kind);
  return buffer == nullptr ? 0 : buffer->size();
}

necpp_wasm_v1_deck* necpp_wasm_v1_deck_create(void)
{
  try {
    return new necpp_wasm_v1_deck();
  } catch (...) {
    return nullptr;
  }
}

void necpp_wasm_v1_deck_delete(necpp_wasm_v1_deck* deck)
{
  try {
    delete deck;
  } catch (...) {
  }
}

int32_t necpp_wasm_v1_deck_process(
  necpp_wasm_v1_deck* deck, const char* utf8, size_t length)
{
  if (deck == nullptr)
    return NECPP_WASM_V1_RUNTIME_ERROR;
  if (utf8 == nullptr || length == 0)
    return set_error(deck, NECPP_WASM_V1_INPUT_ERROR,
      "A nonempty UTF-8 NEC deck is required");
  if (std::find(utf8, utf8 + length, '\0') != utf8 + length)
    return set_error(deck, NECPP_WASM_V1_INPUT_ERROR,
      "A NEC deck cannot contain an embedded NUL");
  try {
    deck->output.clear();
  } catch (...) {
    return set_error(deck, NECPP_WASM_V1_RUNTIME_ERROR,
      "Unable to clear the previous deck result");
  }
  return invoke_deck(deck, NECPP_WASM_V1_SOLVER_ERROR, [&] {
    const std::string input(utf8, length);
    std::unique_ptr<nec_context> solver(new nec_context());
    std::ostringstream report;
    nec_output_file output;
    output.set_stream(report);
    nec_process_deck(input.c_str(), *solver, output);
    deck->output = report.str();
  });
}

int32_t necpp_wasm_v1_deck_last_status(const necpp_wasm_v1_deck* deck)
{
  return deck == nullptr ? NECPP_WASM_V1_RUNTIME_ERROR : deck->last_status;
}

const char* necpp_wasm_v1_deck_last_error(const necpp_wasm_v1_deck* deck)
{
  return error_text(deck);
}

const char* necpp_wasm_v1_deck_output(const necpp_wasm_v1_deck* deck)
{
  return deck == nullptr ? "" : deck->output.c_str();
}

size_t necpp_wasm_v1_deck_output_length(const necpp_wasm_v1_deck* deck)
{
  return deck == nullptr ? 0 : deck->output.size();
}

} /* extern "C" */
