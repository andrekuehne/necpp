#pragma once
#include "nec_field_evaluator.h"
#include <algorithm>
#include <cmath>
#include <complex>
#include <limits>
#include <vector>

namespace nec_ring {
constexpr double pi = 3.141592653589793238462643383279502884;
constexpr double degree = pi / 180, tau = 2 * pi;
using C = std::complex<double>;
struct Grid { double radius_m, theta_start_deg; int theta_count; double theta_step_deg,
  phi_start_deg; int phi_count; double phi_step_deg; };
struct Input {
  size_t count; bool perfect_ground; double wavelength_m;
  const double *x, *y, *z, *cab, *sab, *salp, *half_lengths,
    *air, *aii, *bir, *bii, *cir, *cii;
};
// Geometry-only cache. Current coefficients never enter this object.
struct Geometry {
  double cx=0,cy=0,rho=0,b=0; int projection=0;
  std::vector<double> x,y;
  Geometry() = default;
  explicit Geometry(const Input& s) : x(s.count),y(s.count) {
    for(size_t i=0;i<s.count;++i) {cx+=s.x[i]/s.count;cy+=s.y[i]/s.count;}
    for(size_t i=0;i<s.count;++i) {
      x[i]=s.x[i]-cx;y[i]=s.y[i]-cy;
      rho=std::max(rho,std::hypot(x[i],y[i]));
      const double h=std::hypot(s.cab[i],s.sab[i]);
      b=std::max(b,s.half_lengths[i]*h);if(h>0)projection=1;
    }
  }
};
struct Workspace {
  std::vector<C> ft,fp,target_t,target_p;
  std::vector<double> sin_theta;
  double theta_start=0,theta_step=0;
  void angles(const Grid& g) {
    if(sin_theta.size()==size_t(g.theta_count) && theta_start==g.theta_start_deg && theta_step==g.theta_step_deg)return;
    theta_start=g.theta_start_deg;theta_step=g.theta_step_deg;sin_theta.resize(g.theta_count);
    for(int i=0;i<g.theta_count;++i)sin_theta[i]=std::abs(std::sin((theta_start+i*theta_step)*degree));
  }
};
struct Stats {
  double directions = 0, rings = 0, direct_rings = 0, bound = 0;
  // 1 nonperiodic, 2 unsupported, 3 budget, 4 no sample reduction, 5 cost.
  int reason = 0;
  void add(const Stats& other) {
    directions += other.directions; rings += other.rings;
    direct_rings += other.direct_rings; bound = std::max(bound, other.bound);
    if (other.reason) reason = other.reason;
  }
};
struct Plan { double cx = 0, cy = 0, source_norm = 0; Stats stats; int max_l=0,max_segment_extra=0; std::vector<int> samples; };
struct Field {
  std::vector<double> tr, ti, pr, pp;
  explicit Field(size_t n) : tr(n), ti(n), pr(n), pp(n) {}
  C theta(size_t j) const { return {tr[j], ti[j]}; }
  C phi(size_t j) const { return {pr[j], pp[j]}; }
};
inline int direct(const Input& s, const Grid& g, Field& f) {
  return necpp_field_evaluator_v1_evaluate(s.count, s.perfect_ground, s.wavelength_m,
    g.radius_m, g.theta_start_deg, g.theta_count, g.theta_step_deg,
    g.phi_start_deg, g.phi_count, g.phi_step_deg, 0, f.tr.size(),
    s.x,s.y,s.z,s.cab,s.sab,s.salp,s.half_lengths,s.air,s.aii,s.bir,s.bii,s.cir,s.cii,
    f.tr.data(),f.ti.data(),f.pr.data(),f.pp.data());
}
// Cauchy bound on the Jacobi-Anger tail; see docs/ring-far-field-evaluation.md.
inline double log_tail(double a, int n) {
  if (a == 0) return -INFINITY;
  if (n + 1 <= a) return INFINITY;
  double t = std::acosh((n + 1) / a);
  return std::log(2.) + a * std::sinh(t) - (n + 1) * t
    - std::log(-std::expm1(-t));
}
inline int cutoff(double a, double eps, int limit) {
  if (!std::isfinite(a) || !(eps > 0) || a >= limit) return limit;
  if (a == 0) return 0;
  int n = int(std::floor(a));
  while (n < limit && !(log_tail(a,n) <= std::log(eps))) ++n;
  return n;
}
// A scalar source evaluation contains multiple transcendental functions;
// use a conservative fixed cost estimate rather than timing-dependent choices.
inline bool worthwhile(size_t sources,int m,int outputs) {
  return m<outputs && double(sources)*(outputs-m)>double(m)*(m+double(outputs))/8;
}
inline Plan plan(const Input& s, const Grid& g, const Geometry* cached=nullptr, Workspace* workspace=nullptr) {
  Plan p; p.samples.assign(g.theta_count, g.phi_count);
  auto fallback = [&](int reason) {
    p.stats.reason = reason; p.stats.direct_rings = g.theta_count;
    p.stats.directions += double(g.theta_count) * g.phi_count; return p;
  };
  if (std::abs(g.phi_count * g.phi_step_deg - 360.) > 1e-9)
    return fallback(1);
  if (s.count == 0 || g.phi_count < 3) return fallback(4);
  Geometry local=cached?Geometry():Geometry(s);
  const Geometry& geometry=cached?*cached:local;
  p.cx=geometry.cx;p.cy=geometry.cy;
  const double rho=geometry.rho,b=geometry.b;const int projection=geometry.projection;
  // With eps <= 1e-13 these are lower bounds on every selected order.
  // Avoid scouting when even those orders cannot save work.
  const size_t sources=s.count*(s.perfect_ground?2:1);
  bool candidate=false;
  for(int t=0;t<g.theta_count && !candidate;++t) {
    const double st=std::abs(std::sin((g.theta_start_deg+t*g.theta_step_deg)*degree));
    const int n=cutoff((tau*rho+b)*st,1e-13,g.phi_count/2);
    const int64_t m=2*(int64_t(n)+projection)+1;
    candidate=m<g.phi_count && worthwhile(sources,int(m),g.phi_count);
  }
  if(!candidate)return fallback(5);
  double w=0;
  for(size_t i=0;i<s.count;++i)
    w+=2*s.half_lengths[i]*(std::hypot(s.air[i],s.aii[i])+std::hypot(s.bir[i],s.bii[i])+std::hypot(s.cir[i],s.cii[i]));
  w *= std::sqrt(4*pi*1e-7/8.854e-12)/(4*pi)*s.wavelength_m/g.radius_m
    *(s.perfect_ground?2:1);
  p.source_norm=w;
  if (!(w>0) || !std::isfinite(w) || !std::isfinite(rho)) return fallback(3);
  // Scouts are distinct requested nodes, so their peak bounds the grid peak.
  double peak=0; const int nt=std::min(9,g.theta_count), np=std::min(8,g.phi_count);
  Field scout(1);
  for (int t=0;t<nt;++t) for(int j=0;j<np;++j) {
    int ti=nt==1?0:int(int64_t(t)*(g.theta_count-1)/(nt-1));
    int pj=int(int64_t(j)*g.phi_count/np);
    Grid one={g.radius_m,g.theta_start_deg+ti*g.theta_step_deg,1,0,
      g.phi_start_deg+pj*g.phi_step_deg,1,0};
    if (direct(s,one,scout)) return fallback(3);
    peak=std::max(peak,std::hypot(std::abs(scout.theta(0)),std::abs(scout.phi(0))));
    ++p.stats.directions;
  }
  // Reject phase arguments whose roundoff scale consumes the engineering budget.
  // This is a conservative screening heuristic, not a binary64 error certificate.
  double coordinate_scale=0;
  for(size_t i=0;i<s.count;++i)coordinate_scale=std::max(coordinate_scale,
    std::abs(s.x[i])+std::abs(s.y[i])+std::abs(s.z[i])+s.half_lengths[i]);
  const double angle_scale=degree*(std::abs(g.phi_start_deg)+std::abs(g.theta_start_deg)
    +std::abs(g.theta_step_deg)*g.theta_count+std::abs(g.phi_step_deg)*g.phi_count);
  if(!(peak>0) || 32*std::numeric_limits<double>::epsilon()*(1+tau*coordinate_scale+angle_scale)*(w/peak)>1e-8)
    return fallback(3);
  const double eps=std::min(1e-13,1e-12*(peak/w)/4);
  if (!(eps>0) || !std::isfinite(peak)) return fallback(3);
  p.stats.bound=4*(w*eps);
  if(workspace)workspace->angles(g);
  for(int t=0;t<g.theta_count;++t) {
    double st=workspace?workspace->sin_theta[t]:std::abs(std::sin((g.theta_start_deg+t*g.theta_step_deg)*degree));
    int n=cutoff((tau*rho+b)*st,eps,g.phi_count/2);
    int64_t m=2*(int64_t(n)+projection)+1;
    if (m>=g.phi_count || !worthwhile(sources,int(m),g.phi_count)) { ++p.stats.direct_rings; p.stats.reason=m>=g.phi_count?4:5; }
    else { p.samples[t]=int(m); ++p.stats.rings;
      p.max_l=std::max(p.max_l,n+projection);
      p.max_segment_extra=std::max(p.max_segment_extra,n+projection-cutoff(tau*rho*st,eps,g.phi_count/2));
    }
    p.stats.directions+=p.samples[t];
  }
  if (!p.stats.rings) p.stats.bound=0;
  return p;
}
inline int ring(const Input& original, const Grid& g, int t, int m,
                double cx, double cy, Field& out, const Geometry* cached=nullptr, Workspace* workspace=nullptr) {
  Grid one={g.radius_m,g.theta_start_deg+t*g.theta_step_deg,1,0,
    g.phi_start_deg,g.phi_count,g.phi_step_deg};
  if(m>=g.phi_count) return direct(original,one,out);
  if(m<1 || m%2!=1 || !std::isfinite(cx) || !std::isfinite(cy)) return 1;
  std::vector<double> x,y;
  Input s=original;
  if(cached) {
    if(cached->x.size()!=original.count || cached->cx!=cx || cached->cy!=cy)return 1;
    s.x=cached->x.data();s.y=cached->y.data();
  } else {
    x.resize(original.count);y.resize(original.count);
    for(size_t i=0;i<original.count;++i) { x[i]=original.x[i]-cx; y[i]=original.y[i]-cy; }
    s.x=x.data();s.y=y.data();
  }
  Field sparse(m); Grid sparse_grid=one; sparse_grid.phi_start_deg=0;
  sparse_grid.phi_count=m; sparse_grid.phi_step_deg=360./m;
  if(direct(s,sparse_grid,sparse)) return 1;
  Workspace local;
  auto& scratch=workspace?*workspace:local;
  const int l=(m-1)/2;
  auto& ft=scratch.ft;auto& fp=scratch.fp;ft.resize(m);fp.resize(m);
  for(int n=-l;n<=l;++n) {
    C rot=std::polar(1.,-tau*n/m),z=1,ct=0,cp=0;
    for(int j=0;j<m;++j) {
      if(j%32==0) z=std::polar(1.,-tau*n*j/m);
      ct+=sparse.theta(j)*z; cp+=sparse.phi(j)*z; z*=rot;
    }
    ft[n+l]=ct/double(m); fp[n+l]=cp/double(m);
  }
  auto& target_t=scratch.target_t;auto& target_p=scratch.target_p;
  target_t.assign(g.phi_count,C{});target_p.assign(g.phi_count,C{});
  for(int n=-l;n<=l;++n) {
    C rot=std::polar(1.,n*g.phi_step_deg*degree),z;
    for(int j=0;j<g.phi_count;++j) {
      if(j%32==0) z=std::polar(1.,n*(g.phi_start_deg+j*g.phi_step_deg)*degree);
      target_t[j]+=ft[n+l]*z; target_p[j]+=fp[n+l]*z; z*=rot;
    }
  }
  for(int j=0;j<g.phi_count;++j) {
    double phi=(g.phi_start_deg+j*g.phi_step_deg)*degree;
    C shift=std::polar(1.,tau*std::sin(one.theta_start_deg*degree)
      *(cx*std::cos(phi)+cy*std::sin(phi)));
    C et=target_t[j]*shift,ep=target_p[j]*shift;
    out.tr[j]=et.real(); out.ti[j]=et.imag();out.pr[j]=ep.real();out.pp[j]=ep.imag();
  }
  return 0;
}
} // namespace nec_ring
