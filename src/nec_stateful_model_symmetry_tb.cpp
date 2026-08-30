#include <catch2/catch_test_macros.hpp>

#include "electromag.h"
#include "nec_exception.h"
#include "nec_stateful_model.h"

#include <algorithm>
#include <cmath>
#include <complex>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

namespace {

constexpr nec_float kFrequencyMHz = 300.0;
constexpr int kSegments = 11;
constexpr int kFeedSegment = 6;

struct array_point {
  nec_float x = 0.0;
  nec_float y = 0.0;
};

enum class test_ground {
  perfect,
  finite,
};

class scoped_cout_sink {
public:
  scoped_cout_sink()
    : previous(std::cout.rdbuf(sink.rdbuf()))
  {
  }

  ~scoped_cout_sink()
  {
    std::cout.rdbuf(previous);
  }

private:
  std::ostringstream sink;
  std::streambuf* previous;
};

nec_float wavelength_m()
{
  return em::get_wavelength(kFrequencyMHz * 1.0e6);
}

nec_wire_definition reference_wire(int tag, const array_point& point)
{
  const nec_float wavelength = wavelength_m();
  return {
    tag, kSegments,
    point.x, point.y, wavelength / 12.0,
    point.x, point.y, 5.0 * wavelength / 12.0,
    wavelength / 1000.0,
  };
}

std::vector<array_point> square_points(int side)
{
  const nec_float spacing = wavelength_m() / 2.0;
  std::vector<array_point> points;
  points.reserve(static_cast<size_t>(side * side));
  for (int y = 0; y < side; ++y) {
    for (int x = 0; x < side; ++x) {
      points.push_back({
        (static_cast<nec_float>(x) -
          (static_cast<nec_float>(side) - 1.0) / 2.0) * spacing,
        (static_cast<nec_float>(y) -
          (static_cast<nec_float>(side) - 1.0) / 2.0) * spacing,
      });
    }
  }
  return points;
}

std::vector<array_point> select_fundamental(
  const std::vector<array_point>& caller_points,
  const nec_geometry_symmetry& symmetry)
{
  std::vector<array_point> fundamental;
  for (const array_point& point : caller_points) {
    bool selected = false;
    if (symmetry.kind == nec_geometry_symmetry_kind::reflection) {
      selected =
        ((symmetry.reflection_plane_mask & nec_reflection_plane_x) == 0u ||
          point.x > 0.0) &&
        ((symmetry.reflection_plane_mask & nec_reflection_plane_y) == 0u ||
          point.y > 0.0);
    } else if (symmetry.kind == nec_geometry_symmetry_kind::rotational) {
      selected = symmetry.rotational_order == 2
        ? point.y > 0.0
        : point.x > 0.0 && point.y > 0.0;
    }
    if (selected)
      fundamental.push_back(point);
  }
  return fundamental;
}

std::vector<array_point> generated_points(
  const std::vector<array_point>& fundamental,
  const nec_geometry_symmetry& symmetry)
{
  std::vector<array_point> generated;
  if (symmetry.kind == nec_geometry_symmetry_kind::reflection) {
    const std::vector<int> x_signs =
      (symmetry.reflection_plane_mask & nec_reflection_plane_x) != 0u
        ? std::vector<int>{1, -1}
        : std::vector<int>{1};
    const std::vector<int> y_signs =
      (symmetry.reflection_plane_mask & nec_reflection_plane_y) != 0u
        ? std::vector<int>{1, -1}
        : std::vector<int>{1};
    // NEC applies Y before X, so X is the outer copy block.
    for (const int x_sign : x_signs) {
      for (const int y_sign : y_signs) {
        for (const array_point& point : fundamental)
          generated.push_back({x_sign * point.x, y_sign * point.y});
      }
    }
  } else {
    for (int copy = 0; copy < symmetry.rotational_order; ++copy) {
      const nec_float angle =
        two_pi() * static_cast<nec_float>(copy) /
        static_cast<nec_float>(symmetry.rotational_order);
      const nec_float cosine = std::cos(angle);
      const nec_float sine = std::sin(angle);
      for (const array_point& point : fundamental) {
        generated.push_back({
          cosine * point.x - sine * point.y,
          sine * point.x + cosine * point.y,
        });
      }
    }
  }
  return generated;
}

std::vector<size_t> generated_to_caller_map(
  const std::vector<array_point>& generated,
  const std::vector<array_point>& caller)
{
  // NEC's historical pi() constant is intentionally preserved to ten decimal
  // places, so quarter-turn test coordinates carry a few picometres of roundoff.
  const nec_float tolerance = wavelength_m() * 1.0e-9;
  std::vector<size_t> mapping;
  std::vector<bool> used(caller.size(), false);
  mapping.reserve(generated.size());
  for (const array_point& point : generated) {
    size_t match = caller.size();
    for (size_t index = 0; index < caller.size(); ++index) {
      if (!used[index] &&
          std::abs(point.x - caller[index].x) <= tolerance &&
          std::abs(point.y - caller[index].y) <= tolerance) {
        match = index;
        break;
      }
    }
    REQUIRE(match < caller.size());
    used[match] = true;
    mapping.push_back(match);
  }
  REQUIRE(std::all_of(used.begin(), used.end(), [](bool value) { return value; }));
  return mapping;
}

void set_test_ground(nec_stateful_model& model, test_ground ground)
{
  if (ground == test_ground::perfect) {
    model.set_ground({nec_ground_kind::perfect, 0.0, 0.0});
  } else {
    model.set_ground({
      nec_ground_kind::finite_reflection_coefficient,
      13.0, 0.005,
    });
  }
}

void build_explicit(
  nec_stateful_model& model,
  const std::vector<array_point>& points,
  test_ground ground)
{
  std::vector<nec_port_definition> ports;
  for (size_t index = 0; index < points.size(); ++index) {
    const int tag = static_cast<int>(index + 1);
    model.add_wire(reference_wire(tag, points[index]));
    ports.push_back({tag, kFeedSegment});
  }
  model.complete_geometry();
  model.define_ports(ports);
  set_test_ground(model, ground);
  model.prepare(kFrequencyMHz);
}

std::vector<size_t> build_symmetric(
  nec_stateful_model& model,
  const std::vector<array_point>& caller_points,
  const nec_geometry_symmetry& symmetry,
  test_ground ground)
{
  const std::vector<array_point> fundamental =
    select_fundamental(caller_points, symmetry);
  REQUIRE(!fundamental.empty());
  for (size_t index = 0; index < fundamental.size(); ++index)
    model.add_wire(reference_wire(static_cast<int>(index + 1), fundamental[index]));

  const nec_geometry_completion_result& completion =
    model.complete_geometry(symmetry);
  REQUIRE(completion.symmetry.kind == symmetry.kind);
  REQUIRE(completion.fundamental_segment_count ==
    static_cast<int64_t>(fundamental.size() * kSegments));
  REQUIRE(completion.full_segment_count ==
    static_cast<int64_t>(caller_points.size() * kSegments));
  REQUIRE(&completion == &model.geometry_completion());

  const std::vector<array_point> generated =
    generated_points(fundamental, symmetry);
  REQUIRE(generated.size() == caller_points.size());
  std::vector<nec_port_definition> ports;
  for (size_t index = 0; index < generated.size(); ++index)
    ports.push_back({static_cast<int>(index + 1), kFeedSegment});
  model.define_ports(ports);
  set_test_ground(model, ground);
  model.prepare(kFrequencyMHz);
  return generated_to_caller_map(generated, caller_points);
}

std::vector<nec_complex> gather_complex(
  const std::vector<nec_complex>& native,
  const std::vector<size_t>& native_to_caller)
{
  REQUIRE(native.size() == native_to_caller.size());
  std::vector<nec_complex> caller(native.size());
  for (size_t native_index = 0; native_index < native.size(); ++native_index)
    caller[native_to_caller[native_index]] = native[native_index];
  return caller;
}

std::vector<nec_float> gather_real(
  const std::vector<nec_float>& native,
  const std::vector<size_t>& native_to_caller)
{
  REQUIRE(native.size() == native_to_caller.size());
  std::vector<nec_float> caller(native.size());
  for (size_t native_index = 0; native_index < native.size(); ++native_index)
    caller[native_to_caller[native_index]] = native[native_index];
  return caller;
}

std::vector<nec_complex> gather_matrix(
  const nec_complex_matrix& native,
  const std::vector<size_t>& native_to_caller)
{
  const size_t order = native_to_caller.size();
  REQUIRE(native.rows == order);
  REQUIRE(native.columns == order);
  std::vector<nec_complex> caller(order * order);
  for (size_t native_row = 0; native_row < order; ++native_row) {
    for (size_t native_column = 0; native_column < order; ++native_column) {
      const size_t caller_row = native_to_caller[native_row];
      const size_t caller_column = native_to_caller[native_column];
      caller[caller_row * order + caller_column] =
        native.at(native_row, native_column);
    }
  }
  return caller;
}

void require_complex_close(
  const std::vector<nec_complex>& actual,
  const std::vector<nec_complex>& expected,
  nec_float tolerance = 1.0e-8)
{
  REQUIRE(actual.size() == expected.size());
  nec_float difference_squared = 0.0;
  nec_float expected_squared = 0.0;
  nec_float max_difference = 0.0;
  nec_float max_expected = 0.0;
  for (size_t index = 0; index < actual.size(); ++index) {
    REQUIRE(std::isfinite(actual[index].real()));
    REQUIRE(std::isfinite(actual[index].imag()));
    REQUIRE(std::isfinite(expected[index].real()));
    REQUIRE(std::isfinite(expected[index].imag()));
    difference_squared += std::norm(actual[index] - expected[index]);
    expected_squared += std::norm(expected[index]);
    max_difference = std::max(max_difference, std::abs(actual[index] - expected[index]));
    max_expected = std::max(max_expected, std::abs(expected[index]));
  }
  const nec_float relative_l2 = std::sqrt(difference_squared) /
    std::max(nec_float(1.0e-12), std::sqrt(expected_squared));
  const nec_float scaled_max = max_difference /
    std::max(nec_float(1.0e-12), max_expected);
  REQUIRE(relative_l2 <= tolerance);
  REQUIRE(scaled_max <= tolerance);
}

void require_real_close(
  const std::vector<nec_float>& actual,
  const std::vector<nec_float>& expected,
  nec_float tolerance = 1.0e-8)
{
  REQUIRE(actual.size() == expected.size());
  nec_float max_difference = 0.0;
  nec_float max_expected = 0.0;
  for (size_t index = 0; index < actual.size(); ++index) {
    REQUIRE(std::isfinite(actual[index]));
    REQUIRE(std::isfinite(expected[index]));
    max_difference = std::max(max_difference, std::abs(actual[index] - expected[index]));
    max_expected = std::max(max_expected, std::abs(expected[index]));
  }
  REQUIRE(max_difference / std::max(nec_float(1.0e-12), max_expected) <=
    tolerance);
}

void run_equivalence_case(
  int side,
  nec_geometry_symmetry symmetry,
  test_ground ground)
{
  scoped_cout_sink silence_debug_trace;
  const std::vector<array_point> caller_points = square_points(side);
  const std::vector<array_point> fundamental =
    select_fundamental(caller_points, symmetry);
  symmetry.tag_increment = static_cast<int>(fundamental.size());

  nec_stateful_model explicit_model;
  nec_stateful_model symmetric_model;
  build_explicit(explicit_model, caller_points, ground);
  const std::vector<size_t> native_to_caller =
    build_symmetric(symmetric_model, caller_points, symmetry, ground);

  REQUIRE(explicit_model.geometry_completion().section_count == 1);
  REQUIRE(explicit_model.geometry_completion().fundamental_segment_count ==
    static_cast<int64_t>(caller_points.size() * kSegments));
  REQUIRE(symmetric_model.factorization_generation() == 1);
  REQUIRE(explicit_model.factorization_generation() == 1);

  const nec_impedance_result& explicit_matrices =
    explicit_model.compute_impedance_matrix();
  const nec_impedance_result& symmetric_matrices =
    symmetric_model.compute_impedance_matrix();
  require_complex_close(
    gather_matrix(symmetric_matrices.impedance, native_to_caller),
    explicit_matrices.impedance.values);
  require_complex_close(
    gather_matrix(symmetric_matrices.admittance, native_to_caller),
    explicit_matrices.admittance.values);

  std::vector<nec_complex> caller_currents;
  caller_currents.reserve(caller_points.size());
  for (size_t index = 0; index < caller_points.size(); ++index) {
    const nec_float amplitude = 0.004 + 0.0003 * (index % 5);
    const nec_float phase = 0.23 * index - 0.07 * ((index * index) % 3);
    caller_currents.push_back(std::polar(amplitude, phase));
  }
  std::vector<nec_complex> native_currents(caller_currents.size());
  for (size_t native_index = 0;
       native_index < native_to_caller.size(); ++native_index)
    native_currents[native_index] = caller_currents[native_to_caller[native_index]];

  const nec_port_solution explicit_solution =
    explicit_model.solve_port_currents(caller_currents);
  const nec_port_solution symmetric_solution =
    symmetric_model.solve_port_currents(native_currents);
  require_complex_close(
    gather_complex(symmetric_solution.voltages, native_to_caller),
    explicit_solution.voltages);
  require_complex_close(
    gather_complex(symmetric_solution.currents, native_to_caller),
    explicit_solution.currents);
  require_complex_close(
    gather_complex(symmetric_solution.active_impedances, native_to_caller),
    explicit_solution.active_impedances);
  require_real_close(
    gather_real(symmetric_solution.powers_w, native_to_caller),
    explicit_solution.powers_w);

  const nec_far_field_grid field_grid{
    2.0,
    25.0, 4, 20.0,
    0.0, 4, 60.0,
  };
  const nec_far_field_result& explicit_field =
    explicit_model.compute_far_field(field_grid);
  const nec_far_field_result& symmetric_field =
    symmetric_model.compute_far_field(field_grid);
  REQUIRE(symmetric_field.theta_deg == explicit_field.theta_deg);
  REQUIRE(symmetric_field.phi_deg == explicit_field.phi_deg);
  require_complex_close(symmetric_field.e_theta, explicit_field.e_theta);
  require_complex_close(symmetric_field.e_phi, explicit_field.e_phi);
  REQUIRE(symmetric_model.factorization_generation() == 1);
  REQUIRE(explicit_model.factorization_generation() == 1);
}

nec_geometry_symmetry reflection(uint32_t planes)
{
  return {
    nec_geometry_symmetry_kind::reflection,
    planes,
    1,
    1,
  };
}

nec_geometry_symmetry rotation(int order)
{
  return {
    nec_geometry_symmetry_kind::rotational,
    0u,
    order,
    1,
  };
}

void build_loaded_quadrant(nec_stateful_model& model)
{
  const nec_float quarter = wavelength_m() / 4.0;
  model.add_wire(reference_wire(1, {quarter, quarter}));
  model.complete_geometry(reflection(
    nec_reflection_plane_x | nec_reflection_plane_y));
  model.define_ports({{1, 6}, {2, 6}, {3, 6}, {4, 6}});
}

std::string exception_message(const nec_exception& error)
{
  return error.get_message();
}

} // namespace

