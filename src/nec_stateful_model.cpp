/*
  Copyright (C) 2026  NEC2++ contributors

  This program is free software; you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation; either version 2 of the License, or
  (at your option) any later version.
*/
#include "nec_stateful_model.h"

#include "c_geometry.h"
#include "electromag.h"
#include "nec_context.h"
#include "nec_exception.h"
#include "nec_far_field.h"
#include "nec_port_matrix.h"
#include "nec_prepared_current_quadrature.h"
#include "nec_results.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <exception>
#include <limits>
#include <set>
#include <string>
#include <tuple>
#include <utility>

namespace {

void fail(const char* operation, const char* reason)
{
  nec_exception error("STATEFUL MODEL ");
  error.append(operation);
  error.append(": ");
  error.append(reason);
  throw error;
}

void fail_geometry(const char* operation, const char* reason)
{
  nec_geometry_exception error("STATEFUL MODEL ");
  error.append(operation);
  error.append(": ");
  error.append(reason);
  throw error;
}

bool finite_value(nec_float value)
{
  return std::isfinite(value);
}

size_t checked_field_sample_count(
  const nec_far_field_grid& grid, const char* operation)
{
  if (!finite_value(grid.radius_m) || !(grid.radius_m > 0.0) ||
      !finite_value(grid.theta_start_deg) || !finite_value(grid.theta_step_deg) ||
      !finite_value(grid.phi_start_deg) || !finite_value(grid.phi_step_deg) ||
      grid.theta_count <= 0 || grid.phi_count <= 0)
    fail(operation, "GRID VALUES ARE INVALID");

  const size_t theta_count = static_cast<size_t>(grid.theta_count);
  const size_t phi_count = static_cast<size_t>(grid.phi_count);
  if (theta_count > std::numeric_limits<size_t>::max() / phi_count)
    fail(operation, "GRID SAMPLE COUNT OVERFLOWS");
  const size_t sample_count = theta_count * phi_count;
  if (sample_count > std::vector<nec_complex>().max_size())
    fail(operation, "GRID SAMPLE COUNT IS TOO LARGE");
  return sample_count;
}

void populate_field_axes(
  const nec_far_field_grid& grid,
  std::vector<nec_float>& theta_deg,
  std::vector<nec_float>& phi_deg,
  const char* operation)
{
  theta_deg.resize(static_cast<size_t>(grid.theta_count));
  phi_deg.resize(static_cast<size_t>(grid.phi_count));
  for (size_t index = 0; index < theta_deg.size(); ++index) {
    theta_deg[index] =
      grid.theta_start_deg + static_cast<nec_float>(index) * grid.theta_step_deg;
    if (!finite_value(theta_deg[index]))
      fail(operation, "THETA AXIS CONTAINS A NONFINITE VALUE");
  }
  for (size_t index = 0; index < phi_deg.size(); ++index) {
    phi_deg[index] =
      grid.phi_start_deg + static_cast<nec_float>(index) * grid.phi_step_deg;
    if (!finite_value(phi_deg[index]))
      fail(operation, "PHI AXIS CONTAINS A NONFINITE VALUE");
  }
}

size_t checked_angular_index(
  size_t theta_count, size_t phi_count,
  size_t theta_index, size_t phi_index)
{
  if (theta_index >= theta_count || phi_index >= phi_count)
    throw std::out_of_range("NEC far-field index is out of range");
  return phi_index * theta_count + theta_index;
}

void resize_current_coefficient_planes(
  nec_current_distribution& distribution)
{
  const size_t values = distribution.mode_count * distribution.segment_count();
  distribution.a_real.assign(values, 0.0);
  distribution.a_imag.assign(values, 0.0);
  distribution.b_real.assign(values, 0.0);
  distribution.b_imag.assign(values, 0.0);
  distribution.c_real.assign(values, 0.0);
  distribution.c_imag.assign(values, 0.0);
}

void copy_current_coefficient_mode(
  const nec_far_field_evaluation_input& input,
  nec_current_distribution& distribution,
  size_t mode_index,
  const char* operation)
{
  const size_t count = distribution.segment_count();
  // NEC solves wire-current coefficients in its wavelength-normalized
  // coordinate system.  The native coefficients therefore carry A/m and
  // legacy current reporting multiplies them by wavelength to recover the
  // physical segment current in amperes.  nec_current_distribution is the
  // public producer boundary: its A/B/C contract is ampere-valued with s and
  // geometry in metres, so perform the dimensional conversion here once for
  // direct callers, NECQ packing, characterization, and worker serialization.
  const nec_float amperes_per_native_coefficient = input.wavelength;
  for (size_t index = 0; index < count; ++index) {
    const int64_t native = static_cast<int64_t>(index);
    const nec_float air = input.air[native] * amperes_per_native_coefficient;
    const nec_float aii = input.aii[native] * amperes_per_native_coefficient;
    const nec_float bir = input.bir[native] * amperes_per_native_coefficient;
    const nec_float bii = input.bii[native] * amperes_per_native_coefficient;
    const nec_float cir = input.cir[native] * amperes_per_native_coefficient;
    const nec_float cii = input.cii[native] * amperes_per_native_coefficient;
    if (!finite_value(air) || !finite_value(aii) ||
        !finite_value(bir) || !finite_value(bii) ||
        !finite_value(cir) || !finite_value(cii))
      fail(operation, "ENGINE RETURNED A NONFINITE CURRENT COEFFICIENT");
    const size_t plane = distribution.plane_index(mode_index, index);
    distribution.a_real[plane] = air;
    distribution.a_imag[plane] = aii;
    distribution.b_real[plane] = bir;
    distribution.b_imag[plane] = bii;
    distribution.c_real[plane] = cir;
    distribution.c_imag[plane] = cii;
  }
}

} // namespace

const nec_complex& nec_far_field_result::e_theta_at(
  size_t theta_index, size_t phi_index) const
{
  return e_theta.at(checked_angular_index(
    theta_deg.size(), phi_deg.size(), theta_index, phi_index));
}

const nec_complex& nec_far_field_result::e_phi_at(
  size_t theta_index, size_t phi_index) const
{
  return e_phi.at(checked_angular_index(
    theta_deg.size(), phi_deg.size(), theta_index, phi_index));
}

const nec_complex& nec_embedded_far_field_result::e_theta_at(
  size_t port_index, size_t theta_index, size_t phi_index) const
{
  if (port_index >= ports.size())
    throw std::out_of_range("NEC embedded-field port index is out of range");
  return e_theta.at(port_index * samples_per_port + checked_angular_index(
    theta_deg.size(), phi_deg.size(), theta_index, phi_index));
}

const nec_complex& nec_embedded_far_field_result::e_phi_at(
  size_t port_index, size_t theta_index, size_t phi_index) const
{
  if (port_index >= ports.size())
    throw std::out_of_range("NEC embedded-field port index is out of range");
  return e_phi.at(port_index * samples_per_port + checked_angular_index(
    theta_deg.size(), phi_deg.size(), theta_index, phi_index));
}

nec_stateful_model::nec_stateful_model()
  : m_context(std::make_unique<nec_context>())
{
}

