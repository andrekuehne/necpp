/*
  Conductivity (LD 5) load regression tests for the stateful model.

  These pin the behaviour that downstream consumers rely on when they compute
  conductor loss themselves from exported segment currents:

  - LD 5 applies NEC-2 ZINT per segment, using that segment's own radius, to
    every selected segment (feed segments included).
  - structure_loss_w is the segment-centre rule
    sum 0.5 * Re(Z'_i) * L_i * |I(0)_i|^2 over physical segments only.
  - prepare() at a new frequency recomputes the internal impedance.
  - Out-of-range segment targets are rejected by add_load.
  - Results agree with the original FORTRAN NEC-2 (nec2dx) on the same decks.
*/
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include "nec_exception.h"
#include "nec_stateful_model.h"

#include <cmath>
#include <complex>
#include <string>
#include <vector>

namespace {

constexpr nec_float k_copper = 5.8e7;
constexpr nec_float k_dipole_half_length_m = 0.07045;
constexpr nec_float k_radius_m = 2.998e-4;
// NEC free-space wavelength at 1000 MHz (c0 = 299,795,637.69 m/s).
constexpr nec_float k_wavelength_1000_m = 0.299795637693;

// ZINT's x > 110 branch: Re of j sqrt(60/(sigma lambda)) (0.70710678 - j 0.70710678)
// / (a/lambda), per metre. The truncated constant makes this 1.68e-9 below
// sqrt(30/(sigma lambda))/a.
nec_float skin_limit_r_per_metre(nec_float sigma, nec_float radius_m,
                                 nec_float wavelength_m)
{
  return std::sqrt(60.0 / (sigma * wavelength_m)) * 0.70710678 / radius_m;
}

nec_load_definition conductivity_load(int tag, nec_float sigma,
                                      int first = 0, int last = 0)
{
  return {nec_load_kind::conductivity, tag, first, last, sigma, 0.0, 0.0};
}

void build_dipole(nec_stateful_model& model, int segments = 21)
{
  model.add_wire({1, segments, 0.0, 0.0, -k_dipole_half_length_m,
                  0.0, 0.0, k_dipole_half_length_m, k_radius_m});
  model.complete_geometry();
  model.define_ports({{1, (segments + 1) / 2}});
}

void build_monopole(nec_stateful_model& model)
{
  model.add_wire({1, 11, 0.0, 0.0, 0.0,
                  0.0, 0.0, k_dipole_half_length_m, k_radius_m});
  model.complete_geometry(nec_model_ground_connection::interpolate);
  model.define_ports({{1, 1}});
}

nec_complex port_impedance(nec_stateful_model& model)
{
  const nec_impedance_result& result = model.compute_impedance_matrix();
  return result.impedance.at(0, 0);
}

// Sum of 0.5 * L_i * |I(0)_i|^2 over the exported physical segments, with
// I(0) = A + C, the centre current NEC uses for its power budget.
nec_float half_l_centre_current_squared(const nec_current_distribution& d,
                                        int only_tag = 0)
{
  nec_float sum = 0.0;
  for (size_t i = 0; i < d.segment_count(); ++i) {
    if (only_tag != 0 && d.segments[i].tag != only_tag)
      continue;
    const nec_complex centre = d.a_at(0, i) + d.c_at(0, i);
    sum += 0.5 * d.lengths_m[i] * std::norm(centre);
  }
  return sum;
}

// Measured per-metre resistance of a uniformly loaded single-radius wire.
nec_float measured_r_per_metre(nec_stateful_model& model)
{
  const nec_port_solution& solution =
    model.solve_port_currents({nec_complex(1.0, 0.0)});
  const nec_float loss = solution.power_budget.structure_loss_w;
  const nec_current_distribution d =
    model.get_current_distribution(nec_current_mode_kind::latest_solution);
  return loss / half_l_centre_current_squared(d);
}

void require_close(nec_complex actual, nec_complex expected, nec_float rel)
{
  CAPTURE(actual, expected);
  REQUIRE(std::abs(actual - expected) <= rel * std::abs(expected));
}

} // namespace

