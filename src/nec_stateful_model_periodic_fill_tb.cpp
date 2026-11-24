/*
  The periodic fill from kernel tables, with the splitting chosen for scan
  changes, against the reference fill (the fill before the tables: automatic
  splitting, every kernel sample evaluated directly). Scan impedance and
  admittance, Floquet amplitudes, mode powers and the power budget must
  agree within 1e-9 over free space, perfect and finite ground, stacks above
  and below; planar, tilted, helix-sized, multi-element cells and cells with
  close images; square, hexagonal and oblique lattices; broadside, oblique,
  invisible-space and grating-lobe scans, and states next to and on a Wood
  anomaly.
*/
#include <catch2/catch_test_macros.hpp>

#include "electromag.h"
#include "math_util.h"
#include "nec_context.h"
#include "nec_periodic_accuracy.h"
#include "nec_periodic_green.h"
#include "nec_periodic_spectral_fill.h"
#include "nec_stateful_model.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <optional>
#include <string>
#include <vector>

// Declared a friend of nec_stateful_model and nec_context: the reference
// fill and the bound on the tables' size.
struct nec_periodic_fill_access {
  static void use_reference_fill(nec_stateful_model& model) { model.m_context->m_periodic_reference_fill = true; }
  static void bound_tables(nec_stateful_model& model, size_t bound)
  {
    model.m_context->m_periodic_max_table_size = bound;
  }
  static nec_float splitting(const nec_stateful_model& model) { return model.m_context->m_periodic_green->splitting(); }
  static nec_periodic::spectral_fill::route spectral_route(const nec_stateful_model& model)
  {
    return model.m_context->m_periodic_fill->spectral->chosen_route();
  }
  // The per-frequency cache: the free-space matrix, the lattice points'
  // matrices and the spectral fill's per-sample stencils.
  static double cache_bytes(const nec_stateful_model& model)
  {
    const auto& fill = *model.m_context->m_periodic_fill;
    double bytes = double(fill.free_space.size()) * sizeof(nec_complex);
    for (const auto& matrix : fill.point_matrices)
      bytes += double(matrix.size()) * sizeof(nec_complex);
    if (fill.spectral)
      bytes += double(fill.spectral->kept_bytes());
    return bytes;
  }
  static size_t point_count(const nec_stateful_model& model) { return model.m_context->m_periodic_fill->points.size(); }
  static bool spatial_tables(const nec_stateful_model& model)
  {
    const auto& spatial = model.m_context->m_periodic_fill->spatial;
    return spatial && spatial->full_tabulated() && spatial->smooth_tabulated();
  }
};