nec_stateful_model::~nec_stateful_model() = default;
nec_stateful_model::nec_stateful_model(nec_stateful_model&&) noexcept = default;
nec_stateful_model& nec_stateful_model::operator=(nec_stateful_model&&) noexcept = default;

void nec_stateful_model::require_state(
  nec_model_state expected, const char* operation) const
{
  if (m_state != expected)
    fail(operation, "ILLEGAL LIFECYCLE STATE");
}

void nec_stateful_model::require_configurable(const char* operation) const
{
  if (m_state != nec_model_state::geometry_complete &&
      m_state != nec_model_state::prepared &&
      m_state != nec_model_state::solved)
    fail(operation, "REQUIRES COMPLETED GEOMETRY");
}

void nec_stateful_model::invalidate_factorization()
{
  m_configuration_dirty = true;
  m_frequency_mhz = 0.0;
  clear_matrix_cache();
  clear_consumer_solution();
  m_far_field_segment_half_lengths.clear();
  m_context->stateful_clear_results();
  m_state = nec_model_state::geometry_complete;
}

void nec_stateful_model::clear_matrix_cache()
{
  m_admittance_matrix = {};
  m_impedance_result = {};
  m_has_admittance_matrix = false;
  m_has_impedance_result = false;
}

void nec_stateful_model::clear_consumer_solution()
{
  m_port_currents.clear();
  m_last_port_solution = {};
  m_has_port_solution = false;
}

void nec_stateful_model::add_wire(const nec_wire_definition& wire)
{
  if (m_state != nec_model_state::empty &&
      m_state != nec_model_state::geometry_building)
    fail("ADD WIRE", "GEOMETRY IS ALREADY COMPLETE");
  if (wire.tag <= 0 || wire.segments <= 0)
    fail("ADD WIRE", "TAG AND SEGMENT COUNT MUST BE POSITIVE");
  if (!finite_value(wire.x1) || !finite_value(wire.y1) || !finite_value(wire.z1) ||
      !finite_value(wire.x2) || !finite_value(wire.y2) || !finite_value(wire.z2) ||
      !finite_value(wire.radius_m) || !(wire.radius_m > 0.0))
    fail("ADD WIRE", "COORDINATES AND POSITIVE RADIUS MUST BE FINITE");
  if (wire.x1 == wire.x2 && wire.y1 == wire.y2 && wire.z1 == wire.z2)
    fail("ADD WIRE", "ENDPOINTS MUST BE DISTINCT");

  m_context->wire(
    wire.tag, wire.segments,
    wire.x1, wire.y1, wire.z1,
    wire.x2, wire.y2, wire.z2,
    wire.radius_m, 1.0, 1.0);
  m_state = nec_model_state::geometry_building;
}

void nec_stateful_model::complete_geometry(nec_ground_connection connection)
{
  static_cast<void>(complete_geometry(nec_geometry_symmetry{}, connection));
}

const nec_geometry_completion_result& nec_stateful_model::complete_geometry(
  const nec_geometry_symmetry& symmetry,
  nec_ground_connection connection)
{
  require_state(nec_model_state::geometry_building, "COMPLETE GEOMETRY");
  int flag = 0;
  switch (connection) {
  case nec_ground_connection::none:
    flag = 0;
    break;
  case nec_ground_connection::interpolate:
    flag = 1;
    break;
  case nec_ground_connection::zero_current:
    flag = -1;
    break;
  default:
    fail("COMPLETE GEOMETRY", "UNKNOWN GROUND CONNECTION MODE");
  }

  if (connection != nec_ground_connection::none &&
      symmetry.kind == nec_geometry_symmetry_kind::reflection &&
      (symmetry.reflection_plane_mask & nec_reflection_plane_z) != 0u)
    fail_geometry(
      "COMPLETE GEOMETRY",
      "Z=0 STRUCTURAL REFLECTION IS INCOMPATIBLE WITH A GROUND CONNECTION");

  const nec_geometry_completion_result completion =
    m_context->get_geometry()->generate_symmetry(symmetry);
  m_context->geometry_complete(flag);
  m_geometry_completion = completion;
  m_ground_connection = connection;
  m_state = nec_model_state::geometry_complete;
  m_configuration_dirty = true;
  return m_geometry_completion;
}

const nec_geometry_completion_result&
nec_stateful_model::geometry_completion() const
{
  if (m_state == nec_model_state::empty ||
      m_state == nec_model_state::geometry_building)
    fail("GEOMETRY COMPLETION", "GEOMETRY IS NOT COMPLETE");
  return m_geometry_completion;
}

void nec_stateful_model::define_ports(
  const std::vector<nec_port_definition>& ports)
{
  require_state(nec_model_state::geometry_complete, "DEFINE PORTS");
  if (ports.empty())
    fail("DEFINE PORTS", "AT LEAST ONE PORT IS REQUIRED");

  std::set<std::pair<int, int>> unique_ports;
  std::set<int> unique_absolute_segments;
  std::vector<int> absolute_segments;
  absolute_segments.reserve(ports.size());

  for (const nec_port_definition& port : ports) {
    if (port.tag <= 0 || port.segment <= 0)
      fail("DEFINE PORTS", "TAG AND SEGMENT MUST BE POSITIVE");
    if (!unique_ports.emplace(port.tag, port.segment).second)
      fail("DEFINE PORTS", "DUPLICATE TAG/SEGMENT PAIR");

    const int64_t absolute =
      m_context->get_geometry()->get_segment_number(port.tag, port.segment);
    if (!unique_absolute_segments.insert(static_cast<int>(absolute)).second)
      fail("DEFINE PORTS", "PORTS RESOLVE TO THE SAME PHYSICAL SEGMENT");
    absolute_segments.push_back(static_cast<int>(absolute));
  }

  m_ports = ports;
  m_absolute_port_segments = std::move(absolute_segments);
  clear_matrix_cache();
  clear_consumer_solution();
}

void nec_stateful_model::validate_load_target(
  const nec_load_definition& load) const
{
  if (load.tag < 0 || load.first_segment < 0 || load.last_segment < 0)
    fail("ADD LOAD", "SEGMENT SELECTION CANNOT BE NEGATIVE");
  if (load.first_segment == 0 && load.last_segment != 0)
    fail("ADD LOAD", "LAST SEGMENT REQUIRES A FIRST SEGMENT");
  if (load.first_segment != 0 && load.last_segment != 0 &&
      load.last_segment < load.first_segment)
    fail("ADD LOAD", "SEGMENT RANGE IS REVERSED");

  c_geometry* geometry = m_context->get_geometry();
  if (load.tag == 0) {
    const int first = load.first_segment == 0 ? 1 : load.first_segment;
    const int last = load.last_segment == 0
      ? (load.first_segment == 0 ? static_cast<int>(geometry->n_segments) : first)
      : load.last_segment;
    if (first <= 0 || last > geometry->n_segments)
      fail("ADD LOAD", "ABSOLUTE SEGMENT TARGET IS OUT OF RANGE");
  } else {
    const int first = load.first_segment == 0 ? 1 : load.first_segment;
    geometry->get_segment_number(load.tag, first);
    if (load.last_segment != 0)
      geometry->get_segment_number(load.tag, load.last_segment);
  }
}

