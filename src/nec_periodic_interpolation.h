#pragma once
// Local Lagrange interpolation on a uniform grid, for the tables of the
// periodic fill (nec_periodic_spectral_fill.h, nec_periodic_spatial_table.h).
//
// A grid built by uniform_grid::covering gives every point of the covered
// interval a centred stencil of stencil_width nodes: the point lies in the
// middle interval of its stencil, where the interpolation error is smallest
// and largest at the interval's midpoint. midpoint_weights are the weights
// there, so a table checks its own error by comparing the midpoints of the
// intervals it uses with direct values.
#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>

namespace nec_periodic {
constexpr int stencil_width = 8;

// The spacing of the kernel's tables (in dz and in the distance R), times
// fraction: their functions oscillate like exp(-+j k x), |kz| <= |k| for the
// propagating modes, and change on the scale 1 / E of the Gaussian in the
// error functions; an evanescent mode with |kz| beyond a few E is smaller
// than the kernel's accuracy wherever it changes faster. The 8-point
// stencils' error falls like the spacing to the eighth power; every table
// measures its own at its midpoints.
inline double kernel_table_spacing(double k, double splitting, double fraction) {
  return fraction / std::max(std::abs(k), 4 * splitting);
}

struct uniform_grid {
  double origin = 0, spacing = 1;
  size_t nodes = 0;

  double node(size_t index) const { return origin + double(index) * spacing; }

  // A grid of the given spacing whose centred stencils cover [low, high].
  static uniform_grid covering(double low, double high, double spacing) {
    uniform_grid grid;
    grid.spacing = spacing;
    grid.origin = low - (stencil_width / 2) * spacing;
    grid.nodes = size_t(std::ceil((high - low) / spacing)) + stencil_width + 1;
    return grid;
  }

  // The first node of the centred stencil at x, and its weights.
  size_t stencil(double x, double* weights) const {
    const double t = (x - origin) / spacing;
    const double highest = double(nodes - stencil_width);
    const double first = std::min(std::max(std::floor(t) - (stencil_width / 2 - 1), 0.0), highest);
    lagrange_weights(t - first, weights);
    return size_t(first);
  }

  // Weights of the nodes 0 .. stencil_width - 1 at the position t (in units of
  // the spacing, from the first node).
  static void lagrange_weights(double t, double* weights) {
    // 1 / prod over c != a of (a - c) = (-1)^(width-1-a) / (a! (width-1-a)!).
    constexpr std::array<double, stencil_width> inverse_denominator = [] {
      std::array<double, stencil_width> inverse{};
      for(int a = 0; a < stencil_width; ++a) {
        double product = 1;
        for(int c = 0; c < stencil_width; ++c)
          if(c != a) product *= double(a - c);
        inverse[size_t(a)] = 1 / product;
      }
      return inverse;
    }();
    // Products of (t - c) over the nodes before and after a.
    double before[stencil_width], after[stencil_width];
    before[0] = 1;
    for(int c = 1; c < stencil_width; ++c) before[c] = before[c - 1] * (t - (c - 1));
    after[stencil_width - 1] = 1;
    for(int c = stencil_width - 2; c >= 0; --c) after[c] = after[c + 1] * (t - (c + 1));
    for(int a = 0; a < stencil_width; ++a) weights[a] = before[a] * after[a] * inverse_denominator[size_t(a)];
  }

  // The weights at the midpoint of the stencil's middle interval.
  static const std::array<double, stencil_width>& midpoint_weights() {
    static const std::array<double, stencil_width> weights = [] {
      std::array<double, stencil_width> w{};
      lagrange_weights(stencil_width / 2 - 0.5, w.data());
      return w;
    }();
    return weights;
  }
};
}
