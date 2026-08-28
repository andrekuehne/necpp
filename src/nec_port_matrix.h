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
#include <vector>

struct nec_port_matrix_inverse {
  std::vector<nec_complex> values;
  nec_float condition_estimate = 0.0;
};

/*! Invert a square row-major port matrix with a controlled condition limit.
 *
 * This is an internal numerical seam kept separate from the stateful model so
 * singular-matrix behavior can be tested deterministically without relying on
 * a geometrically degenerate NEC fixture.
 */
nec_port_matrix_inverse nec_invert_port_matrix(
  const std::vector<nec_complex>& values,
  size_t order,
  nec_float maximum_condition_estimate = 1.0e12);