void nec_stateful_model::add_load(const nec_load_definition& load)
{
  require_configurable("ADD LOAD");
  validate_load_target(load);
  const int load_kind = static_cast<int>(load.kind);
  if (load_kind < 0 || load_kind > 5)
    fail("ADD LOAD", "UNKNOWN LOAD KIND");
  if (!finite_value(load.value1) ||
      !finite_value(load.value2) ||
      !finite_value(load.value3))
    fail("ADD LOAD", "LOAD VALUES MUST BE FINITE");

  const int last_segment =
    load.first_segment != 0 && load.last_segment == 0
      ? load.first_segment
      : load.last_segment;

  m_loads.push_back(load);
  try {
    m_context->ld_card(
      load_kind, load.tag,
      load.first_segment, last_segment,
      load.value1, load.value2, load.value3);
  } catch (...) {
    m_loads.pop_back();
    throw;
  }
  invalidate_factorization();
}

void nec_stateful_model::clear_loads()
{
  require_configurable("CLEAR LOADS");
  m_context->stateful_clear_loads();
  m_loads.clear();
  invalidate_factorization();
}

void nec_stateful_model::validate_symmetry_ground(
  const nec_ground_definition& ground, const char* operation) const
{
  if (ground.kind != nec_ground_kind::free_space &&
      m_geometry_completion.symmetry.kind ==
        nec_geometry_symmetry_kind::reflection &&
      (m_geometry_completion.symmetry.reflection_plane_mask &
        nec_reflection_plane_z) != 0u)
    fail_geometry(
      operation,
      "Z=0 STRUCTURAL REFLECTION IS INCOMPATIBLE WITH GROUND");
}

void nec_stateful_model::validate_symmetric_load_orbits() const
{
  if (m_geometry_completion.section_count <= 1 || m_loads.empty())
    return;

  const int64_t fundamental_count =
    m_geometry_completion.fundamental_segment_count;
  const int64_t full_count = m_geometry_completion.full_segment_count;
  using load_signature =
    std::tuple<int, nec_float, nec_float, nec_float>;
  if (fundamental_count <= 0 || full_count <= 0 ||
      full_count % m_geometry_completion.section_count != 0 ||
      full_count / m_geometry_completion.section_count != fundamental_count)
    fail_geometry("PREPARE", "SYMMETRY COMPLETION METADATA IS INCONSISTENT");
  if (static_cast<uint64_t>(full_count) >
      static_cast<uint64_t>(std::vector<load_signature>().max_size()))
    fail_geometry("PREPARE", "SYMMETRY LOAD VALIDATION SIZE IS TOO LARGE");

  std::vector<std::vector<load_signature>> loads_by_segment(
    static_cast<size_t>(full_count));
  const c_geometry* geometry = m_context->get_geometry();

  for (const nec_load_definition& load : m_loads) {
    const load_signature signature{
      static_cast<int>(load.kind), load.value1, load.value2, load.value3};
    const int64_t first = load.first_segment == 0 ? 1 : load.first_segment;
    const int64_t last = load.last_segment == 0
      ? (load.first_segment == 0 ? full_count : first)
      : load.last_segment;
    int64_t tag_occurrence = 0;

    for (int64_t index = 0; index < full_count; ++index) {
      bool selected = false;
      if (load.tag == 0) {
        const int64_t absolute_segment = index + 1;
        selected = absolute_segment >= first && absolute_segment <= last;
      } else if (geometry->segment_tags[index] == load.tag) {
        ++tag_occurrence;
        selected = load.first_segment == 0 ||
          (tag_occurrence >= first && tag_occurrence <= last);
      }
      if (selected)
        loads_by_segment[static_cast<size_t>(index)].push_back(signature);
    }
  }

  for (std::vector<load_signature>& segment_loads : loads_by_segment)
    std::sort(segment_loads.begin(), segment_loads.end());

  for (int64_t fundamental = 0;
       fundamental < fundamental_count; ++fundamental) {
    const std::vector<load_signature>& expected =
      loads_by_segment[static_cast<size_t>(fundamental)];
    for (int copy = 1;
         copy < m_geometry_completion.section_count; ++copy) {
      const size_t generated = static_cast<size_t>(
        fundamental + static_cast<int64_t>(copy) * fundamental_count);
      if (loads_by_segment[generated] != expected)
        fail_geometry("PREPARE", "INCOMPLETE OR UNEQUAL SYMMETRY LOAD ORBIT");
    }
  }
}

void nec_stateful_model::set_ground(const nec_ground_definition& ground)
{
  require_configurable("SET GROUND");
  validate_symmetry_ground(ground, "SET GROUND");

  int ground_type = -1;
  switch (ground.kind) {
  case nec_ground_kind::free_space:
    break;
  case nec_ground_kind::perfect:
    ground_type = 1;
    break;
  case nec_ground_kind::finite_reflection_coefficient:
    ground_type = 0;
    break;
  case nec_ground_kind::finite_sommerfeld_norton:
    ground_type = 2;
    break;
  default:
    fail("SET GROUND", "UNKNOWN GROUND KIND");
  }

  if (ground_type == 0 || ground_type == 2) {
    if (!finite_value(ground.relative_permittivity) ||
        !finite_value(ground.conductivity_s_per_m) ||
        !(ground.relative_permittivity > 0.0) ||
        !(ground.conductivity_s_per_m > 0.0))
      fail("SET GROUND", "FINITE GROUND PARAMETERS MUST BE POSITIVE AND FINITE");
  }

  m_context->gn_card(
    ground_type, 0,
    ground.relative_permittivity, ground.conductivity_s_per_m,
    0.0, 0.0, 0.0, 0.0);
  m_ground = ground;
  invalidate_factorization();
}

void nec_stateful_model::prepare(nec_float frequency_mhz)
{
  require_configurable("PREPARE");
  if (m_ports.empty())
    fail("PREPARE", "PORTS HAVE NOT BEEN DEFINED");
  if (!finite_value(frequency_mhz) || !(frequency_mhz > 0.0))
    fail("PREPARE", "FREQUENCY MUST BE POSITIVE AND FINITE");
  if (m_ground_connection != nec_ground_connection::none &&
      m_ground.kind == nec_ground_kind::free_space)
    fail_geometry(
      "PREPARE", "A GROUND CONNECTION REQUIRES A GROUND MODEL");

  validate_symmetry_ground(m_ground, "PREPARE");
  validate_symmetric_load_orbits();

  if (!m_configuration_dirty && m_frequency_mhz == frequency_mhz)
    return;

  // A failed fill/factorization cannot leave the old prepared state exposed:
  // the context matrix may already have been overwritten.  The geometry and
  // environment remain reusable for a later prepare attempt.
  m_context->stateful_clear_results();
  m_far_field_segment_half_lengths.clear();
  m_configuration_dirty = true;
  m_frequency_mhz = 0.0;
  clear_matrix_cache();
  clear_consumer_solution();
  m_state = nec_model_state::geometry_complete;
  m_context->stateful_prepare_frequency(frequency_mhz);
#ifdef NECPP_FAR_FIELD_CACHE_SEGMENTS
  const real_array& segment_lengths =
    m_context->get_geometry()->segment_length;
  m_far_field_segment_half_lengths.resize(
    static_cast<size_t>(segment_lengths.size()));
  for (size_t index = 0;
       index < m_far_field_segment_half_lengths.size(); ++index) {
    m_far_field_segment_half_lengths[index] =
      pi() * segment_lengths[static_cast<int64_t>(index)];
  }
#endif
  m_frequency_mhz = frequency_mhz;
  ++m_factorization_generation;
  m_configuration_dirty = false;
  clear_consumer_solution();
  m_state = nec_model_state::prepared;
}

