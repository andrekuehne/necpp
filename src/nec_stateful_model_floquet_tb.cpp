/*
  Floquet-mode amplitudes of the periodic unit cell: the power each port puts
  in returns as the power of the propagating Floquet modes plus the loss in
  the loads, and grating-lobe power appears in the modes the lattice puts into
  visible space. The (0,0) amplitude and the terminated amplitudes are tested
  against finite arrays and fresh solves at the WASM package seam.
*/
#include <catch2/catch_test_macros.hpp>

#include "electromag.h"
#include "nec_exception.h"
#include "nec_stateful_model.h"

#include <cmath>
#include <string>
#include <vector>

namespace {

constexpr nec_float frequency_mhz = 299.792458;  // about one metre wavelength
constexpr nec_float exact_pi = 3.141592653589793238462643383279502884;

// The engine's wavenumber: its speed of light follows from NEC's permittivity
// 8.854e-12, so one metre is not exactly one wavelength.
nec_float wavenumber_per_m()
{
  return 2 * exact_pi / em::get_wavelength(frequency_mhz * 1.0e6);
}

// A half-wave dipole along x at height z, 21 segments.
nec_wire_definition dipole_along_x(int tag, nec_float x, nec_float y, nec_float z, int segments = 21)
{
  return {tag, segments, x - 0.24, y, z, x + 0.24, y, z, 0.001};
}

struct cell_setup {
  std::vector<nec_wire_definition> wires;
  std::vector<nec_port_definition> ports;
  nec_lattice_definition lattice;
  bool perfect = false;
  std::vector<nec_load_definition> loads;
};

cell_setup one_dipole(nec_float spacing_x, nec_float spacing_y, nec_float z = 0.0)
{
  return {{dipole_along_x(1, 0.0, 0.0, z)}, {{1, 11}}, {spacing_x, 0.0, 0.0, spacing_y}};
}

// Two tilted, unequal wires: no symmetry relates the ports.
cell_setup tilted_pair()
{
  cell_setup setup;
  setup.wires = {{1, 21, -0.2, -0.05, 0.12, 0.2, 0.05, 0.36, 0.001},
                 {2, 17, 0.1, 0.15, 0.3, 0.3, 0.35, 0.15, 0.001}};
  setup.ports = {{1, 11}, {2, 9}};
  setup.lattice = {0.8, 0.0, 0.1, 0.7};
  return setup;
}

void build(nec_stateful_model& model, const cell_setup& setup, nec_float psi1, nec_float psi2)
{
  for (const nec_wire_definition& wire : setup.wires)
    model.add_wire(wire);
  model.complete_geometry();
  model.define_ports(setup.ports);
  if (setup.perfect)
    model.set_ground({nec_ground_kind::perfect});
  for (const nec_load_definition& load : setup.loads)
    model.add_load(load);
  model.set_lattice(setup.lattice);
  model.set_scan_phases(psi1, psi2);
  model.prepare(frequency_mhz);
}

const nec_floquet_mode* find_mode(const nec_floquet_result& result, int p, int q, nec_floquet_side side)
{
  for (const nec_floquet_mode& mode : result.modes)
    if (mode.p == p && mode.q == q && mode.side == side)
      return &mode;
  return nullptr;
}

// |input - propagating - loss| / input for every port.
nec_float worst_closure(const nec_floquet_result& result)
{
  nec_float worst = 0;
  for (const nec_floquet_port_power& power : result.power)
    worst = std::max(worst, std::abs(power.input_w - power.propagating_w - power.loss_w) / power.input_w);
  return worst;
}

std::string describe(const nec_floquet_result& result)
{
  std::string text;
  for (size_t port = 0; port < result.power.size(); ++port) {
    const nec_floquet_port_power& power = result.power[port];
    text += "port " + std::to_string(port) + ": input " + std::to_string(power.input_w) +
      " W, propagating " + std::to_string(power.propagating_w) + " W, loss " +
      std::to_string(power.loss_w) + " W\n";
  }
  return text;
}

} // namespace

