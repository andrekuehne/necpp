#include "nec_ring_field.h"
struct ring_context {
  nec_ring::Geometry geometry;
  nec_ring::Workspace workspace;
  explicit ring_context(const nec_ring::Input& s) : geometry(s) {}
};
extern "C" {
ring_context* necpp_field_evaluator_ring_v1_create(size_t count,const double* x,const double* y,
  const double* cab,const double* sab,const double* half_lengths) {
  if(!count || !x || !y || !cab || !sab || !half_lengths)return nullptr;
  nec_ring::Input s={count,false,1,x,y,nullptr,cab,sab,nullptr,half_lengths,nullptr,nullptr,nullptr,nullptr,nullptr,nullptr};
  return new ring_context(s);
}
void necpp_field_evaluator_ring_v1_delete(ring_context* context) { delete context; }
uint32_t necpp_field_evaluator_ring_v1_version() { return 1; }
int32_t necpp_field_evaluator_ring_v1_plan(ring_context* context, size_t count, int32_t perfect_ground, double wavelength_m,
  double radius_m, double theta_start_deg, int32_t theta_count, double theta_step_deg,
  double phi_start_deg, int32_t phi_count, double phi_step_deg,
  const double *x, const double *y, const double *z,
  const double *cab, const double *sab, const double *salp, const double *half_lengths,
  const double *air, const double *aii, const double *bir, const double *bii,
  const double *cir, const double *cii, double* out) {

  if(count==0 || theta_count<=0 || phi_count<=0 || !std::isfinite(radius_m) || radius_m<=0
    || !std::isfinite(wavelength_m) || wavelength_m<=0
    || !std::isfinite(theta_start_deg) || !std::isfinite(theta_step_deg)
    || !std::isfinite(phi_start_deg) || !std::isfinite(phi_step_deg)) return 1;
  const double* arrays[]={x,y,z,cab,sab,salp,half_lengths,air,aii,bir,bii,cir,cii};
  for(auto a:arrays) { if(!a) return 1; for(size_t i=0;i<count;++i) if(!std::isfinite(a[i])) return 1; }
  nec_ring::Input s={count,perfect_ground!=0,wavelength_m,x,y,z,cab,sab,salp,half_lengths,
    air,aii,bir,bii,cir,cii};
  nec_ring::Grid g={radius_m,theta_start_deg,theta_count,theta_step_deg,
    phi_start_deg,phi_count,phi_step_deg};

  if(!out) return 1;
  if(!context || context->geometry.x.size()!=count)return 1;
  auto p=nec_ring::plan(s,g,&context->geometry,&context->workspace);
  out[0]=p.cx;out[1]=p.cy;out[2]=p.stats.directions;out[3]=p.stats.rings;
  out[4]=p.stats.direct_rings;out[5]=p.stats.bound;out[6]=p.stats.reason;
  for(int i=0;i<theta_count;++i) out[7+i]=p.samples[i];
  return 0;
}
int32_t necpp_field_evaluator_ring_v1_evaluate(ring_context* context, size_t count, int32_t perfect_ground, double wavelength_m,
  double radius_m, double theta_start_deg, int32_t theta_count, double theta_step_deg,
  double phi_start_deg, int32_t phi_count, double phi_step_deg,
  const double *x, const double *y, const double *z,
  const double *cab, const double *sab, const double *salp, const double *half_lengths,
  const double *air, const double *aii, const double *bir, const double *bii,
  const double *cir, const double *cii,
  int32_t theta_index, int32_t samples, double cx, double cy,
  double* tr, double* ti, double* pr, double* pp) {

  if(count==0 || theta_count<=0 || phi_count<=0 || !std::isfinite(radius_m) || radius_m<=0
    || !std::isfinite(wavelength_m) || wavelength_m<=0
    || !std::isfinite(theta_start_deg) || !std::isfinite(theta_step_deg)
    || !std::isfinite(phi_start_deg) || !std::isfinite(phi_step_deg)) return 1;
  const double* arrays[]={x,y,z,cab,sab,salp,half_lengths,air,aii,bir,bii,cir,cii};
  for(auto a:arrays) { if(!a) return 1; for(size_t i=0;i<count;++i) if(!std::isfinite(a[i])) return 1; }
  nec_ring::Input s={count,perfect_ground!=0,wavelength_m,x,y,z,cab,sab,salp,half_lengths,
    air,aii,bir,bii,cir,cii};
  nec_ring::Grid g={radius_m,theta_start_deg,theta_count,theta_step_deg,
    phi_start_deg,phi_count,phi_step_deg};

  if(theta_index<0 || theta_index>=theta_count || !tr || !ti || !pr || !pp) return 1;
  if(!context || context->geometry.x.size()!=count)return 1;
  nec_ring::Field f(phi_count);
  int status=nec_ring::ring(s,g,theta_index,samples,cx,cy,f,&context->geometry,&context->workspace);
  if(status) return status;
  std::copy(f.tr.begin(),f.tr.end(),tr);std::copy(f.ti.begin(),f.ti.end(),ti);
  std::copy(f.pr.begin(),f.pr.end(),pr);std::copy(f.pp.begin(),f.pp.end(),pp);
  return 0;
}
}
