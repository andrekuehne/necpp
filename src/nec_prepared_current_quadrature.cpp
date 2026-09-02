/*
  Copyright (C) 2026  NEC2++ contributors

  This program is free software; you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation; either version 2 of the License, or
  (at your option) any later version.
*/
#include "nec_prepared_current_quadrature.h"

#include "math_util.h"
#include "nec_exception.h"

#include <cmath>
#include <cstring>
#include <limits>
#include <stdexcept>

namespace {

constexpr uint8_t kMagic[4] = { 'N', 'E', 'C', 'Q' };

void fail_prepared(const char* reason)
{
  nec_exception error("PREPARED QUADRATURE: ");
  error.append(reason);
  throw error;
}

bool finite_value(nec_float value)
{
  return std::isfinite(value);
}

bool multiply_overflows(size_t left, size_t right)
{
  return right != 0 && left > std::numeric_limits<size_t>::max() / right;
}

size_t checked_mul(size_t left, size_t right, const char* reason)
{
  if (multiply_overflows(left, right))
    fail_prepared(reason);
  return left * right;
}

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

uint32_t load_u32_le(const uint8_t* src)
{
  return static_cast<uint32_t>(src[0]) |
    (static_cast<uint32_t>(src[1]) << 8) |
    (static_cast<uint32_t>(src[2]) << 16) |
    (static_cast<uint32_t>(src[3]) << 24);
}

uint64_t load_u64_le(const uint8_t* src)
{
  return static_cast<uint64_t>(src[0]) |
    (static_cast<uint64_t>(src[1]) << 8) |
    (static_cast<uint64_t>(src[2]) << 16) |
    (static_cast<uint64_t>(src[3]) << 24) |
    (static_cast<uint64_t>(src[4]) << 32) |
    (static_cast<uint64_t>(src[5]) << 40) |
    (static_cast<uint64_t>(src[6]) << 48) |
    (static_cast<uint64_t>(src[7]) << 56);
}

nec_float load_f64_le(const uint8_t* src)
{
  const uint64_t bits = load_u64_le(src);
  nec_float value = 0.0;
  std::memcpy(&value, &bits, sizeof(value));
  return value;
}

void store_i32_le(uint8_t* dest, int32_t value)
{
  uint32_t bits = 0;
  std::memcpy(&bits, &value, sizeof(bits));
  store_u32_le(dest, bits);
}

size_t geometry_index(
  size_t n_segments, size_t n_nodes,
  size_t plane, size_t segment, size_t node)
{
  return (plane * n_segments + segment) * n_nodes + node;
}

size_t current_index(
  size_t n_image_planes, size_t n_segments, size_t n_nodes,
  size_t mode, size_t plane, size_t segment, size_t node)
{
  return ((mode * n_image_planes + plane) * n_segments + segment) * n_nodes +
    node;
}

void require_node(nec_float xi)
{
  if (!finite_value(xi))
    fail_prepared("NODE VALUES MUST BE FINITE");
  if (xi < -1.0 || xi > 1.0)
    fail_prepared("NODES MUST LIE IN [-1, 1]");
}

} // namespace

size_t nec_prepared_quadrature_view::geometry_index(
  size_t plane, size_t segment_index, size_t node) const
{
  if (plane >= n_image_planes || segment_index >= n_segments || node >= n_nodes)
    throw std::out_of_range("NEC prepared-quadrature geometry index is out of range");
  return (plane * static_cast<size_t>(n_segments) + segment_index) *
    static_cast<size_t>(n_nodes) + node;
}

size_t nec_prepared_quadrature_view::current_index(
  size_t mode, size_t plane, size_t segment_index, size_t node) const
{
  if (mode >= n_modes || plane >= n_image_planes ||
      segment_index >= n_segments || node >= n_nodes)
    throw std::out_of_range("NEC prepared-quadrature current index is out of range");
  return ((mode * static_cast<size_t>(n_image_planes) + plane) *
    static_cast<size_t>(n_segments) + segment_index) *
    static_cast<size_t>(n_nodes) + node;
}

nec_complex nec_prepared_quadrature_view::current_at(
  size_t mode, size_t plane, size_t segment_index, size_t node) const
{
  const size_t index = current_index(mode, plane, segment_index, node);
  return nec_complex(i_real[index], i_imag[index]);
}