namespace {

constexpr nec_float exact_pi = 3.141592653589793238462643383279502884;
// One metre is exactly one wavelength in the engine's arithmetic.
const nec_float frequency_mhz = em::speed_of_light() / 1.0e6;

struct cell_definition {
  const char* name;
  std::vector<nec_wire_definition> wires;
  std::vector<nec_port_definition> ports;
  nec_lattice_definition lattice;
  nec_ground_definition ground;
  nec_layered_stacks_definition stacks;
};

struct scan_state {
  const char* name;
  nec_float psi1, psi2;
};

// Scan phases of the direction (theta, phi) on the lattice: psi_i = -kt0 . a_i.
scan_state direction(const char* name, const nec_lattice_definition& lattice, nec_float theta_deg,
                     nec_float phi_deg, nec_float sine_scale = 1.0)
{
  const nec_float k = 2 * exact_pi;
  const nec_float theta = theta_deg * exact_pi / 180, phi = phi_deg * exact_pi / 180;
  const nec_float kx = sine_scale * k * std::sin(theta) * std::cos(phi);
  const nec_float ky = sine_scale * k * std::sin(theta) * std::sin(phi);
  return {name, -(kx * lattice.a1x_m + ky * lattice.a1y_m), -(kx * lattice.a2x_m + ky * lattice.a2y_m)};
}

nec_wire_definition dipole_along_x(int tag, nec_float x, nec_float y, nec_float z, int segments = 11)
{
  return {tag, segments, x - 0.24, y, z, x + 0.24, y, z, 0.001};
}

std::vector<nec_wire_definition> helix_wires(int tag, int segments)
{
  // An axial-mode helix of circumference one wavelength, 12 segments a turn.
  std::vector<nec_wire_definition> wires;
  const auto at = [](int i) {
    const nec_float angle = 2 * exact_pi * i / 12;
    return std::array<nec_float, 3>{0.159 * std::cos(angle), 0.159 * std::sin(angle), 0.05 + 0.23 * i / 12.0};
  };
  for (int i = 0; i < segments; ++i) {
    const auto a = at(i), b = at(i + 1);
    wires.push_back({tag + i, 1, a[0], a[1], a[2], b[0], b[1], b[2], 0.002});
  }
  return wires;
}

nec_ground_definition perfect_ground() { return {nec_ground_kind::perfect}; }
nec_ground_definition soil()
{
  nec_ground_definition ground;
  ground.kind = nec_ground_kind::finite_reflection_coefficient;
  ground.relative_permittivity = 13.0;
  ground.conductivity_s_per_m = 0.005;
  return ground;
}

void build(nec_stateful_model& model, const cell_definition& cell)
{
  for (const nec_wire_definition& wire : cell.wires)
    model.add_wire(wire);
  model.complete_geometry();
  model.define_ports(cell.ports);
  if (cell.ground.kind != nec_ground_kind::free_space)
    model.set_ground(cell.ground);
  model.set_lattice(cell.lattice);
  if (cell.stacks.above || cell.stacks.below)
    model.set_layered_stacks(cell.stacks);
}

struct results {
  nec_impedance_result impedance;
  nec_floquet_result floquet;
};

results solve(nec_stateful_model& model, const scan_state& scan)
{
  model.set_scan_phases(scan.psi1, scan.psi2);
  model.prepare(frequency_mhz);
  results r;
  r.impedance = model.compute_impedance_matrix();
  // Two evanescent modes besides the propagating ones.
  r.floquet = model.compute_floquet_amplitudes(nec_embedded_field_normalization::unit_voltage,
                                               {{1, 1}, {-1, 2}});
  return r;
}

// Largest difference relative to the largest entry of the reference.
nec_float matrix_difference(const nec_complex_matrix& value, const nec_complex_matrix& reference)
{
  nec_float largest = 0, worst = 0;
  for (size_t i = 0; i < reference.values.size(); ++i) {
    largest = std::max(largest, std::abs(reference.values[i]));
    worst = std::max(worst, std::abs(value.values[i] - reference.values[i]));
  }
  return worst / largest;
}

struct differences {
  nec_float impedance = 0, admittance = 0, amplitudes = 0, powers = 0, budget = 0;
  nec_float largest() const { return std::max({impedance, admittance, amplitudes, powers, budget}); }
};

// Powers relative to the scale of a unit-voltage solve, half the largest
// admittance entry: in invisible space a lossless cell takes no power.
differences compare(const results& value, const results& reference)
{
  differences d;
  d.impedance = matrix_difference(value.impedance.impedance, reference.impedance.impedance);
  d.admittance = matrix_difference(value.impedance.admittance, reference.impedance.admittance);
  nec_float power = 0;
  for (const nec_complex& entry : reference.impedance.admittance.values)
    power = std::max(power, 0.5 * std::abs(entry));
  REQUIRE(value.floquet.modes.size() == reference.floquet.modes.size());
  nec_float amplitude = 0;
  for (size_t m = 0; m < reference.floquet.modes.size(); ++m) {
    const nec_floquet_mode& a = value.floquet.modes[m];
    const nec_floquet_mode& b = reference.floquet.modes[m];
    REQUIRE(a.p == b.p);
    REQUIRE(a.q == b.q);
    for (size_t port = 0; port < b.te.size(); ++port) {
      amplitude = std::max({amplitude, std::abs(b.te[port]), std::abs(b.tm[port])});
      d.amplitudes = std::max({d.amplitudes, std::abs(a.te[port] - b.te[port]), std::abs(a.tm[port] - b.tm[port])});
      d.powers = std::max(d.powers, std::abs(a.power_w[port] - b.power_w[port]));
    }
  }
  d.amplitudes /= amplitude;
  d.powers /= power;
  for (size_t port = 0; port < reference.floquet.power.size(); ++port) {
    const nec_floquet_port_power& a = value.floquet.power[port];
    const nec_floquet_port_power& b = reference.floquet.power[port];
    d.budget = std::max({d.budget, std::abs(a.input_w - b.input_w) / power,
                         std::abs(a.propagating_w - b.propagating_w) / power, std::abs(a.loss_w - b.loss_w) / power,
                         std::abs(a.dielectric_loss_w - b.dielectric_loss_w) / power});
  }
  return d;
}

std::vector<cell_definition> cells()
{
  std::vector<cell_definition> list;
  const nec_float h = 0.6;
  // A planar cell over perfect ground: crossed dipoles, square lattice.
  {
    cell_definition c{"crossed dipoles over perfect ground, square 0.5", {}, {{1, 6}, {2, 6}}, {0.5, 0, 0, 0.5},
                      perfect_ground(), {}};
    c.wires = {dipole_along_x(1, 0, 0, 0.25), {2, 11, 0, -0.24, 0.27, 0, 0.24, 0.27, 0.001}};
    list.push_back(c);
  }
  // A tilted wire in free space, hexagonal lattice.
  list.push_back({"tilted wire in free space, hexagonal 0.6",
                  {{1, 15, -0.2, -0.05, -0.1, 0.2, 0.08, 0.15, 0.001}}, {{1, 8}},
                  {h, 0, h / 2, h * std::sqrt(3.0) / 2}, {}, {}});
  // Two tilted wires over finite ground, oblique lattice.
  list.push_back({"two tilted wires over finite ground, oblique",
                  {{1, 21, -0.2, -0.05, 0.12, 0.2, 0.05, 0.36, 0.001}, {2, 17, 0.1, 0.15, 0.3, 0.3, 0.35, 0.15, 0.001}},
                  {{1, 11}, {2, 9}}, {0.8, 0.0, 0.1, 0.7}, soil(), {}});
  // A dipole over perfect ground under a radome.
  {
    cell_definition c{"dipole over perfect ground under a radome, square 0.6", {dipole_along_x(1, 0, 0, 0.25)},
                      {{1, 6}}, {0.6, 0, 0, 0.6}, perfect_ground(), {}};
    nec_layered_stack_definition radome;
    radome.bottom_z_m = 0.45;
    radome.layers = {{0.03, 4.0, 0.02}};
    c.stacks.above = radome;
    list.push_back(c);
  }
  // A dipole in free space above a substrate.
  {
    cell_definition c{"dipole above a substrate in free space, square 0.55", {dipole_along_x(1, 0, 0, 0.2)},
                      {{1, 6}}, {0.55, 0, 0, 0.55}, {}, {}};
    nec_layered_stack_below_definition substrate;
    substrate.top_z_m = 0.1;
    substrate.layers = {{0.05, 3.0, 0.01}};
    c.stacks.below = substrate;
    list.push_back(c);
  }
  // Dipoles nearly touching their neighbours: close images.
  list.push_back({"dipoles with close images, rectangular 0.5 x 0.3", {dipole_along_x(1, 0, 0, 0, 13)}, {{1, 7}},
                  {0.5, 0, 0, 0.3}, {}, {}});
  return list;
}

void check_agreement(const cell_definition& cell, const std::vector<scan_state>& scans)
{
  nec_stateful_model tabulated, reference;
  build(tabulated, cell);
  build(reference, cell);
  nec_periodic_fill_access::use_reference_fill(reference);
  for (const scan_state& scan : scans) {
    INFO(cell.name << ", " << scan.name);
    const results a = solve(tabulated, scan);
    const results b = solve(reference, scan);
    const differences d = compare(a, b);
    INFO("k/2E " << 2 * exact_pi / (2 * nec_periodic_fill_access::splitting(tabulated)) << " (reference "
                 << 2 * exact_pi / (2 * nec_periodic_fill_access::splitting(reference)) << "), spectral route "
                 << int(nec_periodic_fill_access::spectral_route(tabulated)) << "; differences Z "
                 << d.impedance << ", Y " << d.admittance << ", amplitudes " << d.amplitudes << ", powers "
                 << d.powers << ", budget " << d.budget << "; estimated error "
                 << a.impedance.periodic->estimated_error);
    CHECK(d.largest() < 1e-9);
    // The estimate covers the difference.
    CHECK(d.impedance <= a.impedance.periodic->estimated_error);
    CHECK(a.impedance.periodic->status == b.impedance.periodic->status);
    CHECK(nec_periodic_fill_access::spatial_tables(tabulated));
  }
}

} // namespace

