// Native seam for the transmission-line model of a layered stack (issue #32).
// Reference values are textbook closed forms in the angle of incidence
// (Fresnel, Brewster, the half-wave window, the thin-sheet susceptance used
// for wide-angle impedance matching) and conservation laws (lossless stacks,
// reciprocity), not the recursion under test.
#include <catch2/catch_test_macros.hpp>
#include "nec_periodic_stack.h"

#include <cmath>
#include <vector>

using nec_periodic::complex_d;
using nec_periodic::dielectric_layer;
using nec_periodic::polarization;
using nec_periodic::stack_response;
using nec_periodic::stack_response_of;

namespace {
constexpr double pi = 3.141592653589793238462643383279502884;
constexpr double k = 2 * pi;  // lengths in wavelengths
const complex_d j(0.0, 1.0);

// The air kz of a mode with sin(theta) = s, s > 1 evanescent (Im kz < 0).
complex_d air_kz(double s) {
  return s <= 1 ? complex_d(k * std::sqrt(1 - s * s), 0.0) : complex_d(0.0, -k * std::sqrt(s * s - 1));
}

stack_response response(const std::vector<dielectric_layer>& layers, double s, polarization mode) {
  return stack_response_of(layers, k, air_kz(s), mode);
}

const polarization both[] = {polarization::te, polarization::tm};
}

TEST_CASE("A layer of relative permittivity 1 is transparent", "[periodic_stack]") {
  const std::vector<dielectric_layer> air{{0.3, 1.0}};
  for (const polarization mode : both)
    for (const double s : {0.0, 0.5, 1.0, 1.7}) {
      const stack_response r = response(air, s, mode);
      CHECK(r.reflection == complex_d(0.0, 0.0));
      CHECK(std::abs(r.transmission - std::exp(-j * air_kz(s) * 0.3)) < 1e-14);
      CHECK(std::abs(r.absorbed) < 1e-14);
    }
}

TEST_CASE("A thick lossy layer reflects like the Fresnel half-space", "[periodic_stack]") {
  // Twenty wavelengths of eps = 4 - 1j: the upper face is invisible.
  const complex_d eps(4.0, -1.0);
  const std::vector<dielectric_layer> half_space{{20.0, eps}};
  for (const double s : {0.0, std::sin(35 * pi / 180), 0.95}) {
    const double c = std::sqrt(1 - s * s);
    complex_d root = std::sqrt(eps - s * s);
    // s-polarization (TE) reflects the tangential field as r_s; for p (TM)
    // the textbook r_p is the reflection of the magnetic field, so the
    // tangential electric field reflects as -r_p.
    const complex_d r_s = (c - root) / (c + root);
    const complex_d r_p = (eps * c - root) / (eps * c + root);
    CHECK(std::abs(response(half_space, s, polarization::te).reflection - r_s) < 1e-12);
    CHECK(std::abs(response(half_space, s, polarization::tm).reflection + r_p) < 1e-12);
  }
}

TEST_CASE("A lossless slab does not reflect TM at the Brewster angle", "[periodic_stack]") {
  // tan(theta_B) = sqrt(eps); both faces are reflectionless, for any thickness.
  const double eps = 3.0;
  const double s = std::sin(std::atan(std::sqrt(eps)));
  for (const double thickness : {0.07, 0.31, 1.3}) {
    const std::vector<dielectric_layer> slab{{thickness, eps}};
    const stack_response tm = response(slab, s, polarization::tm);
    CHECK(std::abs(tm.reflection) < 1e-13);
    CHECK(std::abs(std::abs(tm.transmission) - 1) < 1e-13);
    CHECK(std::abs(response(slab, s, polarization::te).reflection) > 0.1);
  }
}

TEST_CASE("A half-wave slab is transparent at normal incidence", "[periodic_stack]") {
  // Half a wavelength in the dielectric: 1 / (2 sqrt(4)) = 0.25 wavelengths.
  // The Airy sum t12 t21 exp(-j pi) / (1 - r^2 exp(-2j pi)) with
  // t12 t21 = 1 - r^2 gives the transmission -1 exactly: the wave leaves the
  // upper face half a wavelength (in the slab) behind.
  const std::vector<dielectric_layer> window{{0.25, 4.0}};
  for (const polarization mode : both) {
    const stack_response r = response(window, 0.0, mode);
    CHECK(std::abs(r.reflection) < 1e-13);
    CHECK(std::abs(r.transmission + 1.0) < 1e-13);
  }
}