TEST_CASE("Port power returns as propagating Floquet power plus loss", "[periodic_floquet]")
{
  const nec_float k = wavenumber_per_m();
  struct closure_case {
    const char* name;
    cell_setup setup;
    nec_float psi1, psi2;
  };
  cell_setup loaded = tilted_pair();
  loaded.loads = {{nec_load_kind::series_rlc, 1, 4, 4, 40.0, 0.0, 0.0},
                  {nec_load_kind::series_rlc, 2, 12, 12, 15.0, 0.0, 0.0}};
  cell_setup grounded = one_dipole(0.6, 0.5, 0.25);
  grounded.perfect = true;
  cell_setup grounded_pair = tilted_pair();
  grounded_pair.perfect = true;
  const closure_case cases[] = {
    {"broadside dipole", one_dipole(0.6, 0.5), 0.0, 0.0},
    {"oblique dipole", one_dipole(0.6, 0.5), -0.6 * k * std::sin(0.5), 0.3},
    {"grating lobe", one_dipole(0.7, 0.5), -0.7 * k * std::sin(exact_pi / 4), 0.0},
    {"two-port cell", tilted_pair(), 1.1, -0.4},
    {"two-port cell with loads", loaded, 1.1, -0.4},
    {"dipole over ground", grounded, -0.6 * k * std::sin(0.6), 0.0},
    {"two-port cell over ground", grounded_pair, 0.7, 0.9},
  };
  for (const closure_case& c : cases) {
    for (const nec_embedded_field_normalization normalization :
         {nec_embedded_field_normalization::unit_voltage, nec_embedded_field_normalization::unit_current}) {
      nec_stateful_model model;
      build(model, c.setup, c.psi1, c.psi2);
      const nec_floquet_result& result = model.compute_floquet_amplitudes(normalization);
      INFO(c.name << (normalization == nec_embedded_field_normalization::unit_voltage ? ", unit voltage" : ", unit current"));
      INFO(describe(result));
      REQUIRE(result.power.size() == c.setup.ports.size());
      // The moment method's own power error at 17 to 21 segments per wire:
      // measured 3.7e-4 to 1.2e-3, falling with the segment length squared
      // (see the next test).
      REQUIRE(worst_closure(result) < 2e-3);
      if (c.setup.loads.empty())
        for (const nec_floquet_port_power& power : result.power)
          REQUIRE(power.loss_w == 0.0);
      else
        for (const nec_floquet_port_power& power : result.power)
          REQUIRE(power.loss_w > 0.01 * power.input_w);
    }
  }
}

TEST_CASE("Port input power follows the normalization of the amplitudes", "[periodic_floquet]")
{
  nec_stateful_model model;
  build(model, tilted_pair(), 1.1, -0.4);
  const nec_complex_matrix impedance = model.compute_impedance_matrix().impedance;
  const nec_complex_matrix admittance = model.compute_impedance_matrix().admittance;
  const nec_floquet_result by_voltage =
    model.compute_floquet_amplitudes(nec_embedded_field_normalization::unit_voltage);
  REQUIRE(by_voltage.normalization == nec_embedded_field_normalization::unit_voltage);
  for (size_t port = 0; port < 2; ++port)
    REQUIRE(std::abs(by_voltage.power[port].input_w - 0.5 * admittance.at(port, port).real()) <
            1e-12 * std::abs(admittance.at(port, port)));
  const nec_floquet_result by_current =
    model.compute_floquet_amplitudes(nec_embedded_field_normalization::unit_current);
  REQUIRE(by_current.normalization == nec_embedded_field_normalization::unit_current);
  for (size_t port = 0; port < 2; ++port)
    REQUIRE(std::abs(by_current.power[port].input_w - 0.5 * impedance.at(port, port).real()) <
            1e-12 * std::abs(impedance.at(port, port)));
}

