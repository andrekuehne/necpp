#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include "current_quadrature_fixtures.h"
#include "nec_stateful_model.h"
#include "necpp_wasm_v1.h"

#include <cstdint>
#include <cstring>
#include <iterator>
#include <memory>
#include <string>
#include <vector>

using current_quadrature_fixtures::build_stateful;
using current_quadrature_fixtures::dipole_wires;
using current_quadrature_fixtures::monopole_wires;

namespace {

constexpr double kFourNodes[] = { -1.0, -1.0 / 3.0, 1.0 / 3.0, 1.0 };
constexpr size_t kFourNodeCount = 4;

const nec_far_field_grid kFieldGrid{
  1.0,
  30.0, 5, 30.0,
  0.0, 3, 90.0,
};

uint32_t load_u32_le(const uint8_t* src)
{
  return static_cast<uint32_t>(src[0]) |
    (static_cast<uint32_t>(src[1]) << 8) |
    (static_cast<uint32_t>(src[2]) << 16) |
    (static_cast<uint32_t>(src[3]) << 24);
}

using AbiModel =
  std::unique_ptr<necpp_wasm_v1_model, decltype(&necpp_wasm_v1_model_delete)>;

AbiModel make_abi()
{
  return AbiModel(necpp_wasm_v1_model_create(), &necpp_wasm_v1_model_delete);
}

void build_abi_dipole(necpp_wasm_v1_model* model)
{
  REQUIRE(necpp_wasm_v1_add_wire(
    model, 1, 11,
    0.0, 0.0, -0.25,
    0.0, 0.0, 0.25,
    0.001) == NECPP_WASM_V1_OK);
  REQUIRE(necpp_wasm_v1_complete_geometry(
    model, NECPP_WASM_V1_GROUND_CONNECTION_NONE) == NECPP_WASM_V1_OK);
  const int32_t tags[] = {1};
  const int32_t segments[] = {6};
  REQUIRE(necpp_wasm_v1_define_ports(model, tags, segments, 1) == NECPP_WASM_V1_OK);
  REQUIRE(necpp_wasm_v1_prepare(model, 300.0) == NECPP_WASM_V1_OK);
}

void build_abi_monopole(necpp_wasm_v1_model* model)
{
  REQUIRE(necpp_wasm_v1_add_wire(
    model, 1, 11,
    0.0, 0.0, 0.0,
    0.0, 0.0, 0.25,
    0.001) == NECPP_WASM_V1_OK);
  REQUIRE(necpp_wasm_v1_complete_geometry(
    model, NECPP_WASM_V1_GROUND_CONNECTION_INTERPOLATE) == NECPP_WASM_V1_OK);
  const int32_t tags[] = {1};
  const int32_t segments[] = {1};
  REQUIRE(necpp_wasm_v1_define_ports(model, tags, segments, 1) == NECPP_WASM_V1_OK);
  REQUIRE(necpp_wasm_v1_set_ground(
    model, NECPP_WASM_V1_GROUND_PERFECT, 0.0, 0.0) == NECPP_WASM_V1_OK);
  REQUIRE(necpp_wasm_v1_prepare(model, 300.0) == NECPP_WASM_V1_OK);
}

int32_t prepare_four_node(
  necpp_wasm_v1_model* model, int32_t images, int32_t modes)
{
  return necpp_wasm_v1_prepare_current_quadrature(
    model, kFourNodes, kFourNodeCount, nullptr, 0, images, modes);
}

int32_t characterize_four_node(necpp_wasm_v1_model* model, int32_t images)
{
  return necpp_wasm_v1_characterize_isolated_element(
    model, kFourNodes, kFourNodeCount, nullptr, 0, images,
    kFieldGrid.radius_m,
    kFieldGrid.theta_start_deg, kFieldGrid.theta_count, kFieldGrid.theta_step_deg,
    kFieldGrid.phi_start_deg, kFieldGrid.phi_count, kFieldGrid.phi_step_deg);
}

void require_magic(const uint8_t* bytes, const char* magic)
{
  REQUIRE(bytes != nullptr);
  REQUIRE(bytes[0] == static_cast<uint8_t>(magic[0]));
  REQUIRE(bytes[1] == static_cast<uint8_t>(magic[1]));
  REQUIRE(bytes[2] == static_cast<uint8_t>(magic[2]));
  REQUIRE(bytes[3] == static_cast<uint8_t>(magic[3]));
  REQUIRE(load_u32_le(bytes + 4) == 1u);
}

} // namespace