void nec_stateful_model::execute_voltage_solve(
  const std::vector<nec_complex>& voltages,
  std::vector<nec_complex>& achieved_voltages,
  std::vector<nec_complex>& achieved_currents)
{
  m_context->stateful_clear_results();
  m_context->stateful_solve_voltage_sources(m_absolute_port_segments, voltages);

  nec_antenna_input* input = m_context->get_input_parameters(0);
  if (input == nullptr)
    fail("PORT VOLTAGE SOLVE", "ENGINE DID NOT RETURN PORT INPUT DATA");
  achieved_voltages = input->get_voltage();
  achieved_currents = input->get_current();
  if (achieved_voltages.size() != m_ports.size() ||
      achieved_currents.size() != m_ports.size())
    fail("PORT VOLTAGE SOLVE", "ENGINE RETURNED THE WRONG PORT COUNT");
  for (size_t index = 0; index < m_ports.size(); ++index) {
    if (!finite_value(achieved_voltages[index].real()) ||
        !finite_value(achieved_voltages[index].imag()) ||
        !finite_value(achieved_currents[index].real()) ||
        !finite_value(achieved_currents[index].imag()))
      fail("PORT VOLTAGE SOLVE", "ENGINE RETURNED A NONFINITE PORT VALUE");
  }
}

void nec_stateful_model::apply_unit_current_basis(
  size_t port_index,
  const nec_complex_matrix& impedance,
  std::vector<nec_complex>& achieved_voltages,
  std::vector<nec_complex>& achieved_currents)
{
  if (port_index >= m_ports.size() || port_index >= impedance.columns)
    fail("UNIT CURRENT BASIS", "PORT INDEX IS OUT OF RANGE");
  std::vector<nec_complex> basis_voltages(
    m_ports.size(), nec_complex(0.0, 0.0));
  for (size_t row = 0; row < impedance.rows; ++row)
    basis_voltages[row] = impedance.at(row, port_index);
  execute_voltage_solve(
    basis_voltages, achieved_voltages, achieved_currents);
  ++m_unit_current_basis_solve_count;
}

const nec_port_solution& nec_stateful_model::finish_consumer_solve(
  nec_port_drive drive,
  const std::vector<nec_complex>& requested,
  std::vector<nec_complex> achieved_voltages,
  std::vector<nec_complex> achieved_currents)
{
  const nec_float nan = std::numeric_limits<nec_float>::quiet_NaN();
  nec_port_solution solution;
  solution.drive = drive;
  solution.requested = requested;
  solution.voltages = std::move(achieved_voltages);
  solution.currents = std::move(achieved_currents);
  solution.power_budget = m_context->stateful_power_budget();
  solution.active_impedances.reserve(m_ports.size());
  solution.powers_w.reserve(m_ports.size());

  for (size_t index = 0; index < m_ports.size(); ++index) {
    const nec_complex voltage = solution.voltages[index];
    const nec_complex current = solution.currents[index];
    solution.active_impedances.push_back(
      current == nec_complex(0.0, 0.0)
        ? nec_complex(nan, nan)
        : voltage / current);
    solution.powers_w.push_back(
      0.5 * std::real(voltage * std::conj(current)));
  }

  solution.frequency_mhz = m_frequency_mhz;
  solution.factorization_generation = m_factorization_generation;
  solution.solve_generation = ++m_solve_generation;
  m_last_port_solution = std::move(solution);
  m_port_currents = m_last_port_solution.currents;
  m_has_port_solution = true;
  m_state = nec_model_state::solved;
  return m_last_port_solution;
}

const nec_port_solution& nec_stateful_model::solve_port_voltages_detailed(
  const std::vector<nec_complex>& voltages)
{
  if (m_state != nec_model_state::prepared && m_state != nec_model_state::solved)
    fail("SOLVE PORT VOLTAGES", "MODEL IS NOT PREPARED");
  if (voltages.size() != m_ports.size())
    fail("SOLVE PORT VOLTAGES", "VOLTAGE COUNT MUST MATCH PORT COUNT");
  for (const nec_complex voltage : voltages) {
    if (!finite_value(voltage.real()) || !finite_value(voltage.imag()))
      fail("SOLVE PORT VOLTAGES", "VOLTAGES MUST BE FINITE");
  }

  std::vector<nec_complex> achieved_voltages;
  std::vector<nec_complex> achieved_currents;
  try {
    execute_voltage_solve(voltages, achieved_voltages, achieved_currents);
  } catch (...) {
    // Back-substitution does not alter the retained LU factorization. A failed
    // consumer solve discards only the consumer-visible solution.
    clear_consumer_solution();
    m_state = nec_model_state::prepared;
    throw;
  }

  return finish_consumer_solve(
    nec_port_drive::voltage, voltages,
    std::move(achieved_voltages), std::move(achieved_currents));
}

const std::vector<nec_complex>& nec_stateful_model::solve_port_voltages(
  const std::vector<nec_complex>& voltages)
{
  solve_port_voltages_detailed(voltages);
  return m_port_currents;
}

void nec_stateful_model::restore_after_internal_solves(
  bool had_solution, const nec_port_solution& saved_solution)
{
  if (!had_solution) {
    m_context->stateful_clear_results();
    clear_consumer_solution();
    m_state = nec_model_state::prepared;
    return;
  }

  std::vector<nec_complex> restored_voltages;
  std::vector<nec_complex> restored_currents;
  try {
    execute_voltage_solve(
      saved_solution.voltages, restored_voltages, restored_currents);
  } catch (...) {
    m_context->stateful_clear_results();
    clear_consumer_solution();
    m_state = nec_model_state::prepared;
    throw;
  }

  m_last_port_solution = saved_solution;
  m_port_currents = saved_solution.currents;
  m_has_port_solution = true;
  m_state = nec_model_state::solved;
}

