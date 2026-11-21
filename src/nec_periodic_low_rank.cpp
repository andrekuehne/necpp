#include "nec_periodic_low_rank.h"

#include <Eigen/Dense>
#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <utility>

namespace nec_periodic {

void low_rank_update::add(vector u, vector v, std::complex<double> inverse_coefficient) {
  if(u.size() != v.size() || (!columns_.empty() && u.size() != columns_.front().u.size()))
    throw std::invalid_argument("Low-rank columns must have the matrix size");
  // Columns scaled to a largest entry of 1, so that the capacitance matrix
  // is not graded by the columns' units and its pseudo-inverse drops only
  // directions that are dependent: c u v^T = (c |u| |v|) (u / |u|) (v / |v|)^T.
  double u_scale = 0, v_scale = 0;
  for(size_t i = 0; i < u.size(); ++i) {
    u_scale = std::max(u_scale, std::abs(u[i]));
    v_scale = std::max(v_scale, std::abs(v[i]));
  }
  if(u_scale == 0 || v_scale == 0) return;  // a zero term
  for(size_t i = 0; i < u.size(); ++i) {
    u[i] /= u_scale;
    v[i] /= v_scale;
  }
  columns_.push_back({std::move(u), std::move(v), {}, inverse_coefficient / (u_scale * v_scale)});
  capacitance_inverse_.clear();
}

void low_rank_update::factor(const std::function<void(vector&)>& solve_regular) {
  const Eigen::Index rank = Eigen::Index(columns_.size());
  for(column& c : columns_) {
    c.w = c.u;
    solve_regular(c.w);
  }
  Eigen::MatrixXcd capacitance(rank, rank);  // C^-1 + V^T W
  for(Eigen::Index l = 0; l < rank; ++l)
    for(Eigen::Index m = 0; m < rank; ++m) {
      std::complex<double> sum = l == m ? columns_[l].inverse_coefficient : 0.0;
      const vector &v = columns_[l].v, &w = columns_[m].w;
      for(size_t i = 0; i < v.size(); ++i) sum += v[i] * w[i];
      capacitance(l, m) = sum;
    }
  Eigen::JacobiSVD<Eigen::MatrixXcd> svd(capacitance, Eigen::ComputeFullU | Eigen::ComputeFullV);
  const Eigen::VectorXd& sigma = svd.singularValues();
  Eigen::VectorXd inverse_sigma = Eigen::VectorXd::Zero(rank);
  for(Eigen::Index i = 0; i < rank; ++i)
    if(sigma(i) > rank_threshold * sigma(0)) inverse_sigma(i) = 1 / sigma(i);
  const Eigen::MatrixXcd pseudo_inverse =
    svd.matrixV() * inverse_sigma.asDiagonal() * svd.matrixU().adjoint();
  capacitance_inverse_.resize(size_t(rank * rank));
  for(Eigen::Index l = 0; l < rank; ++l)
    for(Eigen::Index m = 0; m < rank; ++m) capacitance_inverse_[size_t(l * rank + m)] = pseudo_inverse(l, m);
}

void low_rank_update::correct(std::complex<double>* x) const {
  const size_t rank = columns_.size();
  if(rank == 0) return;
  if(capacitance_inverse_.size() != rank * rank) throw std::logic_error("Low-rank update used before factor()");
  const size_t size = columns_.front().v.size();
  vector projection(rank, 0.0);
  for(size_t l = 0; l < rank; ++l)
    for(size_t i = 0; i < size; ++i) projection[l] += columns_[l].v[i] * x[i];
  for(size_t l = 0; l < rank; ++l) {
    std::complex<double> amplitude = 0;
    for(size_t m = 0; m < rank; ++m) amplitude += capacitance_inverse_[l * rank + m] * projection[m];
    const vector& w = columns_[l].w;
    for(size_t i = 0; i < size; ++i) x[i] -= amplitude * w[i];
  }
}
}