TEST_CASE("The tabulated periodic fill agrees with the reference fill", "[periodic_fill]")
{
  for (const cell_definition& cell : cells()) {
    std::vector<scan_state> scans = {
      {"broadside", 0, 0},
      direction("oblique", cell.lattice, 35, 25),
      direction("invisible space", cell.lattice, 90, 40, 1.3),
    };
    // 70 degrees: a grating lobe on every lattice but the 0.5 ones.
    scans.push_back(direction("70 degrees", cell.lattice, 70, 0));
    check_agreement(cell, scans);
  }
}

TEST_CASE("A helix-sized cell's tabulated fill agrees with the reference fill", "[periodic_fill]")
{
  cell_definition helix{"84-segment helix over perfect ground, square 0.8", helix_wires(1, 84), {{1, 1}},
                        {0.8, 0, 0, 0.8}, perfect_ground(), {}};
  check_agreement(helix, {direction("oblique", helix.lattice, 30, 20), direction("grating lobe", helix.lattice, 60, 45)});
}

TEST_CASE("The tabulated fill agrees with the reference fill next to and on a Wood anomaly", "[periodic_fill]")
{
  // As in the periodic model test: the spacing whose broadside (+-1, 0)
  // modes are exactly at cut-off, stretched by 1 + delta (propagating) or
  // shrunk (evanescent).
  const nec_float exact_two_pi = 2.0 * std::acos(-1.0);
  nec_float spacing = exact_two_pi / two_pi();
  bool on_cutoff = false;
  nec_float above = spacing, below = spacing;
  for (int step = 0; step < 256 && !on_cutoff; ++step) {
    for (const nec_float candidate : {above, below}) {
      const nec_periodic::lattice_2d lattice({candidate, 0.0}, {0.0, 0.5});
      if (nec_periodic::periodic_green(lattice, two_pi(), {0.0, 0.0}).nearest_cutoff().kz_over_k == 0.0) {
        spacing = candidate;
        on_cutoff = true;
        break;
      }
    }
    above = std::nextafter(above, 2.0);
    below = std::nextafter(below, 0.0);
  }
  REQUIRE(on_cutoff);
  for (const nec_float stretch : {1 + 1e-3, 1 - 1e-3, 1 + 1e-8, 1 - 1e-8, 1.0}) {
    INFO("stretch " << stretch);
    // A tilted wire, so the TE, TM and longitudinal parts all couple, over
    // perfect ground and in free space.
    for (const nec_ground_definition& ground : {nec_ground_definition{}, perfect_ground()}) {
      cell_definition cell{"tilted wire near a Wood anomaly", {{1, 15, -0.2, -0.05, 0.1, 0.2, 0.08, 0.3, 0.001}},
                           {{1, 8}}, {spacing * stretch, 0, 0, 0.5}, ground, {}};
      check_agreement(cell, {{"broadside", 0, 0}});
    }
  }
}

