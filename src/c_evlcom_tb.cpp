#include <catch2/catch_test_macros.hpp>

#include "c_evlcom.h"
#include "math_util.h"
#include "common.h"
#include "electromag.h"

#include <array>
#include <cmath>

/* ---------------------------------------------------------------------------
 * Helper: relative error comparison with a magnitude floor.
 *
 *   close(got, ref, rel, floor)  ==  |got - ref| <= rel * max(|ref|, floor)
 *
 * The floor keeps the comparison meaningful when the reference is tiny (many
 * of the integrand outputs are near cancellation points), while still making
 * the check sensitive to genuine regressions in the transcendental math.
 * ------------------------------------------------------------------------- */
static bool close(nec_complex got, nec_complex ref, nec_float rel,
                  nec_float floor) {
    nec_float scale = std::max(std::abs(ref), floor);
    return std::abs(got - ref) <= rel * scale;
}

/* ===========================================================================
 * bessel()  --  complex J0(z) and J0'(z)
 *
 * Reference values generated independently with SciPy
 *   J0(z)  = scipy.special.jv(0, z)
 *   J0'(z) = -scipy.special.jv(1, z)      (derivative recurrence)
 *
 * Points cover the three code paths: the series expansion (|z|^2 <= 36),
 * the series/asymptotic blend band (36 < |z|^2 <= 37.21), and the asymptotic
 * expansion (|z|^2 > 37.21).  The blend band is where the routine is least
 * accurate (~8e-6 relative); the tolerance of 3e-5 passes it with margin.
 * =========================================================================== */
TEST_CASE("bessel matches independent J0/J0' reference", "[bessel]") {
    struct P { nec_complex z; nec_complex j0; nec_complex j0p; };
    const std::array<P, 17> pts = {{
        // z                     J0(z)                             J0'(z)
        {{1e-6, 0},    { 0.99999999999974998,  0.0},               {-4.9999999999993772e-7, 0.0}},
        {{0.1, 0},     { 0.99750156206604013,  0.0},               {-0.049937526036242005,   0.0}},
        {{1, 0},       { 0.76519768655796661,  0.0},               {-0.44005058574493355,    0.0}},
        {{1, 1},       { 0.93760847680602921, -0.49652994760912211},{-0.61416033492290367,  -0.36502802882708785}},
        {{0, 3},       { 4.8807925858650254,   0.0},               {-2.4207410912932910e-16,-3.9533702174026102}},
        {{0, 1},       { 1.2660658777520082,   0.0},               {-3.4606014385669146e-17,-0.56515910399248503}},
        {{2, 2},       { 0.027654478380304465,-1.7799949648342142},{-1.6170187883495017,     0.27260958229437982}},
        {{5, 0},       {-0.17759677131433835,  1.0680401735926485e-17},{0.32757913759146517, -3.9758551954137275e-17}},
        {{6, 0},       { 0.15064525725099698,  4.2170228901624525e-17},{0.27668385812756546,  6.0510299755488043e-17}},
        {{6.05, 0},    { 0.16422863863561948,  6.7913637578329954e-18},{0.26655532631646067, -5.2989165772200510e-18}},
        {{6.1, 0},     { 0.17729142224274341, -1.0858403477345357e-17},{0.25586477255838314, -3.1337911402215520e-17}},
        {{10, 0},      {-0.24593576445134832,  1.9191218358311527e-16},{-0.043472746168861598,3.6585225470687470e-17}},
        {{10, 10},     {-2314.9753144452134,   411.56285702538037}, {460.68091353835302,    2246.6267907040592}},
        {{0, 20},      { 4.3558282559553519e+07,0.0},              {-2.5996173631991392e-9,-4.2454973385127760e+07}},
        {{8, 3},       { 1.2622634723205310,  -2.4450926858689153},{-2.4779251336526311,   -1.0917369750373505}},
        {{50, 0},      { 0.055812327669251802, 0.0},               { 0.097511828125175143, -5.9708774096251293e-18}},
        {{100, 50},    { 9.1287439720687632e+19,1.7312041196273766e+20},{1.7240934666660037e+20,-9.1799284260301095e+19}},
    }};

    const nec_float rel = 3e-5;   // driven by the series/asymptotic blend band

    for (const auto& p : pts) {
        nec_complex j0, j0p;
        bessel(p.z, &j0, &j0p);
        INFO("bessel z = (" << p.z.real() << ", " << p.z.imag() << ")");
        REQUIRE(close(j0, p.j0, rel, 1.0));
        REQUIRE(close(j0p, p.j0p, rel, 1.0));
    }
}

