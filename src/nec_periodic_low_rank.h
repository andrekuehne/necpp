#pragma once
// The singular parts of the Floquet modes near cut-off, split out of the
// periodic kernel (periodic_green::split_modes), enter the interaction matrix
// as a low-rank update
//
//   Z = Zr + sum_l c_l u_l v_l^T,
//
// u over the observation (row) index, v over the basis (column) index, with
// coefficients c_l of size 1 / kz. Only Zr is factored; the Woodbury identity
//
//   Z^-1 b = x0 - W (C^-1 + V^T W)^-1 V^T x0,   x0 = Zr^-1 b,   W = Zr^-1 U,
//
// involves only C^-1, which is finite and zero exactly on cut-off, so port
// quantities stay finite and continuous through a Wood anomaly.
//
// Several modes at cut-off at once (broadside on a square lattice of one
// wavelength) can couple to the unit cell through linearly dependent columns
// u, which makes the capacitance matrix C^-1 + V^T W singular exactly there.
// Its solve is a pseudo-inverse that drops singular values below
// rank_threshold of the largest; the dropped directions are those that U maps
// to zero.
#include <complex>
#include <functional>
#include <vector>

namespace nec_periodic {
class low_rank_update {
public:
  using vector = std::vector<std::complex<double>>;
  static constexpr double rank_threshold = 1e-11;

  // Adds the column pair (u, v) with coefficient c = 1 / inverse_coefficient
  // (inverse_coefficient = 0 exactly on cut-off), scaled to unit columns; a
  // zero column adds nothing. All columns have the matrix size.
  void add(vector u, vector v, std::complex<double> inverse_coefficient);
  bool empty() const { return columns_.empty(); }
  // Once Zr is factored: solve_regular(b) overwrites b with Zr^-1 b.
  void factor(const std::function<void(vector&)>& solve_regular);
  // Turns x = Zr^-1 b into Z^-1 b in place (the first matrix-size entries).
  void correct(std::complex<double>* x) const;

private:
  struct column {
    vector u, v, w;  // w = Zr^-1 u
    std::complex<double> inverse_coefficient;
  };
  std::vector<column> columns_;
  // Pseudo-inverse of the capacitance matrix C^-1 + V^T W, row-major.
  vector capacitance_inverse_;
};
}
