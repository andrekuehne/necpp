#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include "current_quadrature_fixtures.h"
#include "nec_exception.h"
#include "nec_prepared_current_quadrature.h"
#include "nec_stateful_model.h"

#include <chrono>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <limits>
#include <string>
#include <vector>

using current_quadrature_fixtures::kFrequencyMHz;
using current_quadrature_fixtures::bent_wires;
using current_quadrature_fixtures::build_stateful;
using current_quadrature_fixtures::connected_turnstile_wires;
using current_quadrature_fixtures::dipole_wires;
using current_quadrature_fixtures::insulated_turnstile_wires;
using current_quadrature_fixtures::monopole_wires;

namespace {

constexpr nec_float kRelativeL2SamePath = 1.0e-12;
constexpr nec_float kFourNodes[] = { -1.0, -1.0 / 3.0, 1.0 / 3.0, 1.0 };

nec_prepared_quadrature_request four_node_request(
  nec_current_mode_kind modes = nec_current_mode_kind::unit_current,
  nec_prepared_quadrature_images images =
    nec_prepared_quadrature_images::physical_only)
{
  nec_prepared_quadrature_request request;
  request.nodes.assign(std::begin(kFourNodes), std::end(kFourNodes));
  request.images = images;
  request.modes = modes;
  return request;
}

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

void require_magic(const nec_prepared_current_quadrature& prepared)
{
  REQUIRE(prepared.byte_length() >= 4);
  REQUIRE(prepared.data() != nullptr);
  REQUIRE(prepared.data()[0] == static_cast<uint8_t>('N'));
  REQUIRE(prepared.data()[1] == static_cast<uint8_t>('E'));
  REQUIRE(prepared.data()[2] == static_cast<uint8_t>('C'));
  REQUIRE(prepared.data()[3] == static_cast<uint8_t>('Q'));
}

void require_identity(
  const nec_prepared_quadrature_view& view,
  const nec_current_distribution& distribution)
{
  REQUIRE(view.n_segments == distribution.segment_count());
  for (size_t index = 0; index < distribution.segment_count(); ++index) {
    REQUIRE(view.tag[index] == distribution.segments[index].tag);
    REQUIRE(view.segment[index] == distribution.segments[index].segment);
    REQUIRE(view.native_index[index] == distribution.segments[index].native_index);
  }
}

void require_matches_scalar(
  const nec_prepared_quadrature_view& view,
  const nec_current_distribution& distribution,
  const std::vector<nec_float>& nodes)
{
  REQUIRE(view.n_modes == distribution.mode_count);
  REQUIRE(view.n_nodes == nodes.size());
  REQUIRE(view.n_segments == distribution.segment_count());
  nec_float difference_squared = 0.0;
  nec_float prepared_squared = 0.0;
  nec_float scalar_squared = 0.0;
  for (size_t mode = 0; mode < view.n_modes; ++mode) {
    for (size_t segment = 0; segment < view.n_segments; ++segment) {
      nec_float weight_sum = 0.0;
      for (size_t node = 0; node < view.n_nodes; ++node) {
        const nec_complex prepared = view.current_at(mode, 0, segment, node);
        const nec_complex scalar = nec_evaluate_quadrature_current(
          distribution, mode, segment, nodes[node]);
        difference_squared += std::norm(prepared - scalar);
        prepared_squared += std::norm(prepared);
        scalar_squared += std::norm(scalar);
        const size_t geo = view.geometry_index(0, segment, node);
        const nec_float s = nodes[node] * distribution.lengths_m[segment] * 0.5;
        const size_t xyz = 3 * segment;
        REQUIRE(view.x[geo] == Catch::Approx(
          distribution.centres_m[xyz] + s * distribution.tangents[xyz]));
        REQUIRE(view.y[geo] == Catch::Approx(
          distribution.centres_m[xyz + 1] + s * distribution.tangents[xyz + 1]));
        REQUIRE(view.z[geo] == Catch::Approx(
          distribution.centres_m[xyz + 2] + s * distribution.tangents[xyz + 2]));
        REQUIRE(view.tx[geo] == Catch::Approx(distribution.tangents[xyz]));
        REQUIRE(view.ty[geo] == Catch::Approx(distribution.tangents[xyz + 1]));
        REQUIRE(view.tz[geo] == Catch::Approx(distribution.tangents[xyz + 2]));
        REQUIRE(view.radius_m[geo] == Catch::Approx(distribution.radii_m[segment]));
        REQUIRE(view.length_m[geo] == Catch::Approx(distribution.lengths_m[segment]));
        weight_sum += view.ds_weight[geo];
      }
      const nec_float expected_weight =
        distribution.lengths_m[segment] * 0.5 * static_cast<nec_float>(nodes.size());
      REQUIRE(std::abs(weight_sum - expected_weight) <
        kRelativeL2SamePath * std::max(nec_float(1.0), expected_weight));
    }
  }
  const nec_float scale = std::max(
    { nec_float(1.0), std::sqrt(prepared_squared), std::sqrt(scalar_squared) });
  REQUIRE(std::sqrt(difference_squared) / scale < kRelativeL2SamePath);
}

void require_plane_separation(const nec_prepared_quadrature_view& view)
{
  if (view.n_image_planes == 1)
    return;
  for (size_t segment = 0; segment < view.n_segments; ++segment) {
    for (size_t node = 0; node < view.n_nodes; ++node) {
      const size_t physical = view.geometry_index(0, segment, node);
      const size_t image = view.geometry_index(1, segment, node);
      REQUIRE(view.x[image] == Catch::Approx(view.x[physical]));
      REQUIRE(view.y[image] == Catch::Approx(view.y[physical]));
      REQUIRE(view.z[image] == Catch::Approx(-view.z[physical]));
      REQUIRE(view.tx[image] == Catch::Approx(view.tx[physical]));
      REQUIRE(view.ty[image] == Catch::Approx(view.ty[physical]));
      REQUIRE(view.tz[image] == Catch::Approx(-view.tz[physical]));
      REQUIRE(view.radius_m[image] == Catch::Approx(view.radius_m[physical]));
      REQUIRE(view.length_m[image] == Catch::Approx(view.length_m[physical]));
      REQUIRE(view.ds_weight[image] == Catch::Approx(view.ds_weight[physical]));
      for (size_t mode = 0; mode < view.n_modes; ++mode) {
        const nec_complex physical_i = view.current_at(mode, 0, segment, node);
        const nec_complex image_i = view.current_at(mode, 1, segment, node);
        REQUIRE(relative_error(image_i, -physical_i) < kRelativeL2SamePath);
      }
    }
  }
}

void require_hot_path_frozen(const nec_prepared_current_quadrature& prepared)
{
  const auto before = prepared.diagnostics;
  REQUIRE(before.geometry_walks >= 1);
  REQUIRE(before.trigonometry_evaluations >= 1);
  REQUIRE(before.interpolations >= 1);
  REQUIRE(before.growing_allocations == 1);
  for (int pass = 0; pass < 100; ++pass) {
    const nec_prepared_quadrature_view view =
      nec_view_prepared_quadrature(prepared);
    REQUIRE(view.n_segments > 0);
    REQUIRE(prepared.byte_length() == prepared.packed.size());
    REQUIRE(prepared.data() == prepared.packed.data());
    volatile nec_float sink = view.i_real[0] + view.x[0];
    (void)sink;
  }
  REQUIRE(prepared.diagnostics.geometry_walks == before.geometry_walks);
  REQUIRE(prepared.diagnostics.trigonometry_evaluations ==
    before.trigonometry_evaluations);
  REQUIRE(prepared.diagnostics.interpolations == before.interpolations);
  REQUIRE(prepared.diagnostics.growing_allocations == before.growing_allocations);
}

void require_size_lock(
  const nec_prepared_current_quadrature& prepared,
  size_t n_modes, size_t n_segments, size_t n_nodes, size_t n_planes,
  size_t geometry_bytes, size_t current_bytes)
{
  REQUIRE(nec_prepared_quadrature_geometry_bytes(
    n_segments, n_nodes, n_planes) == geometry_bytes);
  REQUIRE(nec_prepared_quadrature_current_bytes(
    n_modes, n_segments, n_nodes, n_planes) == current_bytes);
  REQUIRE(prepared.byte_length() == nec_prepared_quadrature_packed_bytes(
    n_modes, n_segments, n_nodes, n_planes));
  const nec_prepared_quadrature_view view =
    nec_view_prepared_quadrature(prepared);
  REQUIRE(view.n_modes == n_modes);
  REQUIRE(view.n_segments == n_segments);
  REQUIRE(view.n_nodes == n_nodes);
  REQUIRE(view.n_image_planes == n_planes);
}

} // namespace

