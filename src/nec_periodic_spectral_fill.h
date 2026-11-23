#pragma once
// The spectral Ewald sum's share of the periodic fill, evaluated per Floquet
// mode instead of per kernel sample.
//
// The fill needs the segment field (segment_field_of_kernel) of every source
// segment under periodic_green::spectral at every observation point, and over
// perfect ground that of the segment's ground image. One mode's term at
// r = observation - source point is
//
//   exp(-j kt . rho_obs) exp(+j kt . rho_src) F(dz),
//
// with its gradient from F and a second factor G (spectral_factor): the error
// functions of the mode sit in F and G, which depend on the height
// difference dz alone. So the factors of a mode are evaluated once per scan
// state, on a table in dz, and every pair reads them from it; the transverse
// phases factor into an observation and a source part. A cell whose dz takes
// few distinct values (a planar cell: 0 and the image heights) evaluates them
// at those values exactly. A cell whose table would exceed max_table_entries
// (nodes times modes) evaluates every kernel sample directly, as
// periodic_green::spectral does.
//
// The table interpolates with centred 8-point Lagrange stencils
// (nec_periodic_interpolation.h). Per scan state it compares the midpoints of
// the intervals in use with direct values and reports the largest error of
// the kernel (value and gradient), relative to the size 1 / (2 A |k|) of one
// propagating mode's term: an estimate on the scale of the kernel's own
// accuracy (kernel_error).
#include "nec_periodic_green.h"
#include "nec_periodic_interpolation.h"

#include <array>
#include <cstddef>
#include <vector>

namespace nec_periodic {
// The nine components of a segment field, in the order of NEC's exk..ezc:
// constant x, y, z, sine x, y, z, cosine x, y, z.
using segment_field_components = std::array<complex_d, 9>;

class spectral_fill {
public:
  struct geometry {
    std::vector<point> observations;
    std::vector<source_segment> sources;
    // Perfect ground: each source also has its ground image (centre and
    // direction mirrored in z = 0), whose field enters with the opposite sign.
    bool ground_image = false;
  };
  enum class route { distinct, table, direct };

  // Default bound on nodes times modes of a table (32 MiB).
  static constexpr size_t default_max_table_entries = size_t(1) << 20;

  // green: any scan state of the lattice, wavenumber and splitting the fill
  // is used with; only those enter.
  spectral_fill(const periodic_green& green, geometry cell, size_t max_table_entries = default_max_table_entries);

  route chosen_route() const { return route_; }
  // Nodes of the table (distinct dz values on the distinct route).
  size_t node_count() const { return values_.size(); }
  // Memory kept for the scan states: the kernel samples' stencils.
  size_t kept_bytes() const {
    return stencil_first_.size() * sizeof(unsigned) + stencil_weights_.size() * sizeof(double);
  }

  // One scan state: each mode's factors on the table's nodes and the
  // transverse phases, from which the fields of any range of sources are
  // formed (so that the caller bounds the memory of the fields it holds).
  class scan_evaluation {
  public:
    // The interpolation error estimate, 0 off the table route.
    double interpolation_error() const { return error_; }
    // The fields of the sources first .. last - 1 at every observation point:
    // fields[i * (last - first) + (j - first)] for observation i and source j
    // (with its ground image).
    void fields(size_t first, size_t last, std::vector<segment_field_components>& fields) const;

  private:
    friend class spectral_fill;
    template <int width>
    void accumulate(size_t first, size_t last, std::vector<segment_field_components>& fields) const;
    void direct(size_t first, size_t last, std::vector<segment_field_components>& fields) const;
    const spectral_fill* fill_ = nullptr;
    const periodic_green* green_ = nullptr;
    route route_ = route::direct;
    size_t modes_ = 0;
    std::vector<double> table_;  // F and G (real, imaginary) per node and mode
    std::vector<complex_d> observation_phase_, source_phase_;
    std::vector<double> kt_;
    double error_ = 0;
  };

  // The evaluation of the scan state of green, which must have the lattice,
  // wavenumber and splitting of construction (std::invalid_argument) and
  // outlive the evaluation. With direct, every kernel sample is evaluated
  // directly whatever the route.
  scan_evaluation begin(const periodic_green& green, bool direct = false) const;
  // The fields of every pair, fields[i * sources + j]; returns the
  // interpolation error estimate.
  double evaluate(const periodic_green& green, std::vector<segment_field_components>& fields) const;

private:
  struct source_sample {
    double x, y;
  };
  bool same_kernel(const periodic_green& green) const;
  // The dz of a kernel sample, formed as segment_field_of_kernel forms it.
  double sample_dz(size_t observation, size_t source, size_t image, size_t q) const;
  // The first node of the stencil at dz, and its weights.
  size_t stencil_of(double dz, double* weights) const;

  geometry cell_;
  double k_ = 0, splitting_ = 0, area_ = 0;
  vec2 a1_, a2_;
  std::vector<segment_quadrature> quadratures_;
  size_t samples_per_source_ = 0, images_ = 1;
  std::vector<source_sample> source_samples_;  // per source and offset (shared by the ground image)
  route route_ = route::direct;
  uniform_grid grid_;
  std::vector<double> values_;  // the dz values of the nodes
  // Stencils per sample (first node and weights), kept within a memory bound.
  std::vector<unsigned> stencil_first_;
  std::vector<double> stencil_weights_;
};
}
