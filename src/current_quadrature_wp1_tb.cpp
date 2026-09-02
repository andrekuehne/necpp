#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include "c_geometry.h"
#include "current_quadrature_fixtures.h"
#include "electromag.h"
#include "math_util.h"
#include "nec_current_distribution.h"
#include "nec_exception.h"
#include "nec_stateful_model.h"

#include <cmath>
#include <complex>
#include <vector>

using current_quadrature_fixtures::kArmSegments;
using current_quadrature_fixtures::kDipoleSegments;
using current_quadrature_fixtures::kFrequencyMHz;
using current_quadrature_fixtures::kRadiusM;
using current_quadrature_fixtures::bent_wires;
using current_quadrature_fixtures::build_stateful;
using current_quadrature_fixtures::complete_native;
using current_quadrature_fixtures::connected_turnstile_wires;
using current_quadrature_fixtures::dipole_wires;
using current_quadrature_fixtures::insulated_turnstile_wires;
using current_quadrature_fixtures::monopole_wires;

namespace {

constexpr nec_float kRelativeL2UnitCurrent = 1.0e-7;
constexpr nec_float kRelativeL2SamePath = 1.0e-12;
constexpr nec_float kRelativeL2StraightFeedCurrent = 1.0e-4;
constexpr nec_float kRelativeL2JunctionFeedCurrent = 1.0e-3;
constexpr nec_float kXiSamples[] = { -1.0, -0.5, 0.0, 0.5, 1.0 };

bool finite_complex(nec_complex value)
{
  return std::isfinite(value.real()) && std::isfinite(value.imag());
}

nec_float relative_error(nec_complex first, nec_complex second)
{
  REQUIRE(finite_complex(first));
  REQUIRE(finite_complex(second));
  const nec_float difference = std::abs(first - second);
  const nec_float scale = std::max(
    { nec_float(1.0), std::abs(first), std::abs(second) });
  return difference / scale;
}

size_t public_segment_index(
  const nec_current_distribution& distribution, int tag, int segment)
{
  for (size_t index = 0; index < distribution.segments.size(); ++index) {
    if (distribution.segments[index].tag == tag &&
        distribution.segments[index].segment == segment)
      return index;
  }
  FAIL("public segment identity was not found");
  return 0;
}

void require_public_wire_order(
  const nec_current_distribution& distribution,
  const std::vector<nec_wire_definition>& wires)
{
  size_t index = 0;
  for (const nec_wire_definition& item : wires) {
    for (int segment = 1; segment <= item.segments; ++segment) {
      REQUIRE(index < distribution.segments.size());
      REQUIRE(distribution.segments[index].tag == item.tag);
      REQUIRE(distribution.segments[index].segment == segment);
      ++index;
    }
  }
  REQUIRE(index == distribution.segments.size());
}

void require_reconstruction(
  const nec_current_distribution& distribution)
{
  REQUIRE(distribution.schema_version == 1);
  REQUIRE(distribution.mode_count >= 1);
  REQUIRE(distribution.wavelength_m > 0.0);
  const nec_float k_m = two_pi() / distribution.wavelength_m;
  nec_float difference_squared = 0.0;
  nec_float metres_squared = 0.0;
  nec_float wavelength_squared = 0.0;
  for (size_t mode = 0; mode < distribution.mode_count; ++mode) {
    for (size_t segment = 0; segment < distribution.segment_count(); ++segment) {
      const nec_complex a = distribution.a_at(mode, segment);
      const nec_complex b = distribution.b_at(mode, segment);
      const nec_complex c = distribution.c_at(mode, segment);
      REQUIRE(relative_error(a + c, nec_evaluate_segment_current(
        a, b, c, k_m, 0.0)) < kRelativeL2SamePath);
      const nec_float length = distribution.lengths_m[segment];
      for (nec_float xi : kXiSamples) {
        const nec_float s_m = xi * length / 2.0;
        const nec_complex metres = nec_evaluate_segment_current(
          a, b, c, k_m, s_m);
        const nec_complex equivalent =
          (a + c) + b * std::sin(k_m * s_m) +
          c * (std::cos(k_m * s_m) - 1.0);
        REQUIRE(relative_error(metres, equivalent) < kRelativeL2SamePath);
        const nec_float s_wavelength = s_m / distribution.wavelength_m;
        const nec_complex wavelength = nec_evaluate_segment_current(
          a, b, c, two_pi(), s_wavelength);
        difference_squared += std::norm(metres - wavelength);
        metres_squared += std::norm(metres);
        wavelength_squared += std::norm(wavelength);
      }
    }
  }
  const nec_float scale = std::max(
    { nec_float(1.0), std::sqrt(metres_squared), std::sqrt(wavelength_squared) });
  REQUIRE(std::sqrt(difference_squared) / scale < kRelativeL2SamePath);
}

void require_finite_planes(const nec_current_distribution& distribution)
{
  const auto require_finite = [](const std::vector<nec_float>& values) {
    REQUIRE_FALSE(values.empty());
    for (nec_float value : values)
      REQUIRE(std::isfinite(value));
  };
  require_finite(distribution.a_real);
  require_finite(distribution.a_imag);
  require_finite(distribution.b_real);
  require_finite(distribution.b_imag);
  require_finite(distribution.c_real);
  require_finite(distribution.c_imag);
}

nec_complex centre_current(
  const nec_current_distribution& distribution,
  size_t mode,
  size_t segment)
{
  return distribution.a_at(mode, segment) + distribution.c_at(mode, segment);
}

nec_float coefficient_plane_error(
  const nec_current_distribution& left,
  size_t left_mode,
  const nec_current_distribution& right,
  size_t right_mode)
{
  REQUIRE(left.segment_count() == right.segment_count());
  nec_float difference_squared = 0.0;
  nec_float left_squared = 0.0;
  nec_float right_squared = 0.0;
  for (size_t segment = 0; segment < left.segment_count(); ++segment) {
    const nec_complex values[6] = {
      left.a_at(left_mode, segment), right.a_at(right_mode, segment),
      left.b_at(left_mode, segment), right.b_at(right_mode, segment),
      left.c_at(left_mode, segment), right.c_at(right_mode, segment),
    };
    for (size_t pair = 0; pair < 3; ++pair) {
      const nec_complex first = values[2 * pair];
      const nec_complex second = values[2 * pair + 1];
      REQUIRE(finite_complex(first));
      REQUIRE(finite_complex(second));
      difference_squared += std::norm(first - second);
      left_squared += std::norm(first);
      right_squared += std::norm(second);
    }
  }
  return std::sqrt(difference_squared) /
    std::max({ nec_float(1.0), std::sqrt(left_squared), std::sqrt(right_squared) });
}

void require_unit_mode_matches_latest(
  nec_stateful_model& model,
  const nec_current_distribution& unit,
  size_t mode)
{
  std::vector<nec_complex> currents(
    unit.mode_count, nec_complex(0.0, 0.0));
  currents[mode] = nec_complex(1.0, 0.0);
  const nec_port_solution solved = model.solve_port_currents(currents);
  REQUIRE(relative_error(solved.currents[mode], nec_complex(1.0, 0.0))
    < kRelativeL2UnitCurrent);
  for (size_t other = 0; other < solved.currents.size(); ++other) {
    if (other == mode)
      continue;
    REQUIRE(relative_error(solved.currents[other], nec_complex(0.0, 0.0))
      < kRelativeL2UnitCurrent);
  }
  const nec_current_distribution latest =
    model.get_current_distribution(nec_current_mode_kind::latest_solution);
  REQUIRE(coefficient_plane_error(unit, mode, latest, 0) < kRelativeL2SamePath);
}

} // namespace