TEST_CASE("WP4 ABI current planes match native unit-current distribution",
          "[wasm_api][current_quadrature][wp4_current]")
{
  nec_stateful_model native;
  build_stateful(native, dipole_wires(), {{1, 6}});
  const nec_current_distribution expected =
    native.get_current_distribution(nec_current_mode_kind::unit_current);

  AbiModel abi = make_abi();
  REQUIRE(abi != nullptr);
  build_abi_dipole(abi.get());
  REQUIRE(necpp_wasm_v1_get_current_distribution(
    abi.get(), NECPP_WASM_V1_CURRENT_UNIT_CURRENT) == NECPP_WASM_V1_OK);
  REQUIRE(necpp_wasm_v1_current_segment_count(abi.get()) == expected.segment_count());
  REQUIRE(necpp_wasm_v1_current_mode_count(abi.get()) == expected.mode_count);
  REQUIRE(necpp_wasm_v1_current_mode_kind(abi.get()) ==
    NECPP_WASM_V1_CURRENT_UNIT_CURRENT);
  REQUIRE(necpp_wasm_v1_current_frequency_mhz(abi.get()) ==
    Catch::Approx(expected.frequency_mhz));
  REQUIRE(necpp_wasm_v1_current_wavelength_m(abi.get()) ==
    Catch::Approx(expected.wavelength_m));

  const int32_t* tags = necpp_wasm_v1_int32_result_buffer(
    abi.get(), NECPP_WASM_V1_CURRENT_TAG);
  const int32_t* segments = necpp_wasm_v1_int32_result_buffer(
    abi.get(), NECPP_WASM_V1_CURRENT_SEGMENT);
  const int32_t* native_index = necpp_wasm_v1_int32_result_buffer(
    abi.get(), NECPP_WASM_V1_CURRENT_NATIVE_INDEX);
  REQUIRE(tags != nullptr);
  REQUIRE(segments != nullptr);
  REQUIRE(native_index != nullptr);
  REQUIRE(necpp_wasm_v1_int32_result_buffer_length(
    abi.get(), NECPP_WASM_V1_CURRENT_TAG) == expected.segment_count());
  for (size_t index = 0; index < expected.segment_count(); ++index) {
    REQUIRE(tags[index] == expected.segments[index].tag);
    REQUIRE(segments[index] == expected.segments[index].segment);
    REQUIRE(native_index[index] == expected.segments[index].native_index);
  }

  const double* a_real = necpp_wasm_v1_result_buffer(
    abi.get(), NECPP_WASM_V1_CURRENT_A_REAL);
  const double* a_imag = necpp_wasm_v1_result_buffer(
    abi.get(), NECPP_WASM_V1_CURRENT_A_IMAG);
  REQUIRE(a_real != nullptr);
  REQUIRE(a_imag != nullptr);
  REQUIRE(necpp_wasm_v1_result_buffer_length(
    abi.get(), NECPP_WASM_V1_CURRENT_A_REAL) == expected.a_real.size());
  for (size_t index = 0; index < expected.a_real.size(); ++index) {
    REQUIRE(a_real[index] == Catch::Approx(expected.a_real[index])
      .epsilon(1.0e-12).margin(1.0e-12));
    REQUIRE(a_imag[index] == Catch::Approx(expected.a_imag[index])
      .epsilon(1.0e-12).margin(1.0e-12));
  }

  const double* centres = necpp_wasm_v1_result_buffer(
    abi.get(), NECPP_WASM_V1_CURRENT_CENTRES);
  REQUIRE(centres != nullptr);
  REQUIRE(necpp_wasm_v1_result_buffer_length(
    abi.get(), NECPP_WASM_V1_CURRENT_CENTRES) == expected.centres_m.size());
  REQUIRE(centres[2] == Catch::Approx(expected.centres_m[2])
    .epsilon(1.0e-12).margin(1.0e-12));
}