nec_complex nec_evaluate_quadrature_current(
  const nec_current_distribution& distribution,
  size_t mode, size_t segment, nec_float xi)
{
  require_node(xi);
  if (mode >= distribution.mode_count || segment >= distribution.segment_count())
    fail_prepared("CURRENT SAMPLE INDEX IS OUT OF RANGE");
  if (!finite_value(distribution.wavelength_m) ||
      !(distribution.wavelength_m > 0.0))
    fail_prepared("WAVELENGTH MUST BE POSITIVE AND FINITE");
  const nec_float length = distribution.lengths_m.at(segment);
  if (!finite_value(length) || !(length > 0.0))
    fail_prepared("SEGMENT LENGTH MUST BE POSITIVE AND FINITE");
  const nec_float s = xi * length * 0.5;
  const nec_float k = two_pi() / distribution.wavelength_m;
  return nec_evaluate_segment_current(
    distribution.a_at(mode, segment),
    distribution.b_at(mode, segment),
    distribution.c_at(mode, segment),
    k, s);
}

nec_prepared_current_quadrature nec_prepare_current_quadrature(
  const nec_current_distribution& distribution,
  const nec_prepared_quadrature_request& request,
  uint64_t model_generation,
  uint64_t solution_generation,
  bool perfect_ground)
{
  if (request.nodes.empty())
    fail_prepared("NODE LIST IS EMPTY");
  if (!request.weights.empty() && request.weights.size() != request.nodes.size())
    fail_prepared("WEIGHT COUNT MUST MATCH NODE COUNT");
  if (request.images == nec_prepared_quadrature_images::perfect_ground_images &&
      !perfect_ground)
    fail_prepared("PERFECT-GROUND IMAGES REQUIRE PERFECT GROUND");
  if (distribution.segment_count() == 0 || distribution.mode_count == 0)
    fail_prepared("CURRENT DISTRIBUTION HAS NO SAMPLES");
  if (distribution.schema_version != 1)
    fail_prepared("UNSUPPORTED CURRENT-DISTRIBUTION SCHEMA");

  for (nec_float xi : request.nodes)
    require_node(xi);
  for (nec_float weight : request.weights) {
    if (!finite_value(weight))
      fail_prepared("WEIGHT VALUES MUST BE FINITE");
  }

  const size_t n_segments = distribution.segment_count();
  const size_t n_nodes = request.nodes.size();
  const size_t n_modes = distribution.mode_count;
  const size_t n_planes =
    request.images == nec_prepared_quadrature_images::perfect_ground_images
      ? 2u : 1u;
  if (n_segments > std::numeric_limits<uint32_t>::max() ||
      n_nodes > std::numeric_limits<uint32_t>::max() ||
      n_modes > std::numeric_limits<uint32_t>::max())
    fail_prepared("PACKED SIZE IS TOO LARGE");

  const bool has_weights = !request.weights.empty();

  const size_t n_physical = checked_mul(
    n_segments, n_nodes, "SAMPLE COUNT OVERFLOWS");
  const size_t n_geometry = checked_mul(
    n_physical, n_planes, "SAMPLE COUNT OVERFLOWS");
  const size_t n_currents = checked_mul(
    n_geometry, n_modes, "SAMPLE COUNT OVERFLOWS");
  const size_t geometry_bytes = checked_mul(
    checked_mul(9u, n_geometry, "PACKED SIZE IS TOO LARGE"),
    8u, "PACKED SIZE IS TOO LARGE");
  const size_t current_bytes = checked_mul(
    checked_mul(2u, n_currents, "PACKED SIZE IS TOO LARGE"),
    8u, "PACKED SIZE IS TOO LARGE");
  const size_t identity_bytes = nec_prepared_quadrature_identity_bytes(n_segments);
  const size_t pad_bytes = nec_prepared_quadrature_identity_pad_bytes(n_segments);
  size_t total = nec_prepared_quadrature_header_bytes;
  total = checked_mul(1u, total + identity_bytes, "PACKED SIZE IS TOO LARGE");
  if (total > std::numeric_limits<size_t>::max() - pad_bytes)
    fail_prepared("PACKED SIZE IS TOO LARGE");
  total += pad_bytes;
  if (total > std::numeric_limits<size_t>::max() - geometry_bytes)
    fail_prepared("PACKED SIZE IS TOO LARGE");
  total += geometry_bytes;
  if (total > std::numeric_limits<size_t>::max() - current_bytes)
    fail_prepared("PACKED SIZE IS TOO LARGE");
  total += current_bytes;
  if (total > std::vector<uint8_t>().max_size())
    fail_prepared("PACKED SIZE IS TOO LARGE");

  nec_prepared_current_quadrature prepared;
  prepared.schema_version = nec_prepared_quadrature_schema_version;
  prepared.packed.resize(total);
  prepared.diagnostics.growing_allocations = 1;
  prepared.diagnostics.geometry_walks = 1;
  prepared.diagnostics.trigonometry_evaluations = n_physical;
  prepared.diagnostics.interpolations = n_currents;

  uint8_t* bytes = prepared.packed.data();
  std::memset(bytes, 0, total);
  bytes[0] = kMagic[0];
  bytes[1] = kMagic[1];
  bytes[2] = kMagic[2];
  bytes[3] = kMagic[3];
  store_u32_le(bytes + 4, nec_prepared_quadrature_schema_version);
  uint32_t flags = 0;
  if (n_planes == 2)
    flags |= nec_prepared_quadrature_flag_images;
  if (has_weights)
    flags |= nec_prepared_quadrature_flag_weights;
  store_u32_le(bytes + 8, flags);
  store_u32_le(bytes + 12, static_cast<uint32_t>(n_segments));
  store_u32_le(bytes + 16, static_cast<uint32_t>(n_nodes));
  store_u32_le(bytes + 20, static_cast<uint32_t>(n_modes));
  store_u32_le(bytes + 24, static_cast<uint32_t>(n_planes));
  store_u32_le(bytes + 28, 0);
  uint64_t frequency_bits = 0;
  uint64_t wavelength_bits = 0;
  std::memcpy(&frequency_bits, &distribution.frequency_mhz, sizeof(frequency_bits));
  std::memcpy(&wavelength_bits, &distribution.wavelength_m, sizeof(wavelength_bits));
  store_u64_le(bytes + 32, frequency_bits);
  store_u64_le(bytes + 40, wavelength_bits);
  store_u64_le(bytes + 48, model_generation);
  store_u64_le(bytes + 56, solution_generation);

  uint8_t* identity = bytes + nec_prepared_quadrature_header_bytes;
  int32_t* tag = reinterpret_cast<int32_t*>(identity);
  int32_t* segment = tag + n_segments;
  int32_t* native_index = segment + n_segments;
  for (size_t index = 0; index < n_segments; ++index) {
    store_i32_le(
      reinterpret_cast<uint8_t*>(tag + index),
      distribution.segments[index].tag);
    store_i32_le(
      reinterpret_cast<uint8_t*>(segment + index),
      distribution.segments[index].segment);
    store_i32_le(
      reinterpret_cast<uint8_t*>(native_index + index),
      distribution.segments[index].native_index);
  }

  const size_t geometry_offset =
    nec_prepared_quadrature_header_bytes + identity_bytes + pad_bytes;
  nec_float* planes[9];
  for (size_t plane = 0; plane < 9; ++plane) {
    planes[plane] = reinterpret_cast<nec_float*>(
      bytes + geometry_offset + plane * n_geometry * sizeof(nec_float));
  }
  nec_float* x = planes[0];
  nec_float* y = planes[1];
  nec_float* z = planes[2];
  nec_float* tx = planes[3];
  nec_float* ty = planes[4];
  nec_float* tz = planes[5];
  nec_float* radius = planes[6];
  nec_float* length_plane = planes[7];
  nec_float* ds_weight = planes[8];
  nec_float* i_real = reinterpret_cast<nec_float*>(
    bytes + geometry_offset + geometry_bytes);
  nec_float* i_imag = i_real + n_currents;

  const nec_float k = two_pi() / distribution.wavelength_m;
  for (size_t segment_index = 0; segment_index < n_segments; ++segment_index) {
    const size_t xyz = 3 * segment_index;
    const nec_float cx = distribution.centres_m[xyz];
    const nec_float cy = distribution.centres_m[xyz + 1];
    const nec_float cz = distribution.centres_m[xyz + 2];
    const nec_float txx = distribution.tangents[xyz];
    const nec_float tyy = distribution.tangents[xyz + 1];
    const nec_float tzz = distribution.tangents[xyz + 2];
    const nec_float length = distribution.lengths_m[segment_index];
    const nec_float radius_m = distribution.radii_m[segment_index];
    for (size_t node = 0; node < n_nodes; ++node) {
      const nec_float xi = request.nodes[node];
      const nec_float weight = has_weights ? request.weights[node] : nec_float(1.0);
      const nec_float s = xi * length * 0.5;
      const nec_float sample_x = cx + s * txx;
      const nec_float sample_y = cy + s * tyy;
      const nec_float sample_z = cz + s * tzz;
      const nec_float stored_weight = length * 0.5 * weight;
      const size_t physical = geometry_index(
        n_segments, n_nodes, 0, segment_index, node);
      x[physical] = sample_x;
      y[physical] = sample_y;
      z[physical] = sample_z;
      tx[physical] = txx;
      ty[physical] = tyy;
      tz[physical] = tzz;
      radius[physical] = radius_m;
      length_plane[physical] = length;
      ds_weight[physical] = stored_weight;
      if (n_planes == 2) {
        const size_t image = geometry_index(
          n_segments, n_nodes, 1, segment_index, node);
        x[image] = sample_x;
        y[image] = sample_y;
        z[image] = -sample_z;
        tx[image] = txx;
        ty[image] = tyy;
        tz[image] = -tzz;
        radius[image] = radius_m;
        length_plane[image] = length;
        ds_weight[image] = stored_weight;
      }
      for (size_t mode = 0; mode < n_modes; ++mode) {
        const nec_complex current = nec_evaluate_segment_current(
          distribution.a_at(mode, segment_index),
          distribution.b_at(mode, segment_index),
          distribution.c_at(mode, segment_index),
          k, s);
        const size_t physical_current = current_index(
          n_planes, n_segments, n_nodes, mode, 0, segment_index, node);
        i_real[physical_current] = current.real();
        i_imag[physical_current] = current.imag();
        if (n_planes == 2) {
          const size_t image_current = current_index(
            n_planes, n_segments, n_nodes, mode, 1, segment_index, node);
          i_real[image_current] = -current.real();
          i_imag[image_current] = -current.imag();
        }
      }
    }
  }

  return prepared;
}