const nec_complex_matrix& nec_stateful_model::compute_admittance_matrix()
{
  if (m_state != nec_model_state::prepared && m_state != nec_model_state::solved)
    fail("COMPUTE ADMITTANCE MATRIX", "MODEL IS NOT PREPARED");
  if (m_has_admittance_matrix)
    return m_admittance_matrix;

  const bool had_solution = m_has_port_solution;
  const nec_port_solution saved_solution = m_last_port_solution;
  const size_t order = m_ports.size();
  nec_complex_matrix admittance;
  admittance.rows = order;
  admittance.columns = order;
  admittance.values.assign(order * order, nec_complex(0.0, 0.0));

  try {
    std::vector<nec_complex> basis_voltages(order, nec_complex(0.0, 0.0));
    std::vector<nec_complex> achieved_voltages;
    std::vector<nec_complex> achieved_currents;
    for (size_t column = 0; column < order; ++column) {
      std::fill(basis_voltages.begin(), basis_voltages.end(), nec_complex(0.0, 0.0));
      basis_voltages[column] = nec_complex(1.0, 0.0);
      execute_voltage_solve(
        basis_voltages, achieved_voltages, achieved_currents);
      for (size_t row = 0; row < order; ++row)
        admittance.values[row * order + column] = achieved_currents[row];
    }
  } catch (...) {
    const std::exception_ptr failure = std::current_exception();
    try {
      restore_after_internal_solves(had_solution, saved_solution);
    } catch (...) {
      // The retained factorization is still usable, but no stale consumer
      // result may be exposed if restoration itself fails.
    }
    std::rethrow_exception(failure);
  }
  restore_after_internal_solves(had_solution, saved_solution);

  m_admittance_matrix = std::move(admittance);
  m_has_admittance_matrix = true;
  return m_admittance_matrix;
}

const nec_impedance_result& nec_stateful_model::compute_impedance_matrix()
{
  if (m_state != nec_model_state::prepared && m_state != nec_model_state::solved)
    fail("COMPUTE IMPEDANCE MATRIX", "MODEL IS NOT PREPARED");
  if (m_has_impedance_result)
    return m_impedance_result;

  const nec_complex_matrix& admittance = compute_admittance_matrix();
  const nec_port_matrix_inverse inverse = nec_invert_port_matrix(
    admittance.values, admittance.rows);

  nec_impedance_result result;
  result.admittance = admittance;
  result.impedance.rows = admittance.rows;
  result.impedance.columns = admittance.columns;
  result.impedance.values = inverse.values;
  result.condition_estimate = inverse.condition_estimate;
  result.frequency_mhz = m_frequency_mhz;
  result.factorization_generation = m_factorization_generation;
  m_impedance_result = std::move(result);
  m_has_impedance_result = true;
  return m_impedance_result;
}

const nec_port_solution& nec_stateful_model::solve_port_currents(
  const std::vector<nec_complex>& currents)
{
  if (m_state != nec_model_state::prepared && m_state != nec_model_state::solved)
    fail("SOLVE PORT CURRENTS", "MODEL IS NOT PREPARED");
  if (currents.size() != m_ports.size())
    fail("SOLVE PORT CURRENTS", "CURRENT COUNT MUST MATCH PORT COUNT");
  for (const nec_complex current : currents) {
    if (!finite_value(current.real()) || !finite_value(current.imag()))
      fail("SOLVE PORT CURRENTS", "CURRENTS MUST BE FINITE");
  }

  const nec_complex_matrix& impedance = compute_impedance_matrix().impedance;
  std::vector<nec_complex> required_voltages(
    currents.size(), nec_complex(0.0, 0.0));
  for (size_t row = 0; row < impedance.rows; ++row) {
    for (size_t column = 0; column < impedance.columns; ++column)
      required_voltages[row] += impedance.at(row, column) * currents[column];
  }

  std::vector<nec_complex> achieved_voltages;
  std::vector<nec_complex> achieved_currents;
  try {
    execute_voltage_solve(
      required_voltages, achieved_voltages, achieved_currents);
  } catch (...) {
    clear_consumer_solution();
    m_state = nec_model_state::prepared;
    throw;
  }

  return finish_consumer_solve(
    nec_port_drive::current, currents,
    std::move(achieved_voltages), std::move(achieved_currents));
}

const nec_port_solution& nec_stateful_model::last_port_solution() const
{
  if (m_state != nec_model_state::solved || !m_has_port_solution)
    fail("LAST PORT SOLUTION", "NO CONSUMER SOLUTION IS AVAILABLE");
  return m_last_port_solution;
}

