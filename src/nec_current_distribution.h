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
#include <stdexcept>
#include <vector>

class c_geometry;

enum class nec_current_mode_kind {
  latest_solution,
  unit_current,
};

enum class nec_segment_end_kind {
  free,
  ground,
  segment,
};

enum class nec_segment_end_side {
  start,
  end,
};

/*! Decoded segment-end connection. Native icon1/icon2 integers are not public. */
struct nec_segment_end {
  nec_segment_end_kind kind = nec_segment_end_kind::free;
  int tag = 0;
  int segment = 0;
  nec_segment_end_side end = nec_segment_end_side::start;
};

inline bool operator==(const nec_segment_end& left, const nec_segment_end& right)
{
  if (left.kind != right.kind)
    return false;
  if (left.kind != nec_segment_end_kind::segment)
    return true;
  return left.tag == right.tag && left.segment == right.segment &&
    left.end == right.end;
}

inline bool operator!=(const nec_segment_end& left, const nec_segment_end& right)
{
  return !(left == right);
}

/*! Caller-stable physical segment identity plus native index for mapping checks. */
struct nec_segment_identity {
  int tag = 0;
  int segment = 0;
  int native_index = 0;
};

/*! Owned exact NEC A/B/C current coefficients and physical segment geometry.
 *
 * Geometry is in metres. Coefficient planes are mode-major:
 * index = modeIndex * nSegments + segmentIndex.
 */
struct nec_current_distribution {
  uint32_t schema_version = 1;
  nec_float frequency_mhz = 0.0;
  nec_float wavelength_m = 0.0;
  nec_current_mode_kind mode_kind = nec_current_mode_kind::latest_solution;
  size_t mode_count = 0;
  std::vector<nec_segment_identity> segments;
  std::vector<nec_segment_end> start_ends;
  std::vector<nec_segment_end> end_ends;
  std::vector<nec_float> centres_m;
  std::vector<nec_float> starts_m;
  std::vector<nec_float> ends_m;
  std::vector<nec_float> tangents;
  std::vector<nec_float> radii_m;
  std::vector<nec_float> lengths_m;
  std::vector<nec_float> a_real;
  std::vector<nec_float> a_imag;
  std::vector<nec_float> b_real;
  std::vector<nec_float> b_imag;
  std::vector<nec_float> c_real;
  std::vector<nec_float> c_imag;

  size_t segment_count() const { return segments.size(); }

  size_t plane_index(size_t mode_index, size_t segment_index) const
  {
    if (mode_index >= mode_count || segment_index >= segments.size())
      throw std::out_of_range("NEC current-distribution index is out of range");
    return mode_index * segments.size() + segment_index;
  }

  nec_complex a_at(size_t mode_index, size_t segment_index) const
  {
    const size_t index = plane_index(mode_index, segment_index);
    return nec_complex(a_real.at(index), a_imag.at(index));
  }

  nec_complex b_at(size_t mode_index, size_t segment_index) const
  {
    const size_t index = plane_index(mode_index, segment_index);
    return nec_complex(b_real.at(index), b_imag.at(index));
  }

  nec_complex c_at(size_t mode_index, size_t segment_index) const
  {
    const size_t index = plane_index(mode_index, segment_index);
    return nec_complex(c_real.at(index), c_imag.at(index));
  }
};

/*! I(s) = A + B sin(k s) + C cos(k s) with s in the same length unit as 1/k. */
nec_complex nec_evaluate_segment_current(
  nec_complex a, nec_complex b, nec_complex c,
  nec_float k, nec_float s);

/*! Decode native icon1 (start_end=true) or icon2 (start_end=false). */
nec_segment_end nec_decode_segment_end(
  const c_geometry& geometry, int native_index, bool start_end);

/*! Fill public geometry, identity, and decoded ends in metres. */
void nec_fill_current_geometry(
  const c_geometry& geometry,
  nec_float wavelength_m,
  nec_current_distribution& output);