nec_prepared_quadrature_view nec_view_prepared_quadrature(
  const nec_prepared_current_quadrature& prepared)
{
  if (prepared.packed.size() < nec_prepared_quadrature_header_bytes)
    fail_prepared("PACKED BUFFER IS EMPTY");

  const uint8_t* bytes = prepared.packed.data();
  if (bytes[0] != kMagic[0] || bytes[1] != kMagic[1] ||
      bytes[2] != kMagic[2] || bytes[3] != kMagic[3])
    fail_prepared("PACKED MAGIC IS INVALID");

  nec_prepared_quadrature_view view;
  view.schema_version = load_u32_le(bytes + 4);
  if (view.schema_version != nec_prepared_quadrature_schema_version)
    fail_prepared("UNSUPPORTED PACKED SCHEMA");
  view.flags = load_u32_le(bytes + 8);
  view.n_segments = load_u32_le(bytes + 12);
  view.n_nodes = load_u32_le(bytes + 16);
  view.n_modes = load_u32_le(bytes + 20);
  view.n_image_planes = load_u32_le(bytes + 24);
  if (view.n_segments == 0 || view.n_nodes == 0 || view.n_modes == 0 ||
      (view.n_image_planes != 1 && view.n_image_planes != 2))
    fail_prepared("PACKED COUNTS ARE INVALID");
  const bool expect_images =
    (view.flags & nec_prepared_quadrature_flag_images) != 0;
  if (expect_images != (view.n_image_planes == 2))
    fail_prepared("PACKED IMAGE FLAG DOES NOT MATCH PLANE COUNT");

  view.frequency_mhz = load_f64_le(bytes + 32);
  view.wavelength_m = load_f64_le(bytes + 40);
  view.model_generation = load_u64_le(bytes + 48);
  view.solution_generation = load_u64_le(bytes + 56);

  const size_t packed_bytes = nec_prepared_quadrature_packed_bytes(
    view.n_modes, view.n_segments, view.n_nodes, view.n_image_planes);
  if (prepared.packed.size() != packed_bytes)
    fail_prepared("PACKED SIZE DOES NOT MATCH COUNTS");

  const size_t identity_bytes =
    nec_prepared_quadrature_identity_bytes(view.n_segments);
  const size_t pad_bytes =
    nec_prepared_quadrature_identity_pad_bytes(view.n_segments);
  const uint8_t* identity = bytes + nec_prepared_quadrature_header_bytes;
  view.tag = reinterpret_cast<const int32_t*>(identity);
  view.segment = view.tag + view.n_segments;
  view.native_index = view.segment + view.n_segments;

  view.geometry_count = nec_prepared_quadrature_sample_count(
    view.n_segments, view.n_nodes, view.n_image_planes);
  view.current_count = view.n_modes * view.geometry_count;
  const size_t geometry_offset =
    nec_prepared_quadrature_header_bytes + identity_bytes + pad_bytes;
  const nec_float* geometry = reinterpret_cast<const nec_float*>(
    bytes + geometry_offset);
  view.x = geometry;
  view.y = geometry + view.geometry_count;
  view.z = geometry + 2 * view.geometry_count;
  view.tx = geometry + 3 * view.geometry_count;
  view.ty = geometry + 4 * view.geometry_count;
  view.tz = geometry + 5 * view.geometry_count;
  view.radius_m = geometry + 6 * view.geometry_count;
  view.length_m = geometry + 7 * view.geometry_count;
  view.ds_weight = geometry + 8 * view.geometry_count;
  view.i_real = geometry + 9 * view.geometry_count;
  view.i_imag = view.i_real + view.current_count;
  return view;
}