void nec_stateful_model::calculate_far_field(
  const nec_far_field_grid& grid,
  const std::vector<nec_complex>& currents,
  nec_far_field_result& copied)
{
#ifdef NECPP_ENABLE_PERFORMANCE_DIAGNOSTICS
  const auto total_started = std::chrono::steady_clock::now();
  auto phase_started = total_started;
#endif
  const size_t sample_count =
    checked_field_sample_count(grid, "COMPUTE FAR FIELD");
  const uint64_t output_buffer_allocations =
    (copied.theta_deg.capacity() < static_cast<size_t>(grid.theta_count) ? 1u : 0u) +
    (copied.phi_deg.capacity() < static_cast<size_t>(grid.phi_count) ? 1u : 0u) +
    (copied.e_theta.capacity() < sample_count ? 1u : 0u) +
    (copied.e_phi.capacity() < sample_count ? 1u : 0u);
  copied.diagnostics = {};
  copied.radius_m = grid.radius_m;
  copied.frequency_mhz = m_frequency_mhz;
  populate_field_axes(
    grid, copied.theta_deg, copied.phi_deg, "COMPUTE FAR FIELD");
  copied.e_theta.assign(sample_count, nec_complex(0.0, 0.0));
  copied.e_phi.assign(sample_count, nec_complex(0.0, 0.0));
  // theta, phi, E-theta, and E-phi are the only backing allocations.  The
  // raw path writes samples in place and never creates an RP field matrix.
  copied.diagnostics.output_buffer_allocations = output_buffer_allocations;
  copied.diagnostics.segment_count = static_cast<uint64_t>(
    m_geometry_completion.full_segment_count);
  copied.diagnostics.ground_image_count =
    m_ground.kind == nec_ground_kind::free_space ? 1u : 2u;
#ifdef NECPP_ENABLE_PERFORMANCE_DIAGNOSTICS
  copied.diagnostics.enabled = true;
  copied.diagnostics.validation_allocation_ms =
    std::chrono::duration<nec_float, std::milli>(
      std::chrono::steady_clock::now() - phase_started).count();
  phase_started = std::chrono::steady_clock::now();
#endif

#ifdef NECPP_ENABLE_PERFORMANCE_DIAGNOSTICS
  copied.diagnostics.result_replacement_ms =
    std::chrono::duration<nec_float, std::milli>(
      std::chrono::steady_clock::now() - phase_started).count();
#endif
  const bool zero_excitation = std::all_of(
    currents.begin(), currents.end(),
    [](nec_complex current) { return current == nec_complex(0.0, 0.0); });
  if (zero_excitation) {
#ifdef NECPP_ENABLE_PERFORMANCE_DIAGNOSTICS
    copied.diagnostics.native_total_ms =
      std::chrono::duration<nec_float, std::milli>(
        std::chrono::steady_clock::now() - total_started).count();
#endif
    return;
  }

  const nec_float wavelength = em::get_wavelength(m_frequency_mhz * 1.0e6);
  nec_far_field_evaluation_input input =
    m_context->far_field_evaluation_input(wavelength, 0);
#ifdef NECPP_FAR_FIELD_CACHE_SEGMENTS
  input.segment_half_lengths = &m_far_field_segment_half_lengths;
#endif
#ifdef NECPP_ENABLE_PERFORMANCE_DIAGNOSTICS
  std::chrono::steady_clock::duration raw_duration{};
  uint64_t raw_timing_samples = 0;
  constexpr uint64_t raw_timing_stride = 256;
#endif
#ifdef NECPP_FAR_FIELD_CACHE_DIRECTIONS
  // Use the last E-theta row as bounded direction scratch.  Earlier phi rows
  // are evaluated first, so each cached pair remains live until the final row
  // reads and replaces it with its field sample.  This avoids a fifth backing
  // allocation while retaining theta-fast output order.
  const size_t direction_cache_offset =
    static_cast<size_t>(grid.phi_count - 1) *
    static_cast<size_t>(grid.theta_count);
  nec_float cached_theta_deg =
    grid.theta_start_deg - grid.theta_step_deg;
  for (int theta_index = 0;
       theta_index < grid.theta_count; ++theta_index) {
    cached_theta_deg += grid.theta_step_deg;
    const nec_float theta_rad = degrees_to_rad(cached_theta_deg);
    copied.e_theta[
      direction_cache_offset + static_cast<size_t>(theta_index)] = {
        std::sin(theta_rad),
        std::cos(theta_rad),
      };
  }
#endif

  nec_float phi_deg = grid.phi_start_deg - grid.phi_step_deg;
  for (int phi_index = 0; phi_index < grid.phi_count; ++phi_index) {
    phi_deg += grid.phi_step_deg;
    const nec_float phi_rad = degrees_to_rad(phi_deg);
#ifdef NECPP_FAR_FIELD_CACHE_DIRECTIONS
    const nec_float sin_phi = std::sin(phi_rad);
    const nec_float cos_phi = std::cos(phi_rad);
#endif
    nec_float theta_deg = grid.theta_start_deg - grid.theta_step_deg;
    for (int theta_index = 0; theta_index < grid.theta_count; ++theta_index) {
      theta_deg += grid.theta_step_deg;
      if (input.ground.present() && theta_deg > 90.01) {
#ifdef NECPP_FAR_FIELD_CACHE_DIRECTIONS
        if (phi_index == grid.phi_count - 1) {
          const size_t skipped_index =
            direction_cache_offset + static_cast<size_t>(theta_index);
          copied.e_theta[skipped_index] = cplx_00();
          copied.e_phi[skipped_index] = cplx_00();
        }
#endif
        continue;
      }
      ++copied.diagnostics.evaluated_directions;
#ifdef NECPP_ENABLE_PERFORMANCE_DIAGNOSTICS
      const bool time_raw =
        (copied.diagnostics.evaluated_directions - 1) %
          raw_timing_stride == 0;
      const auto raw_started = time_raw
        ? std::chrono::steady_clock::now()
        : std::chrono::steady_clock::time_point();
#endif
#ifdef NECPP_FAR_FIELD_CACHE_DIRECTIONS
      const nec_complex cached_direction = copied.e_theta[
        direction_cache_offset + static_cast<size_t>(theta_index)];
      const nec_far_field_sample raw = [&] {
        return nec_evaluate_far_field_sample(
          input, {
            cached_direction.real(),
            cached_direction.imag(),
            0.0,
            sin_phi,
            cos_phi,
          });
      }();
#else
      const nec_far_field_sample raw = nec_evaluate_far_field_sample(
        input, degrees_to_rad(theta_deg), phi_rad);
#endif
#ifdef NECPP_ENABLE_PERFORMANCE_DIAGNOSTICS
      if (time_raw) {
        raw_duration += std::chrono::steady_clock::now() - raw_started;
        ++raw_timing_samples;
      }
#endif
      const nec_far_field_sample scaled = nec_scale_far_field_sample(
        raw, wavelength, grid.radius_m);
      const size_t index =
        static_cast<size_t>(phi_index) *
          static_cast<size_t>(grid.theta_count) +
        static_cast<size_t>(theta_index);
      copied.e_theta[index] = scaled.e_theta;
      copied.e_phi[index] = scaled.e_phi;
      if (!finite_value(copied.e_theta[index].real()) ||
          !finite_value(copied.e_theta[index].imag()) ||
          !finite_value(copied.e_phi[index].real()) ||
          !finite_value(copied.e_phi[index].imag()))
        fail("COMPUTE FAR FIELD", "ENGINE RETURNED A NONFINITE FIELD VALUE");
    }
  }
  copied.diagnostics.segment_direction_contributions =
    copied.diagnostics.evaluated_directions *
    copied.diagnostics.segment_count *
    copied.diagnostics.ground_image_count;
#ifdef NECPP_ENABLE_PERFORMANCE_DIAGNOSTICS
  copied.diagnostics.native_total_ms =
    std::chrono::duration<nec_float, std::milli>(
      std::chrono::steady_clock::now() - total_started).count();
  const nec_float sampled_raw_ms =
    std::chrono::duration<nec_float, std::milli>(raw_duration).count();
  copied.diagnostics.raw_accumulation_ms = raw_timing_samples == 0
    ? nec_float(0.0)
    : std::min(
        copied.diagnostics.native_total_ms,
        sampled_raw_ms *
          static_cast<nec_float>(copied.diagnostics.evaluated_directions) /
          static_cast<nec_float>(raw_timing_samples));
#endif
}

const nec_far_field_result& nec_stateful_model::compute_far_field(
  const nec_far_field_grid& grid)
{
  require_state(nec_model_state::solved, "COMPUTE FAR FIELD");
#ifdef NECPP_FAR_FIELD_REUSE_OUTPUTS
  std::swap(m_far_field_result, m_far_field_scratch_result);
  try {
    calculate_far_field(
      grid, m_port_currents, m_far_field_scratch_result);
  } catch (...) {
    std::swap(m_far_field_result, m_far_field_scratch_result);
    throw;
  }
  std::swap(m_far_field_result, m_far_field_scratch_result);
#else
  nec_far_field_result result;
  calculate_far_field(grid, m_port_currents, result);
  m_far_field_result = std::move(result);
#endif
  return m_far_field_result;
}

nec_far_field_snapshot nec_stateful_model::capture_far_field_snapshot() const
{
  nec_far_field_snapshot snapshot;
  snapshot.frequency_mhz = m_frequency_mhz;
  snapshot.model_generation = m_factorization_generation;
  snapshot.solution_generation = m_solve_generation;
  if (m_state != nec_model_state::solved || !m_has_port_solution)
    return snapshot;

  const c_geometry* geometry = m_context->get_geometry();
  if (geometry == nullptr)
    return snapshot;
  if (geometry->m != 0) {
    snapshot.capability = nec_far_field_snapshot_capability::surface_patches;
    return snapshot;
  }
  if (m_ground.kind == nec_ground_kind::finite_reflection_coefficient ||
      m_ground.kind == nec_ground_kind::finite_sommerfeld_norton) {
    snapshot.capability = nec_far_field_snapshot_capability::finite_ground;
    return snapshot;
  }

  snapshot.wavelength_m = em::get_wavelength(m_frequency_mhz * 1.0e6);
  const nec_far_field_evaluation_input input =
    m_context->far_field_evaluation_input(snapshot.wavelength_m, 0);
  const size_t count = static_cast<size_t>(geometry->n_segments);
  auto copy_real_array = [count](const real_array& values) {
    std::vector<nec_float> copied(count);
    for (size_t index = 0; index < count; ++index)
      copied[index] = values[static_cast<int64_t>(index)];
    return copied;
  };
  snapshot.x = copy_real_array(geometry->x);
  snapshot.y = copy_real_array(geometry->y);
  snapshot.z = copy_real_array(geometry->z);
  snapshot.cab = copy_real_array(geometry->cab);
  snapshot.sab = copy_real_array(geometry->sab);
  snapshot.salp = copy_real_array(geometry->salp);
  snapshot.segment_half_lengths.resize(count);
  for (size_t index = 0; index < count; ++index) {
    snapshot.segment_half_lengths[index] = pi() *
      geometry->segment_length[static_cast<int64_t>(index)];
  }
  snapshot.air = copy_real_array(input.air);
  snapshot.aii = copy_real_array(input.aii);
  snapshot.bir = copy_real_array(input.bir);
  snapshot.bii = copy_real_array(input.bii);
  snapshot.cir = copy_real_array(input.cir);
  snapshot.cii = copy_real_array(input.cii);
  snapshot.perfect_ground = m_ground.kind == nec_ground_kind::perfect;
  snapshot.capability = nec_far_field_snapshot_capability::supported;
  return snapshot;
}