TEST_CASE("LD5 per-metre resistance follows the NEC-2 ZINT branches",
          "[conductivity]")
{
  struct row {
    nec_float sigma;
    nec_float expected_ohm_per_m;
    nec_float rel_tol;
  };
  // x = a * sqrt(omega mu0 sigma) with NEC's omega mu0 = 2 pi 120 pi / lambda.
  // x > 110: ZINT uses the pure skin limit sqrt(30/(sigma lambda))/a. That
  //          omits the +1/(sqrt(2) x) term of the Bessel form (0.35 % low
  //          at x = 203), so the exact Bessel value is not the reference.
  // x <= 110: polynomial/asymptotic Kelvin forms, within 2e-7 of the exact
  //          J0/J1 value (mpmath, 40 digits) listed here.
  const std::vector<row> rows = {
    {5.8e7, 4.38129350226955, 1e-8},   // x = 202.95, copper
    {1.5e7, 8.67463434860497, 1e-6},   // x = 103.21, brass
    {1.4e6, 28.8432406473203, 1e-6},   // x = 31.53, stainless steel
    {1.0e3, 3550.77958750132, 1e-6},   // x = 0.843
  };
  for (const row& r : rows) {
    CAPTURE(r.sigma);
    nec_stateful_model model;
    build_dipole(model);
    model.add_load(conductivity_load(1, r.sigma));
    model.prepare(1000.0);
    const nec_current_distribution d =
      model.get_current_distribution(nec_current_mode_kind::unit_current);
    REQUIRE(d.wavelength_m == Catch::Approx(k_wavelength_1000_m).epsilon(1e-11));
    const nec_float measured = measured_r_per_metre(model);
    REQUIRE(measured == Catch::Approx(r.expected_ohm_per_m).epsilon(r.rel_tol));
    if (r.sigma == k_copper) {
      REQUIRE(measured == Catch::Approx(
        skin_limit_r_per_metre(r.sigma, k_radius_m, d.wavelength_m)).epsilon(1e-13));
    }
  }
}

TEST_CASE("LD5 uses each segment's own radius and loads feed segments",
          "[conductivity]")
{
  const nec_float lambda = k_wavelength_1000_m;
  nec_stateful_model model;
  model.add_wire({1, 7, 0.0, 0.0, -0.235 * lambda, 0.0, 0.0, -0.02 * lambda, 0.002 * lambda});
  model.add_wire({2, 1, 0.0, 0.0, -0.02 * lambda, 0.0, 0.0, 0.02 * lambda, 0.0006 * lambda});
  model.add_wire({3, 7, 0.0, 0.0, 0.02 * lambda, 0.0, 0.0, 0.235 * lambda, 0.001 * lambda});
  model.complete_geometry();
  model.define_ports({{2, 1}});

  // All three radii are in the x > 110 branch for copper at 1 GHz
  // (x = 406, 122, 203).
  auto r_per_metre = [&](nec_float radius_m) {
    return skin_limit_r_per_metre(k_copper, radius_m, lambda);
  };

  SECTION("only the feed segment") {
    model.add_load(conductivity_load(2, k_copper));
    model.prepare(1000.0);
    const nec_float loss = model.solve_port_currents({nec_complex(1.0, 0.0)})
      .power_budget.structure_loss_w;
    const nec_current_distribution d =
      model.get_current_distribution(nec_current_mode_kind::latest_solution);
    REQUIRE(loss > 0.0);
    REQUIRE(loss == Catch::Approx(
      r_per_metre(0.0006 * lambda) * half_l_centre_current_squared(d, 2))
      .epsilon(1e-12));
  }

  SECTION("every wire, three radii") {
    for (int tag = 1; tag <= 3; ++tag)
      model.add_load(conductivity_load(tag, k_copper));
    model.prepare(1000.0);
    const nec_float loss = model.solve_port_currents({nec_complex(1.0, 0.0)})
      .power_budget.structure_loss_w;
    const nec_current_distribution d =
      model.get_current_distribution(nec_current_mode_kind::latest_solution);
    const nec_float expected =
      r_per_metre(0.002 * lambda) * half_l_centre_current_squared(d, 1) +
      r_per_metre(0.0006 * lambda) * half_l_centre_current_squared(d, 2) +
      r_per_metre(0.001 * lambda) * half_l_centre_current_squared(d, 3);
    REQUIRE(loss == Catch::Approx(expected).epsilon(1e-12));
  }
}