TEST_CASE("WP4 ABI packed NECQ matches native prepare size and magic",
          "[wasm_api][current_quadrature][wp4_current]")
{
  nec_stateful_model native;
  build_stateful(native, dipole_wires(), {{1, 6}});
  nec_prepared_quadrature_request request;
  request.nodes.assign(std::begin(kFourNodes), std::end(kFourNodes));
  request.images = nec_prepared_quadrature_images::physical_only;
  request.modes = nec_current_mode_kind::unit_current;
  const nec_prepared_current_quadrature prepared =
    native.prepare_current_quadrature(request);

  AbiModel abi = make_abi();
  build_abi_dipole(abi.get());
  REQUIRE(prepare_four_node(
    abi.get(),
    NECPP_WASM_V1_QUADRATURE_PHYSICAL_ONLY,
    NECPP_WASM_V1_CURRENT_UNIT_CURRENT) == NECPP_WASM_V1_OK);
  const uint8_t* packed = necpp_wasm_v1_packed_buffer(
    abi.get(), NECPP_WASM_V1_PACKED_QUADRATURE);
  const size_t length = necpp_wasm_v1_packed_buffer_length(
    abi.get(), NECPP_WASM_V1_PACKED_QUADRATURE);
  REQUIRE(length == prepared.byte_length());
  REQUIRE(length == 4072);
  require_magic(packed, "NECQ");
  REQUIRE(std::memcmp(packed, prepared.data(), length) == 0);

  const uint8_t* first = packed;
  const uint8_t* second = necpp_wasm_v1_packed_buffer(
    abi.get(), NECPP_WASM_V1_PACKED_QUADRATURE);
  REQUIRE(first == second);
  REQUIRE(necpp_wasm_v1_packed_buffer_length(
    abi.get(), NECPP_WASM_V1_PACKED_QUADRATURE) == length);
}