TEST_CASE("WP1 current distribution decodes free, ground, and junction ends",
          "[wasm_api][current_quadrature][wp1_current]")
{
  nec_context dipole_native;
  const c_geometry* dipole =
    complete_native(dipole_native, dipole_wires(), 0);
  const nec_segment_end dipole_start =
    nec_decode_segment_end(*dipole, 0, true);
  const nec_segment_end dipole_end =
    nec_decode_segment_end(*dipole, kDipoleSegments - 1, false);
  REQUIRE(dipole_start.kind == nec_segment_end_kind::free);
  REQUIRE(dipole_end.kind == nec_segment_end_kind::free);

  nec_context monopole_native;
  const c_geometry* monopole =
    complete_native(monopole_native, monopole_wires(), 1);
  const nec_segment_end grounded =
    nec_decode_segment_end(*monopole, 0, true);
  REQUIRE(grounded.kind == nec_segment_end_kind::ground);

  nec_context bent_native;
  const c_geometry* bent = complete_native(bent_native, bent_wires(), 0);
  const nec_segment_end junction_end =
    nec_decode_segment_end(*bent, kArmSegments - 1, false);
  REQUIRE(junction_end.kind == nec_segment_end_kind::segment);
  REQUIRE(junction_end.tag == 2);
  REQUIRE(junction_end.segment == 1);

  c_geometry* mutable_dipole = dipole_native.get_geometry();
  mutable_dipole->icon1[0] = PCHCON + 1;
  REQUIRE_THROWS_AS(
    nec_decode_segment_end(*mutable_dipole, 0, true), nec_exception);
}

