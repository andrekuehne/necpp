/*
  Copyright (C) 2026  NEC2++ contributors

  This program is free software; you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation; either version 2 of the License, or
  (at your option) any later version.
*/
#include "nec_far_field.h"

#include "c_geometry.h"
#include "electromag.h"
#include "math_util.h"
#include "nec_ground.h"

#include <array>
#include <cmath>
#include <utility>

namespace {

#if defined(NECPP_FAR_FIELD_ACCUMULATORS)

struct wire_field_contribution {
  nec_complex x;
  nec_complex y;
  nec_complex z;
};

void evaluate_phase_sine_cosine(
  nec_float value,
  nec_float& sine,
  nec_float& cosine)
{
  sine = std::sin(value);
  cosine = std::cos(value);
}

template <size_t Count>
class wire_field_accumulators {
public:
  template <size_t Lane>
  void add(const wire_field_contribution& value)
  {
    static_assert(Lane < Count, "far-field accumulator lane is out of range");
#if defined(NECPP_FAR_FIELD_SPLIT_ACCUMULATORS)
    m_x_real[Lane] += value.x.real();
    m_x_imag[Lane] += value.x.imag();
    m_y_real[Lane] += value.y.real();
    m_y_imag[Lane] += value.y.imag();
    m_z_real[Lane] += value.z.real();
    m_z_imag[Lane] += value.z.imag();
#else
    m_x[Lane] += value.x;
    m_y[Lane] += value.y;
    m_z[Lane] += value.z;
#endif
  }

  void add_tail(size_t lane, const wire_field_contribution& value)
  {
#if defined(NECPP_FAR_FIELD_SPLIT_ACCUMULATORS)
    m_x_real[lane] += value.x.real();
    m_x_imag[lane] += value.x.imag();
    m_y_real[lane] += value.y.real();
    m_y_imag[lane] += value.y.imag();
    m_z_real[lane] += value.z.real();
    m_z_imag[lane] += value.z.imag();
#else
    m_x[lane] += value.x;
    m_y[lane] += value.y;
    m_z[lane] += value.z;
#endif
  }

