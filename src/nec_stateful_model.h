/*
  Copyright (C) 2026  NEC2++ contributors

  This program is free software; you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation; either version 2 of the License, or
  (at your option) any later version.
*/
#pragma once

#include "common.h"

#include <cstddef>
#include <cstdint>
#include <memory>
#include <stdexcept>
#include <vector>

class nec_context;
class nec_radiation_pattern;

enum class nec_model_state {
  empty,
  geometry_building,
  geometry_complete,
  prepared,
  solved,
};

struct nec_wire_definition {
  int tag = 0;
  int segments = 0;
  nec_float x1 = 0.0;
  nec_float y1 = 0.0;
  nec_float z1 = 0.0;
  nec_float x2 = 0.0;
  nec_float y2 = 0.0;
  nec_float z2 = 0.0;
  nec_float radius_m = 0.0;
};

enum class nec_ground_connection {
  none = 0,
  interpolate = 1,
  zero_current = 2,
};

struct nec_port_definition {
  int tag = 0;
  int segment = 0;
};

enum class nec_load_kind {
  series_rlc = 0,
  parallel_rlc = 1,
  distributed_series_rlc = 2,
  distributed_parallel_rlc = 3,
  impedance = 4,
  conductivity = 5,
};

struct nec_load_definition {
  nec_load_kind kind = nec_load_kind::series_rlc;
  int tag = 0;
  int first_segment = 0;
  int last_segment = 0;
  nec_float value1 = 0.0;
  nec_float value2 = 0.0;
  nec_float value3 = 0.0;
};

enum class nec_ground_kind {
  free_space,
  perfect,
  finite_reflection_coefficient,
  finite_sommerfeld_norton,
};

struct nec_ground_definition {
  nec_ground_kind kind = nec_ground_kind::free_space;
  nec_float relative_permittivity = 0.0;
  nec_float conductivity_s_per_m = 0.0;
};

struct nec_far_field_grid {
  nec_float radius_m = 1.0;
  nec_float theta_start_deg = 0.0;
  int theta_count = 1;
  nec_float theta_step_deg = 0.0;
  nec_float phi_start_deg = 0.0;
  int phi_count = 1;
  nec_float phi_step_deg = 0.0;
};

/*! Dense complex matrix in stable row-major port order. */
struct nec_complex_matrix {
  size_t rows = 0;
  size_t columns = 0;
  std::vector<nec_complex> values;

  const nec_complex& at(size_t row, size_t column) const
  {
    if (row >= rows || column >= columns)
      throw std::out_of_range("NEC port matrix index is out of range");
    return values.at(row * columns + column);
  }
};

struct nec_impedance_result {
  nec_complex_matrix impedance;
  nec_complex_matrix admittance;
  nec_float condition_estimate = 0.0;
  nec_float frequency_mhz = 0.0;
  uint64_t factorization_generation = 0;
};

enum class nec_port_drive {
  voltage,
  current,
};

/*! Complete quantities for one consumer-visible simultaneous port solve. */
struct nec_port_solution {
  nec_port_drive drive = nec_port_drive::voltage;
  std::vector<nec_complex> requested;
  std::vector<nec_complex> voltages;
  std::vector<nec_complex> currents;
  std::vector<nec_complex> active_impedances;
  std::vector<nec_float> powers_w;
  nec_float frequency_mhz = 0.0;
  uint64_t factorization_generation = 0;
  uint64_t solve_generation = 0;
};

/*! A stateful, deck-free native solver above nec_context.
 *
 * The class owns one context and one retained interaction-matrix
 * factorization.  Configuration mutations invalidate the factorization;
 * voltage and far-field changes do not.
 */
class nec_stateful_model {
public:
  nec_stateful_model();
  ~nec_stateful_model();

  nec_stateful_model(const nec_stateful_model&) = delete;
  nec_stateful_model& operator=(const nec_stateful_model&) = delete;
  nec_stateful_model(nec_stateful_model&&) noexcept;
  nec_stateful_model& operator=(nec_stateful_model&&) noexcept;

  nec_model_state state() const { return m_state; }

  void add_wire(const nec_wire_definition& wire);
  void complete_geometry(
    nec_ground_connection connection = nec_ground_connection::none);
  void define_ports(const std::vector<nec_port_definition>& ports);

  void add_load(const nec_load_definition& load);
  void clear_loads();
  void set_ground(const nec_ground_definition& ground);

  void prepare(nec_float frequency_mhz);

  /*! Backward-compatible WP1 current-only voltage solve. */
  const std::vector<nec_complex>& solve_port_voltages(
    const std::vector<nec_complex>& voltages);

  /*! Simultaneous voltage solve with all WP2 port quantities. */
  const nec_port_solution& solve_port_voltages_detailed(
    const std::vector<nec_complex>& voltages);

  /*! Extract Y by unit-voltage basis solves, preserving public solution state. */
  const nec_complex_matrix& compute_admittance_matrix();

  /*! Return cached row-major Z and Y matrices for the prepared configuration. */
  const nec_impedance_result& compute_impedance_matrix();

  /*! Convert requested currents through V=ZI and execute one voltage solve. */
  const nec_port_solution& solve_port_currents(
    const std::vector<nec_complex>& currents);

  const nec_port_solution& last_port_solution() const;

  /*! Calculate a raw NEC radiation-pattern result for the latest solution.
   *
   * WP3 supplies the stable copied complex-field API.  This WP1 hook exists
   * to exercise far-field sampling against the retained factorization.  The
   * reference remains valid until the next solve or far-field call.
   */
  const nec_radiation_pattern& compute_far_field(const nec_far_field_grid& grid);

  const std::vector<nec_port_definition>& ports() const { return m_ports; }
  const std::vector<nec_complex>& port_currents() const { return m_port_currents; }
  nec_float frequency_mhz() const { return m_frequency_mhz; }
  uint64_t factorization_generation() const { return m_factorization_generation; }
  uint64_t solve_generation() const { return m_solve_generation; }

  /*! Diagnostic used to prove result replacement stays bounded. */
  size_t retained_result_count() const;

private:
  void require_state(nec_model_state expected, const char* operation) const;
  void require_configurable(const char* operation) const;
  void invalidate_factorization();
  void validate_load_target(const nec_load_definition& load) const;
  void clear_matrix_cache();
  void clear_consumer_solution();
  void execute_voltage_solve(
    const std::vector<nec_complex>& voltages,
    std::vector<nec_complex>& achieved_voltages,
    std::vector<nec_complex>& achieved_currents);
  void restore_after_internal_solves(
    bool had_solution, const nec_port_solution& saved_solution);
  const nec_port_solution& finish_consumer_solve(
    nec_port_drive drive,
    const std::vector<nec_complex>& requested,
    std::vector<nec_complex> achieved_voltages,
    std::vector<nec_complex> achieved_currents);

  std::unique_ptr<nec_context> m_context;
  nec_model_state m_state = nec_model_state::empty;
  std::vector<nec_port_definition> m_ports;
  std::vector<int> m_absolute_port_segments;
  std::vector<nec_complex> m_port_currents;
  nec_complex_matrix m_admittance_matrix;
  nec_impedance_result m_impedance_result;
  nec_port_solution m_last_port_solution;
  nec_float m_frequency_mhz = 0.0;
  uint64_t m_factorization_generation = 0;
  uint64_t m_solve_generation = 0;
  bool m_configuration_dirty = true;
  bool m_has_admittance_matrix = false;
  bool m_has_impedance_result = false;
  bool m_has_port_solution = false;
};
