/*
  Copyright (C) 2026  NEC2++ contributors

  This program is free software; you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation; either version 2 of the License, or
  (at your option) any later version.
*/
#pragma once

#include <cstdint>

/*! Symmetry generator selected before completing geometry.
 *
 * The numeric values are part of the additive C/WASM boundary. Keep them
 * stable across the native, ABI, and TypeScript layers.
 */
enum class nec_geometry_symmetry_kind {
  none = 0,
  reflection = 1,
  rotational = 2,
};

/*! Coordinate-plane bits used by NEC's geometry reflection generator. */
enum nec_reflection_plane_mask : uint32_t {
  nec_reflection_plane_x = 1u,
  nec_reflection_plane_y = 2u,
  nec_reflection_plane_z = 4u,
};

/*! Immutable input contract for one final geometry symmetry operation.
 *
 * Reflection uses reflection_plane_mask and requires rotational_order == 1.
 * Rotation uses rotational_order >= 2 about global Z and requires a zero
 * reflection_plane_mask. tag_increment is a positive offset per copy block.
 */
struct nec_geometry_symmetry {
  nec_geometry_symmetry_kind kind = nec_geometry_symmetry_kind::none;
  uint32_t reflection_plane_mask = 0u;
  int rotational_order = 1;
  int tag_increment = 0;
};

/*! Geometry-generation metadata; copy transforms derive from the descriptor.
 *
 * A non-symmetric result reports one section. Segment counts use 64-bit
 * storage so metadata does not narrow the geometry's native counts.
 */
struct nec_geometry_completion_result {
  nec_geometry_symmetry symmetry;
  int section_count = 1;
  int64_t fundamental_segment_count = 0;
  int64_t full_segment_count = 0;
};