TEST_CASE("WP2 prepared quadrature matches scalar I(xi) on canonical fixtures",
          "[wasm_api][current_quadrature][wp2_current]")
{
  const auto request = four_node_request();

  struct Fixture {
    const char* name;
    std::vector<nec_wire_definition> wires;
    std::vector<nec_port_definition> ports;
    size_t n_segments;
    size_t n_modes;
    size_t geometry_bytes;
    size_t current_bytes;
  };
  const Fixture fixtures[] = {
    { "dipole", dipole_wires(), {{1, 6}}, 11, 1, 3168, 704 },
    { "bent-multiwire", bent_wires(), {{1, 5}}, 10, 1, 2880, 640 },
    { "turnstile-insulated", insulated_turnstile_wires(), {{1, 6}, {2, 6}},
      22, 2, 6336, 2816 },
    { "turnstile-connected", connected_turnstile_wires(), {{1, 5}, {3, 5}},
      20, 2, 5760, 2560 },
  };

  for (const Fixture& fixture : fixtures) {
    INFO(fixture.name);
    nec_stateful_model model;
    build_stateful(model, fixture.wires, fixture.ports);
    const nec_current_distribution distribution =
      model.get_current_distribution(nec_current_mode_kind::unit_current);
    const nec_prepared_current_quadrature prepared =
      model.prepare_current_quadrature(request);
    require_magic(prepared);
    require_size_lock(
      prepared, fixture.n_modes, fixture.n_segments, 4, 1,
      fixture.geometry_bytes, fixture.current_bytes);
    const nec_prepared_quadrature_view view =
      nec_view_prepared_quadrature(prepared);
    REQUIRE_FALSE(view.has_images());
    REQUIRE_FALSE(view.has_weights());
    require_identity(view, distribution);
    require_matches_scalar(view, distribution, request.nodes);
    require_hot_path_frozen(prepared);
  }
}

