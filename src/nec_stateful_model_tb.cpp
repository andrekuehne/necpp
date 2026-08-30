#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include "nec_exception.h"
#include "nec_stateful_model.h"

#include <cmath>
#include <complex>
#include <iostream>
#include <sstream>
#include <vector>

namespace {

nec_wire_definition dipole_wire(int tag = 1, nec_float x_m = 0.0)
{
  return {
    tag, 11,
    x_m, 0.0, -0.25,
    x_m, 0.0, 0.25,
    0.001,
  };
}

void build_dipole(nec_stateful_model& model)
{
  model.add_wire(dipole_wire());
  model.complete_geometry();
  model.define_ports({{1, 6}});
}

nec_complex solve_dipole(nec_stateful_model& model, nec_float frequency_mhz)
{
  model.prepare(frequency_mhz);
  return model.solve_port_voltages({nec_complex(1.0, 0.0)})[0];
}

bool finite_complex(nec_complex value)
{
  return std::isfinite(value.real()) && std::isfinite(value.imag());
}

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

} // namespace

TEST_CASE("WP-S0 native symmetry descriptor has stable defaults and masks",
          "[symmetry][wp_s0]")
{
  const nec_geometry_symmetry symmetry;
  REQUIRE(symmetry.kind == nec_geometry_symmetry_kind::none);
  REQUIRE(symmetry.reflection_plane_mask == 0u);
  REQUIRE(symmetry.rotational_order == 1);
  REQUIRE(symmetry.tag_increment == 0);

  REQUIRE(static_cast<int>(nec_geometry_symmetry_kind::none) == 0);
  REQUIRE(static_cast<int>(nec_geometry_symmetry_kind::reflection) == 1);
  REQUIRE(static_cast<int>(nec_geometry_symmetry_kind::rotational) == 2);
  REQUIRE(nec_reflection_plane_x == 1u);
  REQUIRE(nec_reflection_plane_y == 2u);
  REQUIRE(nec_reflection_plane_z == 4u);
  REQUIRE((nec_reflection_plane_x | nec_reflection_plane_y
    | nec_reflection_plane_z) == 7u);

  const nec_geometry_completion_result completion;
  REQUIRE(completion.section_count == 1);
  REQUIRE(completion.fundamental_segment_count == 0);
  REQUIRE(completion.full_segment_count == 0);
  REQUIRE(completion.symmetry.kind == nec_geometry_symmetry_kind::none);
}

TEST_CASE("WP1 stateful model constructs and solves without a deck",
          "[wasm_api][wp1][stateful]")
{
  nec_stateful_model model;
  REQUIRE(model.state() == nec_model_state::empty);
  model.add_wire(dipole_wire());
  REQUIRE(model.state() == nec_model_state::geometry_building);
  model.complete_geometry();
  REQUIRE(model.state() == nec_model_state::geometry_complete);
  model.define_ports({{1, 6}});

  model.prepare(300.0);
  REQUIRE(model.state() == nec_model_state::prepared);
  REQUIRE(model.factorization_generation() == 1);
  REQUIRE(model.solve_generation() == 0);

  const std::vector<nec_complex>* currents_ptr = nullptr;
  try {
    currents_ptr = &model.solve_port_voltages({nec_complex(1.0, 0.0)});
  } catch (const nec_exception& error) {
    FAIL(error.get_message());
  }
  const std::vector<nec_complex>& currents = *currents_ptr;
  REQUIRE(model.state() == nec_model_state::solved);
  REQUIRE(currents.size() == 1);
  REQUIRE(finite_complex(currents[0]));
  REQUIRE(currents[0].real() > 0.0);
  REQUIRE(model.factorization_generation() == 1);
  REQUIRE(model.solve_generation() == 1);
  REQUIRE(model.retained_result_count() == 1);
}

TEST_CASE("WP1 repeated excitations retain the factorization and exact zero sources",
          "[wasm_api][wp1][cache]")
{
  nec_stateful_model model;
  model.add_wire(dipole_wire(1, 0.0));
  model.add_wire(dipole_wire(2, 0.20));
  model.complete_geometry();
  model.define_ports({{1, 6}, {2, 6}});
  model.prepare(300.0);

  const std::vector<nec_complex> first = model.solve_port_voltages({
    nec_complex(1.0, 0.0),
    nec_complex(0.0, 0.0),
  });
  const std::vector<nec_complex> second = model.solve_port_voltages({
    nec_complex(0.5, 0.25),
    nec_complex(-0.2, 0.1),
  });

  REQUIRE(first.size() == 2);
  REQUIRE(second.size() == 2);
  REQUIRE(finite_complex(first[0]));
  REQUIRE(finite_complex(first[1]));
  REQUIRE(std::abs(first[1]) > 1.0e-8);
  REQUIRE(second != first);
  REQUIRE(model.factorization_generation() == 1);
  REQUIRE(model.solve_generation() == 2);
  REQUIRE(model.retained_result_count() == 1);
}