TEST_CASE("WP-S2 reflection arrays match explicit Z solve and complex field",
          "[symmetry][wp_s2][equivalence][reflection]")
{
  SECTION("R1 2x2 X/Y reflection over perfect ground") {
    run_equivalence_case(
      2,
      reflection(nec_reflection_plane_x | nec_reflection_plane_y),
      test_ground::perfect);
  }
  SECTION("R2 4x4 X/Y reflection over perfect ground") {
    run_equivalence_case(
      4,
      reflection(nec_reflection_plane_x | nec_reflection_plane_y),
      test_ground::perfect);
  }
  SECTION("R4 4x4 X reflection over perfect ground") {
    run_equivalence_case(
      4,
      reflection(nec_reflection_plane_x),
      test_ground::perfect);
  }
  SECTION("G1 4x4 X/Y reflection over finite ground") {
    run_equivalence_case(
      4,
      reflection(nec_reflection_plane_x | nec_reflection_plane_y),
      test_ground::finite);
  }
}

TEST_CASE("WP-S2 rotational arrays match explicit Z solve and complex field",
          "[symmetry][wp_s2][equivalence][rotation]")
{
  SECTION("T1 order-two 2x2 array over perfect ground") {
    run_equivalence_case(2, rotation(2), test_ground::perfect);
  }
  SECTION("T2 order-four 4x4 array over perfect ground") {
    run_equivalence_case(4, rotation(4), test_ground::perfect);
  }
}