TEST_CASE("WP2 prepared quadrature rooted monopole images are explicit",
          "[wasm_api][current_quadrature][wp2_current]")
{
  nec_stateful_model model;
  build_stateful(
    model, monopole_wires(), {{1, 1}},
    nec_ground_connection::interpolate, nec_ground_kind::perfect);
  const nec_current_distribution distribution =
    model.get_current_distribution(nec_current_mode_kind::unit_current);

  const nec_prepared_current_quadrature physical =
    model.prepare_current_quadrature(four_node_request());
  require_size_lock(physical, 1, 11, 4, 1, 3168, 704);
  const nec_prepared_quadrature_view physical_view =
    nec_view_prepared_quadrature(physical);
  REQUIRE(physical_view.n_image_planes == 1);
  REQUIRE_FALSE(physical_view.has_images());
  require_identity(physical_view, distribution);
  require_matches_scalar(physical_view, distribution, four_node_request().nodes);

  nec_prepared_quadrature_request images = four_node_request(
    nec_current_mode_kind::unit_current,
    nec_prepared_quadrature_images::perfect_ground_images);
  const nec_prepared_current_quadrature imaged =
    model.prepare_current_quadrature(images);
  REQUIRE(imaged.byte_length() == nec_prepared_quadrature_packed_bytes(1, 11, 4, 2));
  const nec_prepared_quadrature_view image_view =
    nec_view_prepared_quadrature(imaged);
  REQUIRE(image_view.n_image_planes == 2);
  REQUIRE(image_view.has_images());
  require_identity(image_view, distribution);
  require_matches_scalar(image_view, distribution, images.nodes);
  require_plane_separation(image_view);
}

