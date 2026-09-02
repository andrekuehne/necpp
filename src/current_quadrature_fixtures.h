/*
  Copyright (C) 2026  NEC2++ contributors

  This program is free software; you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation; either version 2 of the License, or
  (at your option) any later version.
*/
#pragma once

#include "c_geometry.h"
#include "nec_context.h"
#include "nec_stateful_model.h"

#include <vector>

namespace current_quadrature_fixtures {

constexpr nec_float kFrequencyMHz = 300.0;
constexpr nec_float kRadiusM = 0.001;
constexpr nec_float kTurnstileOffsetM = 0.001;
constexpr int kDipoleSegments = 11;
constexpr int kArmSegments = 5;

inline nec_wire_definition wire(
  int tag, int segments,
  nec_float x1, nec_float y1, nec_float z1,
  nec_float x2, nec_float y2, nec_float z2)
{
  return { tag, segments, x1, y1, z1, x2, y2, z2, kRadiusM };
}

inline std::vector<nec_wire_definition> dipole_wires()
{
  return { wire(1, kDipoleSegments, 0.0, 0.0, -0.25, 0.0, 0.0, 0.25) };
}

inline std::vector<nec_wire_definition> monopole_wires()
{
  return { wire(1, kDipoleSegments, 0.0, 0.0, 0.0, 0.0, 0.0, 0.25) };
}

inline std::vector<nec_wire_definition> bent_wires()
{
  return {
    wire(1, kArmSegments, -0.25, 0.0, 0.25, 0.0, 0.0, 0.0),
    wire(2, kArmSegments, 0.0, 0.0, 0.0, 0.25, 0.0, 0.25),
  };
}

inline std::vector<nec_wire_definition> insulated_turnstile_wires()
{
  return {
    wire(1, kDipoleSegments, -0.25, 0.0, kTurnstileOffsetM, 0.25, 0.0, kTurnstileOffsetM),
    wire(2, kDipoleSegments, 0.0, -0.25, -kTurnstileOffsetM, 0.0, 0.25, -kTurnstileOffsetM),
  };
}

inline std::vector<nec_wire_definition> connected_turnstile_wires()
{
  return {
    wire(1, kArmSegments, -0.25, 0.0, 0.0, 0.0, 0.0, 0.0),
    wire(2, kArmSegments, 0.0, 0.0, 0.0, 0.25, 0.0, 0.0),
    wire(3, kArmSegments, 0.0, -0.25, 0.0, 0.0, 0.0, 0.0),
    wire(4, kArmSegments, 0.0, 0.0, 0.0, 0.0, 0.25, 0.0),
  };
}

inline void add_wires(nec_stateful_model& model,
  const std::vector<nec_wire_definition>& wires)
{
  for (const nec_wire_definition& item : wires)
    model.add_wire(item);
}

inline void add_wires(nec_context& model, const std::vector<nec_wire_definition>& wires)
{
  for (const nec_wire_definition& item : wires) {
    model.get_geometry()->wire(
      item.tag, item.segments,
      item.x1, item.y1, item.z1,
      item.x2, item.y2, item.z2,
      item.radius_m, 1.0, 1.0);
  }
}

inline void build_stateful(
  nec_stateful_model& model,
  const std::vector<nec_wire_definition>& wires,
  const std::vector<nec_port_definition>& ports,
  nec_ground_connection connection = nec_ground_connection::none,
  nec_ground_kind ground = nec_ground_kind::free_space,
  nec_float frequency_mhz = kFrequencyMHz)
{
  add_wires(model, wires);
  model.complete_geometry(connection);
  model.define_ports(ports);
  if (ground != nec_ground_kind::free_space)
    model.set_ground({ ground, 0.0, 0.0 });
  model.prepare(frequency_mhz);
}

inline c_geometry* complete_native(
  nec_context& model,
  const std::vector<nec_wire_definition>& wires,
  int ground_flag)
{
  model.initialize();
  add_wires(model, wires);
  model.geometry_complete(ground_flag);
  return model.get_geometry();
}

inline int tag_of(const c_geometry& geometry, int native_index)
{
  return geometry.segment_tags[native_index];
}

inline int segment_in_tag(const c_geometry& geometry, int native_index)
{
  const int tag = tag_of(geometry, native_index);
  int count = 0;
  for (int64_t index = 0; index <= native_index; ++index) {
    if (geometry.segment_tags[index] == tag)
      ++count;
  }
  return count;
}

} // namespace current_quadrature_fixtures