const nec_embedded_far_field_result&
nec_stateful_model::compute_embedded_far_fields(
  const nec_far_field_grid& grid,
  nec_embedded_field_normalization normalization)
{
  if (m_state != nec_model_state::prepared && m_state != nec_model_state::solved)
    fail("COMPUTE EMBEDDED FAR FIELDS", "MODEL IS NOT PREPARED");

  const size_t samples_per_port =
    checked_field_sample_count(grid, "COMPUTE EMBEDDED FAR FIELDS");
  switch (normalization) {
  case nec_embedded_field_normalization::unit_voltage:
  case nec_embedded_field_normalization::unit_current:
    break;
  default:
    fail("COMPUTE EMBEDDED FAR FIELDS", "UNKNOWN NORMALIZATION");
  }
  if (m_ports.size() >
      std::vector<nec_complex>().max_size() / samples_per_port)
    fail("COMPUTE EMBEDDED FAR FIELDS", "EMBEDDED SAMPLE COUNT IS TOO LARGE");

  if (normalization == nec_embedded_field_normalization::unit_current) {
    nec_embedded_far_field_result embedded;
    run_unit_current_basis_loop(
      nullptr, &embedded, &grid, "COMPUTE EMBEDDED FAR FIELDS");
    m_embedded_far_field_result = std::move(embedded);
    return m_embedded_far_field_result;
  }

  const bool had_solution = m_has_port_solution;
  const nec_port_solution saved_solution = m_last_port_solution;
  const size_t embedded_sample_count = m_ports.size() * samples_per_port;
  nec_embedded_far_field_result embedded;
  embedded.radius_m = grid.radius_m;
  embedded.frequency_mhz = m_frequency_mhz;
  embedded.ports = m_ports;
  embedded.normalization = normalization;
  embedded.samples_per_port = samples_per_port;
  populate_field_axes(
    grid, embedded.theta_deg, embedded.phi_deg,
    "COMPUTE EMBEDDED FAR FIELDS");
  embedded.e_theta.assign(
    embedded_sample_count, nec_complex(0.0, 0.0));
  embedded.e_phi.assign(
    embedded_sample_count, nec_complex(0.0, 0.0));

  try {
    std::vector<nec_complex> basis_voltages(
      m_ports.size(), nec_complex(0.0, 0.0));
    std::vector<nec_complex> achieved_voltages;
    std::vector<nec_complex> achieved_currents;
    nec_far_field_result basis;
    for (size_t port_index = 0; port_index < m_ports.size(); ++port_index) {
      std::fill(
        basis_voltages.begin(), basis_voltages.end(),
        nec_complex(0.0, 0.0));
      basis_voltages[port_index] = nec_complex(1.0, 0.0);
      execute_voltage_solve(
        basis_voltages, achieved_voltages, achieved_currents);
      calculate_far_field(grid, achieved_currents, basis);
      const size_t offset = port_index * samples_per_port;
      std::copy(
        basis.e_theta.begin(), basis.e_theta.end(),
        embedded.e_theta.begin() + static_cast<std::ptrdiff_t>(offset));
      std::copy(
        basis.e_phi.begin(), basis.e_phi.end(),
        embedded.e_phi.begin() + static_cast<std::ptrdiff_t>(offset));
    }
  } catch (...) {
    const std::exception_ptr failure = std::current_exception();
    try {
      restore_after_internal_solves(had_solution, saved_solution);
    } catch (...) {
      // Never expose an arbitrary basis solution if restoration fails.
    }
    std::rethrow_exception(failure);
  }
  restore_after_internal_solves(had_solution, saved_solution);

  m_embedded_far_field_result = std::move(embedded);
  return m_embedded_far_field_result;
}

void nec_stateful_model::run_unit_current_basis_loop(
  nec_current_distribution* currents_out,
  nec_embedded_far_field_result* fields_out,
  const nec_far_field_grid* grid,
  const char* operation)
{
  if (m_state != nec_model_state::prepared && m_state != nec_model_state::solved)
    fail(operation, "MODEL IS NOT PREPARED");
  if (currents_out == nullptr && fields_out == nullptr)
    fail(operation, "NO UNIT-CURRENT CAPTURE TARGET");
  if (fields_out != nullptr && grid == nullptr)
    fail(operation, "FIELD GRID IS REQUIRED");

  if (currents_out != nullptr) {
    const c_geometry* geometry = m_context->get_geometry();
    if (geometry == nullptr)
      fail(operation, "GEOMETRY IS UNAVAILABLE");
    const nec_float wavelength_m = em::get_wavelength(m_frequency_mhz * 1.0e6);
    currents_out->schema_version = 1;
    currents_out->frequency_mhz = m_frequency_mhz;
    currents_out->mode_kind = nec_current_mode_kind::unit_current;
    nec_fill_current_geometry(*geometry, wavelength_m, *currents_out);
    currents_out->mode_count = m_ports.size();
    resize_current_coefficient_planes(*currents_out);
  }

  size_t samples_per_port = 0;
  if (fields_out != nullptr) {
    samples_per_port = checked_field_sample_count(*grid, operation);
    if (m_ports.size() >
        std::vector<nec_complex>().max_size() / samples_per_port)
      fail(operation, "EMBEDDED SAMPLE COUNT IS TOO LARGE");
    fields_out->radius_m = grid->radius_m;
    fields_out->frequency_mhz = m_frequency_mhz;
    fields_out->ports = m_ports;
    fields_out->normalization = nec_embedded_field_normalization::unit_current;
    fields_out->samples_per_port = samples_per_port;
    populate_field_axes(
      *grid, fields_out->theta_deg, fields_out->phi_deg, operation);
    const size_t embedded_sample_count = m_ports.size() * samples_per_port;
    fields_out->e_theta.assign(
      embedded_sample_count, nec_complex(0.0, 0.0));
    fields_out->e_phi.assign(
      embedded_sample_count, nec_complex(0.0, 0.0));
  }

  const nec_complex_matrix& impedance = compute_impedance_matrix().impedance;
  const bool had_solution = m_has_port_solution;
  const nec_port_solution saved_solution = m_last_port_solution;
  try {
    std::vector<nec_complex> achieved_voltages;
    std::vector<nec_complex> achieved_currents;
    nec_far_field_result basis;
    for (size_t port_index = 0; port_index < m_ports.size(); ++port_index) {
      apply_unit_current_basis(
        port_index, impedance, achieved_voltages, achieved_currents);
      if (currents_out != nullptr) {
        const nec_far_field_evaluation_input input =
          m_context->far_field_evaluation_input(
            currents_out->wavelength_m, 0);
        copy_current_coefficient_mode(
          input, *currents_out, port_index, operation);
      }
      if (fields_out != nullptr) {
        calculate_far_field(*grid, achieved_currents, basis);
        const size_t offset = port_index * samples_per_port;
        std::copy(
          basis.e_theta.begin(), basis.e_theta.end(),
          fields_out->e_theta.begin() + static_cast<std::ptrdiff_t>(offset));
        std::copy(
          basis.e_phi.begin(), basis.e_phi.end(),
          fields_out->e_phi.begin() + static_cast<std::ptrdiff_t>(offset));
      }
    }
  } catch (...) {
    const std::exception_ptr failure = std::current_exception();
    try {
      restore_after_internal_solves(had_solution, saved_solution);
    } catch (...) {
      // Never expose an arbitrary basis solution if restoration fails.
    }
    std::rethrow_exception(failure);
  }
  restore_after_internal_solves(had_solution, saved_solution);
}

