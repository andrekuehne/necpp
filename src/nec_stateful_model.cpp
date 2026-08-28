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

bool finite(nec_float value)
{
  return std::isfinite(value);
}

} // namespace

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
  if (!finite(wire.x1) || !finite(wire.y1) || !finite(wire.z1) ||
      !finite(wire.x2) || !finite(wire.y2) || !finite(wire.z2) ||
      !finite(wire.radius_m) || !(wire.radius_m > 0.0))
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
  if (!finite(load.value1) || !finite(load.value2) || !finite(load.value3))
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
    if (!finite(ground.relative_permittivity) ||
        !finite(ground.conductivity_s_per_m) ||
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
  if (!finite(frequency_mhz) || !(frequency_mhz > 0.0))
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
    if (!finite(achieved_voltages[index].real()) ||
        !finite(achieved_voltages[index].imag()) ||
        !finite(achieved_currents[index].real()) ||
        !finite(achieved_currents[index].imag()))
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
    if (!finite(voltage.real()) || !finite(voltage.imag()))
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
    if (!finite(current.real()) || !finite(current.imag()))
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

const nec_radiation_pattern& nec_stateful_model::compute_far_field(
  const nec_far_field_grid& grid)
{
  require_state(nec_model_state::solved, "COMPUTE FAR FIELD");
  if (!finite(grid.radius_m) || !(grid.radius_m > 0.0) ||
      !finite(grid.theta_start_deg) || !finite(grid.theta_step_deg) ||
      !finite(grid.phi_start_deg) || !finite(grid.phi_step_deg) ||
      grid.theta_count <= 0 || grid.phi_count <= 0)
    fail("COMPUTE FAR FIELD", "GRID VALUES ARE INVALID");

  m_context->stateful_clear_results(RESULT_RADIATION_PATTERN);
  m_context->rp_card(
    0, grid.theta_count, grid.phi_count,
    0, 0, 0, 0,
    grid.theta_start_deg, grid.phi_start_deg,
    grid.theta_step_deg, grid.phi_step_deg,
    grid.radius_m, 0.0);

  nec_radiation_pattern* result = m_context->get_radiation_pattern(0);
  if (result == nullptr)
    fail("COMPUTE FAR FIELD", "ENGINE DID NOT RETURN A RADIATION PATTERN");
  return *result;
}

size_t nec_stateful_model::retained_result_count() const
{
  return m_context->stateful_result_count();
}
