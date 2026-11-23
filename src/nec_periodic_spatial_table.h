#pragma once
// The spatial Ewald term of a lattice point from tables in the distance, for
// the per-frequency part of the periodic fill.
//
// periodic_green::spatial_term of a lattice point rho depends on r only
// through the distance R = |r - rho| and the direction of the gradient. Two
// radial functions cover every use in the fill: the full term, as the smooth
// numerators c and d of c / (8 pi R) and d / (8 pi R^3)
// (periodic_green::spatial_numerators), and the term minus the free-space
// term exp(-jkR)/(4 pi R), for the origin and the close images
// (periodic_green::smooth_spatial_radial). Each is tabulated on a uniform grid
// in R with centred 8-point Lagrange stencils (nec_periodic_interpolation.h)
// up to the distance the fill needs; beyond it, or when a table would exceed
// max_nodes, the term is evaluated directly.
//
// The tables check their error at the midpoints of their intervals when they
// are built. interpolation_error() is the largest of them relative to the
// free-space term 1 / (4 pi R) the image stands for (for the smooth term at
// R = 1 / k): an estimate on the scale of the kernel's own accuracy
// (kernel_error).
#include "nec_periodic_green.h"
#include "nec_periodic_interpolation.h"

#include <cstddef>
#include <vector>

namespace nec_periodic {
class spatial_table {
public:
  static constexpr size_t default_max_nodes = size_t(1) << 16;

  // green: any scan state of the lattice, wavenumber and splitting (the
  // spatial terms do not depend on the scan state). full_range and
  // smooth_range: the largest distance at which each term is needed.
  spatial_table(const periodic_green& green, double full_range, double smooth_range,
                size_t max_nodes = default_max_nodes);

  // spatial_term(rho, r, false); with smooth, that term minus the free-space
  // term exp(-jkR)/(4 pi R), R = |r - rho| (at rho = 0 spatial_term(rho, r, true)).
  green_value term(vec2 rho, const point& r, bool smooth) const;
  double interpolation_error() const { return error_; }
  bool full_tabulated() const { return !full_.empty(); }
  bool smooth_tabulated() const { return !smooth_.empty(); }

private:
  periodic_green green_;  // a copy: the tables outlive the scan state they were built with
  uniform_grid full_grid_, smooth_grid_;
  double full_range_ = 0, smooth_range_ = 0;
  // Real and imaginary parts of the two functions per node.
  std::vector<double> full_, smooth_;
  double error_ = 0;
};
}