TEST_CASE("A cell past the tables' size bound gives the direct result", "[periodic_fill]")
{
  const cell_definition cell = cells()[1];
  const scan_state scan = direction("oblique", cell.lattice, 35, 25);
  nec_stateful_model bounded, reference;
  build(bounded, cell);
  build(reference, cell);
  nec_periodic_fill_access::bound_tables(bounded, 4);
  const results a = solve(bounded, scan);
  REQUIRE(nec_periodic_fill_access::spectral_route(bounded) == nec_periodic::spectral_fill::route::direct);
  REQUIRE_FALSE(nec_periodic_fill_access::spatial_tables(bounded));
  // Every kernel sample and spatial term evaluated directly, at the same
  // splitting as the tables.
  const results b = solve(reference, scan);
  REQUIRE(nec_periodic_fill_access::spectral_route(reference) == nec_periodic::spectral_fill::route::table);
  REQUIRE(nec_periodic_fill_access::splitting(bounded) == nec_periodic_fill_access::splitting(reference));
  CHECK(compare(a, b).largest() < 1e-9);
  // No table, no interpolation error.
  CHECK(a.impedance.periodic->estimated_error <= b.impedance.periodic->estimated_error);
}

TEST_CASE("The splitting for scan changes stays within k/2E = 3 and is shared by every scan state", "[periodic_fill]")
{
  for (const cell_definition& cell : cells()) {
    INFO(cell.name);
    nec_stateful_model model;
    build(model, cell);
    solve(model, {"broadside", 0, 0});
    const nec_float splitting = nec_periodic_fill_access::splitting(model);
    CHECK(2 * exact_pi / (2 * splitting) <= 3.0 + 1e-12);
    solve(model, direction("oblique", cell.lattice, 35, 25));
    CHECK(nec_periodic_fill_access::splitting(model) == splitting);
  }
}

