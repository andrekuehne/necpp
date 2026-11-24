#include "nec_periodic_spatial_table.h"

#include <algorithm>
#include <array>
#include <cmath>

namespace nec_periodic {
namespace {
constexpr double pi = 3.141592653589793238462643383279502884;

// The table spacing as a fraction of the shorter scale of the terms
// (kernel_table_spacing). Finer than the spectral table's: near the lattice
// point the numerators reach about exp((k/2E)^2) times the free-space term,
// which the spectral sum cancels, so their error counts at that size. The
// tables are built once per frequency.
constexpr double table_fraction = 0.03;

// Fills a table of the two complex functions of evaluate (4 reals per node)
// over grid, checks it at the midpoints of the intervals and returns the
// largest absolute error of each function.
template <typename Evaluate>
std::array<double, 2> tabulate(const uniform_grid& grid, Evaluate evaluate, std::vector<double>& table) {
  table.resize(grid.nodes * 4);
  for(size_t n = 0; n < grid.nodes; ++n) {
    const spatial_radial value = evaluate(grid.node(n));
    table[4 * n] = value.value.real();
    table[4 * n + 1] = value.value.imag();
    table[4 * n + 2] = value.derivative_over_distance.real();
    table[4 * n + 3] = value.derivative_over_distance.imag();
  }
  const std::array<double, stencil_width>& weights = uniform_grid::midpoint_weights();
  constexpr size_t middle = stencil_width / 2 - 1;
  double error[2] = {0, 0};
  for(size_t n = middle; n + stencil_width - middle <= grid.nodes; ++n) {
    const spatial_radial exact = evaluate(grid.node(n) + grid.spacing / 2);
    complex_d value = 0, derivative = 0;
    for(int a = 0; a < stencil_width; ++a) {
      const double* entry = &table[4 * (n - middle + size_t(a))];
      value += weights[size_t(a)] * complex_d(entry[0], entry[1]);
      derivative += weights[size_t(a)] * complex_d(entry[2], entry[3]);
    }
    error[0] = std::max(error[0], std::abs(value - exact.value));
    error[1] = std::max(error[1], std::abs(derivative - exact.derivative_over_distance));
  }
  return {error[0], error[1]};
}
}

spatial_table::spatial_table(const periodic_green& green, double full_range, double smooth_range, size_t max_nodes)
  : green_(green), full_range_(full_range), smooth_range_(smooth_range) {
  const double k = std::abs(green.wavenumber());
  const double spacing = kernel_table_spacing(k, green.splitting(), table_fraction);
  full_grid_ = uniform_grid::covering(0, full_range, spacing);
  smooth_grid_ = uniform_grid::covering(0, smooth_range, spacing);
  // Errors relative to the free-space term 1 / (4 pi R) and its gradient
  // (k + 1 / R) / (4 pi R): an error dc, dd of the numerators is dc / 2 of
  // the value and at most dd / 2 of the gradient; the smooth term is measured
  // at R = 1 / k, value k / (4 pi), gradient 2 k^2 / (4 pi), where its own
  // gradient (T'/R) times R has the error d(T'/R) / k.
  // The numerators are smooth through R = 0 and taken there as they are; the
  // smooth term is even in R.
  if(full_range > 0 && full_grid_.nodes <= max_nodes) {
    const std::array<double, 2> error =
      tabulate(full_grid_, [&](double r) { return green_.spatial_numerators(r); }, full_);
    error_ = std::max(error_, std::max(error[0], error[1]) / 2);
  }
  if(smooth_range > 0 && smooth_grid_.nodes <= max_nodes) {
    const std::array<double, 2> error =
      tabulate(smooth_grid_, [&](double r) { return green_.smooth_spatial_radial(std::abs(r)); }, smooth_);
    error_ = std::max(error_, std::max(error[0] * 4 * pi / k, error[1] * 4 * pi / (2 * k * k * k)));
  }
}

green_value spatial_table::term(vec2 rho, const point& r, bool smooth) const {
  const point d = {r[0] - rho.x, r[1] - rho.y, r[2]};
  const double distance = std::sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
  if(smooth) {
    if(smooth_.empty() || distance > smooth_range_) {
      // Direct: the origin's smooth term, or a close image's full term minus
      // the free-space term.
      if(rho.x == 0 && rho.y == 0) return green_.spatial_term(rho, r, true);
      green_value value = green_.spatial_term(rho, r, false);
      const green_value free = free_space_green(d, green_.wavenumber());
      value.value -= free.value;
      for(int axis = 0; axis < 3; ++axis) value.gradient[size_t(axis)] -= free.gradient[size_t(axis)];
      return value;
    }
  } else if(full_.empty() || distance > full_range_ || distance == 0) {
    return green_.spatial_term(rho, r, false);
  }
  // The stencil's sums in real arithmetic, and for the full term one
  // reciprocal of R: this runs for every kernel sample of every lattice point.
  const uniform_grid& grid = smooth ? smooth_grid_ : full_grid_;
  double weights[stencil_width];
  const double* entry = &(smooth ? smooth_ : full_)[4 * grid.stencil(distance, weights)];
  double value_re = 0, value_im = 0, derivative_re = 0, derivative_im = 0;
  for(int a = 0; a < stencil_width; ++a, entry += 4) {
    value_re += weights[a] * entry[0];
    value_im += weights[a] * entry[1];
    derivative_re += weights[a] * entry[2];
    derivative_im += weights[a] * entry[3];
  }
  if(!smooth) {
    // c / (8 pi R) and d / (8 pi R^3).
    const double inverse = 1 / distance;
    const double value_scale = inverse * (1 / (8 * pi)), derivative_scale = value_scale * inverse * inverse;
    value_re *= value_scale;
    value_im *= value_scale;
    derivative_re *= derivative_scale;
    derivative_im *= derivative_scale;
  }
  return {{value_re, value_im},
          {complex_d(derivative_re * d[0], derivative_im * d[0]), complex_d(derivative_re * d[1], derivative_im * d[1]),
           complex_d(derivative_re * d[2], derivative_im * d[2])}};
}
}
