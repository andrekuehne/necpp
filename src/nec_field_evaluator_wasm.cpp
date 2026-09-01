/* WP3 dedicated ordinary-wire far-field evaluator. No NEC model or matrix. */
#include <cmath>
#include <cstddef>
#include <cstdint>

namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr double kDegree = kPi / 180.0;
constexpr double kTwoPi = 2.0 * kPi;

void scale_component(
  double real, double imag, double wavelength, double radius,
  double& output_real, double& output_imag)
{
  double magnitude = std::sqrt(real * real + imag * imag);
  double phase_deg = std::atan2(imag, real) / kDegree;
  magnitude *= wavelength;
  if (radius >= 1.0e-20) {
    magnitude /= radius;
    const double range_wavelengths = radius / wavelength;
    phase_deg += -360.0 *
      (range_wavelengths - std::floor(range_wavelengths));
  }
  const double phase = phase_deg * kDegree;
  output_real = magnitude * std::cos(phase);
  output_imag = magnitude * std::sin(phase);
}

bool finite_array(const double* values, size_t count)
{
  if (values == nullptr)
    return false;
  for (size_t index = 0; index < count; ++index) {
    if (!std::isfinite(values[index]))
      return false;
  }
  return true;
}

} // namespace

extern "C" {

uint32_t necpp_field_evaluator_v1_version()
{
  return 1;
}

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
  double* e_phi_imag)
{
  const size_t total_samples =
    static_cast<size_t>(theta_count) * static_cast<size_t>(phi_count);
  const double* inputs[] = {
    x, y, z, cab, sab, salp, half_lengths,
    air, aii, bir, bii, cir, cii,
  };
  if (segment_count == 0 || theta_count <= 0 || phi_count <= 0 ||
      sample_count == 0 || sample_start > total_samples ||
      sample_count > total_samples - sample_start ||
      !std::isfinite(wavelength_m) || wavelength_m <= 0.0 ||
      !std::isfinite(radius_m) || radius_m <= 0.0 ||
      e_theta_real == nullptr || e_theta_imag == nullptr ||
      e_phi_real == nullptr || e_phi_imag == nullptr)
    return 1;
  for (const double* values : inputs) {
    if (!finite_array(values, segment_count))
      return 1;
  }

  const double impedance = std::sqrt((4.0 * kPi * 1.0e-7) / 8.854e-12);
  const double field_constant = -impedance / (4.0 * kPi);
  for (size_t local = 0; local < sample_count; ++local) {
    const size_t sample = sample_start + local;
    const size_t theta_index = sample % static_cast<size_t>(theta_count);
    const size_t phi_index = sample / static_cast<size_t>(theta_count);
    const double theta_deg = theta_start_deg +
      static_cast<double>(theta_index) * theta_step_deg;
    if (perfect_ground != 0 && theta_deg > 90.01) {
      e_theta_real[local] = e_theta_imag[local] = 0.0;
      e_phi_real[local] = e_phi_imag[local] = 0.0;
      continue;
    }
    const double theta = theta_deg * kDegree;
    const double phi = (phi_start_deg +
      static_cast<double>(phi_index) * phi_step_deg) * kDegree;
    const double sin_theta = std::sin(theta);
    const double cos_theta = std::cos(theta);
    const double sin_phi = std::sin(phi);
    const double cos_phi = std::cos(phi);
    const double phx = -sin_phi;
    const double phy = cos_phi;
    const double thx = cos_theta * phy;
    const double thy = -cos_theta * phx;
    const double thz = -sin_theta;
    const double rox = sin_theta * cos_phi;
    const double roy = sin_theta * sin_phi;

    double first_xr = 0.0, first_xi = 0.0;
    double first_yr = 0.0, first_yi = 0.0;
    double first_zr = 0.0, first_zi = 0.0;
    double final_xr = 0.0, final_xi = 0.0;
    double final_yr = 0.0, final_yi = 0.0;
    double final_zr = 0.0, final_zi = 0.0;
    const int images = perfect_ground != 0 ? 2 : 1;
    for (int image = 0; image < images; ++image) {
      const double roz = image == 0 ? cos_theta : -cos_theta;
      double xr = 0.0, xi = 0.0;
      double yr = 0.0, yi = 0.0;
      double zr = 0.0, zi = 0.0;
      for (size_t index = 0; index < segment_count; ++index) {
        const double omega = -(rox * cab[index] + roy * sab[index] +
          roz * salp[index]);
        const double el = half_lengths[index];
        const double sill = omega * el;
        const double top = el + sill;
        const double bot = el - sill;
        const double a = std::fabs(omega) >= 1.0e-7
          ? 2.0 * std::sin(sill) / omega
          : (2.0 - omega * omega * el * el / 3.0) * el;
        const double too = std::fabs(top) >= 1.0e-7
          ? std::sin(top) / top : 1.0 - top * top / 6.0;
        const double boo = std::fabs(bot) >= 1.0e-7
          ? std::sin(bot) / bot : 1.0 - bot * bot / 6.0;
        const double b = el * (boo - too);
        const double c = el * (boo + too);
        const double rr = a * air[index] + b * bii[index] + c * cir[index];
        const double ri = a * aii[index] - b * bir[index] + c * cii[index];
        const double argument = kTwoPi *
          (x[index] * rox + y[index] * roy + z[index] * roz);
        const double sine = std::sin(argument);
        const double cosine = std::cos(argument);
        const double exa_real = cosine * rr - sine * ri;
        const double exa_imag = cosine * ri + sine * rr;
        xr += exa_real * cab[index]; xi += exa_imag * cab[index];
        yr += exa_real * sab[index]; yi += exa_imag * sab[index];
        zr += exa_real * salp[index]; zi += exa_imag * salp[index];
      }
      if (image == 0) {
        first_xr = final_xr = xr; first_xi = final_xi = xi;
        first_yr = final_yr = yr; first_yi = final_yi = yi;
        first_zr = final_zr = zr; first_zi = final_zi = zi;
      } else {
        final_xr = first_xr - xr; final_xi = first_xi - xi;
        final_yr = first_yr - yr; final_yi = first_yi - yi;
        final_zr = first_zr + zr; final_zi = first_zi + zi;
      }
    }
    const double theta_raw_real =
      final_xr * thx + final_yr * thy + final_zr * thz;
    const double theta_raw_imag =
      final_xi * thx + final_yi * thy + final_zi * thz;
    const double phi_raw_real = final_xr * phx + final_yr * phy;
    const double phi_raw_imag = final_xi * phx + final_yi * phy;
    scale_component(
      -theta_raw_imag * field_constant,
      theta_raw_real * field_constant,
      wavelength_m, radius_m,
      e_theta_real[local], e_theta_imag[local]);
    scale_component(
      -phi_raw_imag * field_constant,
      phi_raw_real * field_constant,
      wavelength_m, radius_m,
      e_phi_real[local], e_phi_imag[local]);
  }
  return 0;
}

} // extern "C"