TEST_CASE("WP2 prepared quadrature supplied weights store ds * w",
          "[wasm_api][current_quadrature][wp2_current]")
{
  nec_stateful_model model;
  build_stateful(model, dipole_wires(), {{1, 6}});
  nec_prepared_quadrature_request request = four_node_request();
  request.weights = { 0.5, 1.0, 1.0, 0.5 };
  const nec_current_distribution distribution =
    model.get_current_distribution(nec_current_mode_kind::unit_current);
  const nec_prepared_current_quadrature prepared =
    model.prepare_current_quadrature(request);
  const nec_prepared_quadrature_view view =
    nec_view_prepared_quadrature(prepared);
  REQUIRE(view.has_weights());
  REQUIRE_FALSE(view.has_images());
  nec_float weight_sum = 0.0;
  nec_float expected = 0.0;
  for (size_t node = 0; node < view.n_nodes; ++node) {
    const size_t geo = view.geometry_index(0, 0, node);
    weight_sum += view.ds_weight[geo];
    expected += distribution.lengths_m[0] * 0.5 * request.weights[node];
  }
  REQUIRE(std::abs(weight_sum - expected) < kRelativeL2SamePath);
}

TEST_CASE("WP2 prepared quadrature rejects invalid requests",
          "[wasm_api][current_quadrature][wp2_current]")
{
  nec_stateful_model empty;
  REQUIRE_THROWS_AS(
    empty.prepare_current_quadrature(four_node_request()), nec_exception);

  nec_stateful_model prepared_model;
  build_stateful(prepared_model, dipole_wires(), {{1, 6}});
  nec_prepared_quadrature_request latest = four_node_request(
    nec_current_mode_kind::latest_solution);
  REQUIRE_THROWS_AS(
    prepared_model.prepare_current_quadrature(latest), nec_exception);

  nec_prepared_quadrature_request empty_nodes = four_node_request();
  empty_nodes.nodes.clear();
  REQUIRE_THROWS_AS(
    prepared_model.prepare_current_quadrature(empty_nodes), nec_exception);

  nec_prepared_quadrature_request mismatched = four_node_request();
  mismatched.weights = { 1.0 };
  REQUIRE_THROWS_AS(
    prepared_model.prepare_current_quadrature(mismatched), nec_exception);

  nec_prepared_quadrature_request nonfinite = four_node_request();
  nonfinite.nodes[1] = std::numeric_limits<nec_float>::quiet_NaN();
  REQUIRE_THROWS_AS(
    prepared_model.prepare_current_quadrature(nonfinite), nec_exception);

  nec_prepared_quadrature_request outside = four_node_request();
  outside.nodes[0] = -1.1;
  REQUIRE_THROWS_AS(
    prepared_model.prepare_current_quadrature(outside), nec_exception);

  nec_prepared_quadrature_request images = four_node_request(
    nec_current_mode_kind::unit_current,
    nec_prepared_quadrature_images::perfect_ground_images);
  REQUIRE_THROWS_AS(
    prepared_model.prepare_current_quadrature(images), nec_exception);

  nec_stateful_model finite;
  build_stateful(finite, dipole_wires(), {{1, 6}});
  finite.set_ground({
    nec_ground_kind::finite_reflection_coefficient, 10.0, 0.01,
  });
  finite.prepare(kFrequencyMHz);
  REQUIRE_THROWS_AS(
    finite.prepare_current_quadrature(images), nec_exception);
}