  wire_field_contribution reduce() const
  {
#if defined(NECPP_FAR_FIELD_SPLIT_ACCUMULATORS)
    return {
      nec_complex(reduce_component(m_x_real), reduce_component(m_x_imag)),
      nec_complex(reduce_component(m_y_real), reduce_component(m_y_imag)),
      nec_complex(reduce_component(m_z_real), reduce_component(m_z_imag)),
    };
#else
    return {
      reduce_component(m_x),
      reduce_component(m_y),
      reduce_component(m_z),
    };
#endif
  }

private:
  template <typename Component>
  static Component reduce_component(
    const std::array<Component, Count>& values)
  {
#if defined(NECPP_FAR_FIELD_BALANCED_REDUCTION)
    if constexpr (Count == 4) {
      return (values[0] + values[1]) + (values[2] + values[3]);
    } else if constexpr (Count == 8) {
      return ((values[0] + values[1]) + (values[2] + values[3])) +
        ((values[4] + values[5]) + (values[6] + values[7]));
    }
#endif
    Component result = values[0];
    for (size_t index = 1; index < Count; ++index) {
      result += values[index];
    }
    return result;
  }

#if defined(NECPP_FAR_FIELD_SPLIT_ACCUMULATORS)
  std::array<nec_float, Count> m_x_real{};
  std::array<nec_float, Count> m_x_imag{};
  std::array<nec_float, Count> m_y_real{};
  std::array<nec_float, Count> m_y_imag{};
  std::array<nec_float, Count> m_z_real{};
  std::array<nec_float, Count> m_z_imag{};
#else
  std::array<nec_complex, Count> m_x{};
  std::array<nec_complex, Count> m_y{};
  std::array<nec_complex, Count> m_z{};
#endif
};

wire_field_contribution evaluate_ordinary_wire_segment(
  const nec_far_field_evaluation_input& input,
  const c_geometry& geometry,
  int64_t index,
  nec_float rox,
  nec_float roy,
  nec_float roz)
{
  const nec_float omega = -(rox * geometry.cab[index] +
    roy * geometry.sab[index] + roz * geometry.salp[index]);
  const nec_float el = input.segment_half_lengths == nullptr
    ? pi() * geometry.segment_length[index]
    : (*input.segment_half_lengths)[index];
  const nec_float sill = omega * el;
  const nec_float top = el + sill;
  const nec_float bot = el - sill;

  const nec_float a = std::fabs(omega) >= 1.0e-7
    ? 2.0 * std::sin(sill) / omega
    : (2.0 - omega * omega * el * el / 3.0) * el;
  const nec_float too = std::fabs(top) >= 1.0e-7
    ? std::sin(top) / top
    : 1.0 - top * top / 6.0;
  const nec_float boo = std::fabs(bot) >= 1.0e-7
    ? std::sin(bot) / bot
    : 1.0 - bot * bot / 6.0;
  const nec_float b = el * (boo - too);
  const nec_float c = el * (boo + too);
  const nec_float rr = a * input.air[index] + b * input.bii[index] +
    c * input.cir[index];
  const nec_float ri = a * input.aii[index] - b * input.bir[index] +
    c * input.cii[index];
  const nec_float arg = two_pi() * (geometry.x[index] * rox +
    geometry.y[index] * roy + geometry.z[index] * roz);
  nec_float sin_arg;
  nec_float cos_arg;
  evaluate_phase_sine_cosine(arg, sin_arg, cos_arg);
  const nec_complex exa = nec_complex(cos_arg, sin_arg) *
    nec_complex(rr, ri);
  return {
    exa * geometry.cab[index],
    exa * geometry.sab[index],
    exa * geometry.salp[index],
  };
}

template <size_t Count, size_t... Lanes>
void accumulate_ordinary_wire_group(
  wire_field_accumulators<Count>& accumulators,
  const nec_far_field_evaluation_input& input,
  const c_geometry& geometry,
  int64_t base,
  nec_float rox,
  nec_float roy,
  nec_float roz,
  std::index_sequence<Lanes...>)
{
  (accumulators.template add<Lanes>(evaluate_ordinary_wire_segment(
    input, geometry, base + static_cast<int64_t>(Lanes), rox, roy, roz)), ...);
}

wire_field_contribution evaluate_ordinary_wire_fields(
  const nec_far_field_evaluation_input& input,
  const c_geometry& geometry,
  nec_float rox,
  nec_float roy,
  nec_float roz)
{
  constexpr size_t count = NECPP_FAR_FIELD_ACCUMULATORS;
  static_assert(count == 1 || count == 2 || count == 4 || count == 8,
    "unsupported far-field accumulator count");
  wire_field_accumulators<count> accumulators;
  int64_t index = 0;
  for (; index + static_cast<int64_t>(count) <= geometry.n_segments;
       index += static_cast<int64_t>(count)) {
    accumulate_ordinary_wire_group(
      accumulators, input, geometry, index, rox, roy, roz,
      std::make_index_sequence<count>{});
  }
  for (size_t lane = 0; index < geometry.n_segments; ++index, ++lane) {
    accumulators.add_tail(lane, evaluate_ordinary_wire_segment(
      input, geometry, index, rox, roy, roz));
  }
  return accumulators.reduce();
}

#endif

void evaluate_patch_fields(
  const c_geometry& geometry,
  const complex_array& currents,
  nec_float rox,
  nec_float roy,
  nec_float roz,
  nec_complex& ex,
  nec_complex& ey,
  nec_complex& ez)
{
  static const nec_complex constant(0.0, em::impedance() / 2.0);
  ex = cplx_00();
  ey = cplx_00();
  ez = cplx_00();
  const int64_t offset = geometry.n_segments;
  for (int64_t index = 0; index < geometry.m; ++index) {
    const nec_float argument = two_pi() * (
      rox * geometry.px[index] +
      roy * geometry.py[index] +
      roz * geometry.pz[index]);
    const nec_complex coefficient =
      cplx_exp(argument) * geometry.pbi[index];
    const int64_t current = offset + 3 * index;
    ex += currents[current] * coefficient;
    ey += currents[current + 1] * coefficient;
    ez += currents[current + 2] * coefficient;
  }
  const nec_complex radial = rox * ex + roy * ey + roz * ez;
  ex = constant * (radial * rox - ex);
  ey = constant * (radial * roy - ey);
  ez = constant * (radial * roz - ez);
}

nec_complex scale_component(
  const nec_complex& value,
  nec_float wavelength,
  nec_float radius_m)
{
  // Keep the historical RP magnitude/phase operation order.  Apart from
  // compatibility, this preserves frozen scalar field hashes.
  nec_float magnitude = std::sqrt(std::norm(value));
  nec_float phase_deg = arg_degrees(value);
  magnitude *= wavelength;
  if (radius_m >= 1.0e-20) {
    magnitude *= 1.0 / radius_m;
    nec_float range_wavelengths = radius_m / wavelength;
    phase_deg += -360.0 * (
      range_wavelengths - std::floor(range_wavelengths));
  }
  return deg_polar(magnitude, phase_deg);
}

} // namespace