TEST_CASE("WP1 preparation invalidation has deterministic generations",
          "[wasm_api][wp1][cache]")
{
  nec_stateful_model model;
  build_dipole(model);

  model.prepare(300.0);
  model.solve_port_voltages({nec_complex(1.0, 0.0)});
  model.prepare(300.0);
  REQUIRE(model.state() == nec_model_state::solved);
  REQUIRE(model.factorization_generation() == 1);
  REQUIRE(model.solve_generation() == 1);

  model.prepare(301.0);
  REQUIRE(model.state() == nec_model_state::prepared);
  REQUIRE(model.factorization_generation() == 2);
  REQUIRE(model.solve_generation() == 1);

  model.set_ground({nec_ground_kind::perfect, 0.0, 0.0});
  REQUIRE(model.state() == nec_model_state::geometry_complete);
  model.prepare(301.0);
  REQUIRE(model.factorization_generation() == 3);

  model.add_load({
    nec_load_kind::impedance,
    1, 6, 0,
    10.0, 5.0, 0.0,
  });
  model.prepare(301.0);
  REQUIRE(model.factorization_generation() == 4);

  model.clear_loads();
  model.prepare(301.0);
  REQUIRE(model.factorization_generation() == 5);
}

TEST_CASE("WP1 far-field grids do not invalidate the factorization",
          "[wasm_api][wp1][cache][far_field]")
{
  nec_stateful_model model;
  build_dipole(model);
  solve_dipole(model, 300.0);

  const nec_far_field_result& first = model.compute_far_field({
    1.0, 0.0, 3, 45.0, 0.0, 2, 90.0,
  });
  REQUIRE(first.e_theta.size() == 6);
  REQUIRE(model.factorization_generation() == 1);
  REQUIRE(model.solve_generation() == 1);
  REQUIRE(model.retained_result_count() == 2);

  const nec_far_field_result& second = model.compute_far_field({
    2.0, 10.0, 2, 20.0, 15.0, 3, 30.0,
  });
  REQUIRE(second.e_theta.size() == 6);
  REQUIRE(model.factorization_generation() == 1);
  REQUIRE(model.solve_generation() == 1);
  REQUIRE(model.retained_result_count() == 2);
}

TEST_CASE("WP1 invalid and duplicate ports fail without changing state",
          "[wasm_api][wp1][ports]")
{
  nec_stateful_model duplicate;
  duplicate.add_wire(dipole_wire());
  duplicate.complete_geometry();
  REQUIRE_THROWS_AS(
    duplicate.define_ports({{1, 6}, {1, 6}}),
    nec_exception);
  REQUIRE(duplicate.state() == nec_model_state::geometry_complete);

  nec_stateful_model missing;
  missing.add_wire(dipole_wire());
  missing.complete_geometry();
  REQUIRE_THROWS_AS(missing.define_ports({{9, 1}}), nec_exception);
  REQUIRE(missing.state() == nec_model_state::geometry_complete);
}

TEST_CASE("WP1 interleaved contexts do not contaminate one another",
          "[wasm_api][wp1][isolation]")
{
  nec_stateful_model first;
  nec_stateful_model second;
  build_dipole(first);
  build_dipole(second);

  const nec_complex first_before = solve_dipole(first, 300.0);
  const nec_complex second_current = solve_dipole(second, 450.0);
  const nec_complex first_after =
    first.solve_port_voltages({nec_complex(1.0, 0.0)})[0];

  REQUIRE(finite_complex(second_current));
  REQUIRE(first_after.real() == Catch::Approx(first_before.real()).epsilon(1.0e-12));
  REQUIRE(first_after.imag() == Catch::Approx(first_before.imag()).epsilon(1.0e-12));
  REQUIRE(first.factorization_generation() == 1);
  REQUIRE(second.factorization_generation() == 1);
}

TEST_CASE("WP1 one thousand solves keep native results bounded",
          "[wasm_api][wp1][cache][stress]")
{
  nec_stateful_model model;
  build_dipole(model);
  model.prepare(300.0);

  {
    // Bounds-checking builds trace every solve.  Keep the mandated stress
    // test from flooding CI logs while retaining all 1,000 executions.
    scoped_cout_sink silence_debug_trace;
    for (int iteration = 0; iteration < 1000; ++iteration) {
      const nec_float phase = static_cast<nec_float>(iteration) * 0.01;
      model.solve_port_voltages({std::polar<nec_float>(1.0, phase)});
    }
  }

  REQUIRE(model.factorization_generation() == 1);
  REQUIRE(model.solve_generation() == 1000);
  REQUIRE(model.retained_result_count() == 1);
  REQUIRE(model.port_currents().size() == 1);
  REQUIRE(finite_complex(model.port_currents()[0]));
}