TEST_CASE("bessel near-zero and origin limits", "[bessel]") {
    // |z|^2 <= 1e-12 takes the trivial path: J0 -> 1, J0' -> -0.5*z.
    {
        nec_complex j0, j0p;
        bessel(nec_complex(0.0, 0.0), &j0, &j0p);
        CHECK(j0 == nec_complex(1.0, 0.0));
        CHECK(j0p == nec_complex(0.0, 0.0));
    }
    {
        nec_complex j0, j0p;
        bessel(nec_complex(1e-9, 1e-9), &j0, &j0p);
        // J0(z) ~ 1 - z^2/4 ; J0'(z) ~ -z/2 for tiny |z|
        CHECK(close(j0, nec_complex(1.0, 0.0), 1e-6, 1.0));
        CHECK(close(j0p, nec_complex(-5e-10, -5e-10), 1e-6, 1.0));
    }
}

/* ===========================================================================
 * hankel() -- complex H0^(1)(z) and H0^(1)'(z)
 *
 * Reference values generated independently with SciPy
 *   H0^(1)(z)  = scipy.special.hankel1(0, z)
 *   H0^(1)'(z) = -scipy.special.hankel1(1, z)   (derivative recurrence)
 *
 * Points cover: series expansion (|z|^2 <= 16), the series/asymptotic blend
 * band (16 < |z|^2 <= 16.81), and the asymptotic expansion (> 16.81).  The
 * routine is least accurate in the blend band and near the branch cut
 * (~1.6e-4 relative); the tolerance of 1e-3 passes those with margin.
 * =========================================================================== */
TEST_CASE("hankel matches independent H0^(1)/H0^(1)' reference", "[hankel]") {
    struct P { nec_complex z; nec_complex h0; nec_complex h0p; };
    const std::array<P, 13> pts = {{
        // z                       H0^(1)(z)                        H0^(1)'(z)
        {{0.5, 0},    { 0.93846980724081264, -0.44451873350670656}, {-0.24226845767487393,  1.4714723926702433}},
        {{1, 0},      { 0.76519768655796638,  0.088256964215676997},{-0.44005058574493355,  0.78121282130028891}},
        {{1, 1},      { 0.22744989480229472, -0.051055458673089603}, {0.015640669069980788, 0.29266650676425743}},
        {{0, 2},      { 0.0,                 -0.072507091343870247}, {0.089041385844025572, 5.4522124082765173e-18}},
        {{4, 0},      {-0.39714980986384740, -0.016940739325064992}, {0.066043328023549161,-0.39792571055710002}},
        {{4.02, 0},   {-0.39575302690949810, -0.024875511679351620}, {0.073624299158469839,-0.39552871285256858}},
        {{4.11, 0},   {-0.38761880428393758, -0.059933017943225295}, {0.10689873313015916, -0.38307883005688415}},
        {{5, 0},      {-0.17759677131433840, -0.30851762524903381},  {0.32757913759146529, -0.14786314339122694}},
        {{10, 0},     {-0.24593576445134829,  0.055671167283599339}, {-0.043472746168861362,-0.24901542420695386}},
        {{10, 5},     {-0.0014390626993822737,0.00069798313383186519},{-0.00065590035117675831,-0.0014959445758611480}},
        {{20, 0},     { 0.16702466434058319,  0.062640596809383858}, {-0.066833124175850092, 0.16551161436252135}},
        {{-3, 4},     { 0.0010666528746791273,0.0063217917579787260}, {-0.0067578422929059209,0.0015041895936947331}},
        {{100, 50},   { 3.1438393835330555e-25,-1.4543488318531705e-23},{1.4571406265578706e-23,3.7307195487460667e-25}},
    }};

    const nec_float rel = 1e-3;   // driven by the blend band / branch-cut region

    for (const auto& p : pts) {
        nec_complex h0, h0p;
        hankel(p.z, &h0, &h0p);
        INFO("hankel z = (" << p.z.real() << ", " << p.z.imag() << ")");
        REQUIRE(close(h0, p.h0, rel, 1.0));
        REQUIRE(close(h0p, p.h0p, rel, 1.0));
    }
}