// Timing, not a gate: run with "[periodic_fill_bench]".
TEST_CASE("Periodic fill timing: a new frequency and a scan change", "[.][periodic_fill_bench]")
{
  using clock = std::chrono::steady_clock;
  const auto seconds = [](clock::time_point start) {
    return std::chrono::duration<double>(clock::now() - start).count();
  };
  cell_definition dipoles = cells()[0];
  cell_definition helix{"84-segment helix over perfect ground, square 0.8", helix_wires(1, 84), {{1, 1}},
                        {0.8, 0, 0, 0.8}, perfect_ground(), {}};
  for (const cell_definition* cell : {&dipoles, &helix}) {
    for (const bool reference : {true, false}) {
      nec_stateful_model model;
      build(model, *cell);
      if (reference)
        nec_periodic_fill_access::use_reference_fill(model);
      auto start = clock::now();
      model.set_scan_phases(0.3, 0.1);
      model.prepare(frequency_mhz);
      model.compute_impedance_matrix();
      const double first = seconds(start);
      const int changes = 5;
      start = clock::now();
      for (int i = 0; i < changes; ++i) {
        const scan_state scan = direction("scan", cell->lattice, 10.0 + 8 * i, 15.0 * i);
        model.set_scan_phases(scan.psi1, scan.psi2);
        model.prepare(frequency_mhz);
        model.compute_impedance_matrix();
      }
      const double change = seconds(start) / changes;
      WARN(cell->name << (reference ? " (reference)" : " (tables)") << ": k/2E "
                      << 2 * exact_pi / (2 * nec_periodic_fill_access::splitting(model)) << ", new frequency "
                      << 1e3 * first << " ms, scan change " << 1e3 * change << " ms, "
                      << nec_periodic_fill_access::point_count(model) << " lattice points, cache "
                      << nec_periodic_fill_access::cache_bytes(model) / (1024 * 1024) << " MiB");
    }
  }
}