nec_far_field_sample nec_evaluate_far_field_sample(
  const nec_far_field_evaluation_input& input,
  nec_float theta,
  nec_float phi)
{
  return nec_evaluate_far_field_sample(input, {
    std::sin(theta),
    std::cos(theta),
    std::tan(theta),
    std::sin(phi),
    std::cos(phi),
  });
}

nec_far_field_sample nec_evaluate_far_field_sample(
  const nec_far_field_evaluation_input& input,
  const nec_far_field_direction& direction)
{
  static const nec_complex constant(
    0.0, -em::impedance() / four_pi());
  const c_geometry& geometry = input.geometry;
  const nec_ground& ground = input.ground;

  int k;
  bool include_patches;
  nec_float phx, phy, roz, rozs, thx, thy, thz, rox, roy;
  nec_float tthet = 0.0, darg = 0.0, omega, el, sill, top, bot, a;
  nec_float too, boo, b, c, d, rr, ri, arg, dr;
  nec_complex cix, ciy, ciz, exa, ccx, ccy, ccz, cdp;
  nec_complex zrsin, rrv, rrh, rrv1, rrh1, rrv2, rrh2;
  nec_complex tix, tiy, tiz, ex, ey, ez;

  phx = -direction.sin_phi;
  phy = direction.cos_phi;
  roz = direction.cos_theta;
  rozs = roz;
  thx = roz * phy;
  thy = -roz * phx;
  thz = -direction.sin_theta;
  rox = -thz * phy;
  roy = thz * phx;

  include_patches = false;
  if (geometry.n_segments != 0) {
    for (k = 0; k < ground.ksymp; ++k) {
      if (k != 0) {
        if (ground.type_perfect()) {
          rrv = -cplx_10();
          rrh = -cplx_10();
        } else {
          zrsin = std::sqrt(1.0 - ground.get_zrati_sqr() * thz * thz);
          rrv = -(roz - ground.zrati * zrsin) /
            (roz + ground.zrati * zrsin);
          rrh = (ground.zrati * roz - zrsin) /
            (ground.zrati * roz + zrsin);
        }

        if (input.ifar > 1) {
          rrv1 = rrv;
          rrh1 = rrh;
          tthet = direction.tan_theta;
          if (input.ifar != 4) {
            const nec_complex zrati2 = ground.get_zrati2(input.wavelength);
            zrsin = std::sqrt(1.0 - zrati2 * zrati2 * thz * thz);
            rrv2 = -(roz - zrati2 * zrsin) / (roz + zrati2 * zrsin);
            rrh2 = (zrati2 * roz - zrsin) / (zrati2 * roz + zrsin);
            darg = -two_pi() * 2.0 *
              ground.get_ch(input.wavelength) * roz;
          }
        }

        roz = -roz;
        ccx = cix;
        ccy = ciy;
        ccz = ciz;
      }

      cix = cplx_00();
      ciy = cplx_00();
      ciz = cplx_00();

#if defined(NECPP_FAR_FIELD_ACCUMULATORS)
      if (input.ifar < 2) {
        const wire_field_contribution accumulated =
          evaluate_ordinary_wire_fields(input, geometry, rox, roy, roz);
        cix = accumulated.x;
        ciy = accumulated.y;
        ciz = accumulated.z;
      } else
#endif
      for (int64_t i = 0; i < geometry.n_segments; ++i) {
        omega = -(rox * geometry.cab[i] + roy * geometry.sab[i] +
          roz * geometry.salp[i]);
        el = input.segment_half_lengths == nullptr
          ? pi() * geometry.segment_length[i]
          : (*input.segment_half_lengths)[i];
        sill = omega * el;
        top = el + sill;
        bot = el - sill;

        if (std::fabs(omega) >= 1.0e-7)
          a = 2.0 * std::sin(sill) / omega;
        else
          a = (2.0 - omega * omega * el * el / 3.0) * el;

        if (std::fabs(top) >= 1.0e-7)
          too = std::sin(top) / top;
        else
          too = 1.0 - top * top / 6.0;
        if (std::fabs(bot) >= 1.0e-7)
          boo = std::sin(bot) / bot;
        else
          boo = 1.0 - bot * bot / 6.0;

        b = el * (boo - too);
        c = el * (boo + too);
        rr = a * input.air[i] + b * input.bii[i] + c * input.cir[i];
        ri = a * input.aii[i] - b * input.bir[i] + c * input.cii[i];
        arg = two_pi() * (geometry.x[i] * rox + geometry.y[i] * roy +
          geometry.z[i] * roz);

        if ((k != 1) || (input.ifar < 2)) {
          exa = nec_complex(std::cos(arg), std::sin(arg)) *
            nec_complex(rr, ri);
          cix += exa * geometry.cab[i];
          ciy += exa * geometry.sab[i];
          ciz += exa * geometry.salp[i];
          continue;
        }

        dr = geometry.z[i] * tthet;
        d = dr * phy + geometry.x[i];
        if (input.ifar == 2) {
          if ((ground.get_cl(input.wavelength) - d) > 0.0) {
            rrv = rrv1;
            rrh = rrh1;
          } else {
            rrv = rrv2;
            rrh = rrh2;
            arg += darg;
          }
        } else {
          d = std::sqrt(d * d +
            (geometry.y[i] - dr * phx) *
            (geometry.y[i] - dr * phx));
          if (input.ifar == 3) {
            if ((ground.get_cl(input.wavelength) - d) > 0.0) {
              rrv = rrv1;
              rrh = rrh1;
            } else {
              rrv = rrv2;
              rrh = rrh2;
              arg += darg;
            }
          } else if ((ground.get_radial_wire_length_wavelengths() - d) >=
                     0.0) {
            d += ground.t2;
            nec_complex zscreen = ground.m_t1 * d * std::log(d / ground.t2);
            zscreen = (zscreen * ground.zrati) /
              (em::impedance() * ground.zrati + zscreen);
            zrsin = std::sqrt(1.0 - zscreen * zscreen * thz * thz);
            rrv = (roz + zscreen * zrsin) / (-roz + zscreen * zrsin);
            rrh = (zscreen * roz + zrsin) / (zscreen * roz - zrsin);
          } else if (input.ifar == 4) {
            rrv = rrv1;
            rrh = rrh1;
          } else {
            if (input.ifar == 5)
              d = dr * phy + geometry.x[i];
            if ((ground.get_cl(input.wavelength) - d) > 0.0) {
              rrv = rrv1;
              rrh = rrh1;
            } else {
              rrv = rrv2;
              rrh = rrh2;
              arg += darg;
            }
          }
        }

        exa = nec_complex(std::cos(arg), std::sin(arg)) *
          nec_complex(rr, ri);
        tix = exa * geometry.cab[i];
        tiy = exa * geometry.sab[i];
        tiz = exa * geometry.salp[i];
        cdp = (tix * phx + tiy * phy) * (rrh - rrv);
        cix += tix * rrv + cdp * phx;
        ciy += tiy * rrv + cdp * phy;
        ciz -= tiz * rrv;
      }

      if (k == 0)
        continue;
      if (input.ifar < 2) {
        cdp = (cix * phx + ciy * phy) * (rrh - rrv);
        cix = ccx + cix * rrv + cdp * phx;
        ciy = ccy + ciy * rrv + cdp * phy;
        ciz = ccz - ciz * rrv;
      } else {
        cix += ccx;
        ciy += ccy;
        ciz += ccz;
      }
    }

    if (geometry.m > 0) {
      include_patches = true;
    } else {
      return {
        (cix * thx + ciy * thy + ciz * thz) * constant,
        (cix * phx + ciy * phy) * constant,
      };
    }
  }

  if (!include_patches) {
    cix = cplx_00();
    ciy = cplx_00();
    ciz = cplx_00();
  }

  roz = rozs;
  evaluate_patch_fields(
    geometry, input.current_vector, rox, roy, roz, ex, ey, ez);
  if (ground.present()) {
    nec_complex image_x, image_y, image_z;
    evaluate_patch_fields(
      geometry, input.current_vector, rox, roy, -roz,
      image_x, image_y, image_z);
    if (ground.type_perfect()) {
      image_x = -image_x;
      image_y = -image_y;
      image_z = -image_z;
    } else {
      rrv = std::sqrt(1.0 - ground.get_zrati_sqr() * thz * thz);
      rrh = ground.zrati * roz;
      rrh = (rrh - rrv) / (rrh + rrv);
      rrv = ground.zrati * rrv;
      rrv = -(roz - rrv) / (roz + rrv);
      const nec_complex projected =
        (image_x * phx + image_y * phy) * (rrh - rrv);
      image_x = image_x * rrv + projected * phx;
      image_y = image_y * rrv + projected * phy;
      image_z *= rrv;
    }
    ex += image_x;
    ey += image_y;
    ez -= image_z;
  }

  ex += cix * constant;
  ey += ciy * constant;
  ez += ciz * constant;
  return {
    ex * thx + ey * thy + ez * thz,
    ex * phx + ey * phy,
  };
}

nec_far_field_sample nec_scale_far_field_sample(
  const nec_far_field_sample& sample,
  nec_float wavelength,
  nec_float radius_m)
{
  return {
    scale_component(sample.e_theta, wavelength, radius_m),
    scale_component(sample.e_phi, wavelength, radius_m),
  };
}
