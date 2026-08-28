/*
  Copyright (C) 2026  NEC2++ contributors

  This program is free software; you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation; either version 2 of the License, or
  (at your option) any later version.
*/
#include "nec_port_matrix.h"

#include "nec_exception.h"

#include <Eigen/Dense>

#include <cmath>
#include <limits>

namespace {

[[noreturn]] void conditioning_failure(const char* reason)
{
  nec_exception error("PORT MATRIX CONDITIONING ERROR: ");
  error.append(reason);
  throw error;
}

} // namespace

nec_port_matrix_inverse nec_invert_port_matrix(
  const std::vector<nec_complex>& values,
  size_t order,
  nec_float maximum_condition_estimate)
{
  if (order == 0 ||
      order > std::numeric_limits<size_t>::max() / order ||
      order > static_cast<size_t>(std::numeric_limits<Eigen::Index>::max()) ||
      values.size() != order * order)
    conditioning_failure("MATRIX MUST BE NONEMPTY AND SQUARE");
  if (!std::isfinite(maximum_condition_estimate) ||
      !(maximum_condition_estimate >= 1.0))
    conditioning_failure("CONDITION LIMIT MUST BE FINITE AND AT LEAST ONE");
  for (const nec_complex value : values) {
    if (!std::isfinite(value.real()) || !std::isfinite(value.imag()))
      conditioning_failure("MATRIX CONTAINS A NONFINITE VALUE");
  }

  using matrix_type = Eigen::Matrix<nec_complex, Eigen::Dynamic, Eigen::Dynamic>;
  const Eigen::Index dimension = static_cast<Eigen::Index>(order);
  matrix_type matrix(dimension, dimension);
  for (size_t row = 0; row < order; ++row)
    for (size_t column = 0; column < order; ++column)
      matrix(static_cast<Eigen::Index>(row), static_cast<Eigen::Index>(column)) =
        values[row * order + column];

  Eigen::JacobiSVD<matrix_type> decomposition(
    matrix, Eigen::ComputeFullU | Eigen::ComputeFullV);
  const auto& singular_values = decomposition.singularValues();
  const nec_float largest = singular_values(0);
  const nec_float smallest = singular_values(dimension - 1);

  if (!std::isfinite(largest) || !std::isfinite(smallest) ||
      !(largest > 0.0) || !(smallest > 0.0))
    conditioning_failure("MATRIX IS SINGULAR");

  const nec_float condition_estimate = largest / smallest;
  if (!std::isfinite(condition_estimate) ||
      condition_estimate > maximum_condition_estimate)
    conditioning_failure("MATRIX EXCEEDS THE CONDITION LIMIT");

  const matrix_type inverse = decomposition.solve(
    matrix_type::Identity(dimension, dimension));
  nec_port_matrix_inverse result;
  result.condition_estimate = condition_estimate;
  result.values.resize(values.size());
  for (size_t row = 0; row < order; ++row) {
    for (size_t column = 0; column < order; ++column) {
      const nec_complex value = inverse(
        static_cast<Eigen::Index>(row), static_cast<Eigen::Index>(column));
      if (!std::isfinite(value.real()) || !std::isfinite(value.imag()))
        conditioning_failure("INVERSION PRODUCED A NONFINITE VALUE");
      result.values[row * order + column] = value;
    }
  }
  return result;
}
