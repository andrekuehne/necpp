/*
  Copyright (C) 2026  NEC2++ contributors

  This program is free software; you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation; either version 2 of the License, or
  (at your option) any later version.
*/
#include "nec_current_distribution.h"

#include "c_geometry.h"
#include "nec_exception.h"

#include <cmath>

namespace {

void fail_current(const char* reason)
{
  nec_exception error("CURRENT DISTRIBUTION: ");
  error.append(reason);
  throw error;
}

bool finite_value(nec_float value)
{
  return std::isfinite(value);
}

int segment_within_tag(const c_geometry& geometry, int native_index)
{
  const int tag = geometry.segment_tags[native_index];
  int count = 0;
  for (int64_t index = 0; index <= native_index; ++index) {
    if (geometry.segment_tags[index] == tag)
      ++count;
  }
  return count;
}

void require_finite_xyz(
  nec_float x, nec_float y, nec_float z, const char* reason)
{
  if (!finite_value(x) || !finite_value(y) || !finite_value(z))
    fail_current(reason);
}

} // namespace

nec_complex nec_evaluate_segment_current(
  nec_complex a, nec_complex b, nec_complex c,
  nec_float k, nec_float s)
{
  if (!finite_value(k) || !finite_value(s) ||
      !std::isfinite(a.real()) || !std::isfinite(a.imag()) ||
      !std::isfinite(b.real()) || !std::isfinite(b.imag()) ||
      !std::isfinite(c.real()) || !std::isfinite(c.imag()))
    fail_current("CURRENT SAMPLE VALUES MUST BE FINITE");
  const nec_float argument = k * s;
  return a + b * std::sin(argument) + c * std::cos(argument);
}

nec_segment_end nec_decode_segment_end(
  const c_geometry& geometry, int native_index, bool start_end)
{
  if (native_index < 0 || native_index >= geometry.n_segments)
    fail_current("SEGMENT INDEX IS OUT OF RANGE");

  const int icon = start_end
    ? geometry.icon1[native_index]
    : geometry.icon2[native_index];
  if (icon > PCHCON || icon < -PCHCON)
    fail_current("SURFACE PATCHES ARE UNSUPPORTED");

  nec_segment_end decoded;
  if (icon == 0) {
    decoded.kind = nec_segment_end_kind::free;
    return decoded;
  }

  const int self = native_index + 1;
  if (icon == self) {
    decoded.kind = nec_segment_end_kind::ground;
    return decoded;
  }

  const int other_native = (icon < 0 ? -icon : icon) - 1;
  if (other_native < 0 || other_native >= geometry.n_segments)
    fail_current("CONNECTED SEGMENT INDEX IS OUT OF RANGE");

  decoded.kind = nec_segment_end_kind::segment;
  decoded.tag = geometry.segment_tags[other_native];
  decoded.segment = segment_within_tag(geometry, other_native);
  const bool other_is_start = start_end ? (icon < 0) : (icon > 0);
  decoded.end = other_is_start
    ? nec_segment_end_side::start
    : nec_segment_end_side::end;
  return decoded;
}

void nec_fill_current_geometry(
  const c_geometry& geometry,
  nec_float wavelength_m,
  nec_current_distribution& output)
{
  if (!finite_value(wavelength_m) || !(wavelength_m > 0.0))
    fail_current("WAVELENGTH MUST BE POSITIVE AND FINITE");
  if (geometry.m != 0)
    fail_current("SURFACE PATCHES ARE UNSUPPORTED");
  if (geometry.n_segments <= 0)
    fail_current("GEOMETRY HAS NO SEGMENTS");

  const size_t count = static_cast<size_t>(geometry.n_segments);
  output.wavelength_m = wavelength_m;
  output.segments.resize(count);
  output.start_ends.resize(count);
  output.end_ends.resize(count);
  output.centres_m.resize(3 * count);
  output.starts_m.resize(3 * count);
  output.ends_m.resize(3 * count);
  output.tangents.resize(3 * count);
  output.radii_m.resize(count);
  output.lengths_m.resize(count);

  for (size_t index = 0; index < count; ++index) {
    const int native_index = static_cast<int>(index);
    output.segments[index].tag = geometry.segment_tags[native_index];
    output.segments[index].segment =
      segment_within_tag(geometry, native_index);
    output.segments[index].native_index = native_index;
    output.start_ends[index] =
      nec_decode_segment_end(geometry, native_index, true);
    output.end_ends[index] =
      nec_decode_segment_end(geometry, native_index, false);

    const nec_float cx = wavelength_m * geometry.x[native_index];
    const nec_float cy = wavelength_m * geometry.y[native_index];
    const nec_float cz = wavelength_m * geometry.z[native_index];
    const nec_float tx = geometry.cab[native_index];
    const nec_float ty = geometry.sab[native_index];
    const nec_float tz = geometry.salp[native_index];
    const nec_float length = wavelength_m * geometry.segment_length[native_index];
    const nec_float radius = wavelength_m * geometry.segment_radius[native_index];
    require_finite_xyz(cx, cy, cz, "SEGMENT CENTRE CONTAINS A NONFINITE VALUE");
    require_finite_xyz(tx, ty, tz, "SEGMENT TANGENT CONTAINS A NONFINITE VALUE");
    if (!finite_value(length) || !finite_value(radius) ||
        !(length > 0.0) || !(radius > 0.0))
      fail_current("SEGMENT LENGTH AND RADIUS MUST BE POSITIVE AND FINITE");

    const nec_float half = 0.5 * length;
    const size_t xyz = 3 * index;
    output.centres_m[xyz] = cx;
    output.centres_m[xyz + 1] = cy;
    output.centres_m[xyz + 2] = cz;
    output.starts_m[xyz] = cx - half * tx;
    output.starts_m[xyz + 1] = cy - half * ty;
    output.starts_m[xyz + 2] = cz - half * tz;
    output.ends_m[xyz] = cx + half * tx;
    output.ends_m[xyz + 1] = cy + half * ty;
    output.ends_m[xyz + 2] = cz + half * tz;
    output.tangents[xyz] = tx;
    output.tangents[xyz + 1] = ty;
    output.tangents[xyz + 2] = tz;
    output.lengths_m[index] = length;
    output.radii_m[index] = radius;
  }
}
