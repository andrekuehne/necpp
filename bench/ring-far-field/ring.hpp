#pragma once
// Bench-only ring interpolator. The direct kernel is included unchanged.
#include "../../src/nec_field_evaluator_wasm.cpp"
#include "nec_stateful_model.h"
#include <algorithm>
#include <array>
#include <complex>
#include <numeric>
#include <stdexcept>

namespace ring_bench {
using C = std::complex<double>;
constexpr double tau = 6.283185307179586476925286766559;

struct Field {
  std::vector<double> tr, ti, pr, pi;
  explicit Field(size_t n) : tr(n), ti(n), pr(n), pi(n) {}
  C theta(size_t i) const { return {tr[i], ti[i]}; }
  C phi(size_t i) const { return {pr[i], pi[i]}; }
  void put(size_t i, C t, C p) {
    tr[i] = t.real(); ti[i] = t.imag();
    pr[i] = p.real(); pi[i] = p.imag();
  }
};

Field direct(const nec_far_field_snapshot& s, const nec_far_field_grid& g) {
  Field f(size_t(g.theta_count) * g.phi_count);
  int status = necpp_field_evaluator_v1_evaluate(
    s.segment_count(), s.perfect_ground, s.wavelength_m, g.radius_m,
    g.theta_start_deg, g.theta_count, g.theta_step_deg,
    g.phi_start_deg, g.phi_count, g.phi_step_deg, 0, f.tr.size(),
    s.x.data(), s.y.data(), s.z.data(),
    s.cab.data(), s.sab.data(), s.salp.data(), s.segment_half_lengths.data(),
    s.air.data(), s.aii.data(), s.bir.data(), s.bii.data(),
    s.cir.data(), s.cii.data(),
    f.tr.data(), f.ti.data(), f.pr.data(), f.pi.data());
  if (status) throw std::runtime_error("direct tile failed");
  return f;
}

// Sum_{|n|>N}|J_n(A)| <= 2 exp(A sinh(t)-(N+1)t)/(1-exp(-t)).
// t=acosh((N+1)/A) minimizes the numerator. See report for derivation.
double log_tail(double a, int n) {
  if (a == 0) return -INFINITY;
  if (n + 1 <= a) return INFINITY;
  const double t = std::acosh((n + 1) / a);
  return std::log(2.) + a * std::sinh(t) - (n + 1) * t
    - std::log(-std::expm1(-t));
}

int cutoff(double a, double eps) {
  if (a == 0) return 0;
  int n = int(std::floor(a));
  while (log_tail(a, n) > std::log(eps)) ++n;
  return n;
}

struct Result {
  Field field;
  uint64_t directions = 0;
  int fallback = 0, maxL = 0, maxSegmentExtra = 0;
  double bound = 0, lowerPeak = 0, sourceNorm = 0;
  std::vector<int> samples;
  explicit Result(size_t n) : field(n) {}
};

Result evaluate(const nec_far_field_snapshot& original,
                const nec_far_field_grid& g) {
  if (g.theta_count <= 0 || g.phi_count <= 0 || g.radius_m <= 0)
    throw std::runtime_error("invalid grid");
  Result out(size_t(g.theta_count) * g.phi_count);
  // A ring requires a complete periodic phi grid. Partial/nonperiodic grids
  // are an exact fallback, rather than being silently treated as periodic.
  if (std::abs(g.phi_count * g.phi_step_deg - 360) > 1e-9) {
    out.field = direct(original, g);
    out.directions = out.field.tr.size();
    out.fallback = g.theta_count;
    return out;
  }
  auto s = original;
  const double cx = std::accumulate(s.x.begin(), s.x.end(), 0.) / s.segment_count();
  const double cy = std::accumulate(s.y.begin(), s.y.end(), 0.) / s.segment_count();
  double rho = 0, b = 0, w = 0;
  int projection = 0;
  for (size_t i = 0; i < s.segment_count(); ++i) {
    s.x[i] -= cx; s.y[i] -= cy;
    rho = std::max(rho, std::hypot(s.x[i], s.y[i]));
    b = std::max(b, s.segment_half_lengths[i] * std::hypot(s.cab[i], s.sab[i]));
    if (std::hypot(s.cab[i], s.sab[i]) > 0) projection = 1;
    w += 2 * s.segment_half_lengths[i] * (
      std::hypot(s.air[i], s.aii[i]) + std::hypot(s.bir[i], s.bii[i])
      + std::hypot(s.cir[i], s.cii[i]));
  }
  w *= std::sqrt(4 * kPi * 1e-7 / 8.854e-12) / (4 * kPi)
    * s.wavelength_m / g.radius_m * (s.perfect_ground ? 2 : 1);
  out.sourceNorm = w;
  // A measured lower bound on the global vector peak makes the analytic
  // truncation budget robust to cancellation. Include all scout work in counts.
  const auto scout = direct(s, {g.radius_m, 0, 9, 11.25, 0, 8, 45});
  out.directions += 72;
  for (size_t i = 0; i < scout.tr.size(); ++i)
    out.lowerPeak = std::max(out.lowerPeak,
      std::sqrt(std::norm(scout.theta(i)) + std::norm(scout.phi(i))));
  if (!(out.lowerPeak > 0) || !(w > 0)) {
    out.field = direct(original, g);
    out.directions += out.field.tr.size();
    out.fallback = g.theta_count;
    return out;
  }
  const double eps = std::min(1e-13, 1e-12 * out.lowerPeak / (4 * w));
  out.bound = 4 * w * eps;
  for (int it = 0; it < g.theta_count; ++it) {
    const double theta = g.theta_start_deg + it * g.theta_step_deg;
    const double st = std::abs(std::sin(theta * kDegree));
    const double a = tau * rho * st;
    const int n = cutoff(a + b * st, eps), l = n + projection, m = 2 * l + 1;
    out.maxL = std::max(out.maxL, l);
    out.maxSegmentExtra = std::max(out.maxSegmentExtra, l - cutoff(a, eps));
    if (m >= g.phi_count) {
      const auto f = direct(original,
        {g.radius_m, theta, 1, 0, g.phi_start_deg, g.phi_count, g.phi_step_deg});
      for (int j = 0; j < g.phi_count; ++j)
        out.field.put(size_t(j) * g.theta_count + it, f.theta(j), f.phi(j));
      out.directions += g.phi_count;
      ++out.fallback;
      out.samples.push_back(g.phi_count);
      continue;
    }
    const auto sparse = direct(s, {g.radius_m, theta, 1, 0, 0, m, 360. / m});
    out.directions += m;
    out.samples.push_back(m);
    std::vector<C> ft(m), fp(m);
    for (int n = -l; n <= l; ++n) {
      const C rotation = std::polar(1., -tau * n / m);
      C z = 1, ct = 0, cp = 0;
      for (int j = 0; j < m; ++j) {
        if (j % 32 == 0) z = std::polar(1., -tau * n * j / m);
        ct += sparse.theta(j) * z;
        cp += sparse.phi(j) * z;
        z *= rotation;
      }
      ft[n + l] = ct / double(m);
      fp[n + l] = cp / double(m);
    }
    std::vector<C> targetT(g.phi_count), targetP(g.phi_count);
    for (int n = -l; n <= l; ++n) {
      const C rotation = std::polar(1., n * g.phi_step_deg * kDegree);
      C z;
      for (int j = 0; j < g.phi_count; ++j) {
        if (j % 32 == 0)
          z = std::polar(1., n * (g.phi_start_deg + j * g.phi_step_deg) * kDegree);
        targetT[j] += ft[n + l] * z;
        targetP[j] += fp[n + l] * z;
        z *= rotation;
      }
    }
    for (int j = 0; j < g.phi_count; ++j) {
      const double phi = (g.phi_start_deg + j * g.phi_step_deg) * kDegree;
      const C shift = std::polar(1., tau * std::sin(theta * kDegree)
        * (cx * std::cos(phi) + cy * std::sin(phi)));
      out.field.put(size_t(j) * g.theta_count + it,
        targetT[j] * shift, targetP[j] * shift);
    }
  }
  return out;
}
} // namespace ring_bench