TEST_CASE("WP-S2 completion metadata and lifecycle are immutable",
          "[symmetry][wp_s2][lifecycle]")
{
  nec_stateful_model retry;
  retry.add_wire(reference_wire(1, {0.2, 0.2}));
  nec_geometry_symmetry invalid = reflection(nec_reflection_plane_x);
  invalid.tag_increment = 0;
  REQUIRE_THROWS_AS(retry.complete_geometry(invalid), nec_exception);
  REQUIRE(retry.state() == nec_model_state::geometry_building);
  REQUIRE_NOTHROW(retry.complete_geometry(reflection(nec_reflection_plane_x)));

  nec_stateful_model model;
  REQUIRE_THROWS_AS(model.geometry_completion(), nec_exception);
  model.add_wire(reference_wire(1, {0.2, 0.2}));
  REQUIRE_THROWS_AS(model.geometry_completion(), nec_exception);

  const nec_geometry_completion_result& result =
    model.complete_geometry(reflection(nec_reflection_plane_x));
  REQUIRE(result.section_count == 2);
  REQUIRE(result.fundamental_segment_count == kSegments);
  REQUIRE(result.full_segment_count == 2 * kSegments);
  REQUIRE(result.symmetry.reflection_plane_mask == nec_reflection_plane_x);
  REQUIRE_THROWS_AS(
    model.add_wire(reference_wire(2, {0.3, 0.2})),
    nec_exception);
  REQUIRE(&result == &model.geometry_completion());
}