TEST_CASE("WP4 ABI characterize matches native Z/Y, NECQ, and NECF envelope",
          "[wasm_api][current_quadrature][wp4_current]")
{
  nec_stateful_model native;
  build_stateful(native, dipole_wires(), {{1, 6}});
  nec_isolated_element_request request;
  request.quadrature.nodes.assign(std::begin(kFourNodes), std::end(kFourNodes));
  request.quadrature.images = nec_prepared_quadrature_images::physical_only;
  request.quadrature.modes = nec_current_mode_kind::unit_current;
  request.grid = kFieldGrid;
  const nec_isolated_element_characterization expected =
    native.characterize_isolated_element(request);

  AbiModel abi = make_abi();
  build_abi_dipole(abi.get());
  REQUIRE(necpp_wasm_v1_compute_embedded_far_fields(
    abi.get(),
    kFieldGrid.radius_m,
    kFieldGrid.theta_start_deg, kFieldGrid.theta_count, kFieldGrid.theta_step_deg,
    kFieldGrid.phi_start_deg, kFieldGrid.phi_count, kFieldGrid.phi_step_deg,
    NECPP_WASM_V1_UNIT_VOLTAGE) == NECPP_WASM_V1_OK);
  const double* prior_embedded = necpp_wasm_v1_result_buffer(
    abi.get(), NECPP_WASM_V1_EMBEDDED_E_THETA_REAL);
  REQUIRE(prior_embedded != nullptr);
  const size_t prior_length = necpp_wasm_v1_result_buffer_length(
    abi.get(), NECPP_WASM_V1_EMBEDDED_E_THETA_REAL);
  const double prior_sample = prior_embedded[0];
  REQUIRE(necpp_wasm_v1_embedded_normalization(abi.get()) ==
    NECPP_WASM_V1_UNIT_VOLTAGE);

  REQUIRE(characterize_four_node(
    abi.get(), NECPP_WASM_V1_QUADRATURE_PHYSICAL_ONLY) == NECPP_WASM_V1_OK);

  REQUIRE(necpp_wasm_v1_impedance_order(abi.get()) ==
    expected.matrices.impedance.rows);
  const double* z_real = necpp_wasm_v1_result_buffer(
    abi.get(), NECPP_WASM_V1_IMPEDANCE_REAL);
  const double* z_imag = necpp_wasm_v1_result_buffer(
    abi.get(), NECPP_WASM_V1_IMPEDANCE_IMAG);
  REQUIRE(z_real[0] == Catch::Approx(expected.matrices.impedance.values[0].real())
    .epsilon(1.0e-12).margin(1.0e-12));
  REQUIRE(z_imag[0] == Catch::Approx(expected.matrices.impedance.values[0].imag())
    .epsilon(1.0e-12).margin(1.0e-12));

  const uint8_t* necq = necpp_wasm_v1_packed_buffer(
    abi.get(), NECPP_WASM_V1_PACKED_QUADRATURE);
  require_magic(necq, "NECQ");
  REQUIRE(necpp_wasm_v1_packed_buffer_length(
    abi.get(), NECPP_WASM_V1_PACKED_QUADRATURE) ==
    expected.quadrature.byte_length());
  REQUIRE(std::memcmp(
    necq, expected.quadrature.data(), expected.quadrature.byte_length()) == 0);

  const uint8_t* necf = necpp_wasm_v1_packed_buffer(
    abi.get(), NECPP_WASM_V1_PACKED_EMBEDDED_FIELD);
  const size_t necf_length = necpp_wasm_v1_packed_buffer_length(
    abi.get(), NECPP_WASM_V1_PACKED_EMBEDDED_FIELD);
  require_magic(necf, "NECF");
  REQUIRE(load_u32_le(necf + 8) == 1u);
  REQUIRE(load_u32_le(necf + 12) == 5u);
  REQUIRE(load_u32_le(necf + 16) == 3u);
  REQUIRE(load_u32_le(necf + 20) == 15u);
  const size_t expected_necf =
    64 + (5 + 3 + 4 * 15) * sizeof(double);
  REQUIRE(necf_length == expected_necf);

  REQUIRE(necpp_wasm_v1_embedded_normalization(abi.get()) ==
    NECPP_WASM_V1_UNIT_VOLTAGE);
  REQUIRE(necpp_wasm_v1_result_buffer_length(
    abi.get(), NECPP_WASM_V1_EMBEDDED_E_THETA_REAL) == prior_length);
  REQUIRE(necpp_wasm_v1_result_buffer(
    abi.get(), NECPP_WASM_V1_EMBEDDED_E_THETA_REAL)[0] ==
    Catch::Approx(prior_sample));
}

