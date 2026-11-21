#include "nec_periodic_stack.h"

#include <cmath>

namespace nec_periodic {
namespace {
// One medium of the line: kz and the characteristic admittance (TE) or
// impedance (TM), whichever stays finite at kz = 0.
struct medium {
  complex_d kz;
  complex_d immittance;
};

medium medium_of(complex_d permittivity, double k, complex_d air_kz, polarization mode) {
  complex_d kz = air_kz;
  if(permittivity != 1.0) {
    // eps k^2 - kt^2 = (eps - 1) k^2 + kz^2 keeps a layer of eps = 1 exact.
    kz = std::sqrt((permittivity - 1.0) * (k * k) + air_kz * air_kz);
    if(kz.imag() > 0) kz = -kz;
  }
  return {kz, mode == polarization::te ? kz / k : kz / (permittivity * k)};
}

// Voltage reflection of a wave going up from `below` into `above`.
complex_d interface_reflection(const medium& below, const medium& above, polarization mode) {
  const complex_d sum = below.immittance + above.immittance;
  if(sum == 0.0) return 0.0;
  // TE carries admittances, TM impedances.
  return mode == polarization::te ? (below.immittance - above.immittance) / sum
                                  : (above.immittance - below.immittance) / sum;
}
}

stack_response stack_response_of(const std::vector<dielectric_layer>& layers,
  double k, complex_d kz, polarization mode) {
  const medium air = medium_of(1.0, k, kz, mode);
  const size_t count = layers.size();
  std::vector<medium> media(count);
  // Per layer: the reflection at its upper face looking up and the round trip
  // exp(-2j kz d).
  std::vector<complex_d> upper(count), round_trip(count);
  for(size_t i = 0; i < count; ++i) {
    media[i] = medium_of(layers[i].permittivity, k, kz, mode);
    round_trip[i] = std::exp(complex_d(0.0, -2.0) * media[i].kz * layers[i].thickness);
  }
  // From the top down: the Airy recursion R = (r + R' w) / (1 + r R' w).
  complex_d above_lower = 0.0;  // reflection at the lower face of the medium above, inside it
  for(size_t i = count; i-- > 0;) {
    const medium& next = i + 1 < count ? media[i + 1] : air;
    const complex_d r = interface_reflection(media[i], next, mode);
    upper[i] = (r + above_lower) / (1.0 + r * above_lower);
    above_lower = upper[i] * round_trip[i];
  }
  stack_response response;
  {
    const medium& first = count > 0 ? media[0] : air;
    const complex_d r = count > 0 ? interface_reflection(air, first, mode) : 0.0;
    response.reflection = (r + above_lower) / (1.0 + r * above_lower);
  }

  // From the bottom up: across an interface into a medium whose lower face
  // reflects R w, the up-going voltage is multiplied by (1 + r) / (1 + r R w);
  // across a layer by exp(-j kz d).
  complex_d transmission = 1.0;
  const medium* below = &air;
  for(size_t i = 0; i <= count; ++i) {
    const medium& next = i < count ? media[i] : air;
    const complex_d r = interface_reflection(*below, next, mode);
    const complex_d next_lower = i < count ? upper[i] * round_trip[i] : 0.0;
    transmission *= (1.0 + r) / (1.0 + r * next_lower);
    if(i < count) transmission *= std::exp(complex_d(0.0, -1.0) * media[i].kz * layers[i].thickness);
    below = &next;
  }
  response.transmission = transmission;

  // Net power into the stack minus the transmitted power, per |a|^2 / 2 of
  // the incident amplitude: Re[((1 + G)(1 - G)* - |T|^2) y0* / |y0|], with
  // y0* / |y0| = kz* / |kz| for TE (admittance kz / k) and kz / |kz| for TM
  // (admittance k / kz).
  if(std::abs(kz) > 0) {
    const complex_d phase = (mode == polarization::te ? std::conj(kz) : kz) / std::abs(kz);
    const complex_d g = response.reflection;
    response.absorbed =
      std::real(((1.0 + g) * std::conj(1.0 - g) - std::norm(transmission)) * phase);
  }
  return response;
}
}
