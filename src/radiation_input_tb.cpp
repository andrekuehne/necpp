/*
  Regression tests for the nec2diff radiation-pattern parser
  (RadiationInput / BaseInput).

  At angles where the polarization is undefined (e.g. HORIZ gain of
  -999.99 at the horizon) NEC leaves the SENSE column blank. The parser
  used to read the next numeric token as the sense string, shifting all
  remaining columns left by one and returning uninitialized memory for
  the final E_phi_phase field — so comparing a file against itself
  reported a spurious difference.
*/
#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>

#include <cstdio>
#include <fstream>
#include <string>

using namespace std; /* BaseInput.h expects this (same as necDiff.cpp) */

#include "RadiationInput.h"

using Catch::Matchers::WithinAbs;

namespace {

const char* kPatternWithBlankSense =
    "\n"
    "                         ----- RADIATION PATTERNS -----\n"
    " ---- ANGLES -----     ----- POWER GAINS -----       ---- POLARIZATION ----   ---- E(THETA) ----    ----- E(PHI) ------\n"
    "  THETA      PHI       VERTC   HORIZ   TOTAL       AXIAL      TILT  SENSE   MAGNITUDE    PHASE    MAGNITUDE     PHASE\n"
    " DEGREES   DEGREES        DB       DB       DB       RATIO   DEGREES            VOLTS/M   DEGREES     VOLTS/M   DEGREES\n"
    "   90.00      0.00   -199.34  -999.99  -199.32      0.0000      0.00         4.8333E-11   -104.93  2.5549E-12     14.10\n"
    "   89.00      0.00     -9.34   -34.22    -9.33      0.0510     -1.46 LEFT    1.5271E-01     77.57  8.7103E-03   -166.00\n"
    "\n";

std::string write_temp_file(const char* contents) {
    std::string path = "radiation_input_tb.tmp";
    std::ofstream os(path.c_str());
    os << contents;
    os.close();
    return path;
}

} // namespace

TEST_CASE("Radiation pattern with blank SENSE column parses correctly", "[nec2diff]") {
    std::string path = write_temp_file(kPatternWithBlankSense);

    RadiationInput r(path);

    REQUIRE( r.n_items == 2 );

    /* Blank-SENSE row: the E-field columns must land in the right slots. */
    REQUIRE( r.theta[0] == 90.00 );
    REQUIRE_THAT( r.E_theta_mag[0], WithinAbs(4.8333E-11, 1e-16) );
    REQUIRE( r.E_theta_phase[0] == -104.93 );
    REQUIRE_THAT( r.E_phi_mag[0], WithinAbs(2.5549E-12, 1e-17) );
    REQUIRE( r.E_phi_phase[0] == 14.10 );

    /* Row with SENSE present still parses as before. */
    REQUIRE_THAT( r.E_theta_mag[1], WithinAbs(1.5271E-01, 1e-8) );
    REQUIRE( r.E_phi_phase[1] == -166.00 );

    /* A file must compare equal to itself (was nonzero due to the
       uninitialized read). */
    RadiationInput r2(path);
    REQUIRE( r.difference(r2) == 0.0 );
    REQUIRE( r.equalto(r2) );

    std::remove(path.c_str());
}
