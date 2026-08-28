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
  const std::vector<nec_complex>& solve_port_voltages(
    const std::vector<nec_complex>& voltages);

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

  std::unique_ptr<nec_context> m_context;
  nec_model_state m_state = nec_model_state::empty;
  std::vector<nec_port_definition> m_ports;
  std::vector<int> m_absolute_port_segments;
  std::vector<nec_complex> m_port_currents;
  nec_float m_frequency_mhz = 0.0;
  uint64_t m_factorization_generation = 0;
  uint64_t m_solve_generation = 0;
  bool m_configuration_dirty = true;
};
