/*
  Copyright (C) 2026  NEC2++ contributors

  This program is free software; you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation; either version 2 of the License, or
  (at your option) any later version.
*/
#pragma once

#include "common.h"
#include "math_util.h"

#include <vector>

class c_geometry;
class nec_ground;

/*! Read-only inputs needed by the ordinary NEC far-zone field calculation.
 *
 * The referenced arrays are the current-coefficient state produced by the
 * latest solve.  A view is valid until its owning nec_context is mutated.
 */
struct nec_far_field_evaluation_input {
  const c_geometry& geometry;
  const nec_ground& ground;
  const real_array& air;
  const real_array& aii;
  const real_array& bir;
  const real_array& bii;
  const real_array& cir;
  const real_array& cii;
  const complex_array& current_vector;
  const int ifar;
  const nec_float wavelength;
  // Optional stateful-model cache.  The legacy RP path leaves this null and
  // retains its historical calculation; repeated stateful fields populate it
  // once per prepared geometry/frequency instead of once per contribution.
  const std::vector<nec_float>* segment_half_lengths = nullptr;
};

/*! Trigonometric direction terms shared by all segments in one sample. */
struct nec_far_field_direction {
  nec_float sin_theta;
  nec_float cos_theta;
  nec_float tan_theta;
  nec_float sin_phi;
  nec_float cos_phi;
};

struct nec_far_field_sample {
  nec_complex e_theta = nec_complex(0.0, 0.0);
  nec_complex e_phi = nec_complex(0.0, 0.0);
};

/*! Evaluate one unscaled ordinary far-zone sample without shared mutation. */
nec_far_field_sample nec_evaluate_far_field_sample(
  const nec_far_field_evaluation_input& input,
  nec_float theta_rad,
  nec_float phi_rad);

/*! Evaluate from caller-hoisted angular trigonometry. */
nec_far_field_sample nec_evaluate_far_field_sample(
  const nec_far_field_evaluation_input& input,
  const nec_far_field_direction& direction);

/*! Apply the legacy RP wavelength and exp(-j k R) / R transformation. */
nec_far_field_sample nec_scale_far_field_sample(
  const nec_far_field_sample& sample,
  nec_float wavelength,
  nec_float radius_m);