TEST_CASE("WP-S2 validates complete and equal load orbits at prepare",
          "[symmetry][wp_s2][loads]")
{
  SECTION("incomplete orbit fails before preparation") {
    nec_stateful_model model;
    build_loaded_quadrant(model);
    model.add_load({nec_load_kind::impedance, 1, 6, 0, 10.0, 2.0, 0.0});
    try {
      model.prepare(kFrequencyMHz);
      FAIL("incomplete load orbit was accepted");
    } catch (const nec_exception& error) {
      REQUIRE(exception_message(error).find("INCOMPLETE OR UNEQUAL") !=
        std::string::npos);
    }
    REQUIRE(model.state() == nec_model_state::geometry_complete);
    REQUIRE(model.factorization_generation() == 0);
    REQUIRE_THROWS_AS(model.compute_impedance_matrix(), nec_exception);
  }

  SECTION("unequal orbit fails before preparation") {
    nec_stateful_model model;
    build_loaded_quadrant(model);
    for (int tag = 1; tag <= 4; ++tag) {
      model.add_load({
        nec_load_kind::impedance, tag, 6, 0,
        tag == 4 ? 11.0 : 10.0, 2.0, 0.0,
      });
    }
    REQUIRE_THROWS_AS(model.prepare(kFrequencyMHz), nec_exception);
    REQUIRE(model.factorization_generation() == 0);
  }

  SECTION("complete equal orbit passes") {
    scoped_cout_sink silence_debug_trace;
    nec_stateful_model model;
    build_loaded_quadrant(model);
    for (int tag = 1; tag <= 4; ++tag) {
      model.add_load({
        nec_load_kind::impedance, tag, 6, 0,
        10.0, 2.0, 0.0,
      });
    }
    model.prepare(kFrequencyMHz);
    REQUIRE(model.factorization_generation() == 1);
    REQUIRE(model.compute_impedance_matrix().impedance.rows == 4);
  }

  SECTION("all-segment scalar load passes without expansion") {
    scoped_cout_sink silence_debug_trace;
    nec_stateful_model model;
    build_loaded_quadrant(model);
    model.add_load({
      nec_load_kind::conductivity, 0, 0, 0,
      3.72e7, 0.0, 0.0,
    });
    model.prepare(kFrequencyMHz);
    REQUIRE(model.factorization_generation() == 1);
    REQUIRE(model.compute_impedance_matrix().impedance.rows == 4);
  }
}