TEST_CASE("WP1 current distribution dipole latest-solution and unit-current",
          "[wasm_api][current_quadrature][wp1_current]")
{
  nec_stateful_model model;
  build_stateful(model, dipole_wires(), {{1, 6}});
  const nec_port_solution solution =
    model.solve_port_voltages_detailed({ nec_complex(1.0, 0.0) });
  REQUIRE(solution.currents[0].real() > 0.0);

  const nec_current_distribution latest =
    model.get_current_distribution(nec_current_mode_kind::latest_solution);
  REQUIRE(latest.mode_kind == nec_current_mode_kind::latest_solution);
  REQUIRE(latest.mode_count == 1);
  REQUIRE(latest.frequency_mhz == Catch::Approx(kFrequencyMHz));
  REQUIRE(latest.segment_count() == static_cast<size_t>(kDipoleSegments));
  require_public_wire_order(latest, dipole_wires());
  require_reconstruction(latest);
  const size_t feed = public_segment_index(latest, 1, 6);
  REQUIRE(relative_error(centre_current(latest, 0, feed), solution.currents[0])
    < kRelativeL2StraightFeedCurrent);
  REQUIRE(latest.start_ends.front().kind == nec_segment_end_kind::free);
  REQUIRE(latest.end_ends.back().kind == nec_segment_end_kind::free);

  const nec_current_distribution unit =
    model.get_current_distribution(nec_current_mode_kind::unit_current);
  REQUIRE(unit.mode_kind == nec_current_mode_kind::unit_current);
  REQUIRE(unit.mode_count == 1);
  require_reconstruction(unit);
  require_unit_mode_matches_latest(model, unit, 0);
}

TEST_CASE("WP1 current distribution rooted monopole stays physical-only",
          "[wasm_api][current_quadrature][wp1_current]")
{
  nec_stateful_model model;
  build_stateful(
    model, monopole_wires(), {{1, 1}},
    nec_ground_connection::interpolate, nec_ground_kind::perfect);
  const nec_port_solution solution =
    model.solve_port_voltages_detailed({ nec_complex(1.0, 0.0) });

  const nec_current_distribution latest =
    model.get_current_distribution(nec_current_mode_kind::latest_solution);
  REQUIRE(latest.segment_count() == static_cast<size_t>(kDipoleSegments));
  require_public_wire_order(latest, monopole_wires());
  require_reconstruction(latest);
  REQUIRE(latest.start_ends.front().kind == nec_segment_end_kind::ground);
  REQUIRE(latest.end_ends.back().kind == nec_segment_end_kind::free);
  const size_t feed = public_segment_index(latest, 1, 1);
  REQUIRE(relative_error(centre_current(latest, 0, feed), solution.currents[0])
    < kRelativeL2StraightFeedCurrent);

  const nec_current_distribution unit =
    model.get_current_distribution(nec_current_mode_kind::unit_current);
  REQUIRE(unit.mode_count == 1);
  REQUIRE(unit.start_ends.front().kind == nec_segment_end_kind::ground);
  require_unit_mode_matches_latest(model, unit, 0);
}

TEST_CASE("WP1 current distribution bent multiwire uses public junction identity",
          "[wasm_api][current_quadrature][wp1_current]")
{
  nec_stateful_model model;
  build_stateful(model, bent_wires(), {{1, kArmSegments}});
  const nec_port_solution unit_solve =
    model.solve_port_currents({ nec_complex(1.0, 0.0) });
  REQUIRE(relative_error(unit_solve.currents[0], nec_complex(1.0, 0.0))
    < kRelativeL2UnitCurrent);

  const nec_current_distribution latest =
    model.get_current_distribution(nec_current_mode_kind::latest_solution);
  require_public_wire_order(latest, bent_wires());
  require_reconstruction(latest);
  const size_t feed = public_segment_index(latest, 1, kArmSegments);
  REQUIRE(latest.segments[feed].native_index == kArmSegments - 1);
  REQUIRE(latest.end_ends[feed].kind == nec_segment_end_kind::segment);
  REQUIRE(latest.end_ends[feed].tag == 2);
  REQUIRE(latest.end_ends[feed].segment == 1);
  const size_t other = public_segment_index(
    latest, latest.end_ends[feed].tag, latest.end_ends[feed].segment);
  REQUIRE(latest.segments[other].tag == 2);
  REQUIRE(relative_error(centre_current(latest, 0, feed), unit_solve.currents[0])
    < kRelativeL2JunctionFeedCurrent);
}

