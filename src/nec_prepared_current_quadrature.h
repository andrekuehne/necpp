/*
  Copyright (C) 2026  NEC2++ contributors

  This program is free software; you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation; either version 2 of the License, or
  (at your option) any later version.
*/
#pragma once

#include "nec_current_distribution.h"

#include <cstddef>
#include <cstdint>
#include <vector>

constexpr size_t nec_prepared_quadrature_header_bytes = 64;
constexpr uint32_t nec_prepared_quadrature_schema_version = 1;
constexpr uint32_t nec_prepared_quadrature_flag_images = 1u;
constexpr uint32_t nec_prepared_quadrature_flag_weights = 2u;

enum class nec_prepared_quadrature_images {
  physical_only,
  perfect_ground_images,
};

struct nec_prepared_quadrature_request {
  std::vector<nec_float> nodes;
  std::vector<nec_float> weights;
  nec_prepared_quadrature_images images =
    nec_prepared_quadrature_images::physical_only;
  nec_current_mode_kind modes = nec_current_mode_kind::unit_current;
};

struct nec_prepared_quadrature_diagnostics {
  uint64_t geometry_walks = 0;
  uint64_t trigonometry_evaluations = 0;
  uint64_t interpolations = 0;
  uint64_t growing_allocations = 0;
};

/*! Immutable packed NECQ current-quadrature bundle.
 *
 * Large SoA lives in `packed`. Construction walks geometry and interpolates;
 * retrieval is a cached read of that buffer.
 */
struct nec_prepared_current_quadrature {
  uint32_t schema_version = nec_prepared_quadrature_schema_version;
  std::vector<uint8_t> packed;
  nec_prepared_quadrature_diagnostics diagnostics;

  size_t byte_length() const { return packed.size(); }

  const uint8_t* data() const
  {
    return packed.empty() ? nullptr : packed.data();
  }

  /*! Drop the packed buffer. Safe to call twice. */
  void release()
  {
    packed.clear();
    packed.shrink_to_fit();
  }
};

/*! Zero-copy view of a schema-1 NECQ buffer. Pointers alias `packed`. */
struct nec_prepared_quadrature_view {
  uint32_t schema_version = nec_prepared_quadrature_schema_version;
  uint32_t flags = 0;
  uint32_t n_segments = 0;
  uint32_t n_nodes = 0;
  uint32_t n_modes = 0;
  uint32_t n_image_planes = 0;
  nec_float frequency_mhz = 0.0;
  nec_float wavelength_m = 0.0;
  uint64_t model_generation = 0;
  uint64_t solution_generation = 0;
  const int32_t* tag = nullptr;
  const int32_t* segment = nullptr;
  const int32_t* native_index = nullptr;
  const nec_float* x = nullptr;
  const nec_float* y = nullptr;
  const nec_float* z = nullptr;
  const nec_float* tx = nullptr;
  const nec_float* ty = nullptr;
  const nec_float* tz = nullptr;
  const nec_float* radius_m = nullptr;
  const nec_float* length_m = nullptr;
  const nec_float* ds_weight = nullptr;
  const nec_float* i_real = nullptr;
  const nec_float* i_imag = nullptr;
  size_t geometry_count = 0;
  size_t current_count = 0;

  bool has_images() const
  {
    return (flags & nec_prepared_quadrature_flag_images) != 0;
  }

  bool has_weights() const
  {
    return (flags & nec_prepared_quadrature_flag_weights) != 0;
  }

  size_t geometry_index(size_t plane, size_t segment_index, size_t node) const;
  size_t current_index(
    size_t mode, size_t plane, size_t segment_index, size_t node) const;
  nec_complex current_at(
    size_t mode, size_t plane, size_t segment_index, size_t node) const;
};

inline size_t nec_prepared_quadrature_identity_bytes(size_t n_segments)
{
  return 12u * n_segments;
}

inline size_t nec_prepared_quadrature_identity_pad_bytes(size_t n_segments)
{
  const size_t unpadded =
    nec_prepared_quadrature_header_bytes +
    nec_prepared_quadrature_identity_bytes(n_segments);
  return (8u - (unpadded % 8u)) % 8u;
}

inline size_t nec_prepared_quadrature_sample_count(
  size_t n_segments, size_t n_nodes, size_t n_image_planes)
{
  return n_segments * n_nodes * n_image_planes;
}

inline size_t nec_prepared_quadrature_geometry_bytes(
  size_t n_segments, size_t n_nodes, size_t n_image_planes)
{
  return 9u * nec_prepared_quadrature_sample_count(
    n_segments, n_nodes, n_image_planes) * 8u;
}

inline size_t nec_prepared_quadrature_current_bytes(
  size_t n_modes, size_t n_segments, size_t n_nodes, size_t n_image_planes)
{
  return 2u * n_modes * nec_prepared_quadrature_sample_count(
    n_segments, n_nodes, n_image_planes) * 8u;
}

inline size_t nec_prepared_quadrature_packed_bytes(
  size_t n_modes, size_t n_segments, size_t n_nodes, size_t n_image_planes)
{
  return nec_prepared_quadrature_header_bytes +
    nec_prepared_quadrature_identity_bytes(n_segments) +
    nec_prepared_quadrature_identity_pad_bytes(n_segments) +
    nec_prepared_quadrature_geometry_bytes(
      n_segments, n_nodes, n_image_planes) +
    nec_prepared_quadrature_current_bytes(
      n_modes, n_segments, n_nodes, n_image_planes);
}

/*! I(xi) = A + B sin(k s) + C cos(k s) with s = xi L/2 metres. */
nec_complex nec_evaluate_quadrature_current(
  const nec_current_distribution& distribution,
  size_t mode, size_t segment, nec_float xi);

/*! Pack an owned NECQ evaluator from an already-captured current distribution. */
nec_prepared_current_quadrature nec_prepare_current_quadrature(
  const nec_current_distribution& distribution,
  const nec_prepared_quadrature_request& request,
  uint64_t model_generation,
  uint64_t solution_generation,
  bool perfect_ground);

nec_prepared_quadrature_view nec_view_prepared_quadrature(
  const nec_prepared_current_quadrature& prepared);