TEST_CASE("prepare at a new frequency recomputes LD5 internal impedance",
          "[conductivity][cache]")
{
  nec_stateful_model reused;
  build_dipole(reused);
  reused.add_load(conductivity_load(1, k_copper));
  reused.prepare(900.0);
  const nec_complex z900 = port_impedance(reused);
  reused.prepare(1100.0);
  const nec_complex z1100_reused = port_impedance(reused);
  const nec_float loss1100_reused =
    reused.solve_port_currents({nec_complex(1.0, 0.0)}).power_budget.structure_loss_w;
  reused.prepare(900.0);
  const nec_complex z900_again = port_impedance(reused);

  nec_stateful_model fresh;
  build_dipole(fresh);
  fresh.add_load(conductivity_load(1, k_copper));
  fresh.prepare(1100.0);
  const nec_complex z1100_fresh = port_impedance(fresh);
  const nec_float loss1100_fresh =
    fresh.solve_port_currents({nec_complex(1.0, 0.0)}).power_budget.structure_loss_w;

  nec_stateful_model pec;
  build_dipole(pec);
  pec.prepare(1100.0);
  const nec_complex z1100_pec = port_impedance(pec);

  REQUIRE(z1100_reused == z1100_fresh);
  REQUIRE(loss1100_reused == loss1100_fresh);
  REQUIRE(z900_again == z900);
  // Guard against a vacuous pass: copper visibly moves Re Z at 1100 MHz.
  REQUIRE(z1100_fresh.real() - z1100_pec.real() > 0.3);
}

TEST_CASE("perfect-ground structure loss counts physical segments only",
          "[conductivity]")
{
  nec_stateful_model model;
  build_monopole(model);
  model.add_load(conductivity_load(1, k_copper));
  model.set_ground({nec_ground_kind::perfect, 0.0, 0.0});
  model.prepare(1000.0);
  const nec_float loss = model.solve_port_currents({nec_complex(1.0, 0.0)})
    .power_budget.structure_loss_w;
  const nec_current_distribution d =
    model.get_current_distribution(nec_current_mode_kind::latest_solution);
  REQUIRE(d.segment_count() == 11);
  const nec_float r_per_metre =
    skin_limit_r_per_metre(k_copper, k_radius_m, d.wavelength_m);
  REQUIRE(loss == Catch::Approx(r_per_metre * half_l_centre_current_squared(d))
    .epsilon(1e-12));
}