TEST_CASE("WP4 ABI rooted-monopole images stay out of plane 0",
          "[wasm_api][current_quadrature][wp4_current]")
{
  AbiModel abi = make_abi();
  build_abi_monopole(abi.get());
  REQUIRE(prepare_four_node(
    abi.get(),
    NECPP_WASM_V1_QUADRATURE_PERFECT_GROUND_IMAGES,
    NECPP_WASM_V1_CURRENT_UNIT_CURRENT) == NECPP_WASM_V1_OK);
  const uint8_t* packed = necpp_wasm_v1_packed_buffer(
    abi.get(), NECPP_WASM_V1_PACKED_QUADRATURE);
  require_magic(packed, "NECQ");
  const uint32_t flags = load_u32_le(packed + 8);
  REQUIRE((flags & 1u) != 0);
  REQUIRE(load_u32_le(packed + 24) == 2u);

  nec_stateful_model native;
  build_stateful(
    native, monopole_wires(), {{1, 1}},
    nec_ground_connection::interpolate, nec_ground_kind::perfect);
  nec_prepared_quadrature_request request;
  request.nodes.assign(std::begin(kFourNodes), std::end(kFourNodes));
  request.images = nec_prepared_quadrature_images::perfect_ground_images;
  request.modes = nec_current_mode_kind::unit_current;
  const nec_prepared_current_quadrature prepared =
    native.prepare_current_quadrature(request);
  const nec_prepared_quadrature_view view =
    nec_view_prepared_quadrature(prepared);
  REQUIRE(view.n_image_planes == 2);
  REQUIRE(view.has_images());
  REQUIRE(view.z[view.geometry_index(0, 0, 3)] > 0.0);
  REQUIRE(view.z[view.geometry_index(1, 0, 3)] < 0.0);
  REQUIRE(necpp_wasm_v1_packed_buffer_length(
    abi.get(), NECPP_WASM_V1_PACKED_QUADRATURE) == prepared.byte_length());
  REQUIRE(std::memcmp(packed, prepared.data(), prepared.byte_length()) == 0);
}

TEST_CASE("WP4 ABI current capture does not clear impedance",
          "[wasm_api][current_quadrature][wp4_current]")
{
  AbiModel abi = make_abi();
  build_abi_dipole(abi.get());
  REQUIRE(necpp_wasm_v1_compute_impedance(abi.get()) == NECPP_WASM_V1_OK);
  const double z00 = necpp_wasm_v1_result_buffer(
    abi.get(), NECPP_WASM_V1_IMPEDANCE_REAL)[0];
  REQUIRE(necpp_wasm_v1_get_current_distribution(
    abi.get(), NECPP_WASM_V1_CURRENT_UNIT_CURRENT) == NECPP_WASM_V1_OK);
  REQUIRE(necpp_wasm_v1_impedance_order(abi.get()) == 1);
  REQUIRE(necpp_wasm_v1_result_buffer(
    abi.get(), NECPP_WASM_V1_IMPEDANCE_REAL)[0] == Catch::Approx(z00));
}

TEST_CASE("WP4 ABI rejects latest-solution from prepared and images without PEC",
          "[wasm_api][current_quadrature][wp4_current]")
{
  AbiModel abi = make_abi();
  build_abi_dipole(abi.get());
  REQUIRE(necpp_wasm_v1_get_current_distribution(
    abi.get(), NECPP_WASM_V1_CURRENT_LATEST_SOLUTION) ==
    NECPP_WASM_V1_STATE_ERROR);
  REQUIRE(prepare_four_node(
    abi.get(),
    NECPP_WASM_V1_QUADRATURE_PHYSICAL_ONLY,
    NECPP_WASM_V1_CURRENT_LATEST_SOLUTION) == NECPP_WASM_V1_STATE_ERROR);
  REQUIRE(prepare_four_node(
    abi.get(),
    NECPP_WASM_V1_QUADRATURE_PERFECT_GROUND_IMAGES,
    NECPP_WASM_V1_CURRENT_UNIT_CURRENT) == NECPP_WASM_V1_INPUT_ERROR);
  REQUIRE(characterize_four_node(
    abi.get(), NECPP_WASM_V1_QUADRATURE_PERFECT_GROUND_IMAGES) ==
    NECPP_WASM_V1_INPUT_ERROR);
  REQUIRE(necpp_wasm_v1_get_current_distribution(
    abi.get(), 2) == NECPP_WASM_V1_INPUT_ERROR);
}