TEST_CASE("Grating-lobe power appears in the Floquet modes the scan puts into visible space", "[periodic_floquet]")
{
  // Spacing 0.7 wavelengths along x: mode (-1, 0) enters visible space at
  // sin(theta) = 1 / 0.7 - 1 = 0.43 when scanning towards +x.
  const nec_float k = wavenumber_per_m();
  const nec_float spacing = 0.7;
  const nec_float b1 = 2 * exact_pi / spacing;
  for (const nec_float theta : {exact_pi / 12, exact_pi / 4}) {
    const nec_float kt0 = k * std::sin(theta);
    nec_stateful_model model;
    build(model, one_dipole(spacing, 0.5), -spacing * kt0, 0.0);
    const nec_floquet_result& result =
      model.compute_floquet_amplitudes(nec_embedded_field_normalization::unit_voltage);
    const bool visible = std::abs(kt0 - b1) < k;
    INFO("theta " << theta << ", grating lobe visible " << visible);
    INFO(describe(result));
    // Free space: every propagating mode radiates above and below the cell.
    size_t propagating = 0;
    for (const nec_floquet_mode& mode : result.modes) {
      REQUIRE(mode.propagating);
      ++propagating;
      const nec_float kt = std::hypot(mode.kt_x_rad_per_m, mode.kt_y_rad_per_m);
      REQUIRE(std::abs(mode.kz_rad_per_m - std::sqrt(nec_complex(k * k - kt * kt))) < 1e-9 * k);
    }
    REQUIRE(propagating == (visible ? 4u : 2u));
    for (const nec_floquet_side side : {nec_floquet_side::above, nec_floquet_side::below}) {
      const nec_floquet_mode* main = find_mode(result, 0, 0, side);
      REQUIRE(main != nullptr);
      REQUIRE(std::abs(main->kt_x_rad_per_m - kt0) < 1e-9 * k);
      REQUIRE(std::abs(main->kt_y_rad_per_m) < 1e-9 * k);
      const nec_floquet_mode* lobe = find_mode(result, -1, 0, side);
      REQUIRE((lobe != nullptr) == visible);
      if (lobe != nullptr) {
        REQUIRE(std::abs(lobe->kt_x_rad_per_m - (kt0 - b1)) < 1e-9 * k);
        // A real grating lobe: a sizeable share of the input power.
        REQUIRE(lobe->power_w[0] > 0.05 * result.power[0].input_w);
      }
    }
  }
}

TEST_CASE("Over perfect ground the Floquet modes radiate above the cell only", "[periodic_floquet]")
{
  cell_setup setup = one_dipole(0.6, 0.5, 0.25);
  setup.perfect = true;
  nec_stateful_model model;
  build(model, setup, 0.4, 0.0);
  const nec_floquet_result& result = model.compute_floquet_amplitudes(
    nec_embedded_field_normalization::unit_voltage, {{1, 0}, {0, -1}});
  for (const nec_floquet_mode& mode : result.modes)
    REQUIRE(mode.side == nec_floquet_side::above);
  // The requested evanescent modes carry no power, and their amplitudes are finite.
  const nec_floquet_mode* evanescent = find_mode(result, 1, 0, nec_floquet_side::above);
  REQUIRE(evanescent != nullptr);
  REQUIRE_FALSE(evanescent->propagating);
  REQUIRE(evanescent->kz_rad_per_m.imag() < 0.0);
  REQUIRE(evanescent->power_w[0] == 0.0);
  REQUIRE(std::isfinite(std::abs(evanescent->te[0])));
  REQUIRE(std::abs(evanescent->tm[0]) > 0.0);
  REQUIRE(find_mode(result, 0, -1, nec_floquet_side::above) != nullptr);
}

TEST_CASE("Floquet amplitudes need a prepared periodic model", "[periodic_floquet]")
{
  nec_stateful_model finite;
  finite.add_wire(dipole_along_x(1, 0.0, 0.0, 0.0));
  finite.complete_geometry();
  finite.define_ports({{1, 11}});
  finite.prepare(frequency_mhz);
  REQUIRE_THROWS_AS(finite.compute_floquet_amplitudes(nec_embedded_field_normalization::unit_voltage),
                    nec_exception);

  nec_stateful_model periodic;
  periodic.add_wire(dipole_along_x(1, 0.0, 0.0, 0.0));
  periodic.complete_geometry();
  periodic.define_ports({{1, 11}});
  periodic.set_lattice({0.6, 0.0, 0.0, 0.5});
  REQUIRE_THROWS_AS(periodic.compute_floquet_amplitudes(nec_embedded_field_normalization::unit_voltage),
                    nec_exception);
}

TEST_CASE("The power closure error is the discretization's: it falls like the segment length squared", "[periodic_floquet]")
{
  // Measured 3.5e-3, 9.5e-4, 2.4e-4 and 4.7e-5 at 11, 21, 41 and 81 segments.
  std::vector<nec_float> closures;
  for (const int segments : {11, 21, 41, 81}) {
    const cell_setup setup{{dipole_along_x(1, 0.0, 0.0, 0.0, segments)}, {{1, (segments + 1) / 2}},
                           {0.6, 0.0, 0.0, 0.5}};
    nec_stateful_model model;
    build(model, setup, 0.0, 0.0);
    closures.push_back(worst_closure(
      model.compute_floquet_amplitudes(nec_embedded_field_normalization::unit_voltage)));
  }
  INFO("closures " << closures[0] << ", " << closures[1] << ", " << closures[2] << ", " << closures[3]);
  for (size_t index = 1; index < closures.size(); ++index)
    REQUIRE(closures[index] < closures[index - 1] / 3);
}