TEST_CASE("WP2 prepared quadrature latest-solution zero current and disposal",
          "[wasm_api][current_quadrature][wp2_current]")
{
  nec_stateful_model model;
  build_stateful(model, dipole_wires(), {{1, 6}});
  model.solve_port_currents({ nec_complex(0.0, 0.0) });
  nec_prepared_quadrature_request request = four_node_request(
    nec_current_mode_kind::latest_solution);
  nec_prepared_current_quadrature prepared =
    model.prepare_current_quadrature(request);
  const nec_prepared_quadrature_view view =
    nec_view_prepared_quadrature(prepared);
  REQUIRE(view.n_modes == 1);
  REQUIRE(view.solution_generation == model.solve_generation());
  for (size_t segment = 0; segment < view.n_segments; ++segment) {
    for (size_t node = 0; node < view.n_nodes; ++node) {
      const nec_complex current = view.current_at(0, 0, segment, node);
      REQUIRE(std::abs(current) < kRelativeL2SamePath);
    }
  }

  prepared.release();
  REQUIRE(prepared.data() == nullptr);
  REQUIRE(prepared.byte_length() == 0);
  REQUIRE_THROWS_AS(nec_view_prepared_quadrature(prepared), nec_exception);
  prepared.release();
  REQUIRE(prepared.data() == nullptr);
}