TEST_CASE("hankel rejects the origin", "[hankel]") {
    REQUIRE_THROWS_AS(hankel(nec_complex(0.0, 0.0), nullptr, nullptr),
                      nec_exception);
}

/* ===========================================================================
 * saoa() -- the Sommerfeld integrand (6 integrals), c_evlcom member function.
 *
 * saoa depends on the c_evlcom ground-state (contour, ck1/ck2, rho, zph,
 * bessel-vs-hankel flag) and computes 6 integrand values used by the Romberg
 * integration rom1().  There is no independent closed-form reference for the
 * whole integrand, so these are characterization tests:
 *
 *   1. Golden values: lock in the exact current outputs for representative
 *      Bessel-form and Hankel-form integrand evaluations, so any future change
 *      to the transcendental math (bessel/hankel/sqrt/exp) must reproduce them
 *      within the documented tolerance.
 *   2. Structural identity: for rho == 0 the code sets ans[0] == ans[3].
 *
 * The golden tolerance (1e-5, infinity-norm-relative) is looser than the
 * bessel/hankel point tests because the integrand inherits the ~1e-4 accuracy
 * of the underlying routine approximations; it is still tight enough to catch
 * any genuine regression.
 * ========================================================================== */

// Replicate the c_evlcom member setup performed by c_ggrid::sommerfeld() for
// ground (epr=13, sig=0.05 S/m, wavelength=0.125) so saoa sees realistic
// physical state.
static void setup_sommerfeld_state(c_evlcom& ev, nec_float epr,
                                   nec_float sig, nec_float wavelength) {
    nec_complex epscf = (sig >= 0.0)
        ? nec_complex(epr, -sig * wavelength * em::impedance_over_2pi())
        : nec_complex(epr, sig);
    ev.m_ck2 = two_pi();
    ev.m_ck2sq = ev.m_ck2 * ev.m_ck2;
    ev.m_ck1sq = ev.m_ck2sq * conj(epscf);
    ev.m_ck1 = sqrt(ev.m_ck1sq);
    ev.m_ck1r = real(ev.m_ck1);
    ev.m_tkmag = 100.0 * abs(ev.m_ck1);
    ev.m_tsmag = 100.0 * norm(ev.m_ck1);
    ev.m_cksm = ev.m_ck2sq / (ev.m_ck1sq + ev.m_ck2sq);
    ev.m_ct1 = 0.5 * (ev.m_ck1sq - ev.m_ck2sq);
    nec_complex erv = ev.m_ck1sq * ev.m_ck1sq;
    nec_complex ezv = ev.m_ck2sq * ev.m_ck2sq;
    ev.m_ct2 = 0.125 * (erv - ezv);
    erv *= ev.m_ck1sq;
    ezv *= ev.m_ck2sq;
    ev.m_ct3 = 0.0625 * (erv - ezv);
}

// Infinity-norm relative check across the 6 integrand components.
static bool close_vec(const std::array<nec_complex,6>& got,
                      const std::array<nec_complex,6>& ref, nec_float rel) {
    nec_float ref_norm = 0.0, diff_norm = 0.0;
    for (int i = 0; i < 6; ++i) {
        ref_norm = std::max(ref_norm, std::abs(ref[i]));
        diff_norm = std::max(diff_norm, std::abs(got[i] - ref[i]));
    }
    return diff_norm <= rel * ref_norm;
}

