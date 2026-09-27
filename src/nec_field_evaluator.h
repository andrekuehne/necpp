#pragma once
#include <cstddef>
#include <cstdint>
struct ring_context;
extern "C" {
// Internal ring ABI: create a geometry cache, plan once, evaluate individual rings.
// Plan output has theta_count+7 doubles: cx, cy, directions, rings, direct rings,
// absolute truncation bound, fallback reason, then sparse sample counts.
ring_context* necpp_field_evaluator_ring_v1_create(size_t count,const double* x,const double* y,
  const double* cab,const double* sab,const double* half_lengths);
void necpp_field_evaluator_ring_v1_delete(ring_context* context);
int32_t necpp_field_evaluator_ring_v1_plan(ring_context* context, size_t count, int32_t perfect_ground, double wavelength_m,
  double radius_m, double theta_start_deg, int32_t theta_count, double theta_step_deg,
  double phi_start_deg, int32_t phi_count, double phi_step_deg,
  const double *x, const double *y, const double *z,
  const double *cab, const double *sab, const double *salp, const double *half_lengths,
  const double *air, const double *aii, const double *bir, const double *bii,
  const double *cir, const double *cii, double* out);
int32_t necpp_field_evaluator_ring_v1_evaluate(ring_context* context, size_t count, int32_t perfect_ground, double wavelength_m,
  double radius_m, double theta_start_deg, int32_t theta_count, double theta_step_deg,
  double phi_start_deg, int32_t phi_count, double phi_step_deg,
  const double *x, const double *y, const double *z,
  const double *cab, const double *sab, const double *salp, const double *half_lengths,
  const double *air, const double *aii, const double *bir, const double *bii,
  const double *cir, const double *cii,
  int32_t theta_index, int32_t samples, double cx, double cy,
  double* tr, double* ti, double* pr, double* pp);

int32_t necpp_field_evaluator_v1_evaluate(
  size_t segment_count,
  int32_t perfect_ground,
  double wavelength_m,
  double radius_m,
  double theta_start_deg,
  int32_t theta_count,
  double theta_step_deg,
  double phi_start_deg,
  int32_t phi_count,
  double phi_step_deg,
  size_t sample_start,
  size_t sample_count,
  const double* x,
  const double* y,
  const double* z,
  const double* cab,
  const double* sab,
  const double* salp,
  const double* half_lengths,
  const double* air,
  const double* aii,
  const double* bir,
  const double* bii,
  const double* cir,
  const double* cii,
  double* e_theta_real,
  double* e_theta_imag,
  double* e_phi_real,
  double* e_phi_imag);
}