TEST_CASE("WP1 current distribution insulated turnstile unit modes and +90 drive",
          "[wasm_api][current_quadrature][wp1_current]")
{
  nec_stateful_model model;
  build_stateful(model, insulated_turnstile_wires(), {{1, 6}, {2, 6}});
  const nec_impedance_result matrices = model.compute_impedance_matrix();
  REQUIRE(std::abs(matrices.impedance.at(0, 1))
    < 1.0e-6 * std::abs(matrices.impedance.at(0, 0)));

  const nec_current_distribution unit =
    model.get_current_distribution(nec_current_mode_kind::unit_current);
  REQUIRE(unit.mode_count == 2);
  require_public_wire_order(unit, insulated_turnstile_wires());
  require_reconstruction(unit);
  const size_t feed1 = public_segment_index(unit, 1, 6);
  const size_t feed2 = public_segment_index(unit, 2, 6);
  require_unit_mode_matches_latest(model, unit, 0);
  require_unit_mode_matches_latest(model, unit, 1);

  const nec_port_solution combined = model.solve_port_currents({
    nec_complex(1.0, 0.0), nec_complex(0.0, 1.0),
  });
  REQUIRE(relative_error(combined.currents[0], nec_complex(1.0, 0.0))
    < kRelativeL2UnitCurrent);
  REQUIRE(relative_error(combined.currents[1], nec_complex(0.0, 1.0))
    < kRelativeL2UnitCurrent);
  const nec_current_distribution latest =
    model.get_current_distribution(nec_current_mode_kind::latest_solution);
  REQUIRE(latest.mode_count == 1);
  require_reconstruction(latest);
  REQUIRE(relative_error(centre_current(latest, 0, feed1), combined.currents[0])
    < kRelativeL2JunctionFeedCurrent);
  REQUIRE(relative_error(centre_current(latest, 0, feed2), combined.currents[1])
    < kRelativeL2JunctionFeedCurrent);
}

TEST_CASE("WP1 current distribution connected turnstile junctions at the hub",
          "[wasm_api][current_quadrature][wp1_current]")
{
  nec_stateful_model insulated;
  build_stateful(insulated, insulated_turnstile_wires(), {{1, 6}, {2, 6}});
  nec_stateful_model connected;
  build_stateful(connected, connected_turnstile_wires(), {
    {1, kArmSegments}, {3, kArmSegments},
  });
  const nec_impedance_result insulated_z = insulated.compute_impedance_matrix();
  const nec_impedance_result connected_z = connected.compute_impedance_matrix();
  REQUIRE(relative_error(
    insulated_z.impedance.at(0, 0), connected_z.impedance.at(0, 0)) > 1.0e-3);
  REQUIRE(std::abs(connected_z.impedance.at(0, 1))
    > 0.1 * std::abs(connected_z.impedance.at(0, 0)));

  connected.solve_port_currents({
    nec_complex(1.0, 0.0), nec_complex(0.0, 1.0),
  });
  const nec_current_distribution latest =
    connected.get_current_distribution(nec_current_mode_kind::latest_solution);
  require_public_wire_order(latest, connected_turnstile_wires());
  require_reconstruction(latest);
  const size_t arm1 = public_segment_index(latest, 1, kArmSegments);
  const size_t arm3 = public_segment_index(latest, 3, kArmSegments);
  REQUIRE(latest.end_ends[arm1].kind == nec_segment_end_kind::segment);
  REQUIRE(latest.end_ends[arm1].kind != nec_segment_end_kind::free);
  REQUIRE(latest.end_ends[arm3].kind == nec_segment_end_kind::segment);

  const nec_current_distribution unit =
    connected.get_current_distribution(nec_current_mode_kind::unit_current);
  REQUIRE(unit.mode_count == 2);
  require_reconstruction(unit);
  require_unit_mode_matches_latest(connected, unit, 0);
  require_unit_mode_matches_latest(connected, unit, 1);
}

