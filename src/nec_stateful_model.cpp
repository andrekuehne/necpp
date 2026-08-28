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
#include "nec_radiation_pattern.h"
#include "nec_results.h"

#include <cmath>
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
  m_port_currents.clear();
  m_context->stateful_clear_results();
  m_state = nec_model_state::geometry_complete;
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
  m_port_currents.clear();
  m_state = nec_model_state::geometry_complete;
  m_context->stateful_prepare_frequency(frequency_mhz);
  m_frequency_mhz = frequency_mhz;
  ++m_factorization_generation;
  m_configuration_dirty = false;
  m_port_currents.clear();
  m_state = nec_model_state::prepared;
}

const std::vector<nec_complex>& nec_stateful_model::solve_port_voltages(
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

  m_context->stateful_clear_results();
  try {
    m_context->stateful_solve_voltage_sources(m_absolute_port_segments, voltages);
  } catch (...) {
    // Back-substitution does not alter the retained LU factorization.  A
    // failed solve therefore discards only the consumer solution.
    m_port_currents.clear();
    m_state = nec_model_state::prepared;
    throw;
  }

  nec_antenna_input* input = m_context->get_input_parameters(0);
  if (input == nullptr)
    fail("SOLVE PORT VOLTAGES", "ENGINE DID NOT RETURN PORT INPUT DATA");
  m_port_currents = input->get_current();
  if (m_port_currents.size() != m_ports.size())
    fail("SOLVE PORT VOLTAGES", "ENGINE RETURNED THE WRONG PORT COUNT");

  ++m_solve_generation;
  m_state = nec_model_state::solved;
  return m_port_currents;
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