TEST_CASE("conductivity loads agree with FORTRAN NEC-2 decks",
          "[conductivity][reference]")
{
  // Reference: testharness/FORTRAN/nec2dx.f built with gfortran
  // (-std=legacy -O0 -fno-automatic -finit-local-zero) and CVEL set to
  // 299.79563769321626 so both engines use the same wavelength. Decks:
  //   GW 1 21 0 0 -0.07045 0 0 0.07045 0.0002998 / GE 0 / LD 5 1 0 0 <sigma>
  //   FR 0 2 0 0 1000 100 / EX 0 1 11 0 1 0 / XQ
  // and the monopole GW 1 11 0 0 0 0 0 0.07045 0.0002998 / GE 1 / GN 1 /
  //   ... / EX 0 1 1 0 1 0. FORTRAN prints 6 significant digits for Z and 5
  //   for STRUCTURE LOSS (watts with a 1 V source).
  struct row {
    const char* name;
    nec_float sigma;
    bool monopole;
    nec_float f_mhz;
    nec_complex z;
    nec_float loss_w;
  };
  const std::vector<row> rows = {
    {"copper dipole", 5.8e7, false, 1000.0, {7.00946e+01, -7.99689e+00}, 3.2336e-05},
    {"copper dipole", 5.8e7, false, 1100.0, {9.56520e+01, 8.05099e+01}, 1.2257e-05},
    {"stainless dipole", 1.4e6, false, 1000.0, {7.20581e+01, -6.43996e+00}, 2.0287e-04},
    {"stainless dipole", 1.4e6, false, 1100.0, {9.80647e+01, 8.22555e+01}, 7.7112e-05},
    {"sigma 1e3 dipole", 1.0e3, false, 1000.0, {3.21389e+02, -5.35592e+01}, 1.1979e-03},
    {"sigma 1e3 dipole", 1.0e3, false, 1100.0, {3.72580e+02, 9.50813e+00}, 1.0198e-03},
    {"copper monopole", 5.8e7, true, 1000.0, {3.52834e+01, -3.66555e+00}, 6.4372e-05},
    {"copper monopole", 5.8e7, true, 1100.0, {4.69929e+01, 4.06593e+01}, 2.4374e-05},
  };
  for (const row& r : rows) {
    CAPTURE(r.name, r.f_mhz);
    nec_stateful_model model;
    if (r.monopole) {
      build_monopole(model);
      model.set_ground({nec_ground_kind::perfect, 0.0, 0.0});
    } else {
      build_dipole(model);
    }
    model.add_load(conductivity_load(1, r.sigma));
    model.prepare(r.f_mhz);
    require_close(port_impedance(model), r.z, 2e-5);
    const nec_float loss = model.solve_port_voltages_detailed({nec_complex(1.0, 0.0)})
      .power_budget.structure_loss_w;
    REQUIRE(loss == Catch::Approx(r.loss_w).epsilon(1e-4));
  }
}

TEST_CASE("add_load rejects segment targets outside the tag",
          "[conductivity][validation]")
{
  auto message_of = [](const nec_load_definition& load) {
    nec_stateful_model model;
    build_dipole(model);
    try {
      model.add_load(load);
    } catch (const nec_exception& error) {
      return error.get_message();
    }
    return std::string();
  };

  REQUIRE(message_of(conductivity_load(1, k_copper)).empty());
  REQUIRE(message_of(conductivity_load(1, k_copper, 1, 21)).empty());
  REQUIRE(message_of(conductivity_load(1, k_copper, 21, 0)).empty());
  REQUIRE(message_of(conductivity_load(1, k_copper, 1, 22))
          .find("OUT OF RANGE FOR THE TAG") != std::string::npos);
  REQUIRE(message_of(conductivity_load(1, k_copper, 22, 0))
          .find("OUT OF RANGE FOR THE TAG") != std::string::npos);
  REQUIRE(message_of(conductivity_load(7, k_copper))
          .find("NO SEGMENT HAS AN ITAG OF") != std::string::npos);
  REQUIRE(message_of(conductivity_load(0, k_copper, 1, 22))
          .find("ABSOLUTE SEGMENT TARGET IS OUT OF RANGE") != std::string::npos);

  // A rejected load leaves the model configurable and unloaded.
  nec_stateful_model model;
  build_dipole(model);
  REQUIRE_THROWS_AS(model.add_load(conductivity_load(1, k_copper, 1, 22)),
                    nec_exception);
  model.prepare(1000.0);
  REQUIRE(model.solve_port_currents({nec_complex(1.0, 0.0)})
          .power_budget.structure_loss_w == 0.0);
}