TEST_CASE("WP1 current distribution converts snapshot units to metres at 150 MHz",
          "[wasm_api][current_quadrature][wp1_current]")
{
  constexpr nec_float frequency_mhz = 150.0;
  nec_stateful_model model;
  build_stateful(model, dipole_wires(), {{1, 6}},
    nec_ground_connection::none, nec_ground_kind::free_space, frequency_mhz);
  model.solve_port_currents({ nec_complex(1.0, 0.0) });

  const nec_current_distribution latest =
    model.get_current_distribution(nec_current_mode_kind::latest_solution);
  const nec_far_field_snapshot snapshot = model.capture_far_field_snapshot();
  const nec_float wavelength_m = em::get_wavelength(frequency_mhz * 1.0e6);
  REQUIRE(latest.wavelength_m == Catch::Approx(wavelength_m));
  REQUIRE(wavelength_m > 1.9);
  REQUIRE(wavelength_m < 2.1);
  REQUIRE(latest.segment_count() == snapshot.segment_count());
  REQUIRE(latest.radii_m[0] == Catch::Approx(kRadiusM));
  REQUIRE(latest.lengths_m[0] == Catch::Approx(0.5 / kDipoleSegments));

  const nec_float first_centre_z = -0.25 + 0.5 / (2.0 * kDipoleSegments);
  REQUIRE(latest.centres_m[2] == Catch::Approx(first_centre_z));
  REQUIRE(std::abs(latest.centres_m[2] - snapshot.z[0]) > 0.05);
  REQUIRE(latest.centres_m[2] == Catch::Approx(snapshot.z[0] * wavelength_m));
  REQUIRE(latest.starts_m[2] == Catch::Approx(-0.25));
  REQUIRE(latest.ends_m[latest.ends_m.size() - 1] == Catch::Approx(0.25));
  require_reconstruction(latest);
}

TEST_CASE("WP1 current distribution zero-current and error paths are deterministic",
          "[wasm_api][current_quadrature][wp1_current]")
{
  nec_stateful_model empty;
  REQUIRE_THROWS_AS(
    empty.get_current_distribution(nec_current_mode_kind::unit_current),
    nec_exception);
  REQUIRE_THROWS_AS(
    empty.get_current_distribution(nec_current_mode_kind::latest_solution),
    nec_exception);

  nec_stateful_model prepared;
  build_stateful(prepared, dipole_wires(), {{1, 6}});
  REQUIRE_THROWS_AS(
    prepared.get_current_distribution(nec_current_mode_kind::latest_solution),
    nec_exception);
  const nec_current_distribution unit =
    prepared.get_current_distribution(nec_current_mode_kind::unit_current);
  REQUIRE(prepared.state() == nec_model_state::prepared);
  REQUIRE(unit.mode_count == 1);
  require_finite_planes(unit);

  prepared.solve_port_currents({ nec_complex(0.0, 0.0) });
  const nec_current_distribution latest =
    prepared.get_current_distribution(nec_current_mode_kind::latest_solution);
  require_finite_planes(latest);
  for (size_t index = 0; index < latest.a_real.size(); ++index) {
    REQUIRE(std::abs(latest.a_real[index]) < 1.0e-12);
    REQUIRE(std::abs(latest.a_imag[index]) < 1.0e-12);
    REQUIRE(std::abs(latest.b_real[index]) < 1.0e-12);
    REQUIRE(std::abs(latest.b_imag[index]) < 1.0e-12);
    REQUIRE(std::abs(latest.c_real[index]) < 1.0e-12);
    REQUIRE(std::abs(latest.c_imag[index]) < 1.0e-12);
  }
}

TEST_CASE("WP1 current distribution unit-current restores the consumer solution",
          "[wasm_api][current_quadrature][wp1_current]")
{
  nec_stateful_model model;
  build_stateful(model, insulated_turnstile_wires(), {{1, 6}, {2, 6}});
  const nec_port_solution solution = model.solve_port_voltages_detailed({
    nec_complex(1.0, 0.0), nec_complex(0.5, -0.25),
  });
  const uint64_t generation = model.solve_generation();
  const nec_far_field_grid grid{ 1.0, 0.0, 5, 45.0, 0.0, 3, 90.0 };
  const nec_far_field_result before = model.compute_far_field(grid);

  const nec_current_distribution unit =
    model.get_current_distribution(nec_current_mode_kind::unit_current);
  REQUIRE(unit.mode_count == 2);
  REQUIRE(model.solve_generation() == generation);
  REQUIRE(model.last_port_solution().currents == solution.currents);
  REQUIRE(model.last_port_solution().voltages == solution.voltages);
  REQUIRE(model.state() == nec_model_state::solved);

  const nec_far_field_result after = model.compute_far_field(grid);
  REQUIRE(after.e_theta.size() == before.e_theta.size());
  for (size_t index = 0; index < before.e_theta.size(); ++index) {
    REQUIRE(relative_error(after.e_theta[index], before.e_theta[index])
      < kRelativeL2SamePath);
    REQUIRE(relative_error(after.e_phi[index], before.e_phi[index])
      < kRelativeL2SamePath);
  }
}