TEST_CASE("At the Brewster angle TM crosses a slab with only its own phase", "[periodic_stack]") {
  // Neither face reflects, so the transmission is exp(-j kz1 d) with
  // kz1 = k sqrt(eps - sin^2(theta)).
  const double eps = 3.0, thickness = 0.31;
  const double s = std::sin(std::atan(std::sqrt(eps)));
  const complex_d expected = std::exp(-j * k * std::sqrt(eps - s * s) * thickness);
  CHECK(std::abs(response({{thickness, eps}}, s, polarization::tm).transmission - expected) < 1e-13);
}

TEST_CASE("A thin sheet acts as the shunt susceptance (eps_r - 1) k t", "[periodic_stack]") {
  // The thin-sheet model of wide-angle impedance matching: at broadside a
  // sheet of thickness t is a shunt susceptance B = (eps_r - 1) 2 pi t /
  // lambda across the line, so Gamma = -j B / (2 + j B). Its error is second
  // order in the thickness, so the relative error shrinks with t.
  const double eps = 6.0;
  double previous = 1;
  for (const double thickness : {1e-2, 1e-3, 1e-4}) {
    const double b = (eps - 1) * k * thickness;
    const complex_d sheet = -j * b / (2.0 + j * b);
    const stack_response r = response({{thickness, eps}}, 0.0, polarization::te);
    const double error = std::abs(r.reflection - sheet) / std::abs(sheet);
    CHECK(error < 3 * k * thickness);
    CHECK(error < previous / 5);
    previous = error;
  }
}

TEST_CASE("A lossless stack absorbs nothing, also from an evanescent mode", "[periodic_stack]") {
  const std::vector<dielectric_layer> stack{{0.05, 4.0}, {0.12, 2.2}, {0.02, 9.8}};
  for (const polarization mode : both) {
    for (const double s : {0.0, 0.4, 0.9}) {
      const stack_response r = response(stack, s, mode);
      CHECK(std::abs(std::norm(r.reflection) + std::norm(r.transmission) - 1) < 1e-13);
      CHECK(std::abs(r.absorbed) < 1e-13);
    }
    for (const double s : {1.05, 1.6, 4.0}) {
      CHECK(std::abs(response(stack, s, mode).absorbed) < 1e-12);
    }
  }
}

TEST_CASE("A lossy stack absorbs from propagating and evanescent modes", "[periodic_stack]") {
  const std::vector<dielectric_layer> stack{{0.05, complex_d(4.0, -0.08)}, {0.12, complex_d(2.2, -0.01)}};
  for (const polarization mode : both) {
    for (const double s : {0.0, 0.6}) {
      const stack_response r = response(stack, s, mode);
      CHECK(r.absorbed > 1e-3);
      CHECK(std::abs(r.absorbed - (1 - std::norm(r.reflection) - std::norm(r.transmission))) < 1e-13);
    }
    for (const double s : {1.2, 2.5})
      CHECK(response(stack, s, mode).absorbed > 1e-6);
  }
}

TEST_CASE("Transmission is the same through the reversed stack", "[periodic_stack]") {
  // Reciprocity of a two-port between equal air lines: S21 = S12.
  const std::vector<dielectric_layer> stack{{0.05, complex_d(4.0, -0.3)}, {0.12, 2.2}, {0.02, 9.8}};
  const std::vector<dielectric_layer> reversed(stack.rbegin(), stack.rend());
  for (const polarization mode : both)
    for (const double s : {0.0, 0.7, 1.4}) {
      const complex_d forward = response(stack, s, mode).transmission;
      CHECK(std::abs(forward - response(reversed, s, mode).transmission) < 1e-13 * std::abs(forward));
    }
}

TEST_CASE("At cut-off in air the stack response is finite", "[periodic_stack]") {
  // kz = 0 exactly: TE sees a short (reflection -1), TM an open (+1), as at
  // grazing incidence on any dielectric; nothing is transmitted or absorbed.
  const std::vector<dielectric_layer> stack{{0.05, complex_d(4.0, -0.08)}};
  const stack_response te = stack_response_of(stack, k, 0.0, polarization::te);
  const stack_response tm = stack_response_of(stack, k, 0.0, polarization::tm);
  CHECK(te.reflection == complex_d(-1.0, 0.0));
  CHECK(tm.reflection == complex_d(1.0, 0.0));
  CHECK(te.transmission == complex_d(0.0, 0.0));
  CHECK(tm.transmission == complex_d(0.0, 0.0));
  CHECK(te.absorbed == 0.0);
  CHECK(tm.absorbed == 0.0);
}
