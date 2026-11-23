#include "nec_periodic_spectral_fill.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <stdexcept>
#include <utility>

namespace nec_periodic {
namespace {
const complex_d j(0.0, 1.0);

// Per-sample stencils are kept up to this size; beyond it they are formed
// again at every scan state.
constexpr double stencil_cache_bytes = 32.0 * 1024 * 1024;
// The distinct dz values are looked for up to this many kernel samples.
constexpr size_t max_distinct_search = size_t(1) << 22;
// The table spacing, as a fraction of the shorter scale of the factors
// (kernel_table_spacing): about 1e-11 of the kernel at the midpoints.
constexpr double table_fraction = 0.1;

void add_field(double sign, const segment_field& result, segment_field_components& field) {
  for(size_t c = 0; c < 3; ++c) {
    field[c] += sign * result.constant[c];
    field[3 + c] += sign * result.sine[c];
    field[6 + c] += sign * result.cosine[c];
  }
}
}

spectral_fill::spectral_fill(const periodic_green& green, geometry cell, size_t max_table_entries)
  : cell_(std::move(cell)),
    k_(green.wavenumber().real()),
    splitting_(green.splitting()),
    area_(green.lattice().cell_area()),
    a1_(green.lattice().a1()),
    a2_(green.lattice().a2()) {
  images_ = cell_.ground_image ? 2 : 1;
  const size_t observations = cell_.observations.size(), sources = cell_.sources.size();
  quadratures_.reserve(sources);
  for(const source_segment& segment : cell_.sources) quadratures_.push_back(segment_quadrature_of(segment.length, k_));
  samples_per_source_ = quadratures_.empty() ? 0 : quadratures_.front().offset.size();
  source_samples_.reserve(sources * samples_per_source_);
  for(size_t s = 0; s < sources; ++s) {
    const source_segment& segment = cell_.sources[s];
    for(const double offset : quadratures_[s].offset)
      source_samples_.push_back(
        {segment.centre[0] + offset * segment.direction[0], segment.centre[1] + offset * segment.direction[1]});
  }

  // The range of dz over every kernel sample, and its distinct values.
  const size_t count = observations * sources * images_ * samples_per_source_;
  if(count == 0) {
    route_ = route::distinct;
    return;
  }
  const bool search = count <= max_distinct_search;
  std::vector<double> distinct;
  if(search) distinct.reserve(count);
  double lowest = std::numeric_limits<double>::infinity(), highest = -lowest;
  for(size_t i = 0; i < observations; ++i)
    for(size_t s = 0; s < sources; ++s)
      for(size_t image = 0; image < images_; ++image)
        for(size_t q = 0; q < samples_per_source_; ++q) {
          const double dz = sample_dz(i, s, image, q);
          lowest = std::min(lowest, dz);
          highest = std::max(highest, dz);
          if(search) distinct.push_back(dz);
        }
  grid_ = uniform_grid::covering(lowest, highest, kernel_table_spacing(k_, splitting_, table_fraction));
  const double modes = std::max(green.spectral_mode_count(), 1.0);
  if(search) {
    std::sort(distinct.begin(), distinct.end());
    distinct.erase(std::unique(distinct.begin(), distinct.end()), distinct.end());
  }

  size_t width = 1;
  if(search && distinct.size() <= grid_.nodes && double(distinct.size()) * modes <= double(max_table_entries)) {
    route_ = route::distinct;
    values_ = std::move(distinct);
  } else if(double(grid_.nodes) * modes <= double(max_table_entries)) {
    route_ = route::table;
    width = stencil_width;
    values_.resize(grid_.nodes);
    for(size_t n = 0; n < grid_.nodes; ++n) values_[n] = grid_.node(n);
  } else {
    route_ = route::direct;
    return;
  }
  if(double(count) * (sizeof(unsigned) + width * sizeof(double)) <= stencil_cache_bytes) {
    stencil_first_.resize(count);
    stencil_weights_.resize(count * width);
    size_t sample = 0;
    for(size_t i = 0; i < observations; ++i)
      for(size_t s = 0; s < sources; ++s)
        for(size_t image = 0; image < images_; ++image)
          for(size_t q = 0; q < samples_per_source_; ++q, ++sample)
            stencil_first_[sample] = unsigned(stencil_of(sample_dz(i, s, image, q), &stencil_weights_[sample * width]));
  }
}

double spectral_fill::sample_dz(size_t observation, size_t source, size_t image, size_t q) const {
  const source_segment& segment = cell_.sources[source];
  const double centre = image ? -segment.centre[2] : segment.centre[2];
  const double direction = image ? -segment.direction[2] : segment.direction[2];
  return cell_.observations[observation][2] - (centre + quadratures_[source].offset[q] * direction);
}

size_t spectral_fill::stencil_of(double dz, double* weights) const {
  if(route_ == route::table) return grid_.stencil(dz, weights);
  weights[0] = 1;
  return size_t(std::lower_bound(values_.begin(), values_.end(), dz) - values_.begin());
}

bool spectral_fill::same_kernel(const periodic_green& green) const {
  const lattice_2d& lattice = green.lattice();
  return green.splitting() == splitting_ && green.wavenumber() == complex_d(k_) && lattice.a1().x == a1_.x &&
         lattice.a1().y == a1_.y && lattice.a2().x == a2_.x && lattice.a2().y == a2_.y;
}

spectral_fill::scan_evaluation spectral_fill::begin(const periodic_green& green, bool direct) const {
  if(!same_kernel(green))
    throw std::invalid_argument("The spectral fill was prepared for another lattice, wavenumber or splitting");
  scan_evaluation evaluation;
  evaluation.fill_ = this;
  evaluation.green_ = &green;
  evaluation.route_ = direct ? route::direct : route_;
  if(evaluation.route_ == route::direct) return evaluation;

  const std::vector<floquet_mode> modes = green.spectral_modes();
  const size_t mode_count = modes.size();
  evaluation.modes_ = mode_count;
  std::vector<double>& table = evaluation.table_;
  table.resize(values_.size() * mode_count * 4);
  for(size_t n = 0; n < values_.size(); ++n)
    for(size_t m = 0; m < mode_count; ++m) {
      const spectral_factor factor = green.spectral_mode_factor(modes[m], values_[n]);
      double* entry = &table[(n * mode_count + m) * 4];
      entry[0] = factor.value.real();
      entry[1] = factor.value.imag();
      entry[2] = factor.z_derivative.real();
      entry[3] = factor.z_derivative.imag();
    }

  // The table's error at the midpoints of its intervals.
  if(route_ == route::table) {
    const std::array<double, stencil_width>& weights = uniform_grid::midpoint_weights();
    std::vector<double> value_error(mode_count, 0.0), derivative_error(mode_count, 0.0);
    constexpr size_t middle = stencil_width / 2 - 1;
    for(size_t n = middle; n + stencil_width - middle <= values_.size(); ++n) {
      const size_t first = n - middle;
      const double dz = grid_.node(n) + grid_.spacing / 2;
      for(size_t m = 0; m < mode_count; ++m) {
        const spectral_factor exact = green.spectral_mode_factor(modes[m], dz);
        complex_d value = 0, derivative = 0;
        for(int a = 0; a < stencil_width; ++a) {
          const double* entry = &table[((first + size_t(a)) * mode_count + m) * 4];
          value += weights[size_t(a)] * complex_d(entry[0], entry[1]);
          derivative += weights[size_t(a)] * complex_d(entry[2], entry[3]);
        }
        value_error[m] = std::max(value_error[m], std::abs(value - exact.value));
        derivative_error[m] = std::max(derivative_error[m], std::abs(derivative - exact.z_derivative));
      }
    }
    // Relative to one propagating mode's term 1 / (2 A |k|), and its
    // gradient |k| times that.
    const double reference = 1 / (2 * area_ * std::abs(k_));
    double value_sum = 0, gradient_sum = 0;
    for(size_t m = 0; m < mode_count; ++m) {
      const double transverse = std::hypot(modes[m].kt.x, modes[m].kt.y);
      value_sum += value_error[m];
      gradient_sum += std::max(transverse * value_error[m], derivative_error[m]);
    }
    evaluation.error_ = std::max(value_sum / reference, gradient_sum / (std::abs(k_) * reference));
  }

  // Transverse phases: exp(-j kt . rho) at the observation points and
  // exp(+j kt . rho) at the source samples.
  const size_t observations = cell_.observations.size();
  evaluation.observation_phase_.resize(observations * mode_count);
  evaluation.source_phase_.resize(source_samples_.size() * mode_count);
  evaluation.kt_.resize(mode_count * 2);
  for(size_t m = 0; m < mode_count; ++m) {
    evaluation.kt_[2 * m] = modes[m].kt.x;
    evaluation.kt_[2 * m + 1] = modes[m].kt.y;
  }
  for(size_t i = 0; i < observations; ++i)
    for(size_t m = 0; m < mode_count; ++m)
      evaluation.observation_phase_[i * mode_count + m] =
        std::exp(-j * (modes[m].kt.x * cell_.observations[i][0] + modes[m].kt.y * cell_.observations[i][1]));
  for(size_t s = 0; s < source_samples_.size(); ++s)
    for(size_t m = 0; m < mode_count; ++m)
      evaluation.source_phase_[s * mode_count + m] =
        std::exp(j * (modes[m].kt.x * source_samples_[s].x + modes[m].kt.y * source_samples_[s].y));
  return evaluation;
}

double spectral_fill::evaluate(const periodic_green& green, std::vector<segment_field_components>& fields) const {
  const scan_evaluation evaluation = begin(green);
  evaluation.fields(0, cell_.sources.size(), fields);
  return evaluation.interpolation_error();
}

void spectral_fill::scan_evaluation::fields(size_t first, size_t last,
                                            std::vector<segment_field_components>& fields) const {
  fields.assign(fill_->cell_.observations.size() * (last - first), segment_field_components{});
  if(route_ == route::table)
    accumulate<stencil_width>(first, last, fields);
  else if(route_ == route::distinct)
    accumulate<1>(first, last, fields);
  else
    direct(first, last, fields);
}

template <int width>
void spectral_fill::scan_evaluation::accumulate(size_t first, size_t last,
                                                std::vector<segment_field_components>& fields) const {
  const spectral_fill& fill = *fill_;
  const size_t observations = fill.cell_.observations.size(), sources = fill.cell_.sources.size();
  const size_t images = fill.images_, per_source = fill.samples_per_source_, modes = modes_;
  const bool cached = !fill.stencil_first_.empty();
  std::vector<double> factors(modes * 4);
  std::vector<green_value> samples(per_source);
  double weights[width];
  for(size_t i = 0; i < observations; ++i) {
    const complex_d* observation = &observation_phase_[i * modes];
    for(size_t s = first; s < last; ++s) {
      segment_field_components& field = fields[i * (last - first) + (s - first)];
      for(size_t image = 0; image < images; ++image) {
        for(size_t q = 0; q < per_source; ++q) {
          size_t node;
          const double* w;
          if(cached) {
            const size_t sample = ((i * sources + s) * images + image) * per_source + q;
            node = fill.stencil_first_[sample];
            w = &fill.stencil_weights_[sample * width];
          } else {
            node = fill.stencil_of(fill.sample_dz(i, s, image, q), weights);
            w = weights;
          }
          // F and G of every mode at this dz.
          const double* row = &table_[node * modes * 4];
          for(size_t t = 0; t < modes * 4; ++t) factors[t] = w[0] * row[t];
          for(int a = 1; a < width; ++a) {
            row = &table_[(node + size_t(a)) * modes * 4];
            for(size_t t = 0; t < modes * 4; ++t) factors[t] += w[a] * row[t];
          }
          const complex_d* source = &source_phase_[(s * per_source + q) * modes];
          double value_re = 0, value_im = 0, x_re = 0, x_im = 0, y_re = 0, y_im = 0, z_re = 0, z_im = 0;
          for(size_t m = 0; m < modes; ++m) {
            const complex_d phase = observation[m] * source[m];
            const double p_re = phase.real(), p_im = phase.imag();
            const double* f = &factors[m * 4];
            const double v_re = p_re * f[0] - p_im * f[1], v_im = p_re * f[1] + p_im * f[0];
            value_re += v_re;
            value_im += v_im;
            x_re += kt_[2 * m] * v_re;
            x_im += kt_[2 * m] * v_im;
            y_re += kt_[2 * m + 1] * v_re;
            y_im += kt_[2 * m + 1] * v_im;
            z_re += p_re * f[2] - p_im * f[3];
            z_im += p_re * f[3] + p_im * f[2];
          }
          // Gradient (-j sum kt_x V, -j sum kt_y V, sum W).
          samples[q] = {{value_re, value_im}, {complex_d(x_im, -x_re), complex_d(y_im, -y_re), complex_d(z_re, z_im)}};
        }
        const source_segment& segment = fill.cell_.sources[s];
        const point direction = {segment.direction[0], segment.direction[1],
                                 image ? -segment.direction[2] : segment.direction[2]};
        add_field(image ? -1.0 : 1.0, segment_field_of_samples(fill.quadratures_[s], direction, samples.data(), fill.k_),
                  field);
      }
    }
  }
}

void spectral_fill::scan_evaluation::direct(size_t first, size_t last,
                                            std::vector<segment_field_components>& fields) const {
  const spectral_fill& fill = *fill_;
  const size_t observations = fill.cell_.observations.size();
  std::vector<green_value> samples(fill.samples_per_source_);
  for(size_t i = 0; i < observations; ++i) {
    const point& observation = fill.cell_.observations[i];
    for(size_t s = first; s < last; ++s) {
      segment_field_components& field = fields[i * (last - first) + (s - first)];
      for(size_t image = 0; image < fill.images_; ++image) {
        source_segment segment = fill.cell_.sources[s];
        if(image) {
          segment.centre[2] = -segment.centre[2];
          segment.direction[2] = -segment.direction[2];
        }
        const point& u = segment.direction;
        for(size_t q = 0; q < fill.samples_per_source_; ++q) {
          const double offset = fill.quadratures_[s].offset[q];
          samples[q] = green_->spectral({observation[0] - (segment.centre[0] + offset * u[0]),
                                         observation[1] - (segment.centre[1] + offset * u[1]),
                                         observation[2] - (segment.centre[2] + offset * u[2])});
        }
        add_field(image ? -1.0 : 1.0, segment_field_of_samples(fill.quadratures_[s], u, samples.data(), fill.k_),
                  field);
      }
    }
  }
}
}
