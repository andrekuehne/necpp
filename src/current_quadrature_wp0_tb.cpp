#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include "c_geometry.h"
#include "electromag.h"
#include "nec_context.h"
#include "nec_exception.h"
#include "nec_stateful_model.h"

#include <chrono>
#include <cmath>
#include <complex>
#include <filesystem>
#include <fstream>
#include <vector>

namespace {

constexpr nec_float kFrequencyMHz = 300.0;
constexpr nec_float kRadiusM = 0.001;
constexpr nec_float kTurnstileOffsetM = 0.001;
constexpr int kDipoleSegments = 11;
constexpr int kArmSegments = 5;
constexpr nec_float kRelativeL2UnitCurrent = 1.0e-7;
constexpr nec_float kRelativeL2SamePath = 1.0e-12;
constexpr nec_float kRelativeL2StraightFeedCurrent = 1.0e-4;
constexpr nec_float kRelativeL2JunctionFeedCurrent = 1.0e-3;

nec_wire_definition wire(
  int tag, int segments,
  nec_float x1, nec_float y1, nec_float z1,
  nec_float x2, nec_float y2, nec_float z2)
{
  return { tag, segments, x1, y1, z1, x2, y2, z2, kRadiusM };
}

std::vector<nec_wire_definition> dipole_wires()
{
  return { wire(1, kDipoleSegments, 0.0, 0.0, -0.25, 0.0, 0.0, 0.25) };
}

std::vector<nec_wire_definition> monopole_wires()
{
  return { wire(1, kDipoleSegments, 0.0, 0.0, 0.0, 0.0, 0.0, 0.25) };
}

std::vector<nec_wire_definition> bent_wires()
{
  return {
    wire(1, kArmSegments, -0.25, 0.0, 0.25, 0.0, 0.0, 0.0),
    wire(2, kArmSegments, 0.0, 0.0, 0.0, 0.25, 0.0, 0.25),
  };
}

std::vector<nec_wire_definition> insulated_turnstile_wires()
{
  return {
    wire(1, kDipoleSegments, -0.25, 0.0, kTurnstileOffsetM, 0.25, 0.0, kTurnstileOffsetM),
    wire(2, kDipoleSegments, 0.0, -0.25, -kTurnstileOffsetM, 0.0, 0.25, -kTurnstileOffsetM),
  };
}

std::vector<nec_wire_definition> connected_turnstile_wires()
{
  return {
    wire(1, kArmSegments, -0.25, 0.0, 0.0, 0.0, 0.0, 0.0),
    wire(2, kArmSegments, 0.0, 0.0, 0.0, 0.25, 0.0, 0.0),
    wire(3, kArmSegments, 0.0, -0.25, 0.0, 0.0, 0.0, 0.0),
    wire(4, kArmSegments, 0.0, 0.0, 0.0, 0.0, 0.25, 0.0),
  };
}

void add_wires(nec_stateful_model& model,
  const std::vector<nec_wire_definition>& wires)
{
  for (const nec_wire_definition& item : wires)
    model.add_wire(item);
}

void add_wires(nec_context& model, const std::vector<nec_wire_definition>& wires)
{
  for (const nec_wire_definition& item : wires) {
    model.get_geometry()->wire(
      item.tag, item.segments,
      item.x1, item.y1, item.z1,
      item.x2, item.y2, item.z2,
      item.radius_m, 1.0, 1.0);
  }
}

void build_stateful(
  nec_stateful_model& model,
  const std::vector<nec_wire_definition>& wires,
  const std::vector<nec_port_definition>& ports,
  nec_ground_connection connection = nec_ground_connection::none,
  nec_ground_kind ground = nec_ground_kind::free_space)
{
  add_wires(model, wires);
  model.complete_geometry(connection);
  model.define_ports(ports);
  if (ground != nec_ground_kind::free_space)
    model.set_ground({ ground, 0.0, 0.0 });
  model.prepare(kFrequencyMHz);
}

c_geometry* complete_native(
  nec_context& model,
  const std::vector<nec_wire_definition>& wires,
  int ground_flag)
{
  model.initialize();
  add_wires(model, wires);
  model.geometry_complete(ground_flag);
  return model.get_geometry();
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

int tag_of(const c_geometry& geometry, int native_index)
{
  return geometry.segment_tags[native_index];
}

int segment_in_tag(const c_geometry& geometry, int native_index)
{
  const int tag = tag_of(geometry, native_index);
  int count = 0;
  for (int64_t index = 0; index <= native_index; ++index) {
    if (geometry.segment_tags[index] == tag)
      ++count;
  }
  return count;
}

bool connects_across_tags(const c_geometry& geometry)
{
  for (int64_t index = 0; index < geometry.n_segments; ++index) {
    const int tag = geometry.segment_tags[index];
    for (int icon : { geometry.icon1[index], geometry.icon2[index] }) {
      if (icon == 0 || icon == static_cast<int>(index) + 1)
        continue;
      const int other = std::abs(icon) - 1;
      if (other < 0 || other >= geometry.n_segments)
        continue;
      if (geometry.segment_tags[other] != tag)
        return true;
    }
  }
  return false;
}

int grounded_end_count(const c_geometry& geometry)
{
  int count = 0;
  for (int64_t index = 0; index < geometry.n_segments; ++index) {
    const int self = static_cast<int>(index) + 1;
    if (geometry.icon1[index] == self || geometry.icon2[index] == self)
      ++count;
  }
  return count;
}

nec_complex centre_current(const nec_far_field_snapshot& snapshot, size_t index)
{
  return nec_complex(
    snapshot.air[index] + snapshot.cir[index],
    snapshot.aii[index] + snapshot.cii[index]);
}

void require_public_order(
  const c_geometry& geometry,
  const std::vector<nec_wire_definition>& wires)
{
  size_t native = 0;
  for (const nec_wire_definition& item : wires) {
    for (int segment = 1; segment <= item.segments; ++segment) {
      REQUIRE(native < static_cast<size_t>(geometry.n_segments));
      REQUIRE(tag_of(geometry, static_cast<int>(native)) == item.tag);
      REQUIRE(segment_in_tag(geometry, static_cast<int>(native)) == segment);
      ++native;
    }
  }
  REQUIRE(native == static_cast<size_t>(geometry.n_segments));
}

} // namespace

TEST_CASE("WP0 current-quadrature dipole locks polarity and centre current",
          "[wasm_api][current_quadrature][wp0_current]")
{
  nec_context native;
  const c_geometry* geometry = complete_native(native, dipole_wires(), 0);
  REQUIRE(geometry->n_segments == kDipoleSegments);
  require_public_order(*geometry, dipole_wires());
  REQUIRE_FALSE(connects_across_tags(*geometry));
  REQUIRE(geometry->icon1[0] == 0);
  REQUIRE(geometry->icon2[geometry->n_segments - 1] == 0);

  nec_stateful_model model;
  build_stateful(model, dipole_wires(), {{1, 6}});
  const nec_impedance_result matrices = model.compute_impedance_matrix();
  REQUIRE(matrices.impedance.rows == 1);
  REQUIRE(matrices.impedance.columns == 1);
  REQUIRE(matrices.admittance.rows == 1);
  REQUIRE(finite_complex(matrices.impedance.at(0, 0)));

  const nec_port_solution solution =
    model.solve_port_voltages_detailed({ nec_complex(1.0, 0.0) });
  REQUIRE(solution.currents[0].real() > 0.0);
  REQUIRE(solution.powers_w[0] == Catch::Approx(
    0.5 * std::real(solution.voltages[0] * std::conj(solution.currents[0])))
    .epsilon(kRelativeL2SamePath));

  const nec_far_field_snapshot snapshot = model.capture_far_field_snapshot();
  REQUIRE(snapshot.capability == nec_far_field_snapshot_capability::supported);
  REQUIRE(snapshot.segment_count() == static_cast<size_t>(kDipoleSegments));
  REQUIRE(snapshot.perfect_ground == false);
  REQUIRE(relative_error(centre_current(snapshot, 5), solution.currents[0])
    < kRelativeL2StraightFeedCurrent);

  const nec_port_solution unit = model.solve_port_currents({ nec_complex(1.0, 0.0) });
  REQUIRE(relative_error(unit.currents[0], nec_complex(1.0, 0.0))
    < kRelativeL2UnitCurrent);

  const auto started = std::chrono::steady_clock::now();
  const nec_far_field_grid grid{ 1.0, 0.0, 19, 10.0, 0.0, 37, 10.0 };
  const nec_embedded_far_field_result embedded =
    model.compute_embedded_far_fields(
      grid, nec_embedded_field_normalization::unit_current);
  const nec_float embedded_ms = std::chrono::duration<nec_float, std::milli>(
    std::chrono::steady_clock::now() - started).count();
  REQUIRE(embedded.samples_per_port == 19 * 37);
  const auto snapshot_started = std::chrono::steady_clock::now();
  const nec_far_field_snapshot timed_snapshot = model.capture_far_field_snapshot();
  const nec_float snapshot_ms = std::chrono::duration<nec_float, std::milli>(
    std::chrono::steady_clock::now() - snapshot_started).count();
  REQUIRE(timed_snapshot.segment_count() == static_cast<size_t>(kDipoleSegments));
  UNSCOPED_INFO("dipole embedded 19x37 ms " << embedded_ms);
  UNSCOPED_INFO("dipole snapshot capture ms " << snapshot_ms);
  UNSCOPED_INFO("dipole snapshot bytes "
    << timed_snapshot.segment_count() * 13 * 8);
}

TEST_CASE("WP0 current-quadrature rooted monopole uses interpolate ground",
          "[wasm_api][current_quadrature][wp0_current]")
{
  nec_context native;
  const c_geometry* geometry = complete_native(native, monopole_wires(), 1);
  REQUIRE(geometry->n_segments == kDipoleSegments);
  require_public_order(*geometry, monopole_wires());
  REQUIRE(grounded_end_count(*geometry) == 1);
  REQUIRE(geometry->icon1[0] == 1);

  nec_stateful_model model;
  build_stateful(
    model, monopole_wires(), {{1, 1}},
    nec_ground_connection::interpolate, nec_ground_kind::perfect);
  const nec_port_solution solution =
    model.solve_port_voltages_detailed({ nec_complex(1.0, 0.0) });
  REQUIRE(solution.currents[0].real() > 0.0);

  const nec_far_field_snapshot snapshot = model.capture_far_field_snapshot();
  REQUIRE(snapshot.capability == nec_far_field_snapshot_capability::supported);
  REQUIRE(snapshot.perfect_ground == true);
  REQUIRE(relative_error(centre_current(snapshot, 0), solution.currents[0])
    < kRelativeL2StraightFeedCurrent);
}

TEST_CASE("WP0 current-quadrature bent multiwire locks the feed junction",
          "[wasm_api][current_quadrature][wp0_current]")
{
  nec_context native;
  const c_geometry* geometry = complete_native(native, bent_wires(), 0);
  REQUIRE(geometry->n_segments == 2 * kArmSegments);
  require_public_order(*geometry, bent_wires());
  REQUIRE(connects_across_tags(*geometry));
  const int junction_native = kArmSegments - 1;
  REQUIRE(tag_of(*geometry, junction_native) == 1);
  REQUIRE(segment_in_tag(*geometry, junction_native) == kArmSegments);
  REQUIRE(geometry->icon2[junction_native] != 0);

  nec_stateful_model model;
  build_stateful(model, bent_wires(), {{1, kArmSegments}});
  const nec_impedance_result matrices = model.compute_impedance_matrix();
  REQUIRE(matrices.impedance.rows == 1);
  const nec_port_solution unit =
    model.solve_port_currents({ nec_complex(1.0, 0.0) });
  REQUIRE(relative_error(unit.currents[0], nec_complex(1.0, 0.0))
    < kRelativeL2UnitCurrent);
  const nec_far_field_snapshot snapshot = model.capture_far_field_snapshot();
  REQUIRE(relative_error(
    centre_current(snapshot, static_cast<size_t>(junction_native)),
    unit.currents[0]) < kRelativeL2JunctionFeedCurrent);
}

TEST_CASE("WP0 current-quadrature insulated turnstile does not junction",
          "[wasm_api][current_quadrature][wp0_current]")
{
  nec_context native;
  const c_geometry* geometry =
    complete_native(native, insulated_turnstile_wires(), 0);
  REQUIRE(geometry->n_segments == 2 * kDipoleSegments);
  require_public_order(*geometry, insulated_turnstile_wires());
  REQUIRE_FALSE(connects_across_tags(*geometry));

  nec_stateful_model model;
  build_stateful(model, insulated_turnstile_wires(), {{1, 6}, {2, 6}});
  const nec_impedance_result matrices = model.compute_impedance_matrix();
  REQUIRE(matrices.impedance.rows == 2);
  REQUIRE(matrices.impedance.columns == 2);
  REQUIRE(finite_complex(matrices.impedance.at(0, 0)));
  REQUIRE(relative_error(
    matrices.impedance.at(0, 0), matrices.impedance.at(1, 1)) < 1.0e-8);
  REQUIRE(std::abs(matrices.impedance.at(0, 1))
    < 1.0e-6 * std::abs(matrices.impedance.at(0, 0)));

  const nec_port_solution unit = model.solve_port_currents({
    nec_complex(1.0, 0.0), nec_complex(0.0, 0.0),
  });
  REQUIRE(relative_error(unit.currents[0], nec_complex(1.0, 0.0))
    < kRelativeL2UnitCurrent);
  REQUIRE(relative_error(unit.currents[1], nec_complex(0.0, 0.0))
    < kRelativeL2UnitCurrent);

  const nec_far_field_grid grid{ 1.0, 0.0, 5, 45.0, 0.0, 3, 90.0 };
  const nec_embedded_far_field_result embedded =
    model.compute_embedded_far_fields(
      grid, nec_embedded_field_normalization::unit_current);
  REQUIRE(embedded.ports.size() == 2);
  REQUIRE(embedded.samples_per_port == 15);
  REQUIRE(model.last_port_solution().currents == unit.currents);

  const auto started = std::chrono::steady_clock::now();
  const nec_far_field_grid timed_grid{ 1.0, 0.0, 19, 10.0, 0.0, 37, 10.0 };
  const nec_embedded_far_field_result timed =
    model.compute_embedded_far_fields(
      timed_grid, nec_embedded_field_normalization::unit_current);
  const nec_float embedded_ms = std::chrono::duration<nec_float, std::milli>(
    std::chrono::steady_clock::now() - started).count();
  REQUIRE(timed.samples_per_port == 19 * 37);
  UNSCOPED_INFO("turnstile-insulated embedded 19x37 ms " << embedded_ms);
}

TEST_CASE("WP0 current-quadrature connected turnstile junctions at the origin",
          "[wasm_api][current_quadrature][wp0_current]")
{
  nec_context native;
  const c_geometry* geometry =
    complete_native(native, connected_turnstile_wires(), 0);
  REQUIRE(geometry->n_segments == 4 * kArmSegments);
  require_public_order(*geometry, connected_turnstile_wires());
  REQUIRE(connects_across_tags(*geometry));
  REQUIRE(geometry->icon2[kArmSegments - 1] != 0);
  REQUIRE(geometry->icon1[kArmSegments] != 0);
  REQUIRE(geometry->icon2[3 * kArmSegments - 1] != 0);
  REQUIRE(geometry->icon1[3 * kArmSegments] != 0);

  nec_stateful_model insulated;
  build_stateful(insulated, insulated_turnstile_wires(), {{1, 6}, {2, 6}});
  nec_stateful_model connected;
  build_stateful(connected, connected_turnstile_wires(), {
    {1, kArmSegments}, {3, kArmSegments},
  });
  const nec_impedance_result insulated_z = insulated.compute_impedance_matrix();
  const nec_impedance_result connected_z = connected.compute_impedance_matrix();
  REQUIRE(connected_z.impedance.rows == 2);
  REQUIRE(relative_error(
    insulated_z.impedance.at(0, 0), connected_z.impedance.at(0, 0)) > 1.0e-3);
  REQUIRE(std::abs(connected_z.impedance.at(0, 1))
    > 0.1 * std::abs(connected_z.impedance.at(0, 0)));

  const nec_port_solution unit = connected.solve_port_currents({
    nec_complex(1.0, 0.0), nec_complex(0.0, 0.0),
  });
  REQUIRE(relative_error(unit.currents[0], nec_complex(1.0, 0.0))
    < kRelativeL2UnitCurrent);
}

TEST_CASE("WP0 current-quadrature through-crossing dipoles are overlap errors",
          "[wasm_api][current_quadrature][wp0_current]")
{
  nec_stateful_model model;
  model.add_wire(wire(1, kDipoleSegments, -0.25, 0.0, 0.0, 0.25, 0.0, 0.0));
  model.add_wire(wire(2, kDipoleSegments, 0.0, -0.25, 0.0, 0.0, 0.25, 0.0));
  REQUIRE_THROWS_AS(model.complete_geometry(), nec_exception);
}

TEST_CASE("WP0 current-quadrature native baseline JSON is recorded",
          "[wasm_api][current_quadrature][wp0_current][baseline]")
{
  const nec_far_field_grid grid{ 1.0, 0.0, 19, 10.0, 0.0, 37, 10.0 };

  nec_stateful_model dipole;
  build_stateful(dipole, dipole_wires(), {{1, 6}});
  dipole.compute_impedance_matrix();
  dipole.solve_port_currents({ nec_complex(1.0, 0.0) });
  const auto dipole_field_started = std::chrono::steady_clock::now();
  dipole.compute_embedded_far_fields(
    grid, nec_embedded_field_normalization::unit_current);
  const nec_float dipole_embedded_ms =
    std::chrono::duration<nec_float, std::milli>(
      std::chrono::steady_clock::now() - dipole_field_started).count();
  const auto dipole_snapshot_started = std::chrono::steady_clock::now();
  const nec_far_field_snapshot dipole_snapshot =
    dipole.capture_far_field_snapshot();
  const nec_float dipole_snapshot_ms =
    std::chrono::duration<nec_float, std::milli>(
      std::chrono::steady_clock::now() - dipole_snapshot_started).count();

  nec_stateful_model turnstile;
  build_stateful(turnstile, insulated_turnstile_wires(), {{1, 6}, {2, 6}});
  turnstile.compute_impedance_matrix();
  turnstile.solve_port_currents({ nec_complex(1.0, 0.0), nec_complex(0.0, 0.0) });
  const auto turnstile_field_started = std::chrono::steady_clock::now();
  turnstile.compute_embedded_far_fields(
    grid, nec_embedded_field_normalization::unit_current);
  const nec_float turnstile_embedded_ms =
    std::chrono::duration<nec_float, std::milli>(
      std::chrono::steady_clock::now() - turnstile_field_started).count();
  const nec_far_field_snapshot turnstile_snapshot =
    turnstile.capture_far_field_snapshot();

  const std::filesystem::path destination =
    std::filesystem::path(__FILE__).parent_path().parent_path()
    / "packages" / "necpp-wasm" / "bench" / "evidence"
    / "current-quadrature-wp0" / "native-baseline.json";
  std::filesystem::create_directories(destination.parent_path());
  std::ofstream output(destination, std::ios::trunc);
  REQUIRE(output.good());
  output << "{\n"
    << "  \"type\": \"current-quadrature-wp0-native-baseline\",\n"
    << "  \"schemaVersion\": 1,\n"
    << "  \"host\": \"windows-msvc-release\",\n"
    << "  \"grid\": { \"thetaCount\": 19, \"phiCount\": 37 },\n"
    << "  \"budgets\": {\n"
    << "    \"internalSnapshotBytes\": \"13 * nSegments * 8\",\n"
    << "    \"exactCoefficientBytesPerMode\": \"6 * nSegments * 8\",\n"
    << "    \"embeddedFieldBytes\": \"4 * nPorts * nTheta * nPhi * 8\"\n"
    << "  },\n"
    << "  \"dipole\": {\n"
    << "    \"segmentCount\": " << dipole_snapshot.segment_count() << ",\n"
    << "    \"portCount\": 1,\n"
    << "    \"snapshotBytes\": " << dipole_snapshot.segment_count() * 13 * 8 << ",\n"
    << "    \"embeddedUnitCurrentMs\": " << dipole_embedded_ms << ",\n"
    << "    \"snapshotCaptureMs\": " << dipole_snapshot_ms << "\n"
    << "  },\n"
    << "  \"turnstile-insulated\": {\n"
    << "    \"segmentCount\": " << turnstile_snapshot.segment_count() << ",\n"
    << "    \"portCount\": 2,\n"
    << "    \"snapshotBytes\": "
    << turnstile_snapshot.segment_count() * 13 * 8 << ",\n"
    << "    \"embeddedUnitCurrentMs\": " << turnstile_embedded_ms << "\n"
    << "  }\n"
    << "}\n";
  REQUIRE(output.good());
}

