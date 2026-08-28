/*
  Copyright (C) 2026  NEC2++ contributors

  This program is free software; you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation; either version 2 of the License, or
  (at your option) any later version.
*/
#include "nec_stateful_model.h"

#include "c_geometry.h"
#include "nec_context.h"
#include "nec_exception.h"
#include "nec_port_matrix.h"
#include "nec_radiation_pattern.h"
#include "nec_results.h"

#include <algorithm>
#include <cmath>
#include <exception>
#include <limits>
#include <set>
#include <string>
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
  require_state(nec_model_state::geometry_building, "COMPLETE GEOMETRY");
  const int flag = static_cast<int>(connection);
  if (flag < 0 || flag > 2)
    fail("COMPLETE GEOMETRY", "UNKNOWN GROUND CONNECTION MODE");
  m_context->geometry_complete(flag);
  m_state = nec_model_state::geometry_complete;
  m_configuration_dirty = true;
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

  m_context->ld_card(
    load_kind, load.tag,
    load.first_segment, last_segment,
    load.value1, load.value2, load.value3);
  invalidate_factorization();
}

void nec_stateful_model::clear_loads()
{
  require_configurable("CLEAR LOADS");
  m_context->stateful_clear_loads();
  invalidate_factorization();
}

void nec_stateful_model::set_ground(const nec_ground_definition& ground)
{
  require_configurable("SET GROUND");

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
  invalidate_factorization();
}

void nec_stateful_model::prepare(nec_float frequency_mhz)
{
  require_configurable("PREPARE");
  if (m_ports.empty())
    fail("PREPARE", "PORTS HAVE NOT BEEN DEFINED");
  if (!finite_value(frequency_mhz) || !(frequency_mhz > 0.0))
    fail("PREPARE", "FREQUENCY MUST BE POSITIVE AND FINITE");

  if (!m_configuration_dirty && m_frequency_mhz == frequency_mhz)
    return;

  // A failed fill/factorization cannot leave the old prepared state exposed:
  // the context matrix may already have been overwritten.  The geometry and
  // environment remain reusable for a later prepare attempt.
  m_context->stateful_clear_results();
  m_configuration_dirty = true;
  m_frequency_mhz = 0.0;
  clear_matrix_cache();
  clear_consumer_solution();
  m_state = nec_model_state::geometry_complete;
  m_context->stateful_prepare_frequency(frequency_mhz);
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

nec_far_field_result nec_stateful_model::calculate_far_field(
  const nec_far_field_grid& grid,
  const std::vector<nec_complex>& currents)
{
  const size_t sample_count =
    checked_field_sample_count(grid, "COMPUTE FAR FIELD");
  nec_far_field_result copied;
  copied.radius_m = grid.radius_m;
  copied.frequency_mhz = m_frequency_mhz;
  populate_field_axes(
    grid, copied.theta_deg, copied.phi_deg, "COMPUTE FAR FIELD");
  copied.e_theta.assign(sample_count, nec_complex(0.0, 0.0));
  copied.e_phi.assign(sample_count, nec_complex(0.0, 0.0));

  m_context->stateful_clear_results(RESULT_RADIATION_PATTERN);
  const bool zero_excitation = std::all_of(
    currents.begin(), currents.end(),
    [](nec_complex current) { return current == nec_complex(0.0, 0.0); });
  if (zero_excitation)
    return copied;

  m_context->rp_card(
    0, grid.theta_count, grid.phi_count,
    0, 0, 0, 0,
    grid.theta_start_deg, grid.phi_start_deg,
    grid.theta_step_deg, grid.phi_step_deg,
    grid.radius_m, 0.0);

  nec_radiation_pattern* result = m_context->get_radiation_pattern(0);
  if (result == nullptr)
    fail("COMPUTE FAR FIELD", "ENGINE DID NOT RETURN A RADIATION PATTERN");
  const complex_array e_theta = result->get_e_theta();
  const complex_array e_phi = result->get_e_phi();
  if (static_cast<size_t>(e_theta.size()) != sample_count ||
      static_cast<size_t>(e_phi.size()) != sample_count)
    fail("COMPUTE FAR FIELD", "ENGINE RETURNED THE WRONG FIELD SAMPLE COUNT");

  for (size_t index = 0; index < sample_count; ++index) {
    copied.e_theta[index] = e_theta[static_cast<int64_t>(index)];
    copied.e_phi[index] = e_phi[static_cast<int64_t>(index)];
    if (!finite_value(copied.e_theta[index].real()) ||
        !finite_value(copied.e_theta[index].imag()) ||
        !finite_value(copied.e_phi[index].real()) ||
        !finite_value(copied.e_phi[index].imag()))
      fail("COMPUTE FAR FIELD", "ENGINE RETURNED A NONFINITE FIELD VALUE");
  }
  return copied;
}

const nec_far_field_result& nec_stateful_model::compute_far_field(
  const nec_far_field_grid& grid)
{
  require_state(nec_model_state::solved, "COMPUTE FAR FIELD");
  nec_far_field_result result = calculate_far_field(grid, m_port_currents);
  m_far_field_result = std::move(result);
  return m_far_field_result;
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

  const nec_complex_matrix* impedance = nullptr;
  if (normalization == nec_embedded_field_normalization::unit_current)
    impedance = &compute_impedance_matrix().impedance;

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
    for (size_t port_index = 0; port_index < m_ports.size(); ++port_index) {
      std::fill(
        basis_voltages.begin(), basis_voltages.end(),
        nec_complex(0.0, 0.0));
      if (normalization == nec_embedded_field_normalization::unit_voltage) {
        basis_voltages[port_index] = nec_complex(1.0, 0.0);
      } else {
        for (size_t row = 0; row < impedance->rows; ++row)
          basis_voltages[row] = impedance->at(row, port_index);
      }

      execute_voltage_solve(
        basis_voltages, achieved_voltages, achieved_currents);
      const nec_far_field_result basis =
        calculate_far_field(grid, achieved_currents);
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

size_t nec_stateful_model::retained_result_count() const
{
  return m_context->stateful_result_count();
}