TEST_CASE("saoa Bessel-form golden values", "[saoa]") {
    c_evlcom ev;
    setup_sommerfeld_state(ev, 13.0, 0.050, 0.125);
    ev.set_bessel_flag(true);          // used when zph >= 2*rho

    const nec_float t = 0.35;

    // Case 1: rho = 0.5, zph = 2.0 (observer well above the ground).
    {
        ev.m_rho = 0.5; ev.m_zph = 2.0;
        ev.m_contour_a = nec_complex(0.0, 0.0);
        ev.m_contour_b = nec_complex(0.3, -0.3);
        std::array<nec_complex,6> ans;
        ev.saoa(t, ans);

        const std::array<nec_complex,6> ref = {
            nec_complex(-1.9395703935042349e-09, -6.2493519835480429e-08),
            nec_complex( 2.2377628073964496e-04, -6.9744350903347496e-06),
            nec_complex( 1.9632213530921673e-07, -6.3090665972042463e-09),
            nec_complex(-2.0256897529968627e-09, -6.2490708401323787e-08),
            nec_complex(-5.6682189676555206e-06,  1.7983039213156868e-07),
            nec_complex( 1.2848334192497061e-04, -2.1464784172237421e-06),
        };
        CHECK(close_vec(ans, ref, 1e-5));
    }

    // Case 2: rho = 0.02, zph = 0.2 (observer near the ground).
    {
        ev.m_rho = 0.02; ev.m_zph = 0.2;
        ev.m_contour_a = nec_complex(0.0, 0.0);
        ev.m_contour_b = nec_complex(0.8, -0.8);
        std::array<nec_complex,6> ans;
        ev.saoa(t, ans);

        const std::array<nec_complex,6> ref = {
            nec_complex( 2.9721408001709313e-06, -1.0875161570983060e-06),
            nec_complex( 5.4168758373328773e-04,  1.4987959854737129e-03),
            nec_complex( 1.3592572983848659e-07,  3.7376022778436681e-07),
            nec_complex( 2.9721237470650671e-06, -1.0875627599540938e-06),
            nec_complex(-1.3871676766915813e-05, -3.7909850428801015e-05),
            nec_complex( 2.9821893255622581e-04,  8.6473991264578870e-04),
        };
        CHECK(close_vec(ans, ref, 1e-5));
    }
}

TEST_CASE("saoa Hankel-form golden values", "[saoa]") {
    c_evlcom ev;
    setup_sommerfeld_state(ev, 13.0, 0.050, 0.125);
    ev.set_bessel_flag(false);         // used when zph < 2*rho

    const nec_float t = 0.35;

    // Case 1: rho = 2.0, zph = 0.5.
    {
        ev.m_rho = 2.0; ev.m_zph = 0.5;
        ev.m_contour_a = nec_complex(0.0, 0.4 * ev.m_ck2);
        ev.m_contour_b = nec_complex(0.6 * ev.m_ck2, -0.2 * ev.m_ck2);
        std::array<nec_complex,6> ans;
        ev.saoa(t, ans);

        const std::array<nec_complex,6> ref = {
            nec_complex( 8.2456936439888724e-07,  7.1113185252683156e-05),
            nec_complex( 7.1444745941748756e-04, -1.4218254013119457e-04),
            nec_complex( 1.7845867067184395e-04,  1.4040648555671765e-04),
            nec_complex( 1.1762252585482249e-05, -1.3774601248583885e-05),
            nec_complex(-1.8415993484054896e-05,  2.1491225149100035e-06),
            nec_complex( 4.1060600554067463e-04, -7.8212390736496180e-05),
        };
        CHECK(close_vec(ans, ref, 1e-5));
    }

    // Case 2: rho = 1.0, zph = 0.0 (observer on the ground).
    {
        ev.m_rho = 1.0; ev.m_zph = 0.0;
        ev.m_contour_a = nec_complex(0.0, 0.4 * ev.m_ck2);
        ev.m_contour_b = nec_complex(0.6 * ev.m_ck2, -0.2 * ev.m_ck2);
        std::array<nec_complex,6> ans;
        ev.saoa(t, ans);

        const std::array<nec_complex,6> ref = {
            nec_complex(-3.2021020597560731e-04, -1.4211112162366052e-04),
            nec_complex(-1.4266886124412602e-04,  2.9295653078370855e-03),
            nec_complex(-8.2598997732596816e-04,  5.5977934556877276e-04),
            nec_complex( 8.3946634945457864e-05,  1.3525397884867003e-04),
            nec_complex( 9.5984706395625277e-06, -7.4033062680823098e-05),
            nec_complex(-9.5675296016319144e-05,  1.6802526334216970e-03),
        };
        CHECK(close_vec(ans, ref, 1e-5));
    }
}

TEST_CASE("saoa rho==0 identity ans[0] == ans[3]", "[saoa]") {
    c_evlcom ev;
    setup_sommerfeld_state(ev, 13.0, 0.050, 0.125);
    ev.set_bessel_flag(true);
    ev.m_rho = 0.0; ev.m_zph = 1.0;
    ev.m_contour_a = nec_complex(0.0, 0.0);
    ev.m_contour_b = nec_complex(0.5, -0.5);

    for (nec_float t : {0.1f, 0.35f, 0.9f}) {
        std::array<nec_complex,6> ans;
        ev.saoa(t, ans);
        INFO("t = " << t);
        // With rho == 0 the code sets ans[0] and ans[3] to the same value.
        CHECK(ans[0] == ans[3]);
    }
}
