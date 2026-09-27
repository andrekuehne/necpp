#pragma once
// Bench adapter for the production kernel; keep the original evidence immutable.
#include "nec_stateful_model.h"
#include "nec_ring_field.h"
#include <stdexcept>
namespace ring_bench {
using C = nec_ring::C;
struct Field : nec_ring::Field {
  std::vector<double>& pi = pp;
  explicit Field(size_t n) : nec_ring::Field(n) {}
  Field(Field&& other) : nec_ring::Field(std::move(other)) {}
};
inline nec_ring::Input input(const nec_far_field_snapshot& s) {
  return {s.segment_count(),s.perfect_ground,s.wavelength_m,s.x.data(),s.y.data(),s.z.data(),
    s.cab.data(),s.sab.data(),s.salp.data(),s.segment_half_lengths.data(),s.air.data(),s.aii.data(),
    s.bir.data(),s.bii.data(),s.cir.data(),s.cii.data()};
}
inline nec_ring::Grid grid(const nec_far_field_grid& g) {
  return {g.radius_m,g.theta_start_deg,g.theta_count,g.theta_step_deg,g.phi_start_deg,g.phi_count,g.phi_step_deg};
}
inline Field direct(const nec_far_field_snapshot& s,const nec_far_field_grid& g) {
  Field f(size_t(g.theta_count)*g.phi_count);
  if(nec_ring::direct(input(s),grid(g),f)) throw std::runtime_error("direct kernel failed");
  return f;
}
using nec_ring::log_tail;
inline int cutoff(double a,double eps) { return nec_ring::cutoff(a,eps,1000000); }
struct Result {
  Field field;
  uint64_t directions=0;
  int fallback=0,maxL=0,maxSegmentExtra=0;
  double bound=0,sourceNorm=0;
  std::vector<int> samples;
  explicit Result(size_t n):field(n){}
};
inline Result evaluate(const nec_far_field_snapshot& s,const nec_far_field_grid& g) {
  auto view=input(s);auto rg=grid(g);nec_ring::Geometry geometry(view);nec_ring::Workspace workspace;
  auto p=nec_ring::plan(view,rg,&geometry,&workspace);
  Result result(size_t(g.theta_count)*g.phi_count);
  result.directions=p.stats.directions;result.fallback=p.stats.direct_rings;
  result.maxSegmentExtra=p.max_segment_extra;result.maxL=p.max_l;
  result.sourceNorm=p.source_norm;result.bound=p.stats.bound;result.samples=p.samples;
  for(int t=0;t<g.theta_count;++t) {
    nec_ring::Field row(g.phi_count);
    if(nec_ring::ring(view,rg,t,p.samples[t],p.cx,p.cy,row,&geometry,&workspace)) throw std::runtime_error("ring kernel failed");
    if(p.samples[t]<g.phi_count) result.maxL=std::max(result.maxL,(p.samples[t]-1)/2);
    for(int j=0;j<g.phi_count;++j) {
      size_t i=size_t(j)*g.theta_count+t;
      result.field.tr[i]=row.tr[j];result.field.ti[i]=row.ti[j];
      result.field.pr[i]=row.pr[j];result.field.pp[i]=row.pp[j];
    }
  }
  return result;
}
}