TEST_CASE("WP2 prepared quadrature unit-current restores the consumer solution",
          "[wasm_api][current_quadrature][wp2_current]")
{
  nec_stateful_model model;
  build_stateful(model, insulated_turnstile_wires(), {{1, 6}, {2, 6}});
  const nec_port_solution solution = model.solve_port_voltages_detailed({
    nec_complex(1.0, 0.0), nec_complex(0.5, -0.25),
  });
  const uint64_t generation = model.solve_generation();
  const nec_far_field_grid grid{ 1.0, 0.0, 5, 45.0, 0.0, 3, 90.0 };
  const nec_far_field_result before = model.compute_far_field(grid);

  const nec_prepared_current_quadrature prepared =
    model.prepare_current_quadrature(four_node_request());
  REQUIRE(prepared.byte_length() > 0);
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

TEST_CASE("WP2 prepared quadrature large jobs do not grow on retrieve",
          "[wasm_api][current_quadrature][wp2_current]")
{
  nec_stateful_model model;
  build_stateful(model, insulated_turnstile_wires(), {{1, 6}, {2, 6}});
  nec_prepared_quadrature_request request;
  request.nodes.resize(64);
  for (size_t index = 0; index < request.nodes.size(); ++index) {
    const nec_float xi = -1.0 + 2.0 * static_cast<nec_float>(index) /
      static_cast<nec_float>(request.nodes.size() - 1);
    request.nodes[index] = xi;
  }
  request.modes = nec_current_mode_kind::unit_current;
  const nec_prepared_current_quadrature prepared =
    model.prepare_current_quadrature(request);
  REQUIRE(prepared.byte_length() == nec_prepared_quadrature_packed_bytes(
    2, 22, 64, 1));
  require_hot_path_frozen(prepared);
  const size_t capacity = prepared.packed.capacity();
  for (int pass = 0; pass < 20; ++pass)
    (void)nec_view_prepared_quadrature(prepared);
  REQUIRE(prepared.packed.capacity() == capacity);
}

TEST_CASE("WP2 prepared quadrature native baseline JSON is recorded",
          "[wasm_api][current_quadrature][wp2_current][baseline]")
{
  const auto request = four_node_request();

  nec_stateful_model dipole;
  build_stateful(dipole, dipole_wires(), {{1, 6}});
  const auto dipole_prepare_started = std::chrono::steady_clock::now();
  const nec_prepared_current_quadrature dipole_prepared =
    dipole.prepare_current_quadrature(request);
  const nec_float dipole_prepare_ms =
    std::chrono::duration<nec_float, std::milli>(
      std::chrono::steady_clock::now() - dipole_prepare_started).count();
  const auto dipole_retrieve_started = std::chrono::steady_clock::now();
  volatile size_t dipole_bytes = 0;
  for (int pass = 0; pass < 1000; ++pass) {
    const nec_prepared_quadrature_view view =
      nec_view_prepared_quadrature(dipole_prepared);
    dipole_bytes = view.geometry_count + dipole_prepared.byte_length();
  }
  const nec_float dipole_retrieve_ms =
    std::chrono::duration<nec_float, std::milli>(
      std::chrono::steady_clock::now() - dipole_retrieve_started).count() /
    1000.0;
  (void)dipole_bytes;

  nec_stateful_model turnstile;
  build_stateful(turnstile, insulated_turnstile_wires(), {{1, 6}, {2, 6}});
  const auto turnstile_prepare_started = std::chrono::steady_clock::now();
  const nec_prepared_current_quadrature turnstile_prepared =
    turnstile.prepare_current_quadrature(request);
  const nec_float turnstile_prepare_ms =
    std::chrono::duration<nec_float, std::milli>(
      std::chrono::steady_clock::now() - turnstile_prepare_started).count();
  const auto turnstile_retrieve_started = std::chrono::steady_clock::now();
  volatile size_t turnstile_bytes = 0;
  for (int pass = 0; pass < 1000; ++pass) {
    const nec_prepared_quadrature_view view =
      nec_view_prepared_quadrature(turnstile_prepared);
    turnstile_bytes = view.geometry_count + turnstile_prepared.byte_length();
  }
  const nec_float turnstile_retrieve_ms =
    std::chrono::duration<nec_float, std::milli>(
      std::chrono::steady_clock::now() - turnstile_retrieve_started).count() /
    1000.0;
  (void)turnstile_bytes;

  const std::filesystem::path destination =
    std::filesystem::path(__FILE__).parent_path().parent_path()
    / "packages" / "necpp-wasm" / "bench" / "evidence"
    / "current-quadrature-wp2" / "native-baseline.json";
  std::filesystem::create_directories(destination.parent_path());
  std::ofstream output(destination, std::ios::trunc);
  REQUIRE(output.good());
  output << "{\n"
    << "  \"type\": \"current-quadrature-wp2-native-baseline\",\n"
    << "  \"schemaVersion\": 1,\n"
    << "  \"host\": \"windows-msvc-release\",\n"
    << "  \"nodes\": 4,\n"
    << "  \"budgets\": {\n"
    << "    \"preparedGeometryBytes\": \"9 * nSeg * nNodes * nImagePlanes * 8\",\n"
    << "    \"preparedCurrentBytes\": \"nModes * nSeg * nNodes * nImagePlanes * 16\"\n"
    << "  },\n"
    << "  \"dipole\": {\n"
    << "    \"segmentCount\": 11,\n"
    << "    \"modeCount\": 1,\n"
    << "    \"packedBytes\": " << dipole_prepared.byte_length() << ",\n"
    << "    \"geometryBytes\": 3168,\n"
    << "    \"currentBytes\": 704,\n"
    << "    \"prepareMs\": " << dipole_prepare_ms << ",\n"
    << "    \"retrieveMs\": " << dipole_retrieve_ms << ",\n"
    << "    \"geometryWalks\": " << dipole_prepared.diagnostics.geometry_walks << ",\n"
    << "    \"trigonometryEvaluations\": "
    << dipole_prepared.diagnostics.trigonometry_evaluations << ",\n"
    << "    \"interpolations\": " << dipole_prepared.diagnostics.interpolations << ",\n"
    << "    \"growingAllocations\": "
    << dipole_prepared.diagnostics.growing_allocations << "\n"
    << "  },\n"
    << "  \"turnstile-insulated\": {\n"
    << "    \"segmentCount\": 22,\n"
    << "    \"modeCount\": 2,\n"
    << "    \"packedBytes\": " << turnstile_prepared.byte_length() << ",\n"
    << "    \"geometryBytes\": 6336,\n"
    << "    \"currentBytes\": 2816,\n"
    << "    \"prepareMs\": " << turnstile_prepare_ms << ",\n"
    << "    \"retrieveMs\": " << turnstile_retrieve_ms << ",\n"
    << "    \"geometryWalks\": "
    << turnstile_prepared.diagnostics.geometry_walks << ",\n"
    << "    \"trigonometryEvaluations\": "
    << turnstile_prepared.diagnostics.trigonometry_evaluations << ",\n"
    << "    \"interpolations\": "
    << turnstile_prepared.diagnostics.interpolations << ",\n"
    << "    \"growingAllocations\": "
    << turnstile_prepared.diagnostics.growing_allocations << "\n"
    << "  }\n"
    << "}\n";
  REQUIRE(output.good());
}