TEST_CASE("WP-S2 rejects only ground that conflicts with structural symmetry",
          "[symmetry][wp_s2][ground]")
{
  const array_point point{0.2, 0.2};

  SECTION("z reflection rejects a ground connection before generation") {
    nec_stateful_model model;
    model.add_wire(reference_wire(1, point));
    REQUIRE_THROWS_AS(
      model.complete_geometry(
        reflection(nec_reflection_plane_z),
        nec_ground_connection::interpolate),
      nec_exception);
    REQUIRE(model.state() == nec_model_state::geometry_building);
  }

  SECTION("z reflection rejects a later ground model") {
    nec_stateful_model model;
    model.add_wire(reference_wire(1, point));
    model.complete_geometry(reflection(nec_reflection_plane_z));
    REQUIRE_THROWS_AS(
      model.set_ground({nec_ground_kind::perfect, 0.0, 0.0}),
      nec_exception);
    REQUIRE(model.state() == nec_model_state::geometry_complete);
  }

  SECTION("vertical reflection planes remain valid over ground") {
    nec_stateful_model model;
    model.add_wire(reference_wire(1, point));
    model.complete_geometry(reflection(
      nec_reflection_plane_x | nec_reflection_plane_y));
    REQUIRE_NOTHROW(model.set_ground({nec_ground_kind::perfect, 0.0, 0.0}));
  }

  SECTION("Z-axis rotation remains valid over ground") {
    nec_stateful_model model;
    model.add_wire(reference_wire(1, point));
    model.complete_geometry(rotation(4));
    REQUIRE_NOTHROW(model.set_ground({nec_ground_kind::perfect, 0.0, 0.0}));
  }
}