nec_current_distribution nec_stateful_model::get_current_distribution(
  nec_current_mode_kind kind)
{
  switch (kind) {
  case nec_current_mode_kind::latest_solution:
    if (m_state != nec_model_state::solved || !m_has_port_solution)
      fail("GET CURRENT DISTRIBUTION", "MODEL IS NOT SOLVED");
    break;
  case nec_current_mode_kind::unit_current:
    if (m_state != nec_model_state::prepared &&
        m_state != nec_model_state::solved)
      fail("GET CURRENT DISTRIBUTION", "MODEL IS NOT PREPARED");
    break;
  default:
    fail("GET CURRENT DISTRIBUTION", "UNKNOWN CURRENT MODE");
  }

  if (kind == nec_current_mode_kind::unit_current) {
    nec_current_distribution distribution;
    run_unit_current_basis_loop(
      &distribution, nullptr, nullptr, "GET CURRENT DISTRIBUTION");
    return distribution;
  }

  const c_geometry* geometry = m_context->get_geometry();
  if (geometry == nullptr)
    fail("GET CURRENT DISTRIBUTION", "GEOMETRY IS UNAVAILABLE");

  const nec_float wavelength_m = em::get_wavelength(m_frequency_mhz * 1.0e6);
  nec_current_distribution distribution;
  distribution.schema_version = 1;
  distribution.frequency_mhz = m_frequency_mhz;
  distribution.mode_kind = kind;
  nec_fill_current_geometry(*geometry, wavelength_m, distribution);
  distribution.mode_count = 1;
  resize_current_coefficient_planes(distribution);
  const nec_far_field_evaluation_input input =
    m_context->far_field_evaluation_input(distribution.wavelength_m, 0);
  copy_current_coefficient_mode(
    input, distribution, 0, "GET CURRENT DISTRIBUTION");
  return distribution;
}

nec_isolated_element_characterization
nec_stateful_model::characterize_isolated_element(
  const nec_isolated_element_request& request)
{
  if (m_state != nec_model_state::prepared && m_state != nec_model_state::solved)
    fail("CHARACTERIZE ISOLATED ELEMENT", "MODEL IS NOT PREPARED");
  switch (request.quadrature.modes) {
  case nec_current_mode_kind::unit_current:
    break;
  case nec_current_mode_kind::latest_solution:
    fail(
      "CHARACTERIZE ISOLATED ELEMENT",
      "CURRENT MODES MUST BE UNIT-CURRENT");
    break;
  default:
    fail("CHARACTERIZE ISOLATED ELEMENT", "UNKNOWN CURRENT MODE");
  }

  if (request.quadrature.nodes.empty())
    fail("CHARACTERIZE ISOLATED ELEMENT", "NODE LIST IS EMPTY");
  if (!request.quadrature.weights.empty() &&
      request.quadrature.weights.size() != request.quadrature.nodes.size())
    fail("CHARACTERIZE ISOLATED ELEMENT", "WEIGHT COUNT MUST MATCH NODE COUNT");
  if (request.quadrature.images ==
        nec_prepared_quadrature_images::perfect_ground_images &&
      m_ground.kind != nec_ground_kind::perfect)
    fail(
      "CHARACTERIZE ISOLATED ELEMENT",
      "PERFECT-GROUND IMAGES REQUIRE PERFECT GROUND");
  for (const nec_float xi : request.quadrature.nodes) {
    if (!finite_value(xi))
      fail("CHARACTERIZE ISOLATED ELEMENT", "NODE VALUES MUST BE FINITE");
    if (xi < -1.0 || xi > 1.0)
      fail("CHARACTERIZE ISOLATED ELEMENT", "NODES MUST LIE IN [-1, 1]");
  }
  for (const nec_float weight : request.quadrature.weights) {
    if (!finite_value(weight))
      fail("CHARACTERIZE ISOLATED ELEMENT", "WEIGHT VALUES MUST BE FINITE");
  }
  checked_field_sample_count(request.grid, "CHARACTERIZE ISOLATED ELEMENT");

  nec_isolated_element_characterization result;
  result.matrices = compute_impedance_matrix();

  nec_current_distribution currents;
  run_unit_current_basis_loop(
    &currents, &result.embedded_field, &request.grid,
    "CHARACTERIZE ISOLATED ELEMENT");

  const bool perfect_ground = m_ground.kind == nec_ground_kind::perfect;
  result.quadrature = nec_prepare_current_quadrature(
    currents, request.quadrature,
    m_factorization_generation, m_solve_generation, perfect_ground);
  return result;
}

nec_prepared_current_quadrature nec_stateful_model::prepare_current_quadrature(
  const nec_prepared_quadrature_request& request)
{
  switch (request.modes) {
  case nec_current_mode_kind::latest_solution:
    if (m_state != nec_model_state::solved || !m_has_port_solution)
      fail("PREPARE CURRENT QUADRATURE", "MODEL IS NOT SOLVED");
    break;
  case nec_current_mode_kind::unit_current:
    if (m_state != nec_model_state::prepared &&
        m_state != nec_model_state::solved)
      fail("PREPARE CURRENT QUADRATURE", "MODEL IS NOT PREPARED");
    break;
  default:
    fail("PREPARE CURRENT QUADRATURE", "UNKNOWN CURRENT MODE");
  }

  const nec_current_distribution distribution =
    get_current_distribution(request.modes);
  const bool perfect_ground = m_ground.kind == nec_ground_kind::perfect;
  return nec_prepare_current_quadrature(
    distribution, request,
    m_factorization_generation, m_solve_generation, perfect_ground);
}

size_t nec_stateful_model::retained_result_count() const
{
  return m_context->stateful_result_count();
}
