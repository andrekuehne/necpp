/*
  Layered stacks above and below the wires of a periodic unit cell, and
  finite ground as one of them (issues #32, #33; ADR 0001). The wires live in
  an air region between an upper reflection G_a at z_a (a radome; zero
  without one) and a lower one G_b at z_b (a substrate, finite ground, the
  perfect ground's rho = -1 TE, +1 TM at z = 0, or zero in free space), in
  the field convention of the Floquet amplitudes. Each Floquet mode leaves a
  source going up (moments s_u, referred to z_a) and down (s_d, referred to
  z_b); summing the reflections between the two sides, the field reflected
  back to the observation points adds

    c [a_down a_up] (1 / D) [[G_a, G_a G_b W], [G_a G_b W, G_b]] [s_u s_d]^T

  to the interaction matrix, with W = exp(-j kz (z_a - z_b)), D = 1 - G_a G_b
  W^2 and c = -eta k / (2 A kz); a_down (a_up) observes the wave going down
  from z_a (up from z_b). The matrix is G_a / D (1, G_b W)^T (1, G_b W) +
  diag(0, G_b), so this is

    c (G_a / D) a b^T,   a = a_down + G_b W a_up,  b = s_u + G_b W s_d,
    c (G_b - K) a_up s_d^T,

  per mode and polarization, where K is the part of G_b that the kernel's
  ground image already holds: rho exp(-2j kz z_b) over perfect ground, so
  that without a stack below the second term vanishes, and zero otherwise.
  Phases are referred to the faces, so that evanescent terms decay across
  the gaps.

  Terms of size 1 / kz near cut-off, and terms near a guided-wave pole of a
  stack, go to the low-rank update with their finite inverse coefficient;
  the others go into the matrix. Near cut-off the reflection terms nearly
  cancel the split singular parts of the kernel, so a mode exactly at
  cut-off is evaluated, consistently in both, at the nearest representable
  state |kz| = sqrt(eps) k.
*/
#include "nec_context.h"

#include "c_geometry.h"
#include "electromag.h"
#include "nec_exception.h"
#include "nec_periodic_accuracy.h"
#include "nec_periodic_clearance.h"
#include "nec_periodic_green.h"
#include "nec_periodic_low_rank.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <limits>
#include <tuple>

namespace {
// A stack needing more Floquet modes than this is refused. The modes are
// first estimated from the cell area, so that a gap far too small is refused
// before they are enumerated; the estimate is within a few percent of the
// count, and twice the limit leaves the exact count to decide near it.
constexpr double max_stack_modes = 20000;
// The stack's modes are kept while their decay over twice the gap,
// exp(-2 g |kz|), exceeds exp(-stack_decay). The truncation error, relative
// to the largest scan-impedance entry, was measured at most 0.03
// exp(-stack_decay) for decays of 6 to 26 (gaps of 0.02 to 0.2 wavelengths,
// free space and perfect ground, eps_r 4 and 10); exp(-stack_decay) is the
// estimate, at least 30 times that (about 400 times the measurement at
// this decay).
constexpr double stack_decay = 18;
// A lower stack whose last face is this close to the ground (relative to the
// stack's thickness) rests on it.
constexpr double resting_on_ground = 1e-9;

const nec_complex j_unit(0.0, 1.0);

using nec_periodic::stack_cutoff_kz;

// The unit vector t along kt, x when kt = 0 (phi = 0, as for the Floquet
// amplitudes).
std::array<nec_float, 2> transverse_direction(nec_periodic::vec2 kt)
{
  const nec_float transverse = std::hypot(kt.x, kt.y);
  if (transverse == 0.0)
    return {1.0, 0.0};
  return {kt.x / transverse, kt.y / transverse};
}

// The power normalization of a Floquet amplitude: E = -(eta k / (2 A kz)) N_t
// carries A |E|^2 |kz| / (2 eta k) = |a|^2 / 2 per cell. In wavelength units
// with native currents, E keeps its value and the area carries the
// wavelength into the power.
nec_complex amplitude_normalization(nec_float wavelength, nec_float area, nec_complex kz, nec_float k)
{
  const nec_float eta = nec_periodic::nec_segment_field_impedance;
  return -(wavelength / 2.0) * std::sqrt(eta * k / area) * std::sqrt(std::abs(kz)) / kz;
}

struct polarization_vectors {
  // Up- and down-going: e = z x t for TE, theta-hat of (kt, +-kz) for TM.
  std::array<nec_complex, 3> up, down;
};

polarization_vectors polarizations(nec_periodic::vec2 kt, nec_complex kz, nec_float k, bool te)
{
  const auto [tx, ty] = transverse_direction(kt);
  if (te)
    return {{-ty, tx, 0.0}, {-ty, tx, 0.0}};
  const nec_complex cos_theta = kz / k;
  const nec_float sin_theta = std::hypot(kt.x, kt.y) / k;
  return {{cos_theta * tx, cos_theta * ty, -sin_theta},
          {-cos_theta * tx, -cos_theta * ty, -sin_theta}};
}

nec_complex dot(const std::array<nec_complex, 3>& p, nec_float x, nec_float y, nec_float z)
{
  return p[0] * x + p[1] * y + p[2] * z;
}

nec_complex dot(const std::array<nec_complex, 3>& p, const std::array<nec_complex, 3>& n)
{
  return p[0] * n[0] + p[1] * n[1] + p[2] * n[2];
}

nec_float total_thickness(const std::vector<nec_periodic::dielectric_layer>& layers)
{
  nec_float total = 0;
  for (const nec_periodic::dielectric_layer& layer : layers)
    total += layer.thickness;
  return total;
}

// kappa: the limit at cut-off of the observation and source projections of
// a reflected wave over the kernel's split ones (without the source factor):
// both tend to u for TE and to -(kt / k) u for TM.
nec_float split_kappa(nec_float kt_over_k, bool te)
{
  return te ? 1.0 : kt_over_k * kt_over_k;
}

// The two reflection terms' sigma, the limit at cut-off of their a b^T over
// u v^T: (1 + G_b)^2 kappa for the upper one (a = a_down + G_b W a_up) and
// kappa for the lower one.
std::pair<nec_complex, nec_float> split_sigmas(nec_complex lower, nec_float kappa)
{
  return {(1.0 + lower) * (1.0 + lower) * kappa, kappa};
}
}

void nec_context::stateful_set_periodic_stacks(periodic_stacks_definition stacks)
{
  m_periodic_stacks = std::move(stacks);
  m_prepared_stack.reset();
}

void nec_context::stateful_set_periodic_finite_ground(std::optional<periodic_finite_ground> finite)
{
  m_periodic_finite_ground = finite;
  m_prepared_stack.reset();
}

void nec_context::stateful_check_periodic_boundaries(const periodic_stacks_definition& stacks,
  bool ground_below, bool finite_ground) const
{
  char reason[320];
  const std::vector<nec_periodic::wire_segment> segments = periodic_wire_segments_m();
  for (size_t index = 0; index < segments.size(); ++index) {
    const nec_periodic::wire_segment& segment = segments[index];
    const long long number = static_cast<long long>(index + 1);
    const int tag = m_geometry->segment_tags[static_cast<int64_t>(index)];
    const nec_float highest = std::max(segment.start[2], segment.end[2]) + segment.radius;
    const nec_float lowest = std::min(segment.start[2], segment.end[2]) - segment.radius;
    if (stacks.above && highest >= stacks.above->face_z_m) {
      std::snprintf(reason, sizeof(reason),
        "CONDUCTOR ENTERS THE LAYERED STACK: SEGMENT %lld (TAG %d) REACHES Z = %.4g M"
        " (AXIS PLUS RADIUS) AND THE STACK STARTS AT Z = %.4g M; WIRES MUST STAY IN"
        " THE AIR BELOW IT",
        number, tag, highest, stacks.above->face_z_m);
      throw nec_geometry_exception(reason);
    }
    if (stacks.below && lowest <= stacks.below->face_z_m) {
      std::snprintf(reason, sizeof(reason),
        "CONDUCTOR ENTERS THE LAYERED STACK BELOW THE WIRES: SEGMENT %lld (TAG %d)"
        " REACHES Z = %.4g M (AXIS MINUS RADIUS) AND THE STACK ENDS AT Z = %.4g M;"
        " WIRES MUST STAY IN THE AIR ABOVE IT",
        number, tag, lowest, stacks.below->face_z_m);
      throw nec_geometry_exception(reason);
    }
    if (finite_ground && lowest <= 0) {
      std::snprintf(reason, sizeof(reason),
        "CONDUCTOR ENTERS THE FINITE GROUND: SEGMENT %lld (TAG %d) REACHES Z = %.4g M"
        " (AXIS MINUS RADIUS); WIRES MUST STAY IN THE AIR ABOVE Z = 0",
        number, tag, lowest);
      throw nec_geometry_exception(reason);
    }
  }
  if (stacks.below && ground_below) {
    const nec_float thickness = total_thickness(stacks.below->layers);
    const nec_float lowest_face = stacks.below->face_z_m - thickness;
    if (lowest_face < -resting_on_ground * thickness) {
      std::snprintf(reason, sizeof(reason),
        "LAYERED STACK BELOW THE WIRES REACHES INTO THE GROUND: ITS LOWEST FACE IS AT"
        " Z = %.4g M AND THE GROUND STARTS AT Z = 0",
        lowest_face);
      throw nec_geometry_exception(reason);
    }
  }
}

std::optional<nec_context::periodic_stack_diagnostics>
nec_context::stateful_periodic_stack_diagnostics() const
{
  if (!m_prepared_stack)
    return std::nullopt;
  return periodic_stack_diagnostics{m_prepared_stack->gap_m, m_prepared_stack->modes.size()};
}

nec_float nec_context::prepare_periodic_stack(const nec_periodic::lattice_2d& lattice,
  nec_periodic::vec2 scan_wavevector, nec_float per_metre)
{
  m_prepared_stack.reset();
  const periodic_stacks_definition& stacks = m_periodic_stacks;
  if (!stacks.above && !stacks.below && !m_periodic_finite_ground)
    return 0;
  nec_float top_m = -std::numeric_limits<nec_float>::infinity();
  nec_float bottom_m = std::numeric_limits<nec_float>::infinity();
  for (const nec_periodic::wire_segment& segment : periodic_wire_segments_m()) {
    top_m = std::max({top_m, segment.start[2], segment.end[2]});
    bottom_m = std::min({bottom_m, segment.start[2], segment.end[2]});
  }
  const auto in_wavelengths = [per_metre](const std::vector<nec_periodic::dielectric_layer>& layers) {
    std::vector<nec_periodic::dielectric_layer> scaled;
    for (const nec_periodic::dielectric_layer& layer : layers)
      scaled.push_back({layer.thickness * per_metre, layer.permittivity});
    return scaled;
  };

  prepared_periodic_stack prepared;
  prepared.gap_m = std::numeric_limits<nec_float>::infinity();
  const char* nearest = "LAYERED STACK";
  if (stacks.above) {
    prepared_stack_side side;
    side.face_z = stacks.above->face_z_m * per_metre;
    side.layers = in_wavelengths(stacks.above->layers);
    side.far_z = side.face_z + total_thickness(side.layers);
    prepared.above = std::move(side);
    prepared.gap_m = stacks.above->face_z_m - top_m;
  }
  if (stacks.below || m_periodic_finite_ground) {
    prepared_stack_side side;
    const bool grounded = ground.type_perfect() || m_periodic_finite_ground;
    if (ground.type_perfect()) {
      side.beyond.perfect_conductor = true;
    } else if (m_periodic_finite_ground) {
      // exp(+jwt): eps = eps_r - j sigma / (w eps0), as nec_ground forms it.
      side.beyond.permittivity = nec_complex(m_periodic_finite_ground->relative_permittivity,
        -m_periodic_finite_ground->conductivity_s_per_m * _wavelength * em::impedance_over_2pi());
    }
    nec_float gap_m = bottom_m;
    if (stacks.below) {
      side.face_z = stacks.below->face_z_m * per_metre;
      side.layers = in_wavelengths(stacks.below->layers);
      const nec_float thickness = total_thickness(side.layers);
      side.far_z = side.face_z - thickness;
      // Air between the stack and the ground.
      if (grounded && side.far_z > resting_on_ground * thickness)
        side.layers.push_back({side.far_z, 1.0});
      gap_m = bottom_m - stacks.below->face_z_m;
    } else if (gap_m < prepared.gap_m) {
      nearest = "FINITE GROUND";
    }
    prepared.below = std::move(side);
    prepared.gap_m = std::min(prepared.gap_m, gap_m);
  }

  // Every mode whose term decays by less than exp(-decay) over twice the gap.
  const nec_float k = two_pi();
  const nec_float gap = prepared.gap_m * per_metre;
  const nec_float kz_limit = stack_decay / (2 * gap);
  const nec_float kt_limit2 = k * k + kz_limit * kz_limit;
  const nec_float area = lattice.cell_area();
  const auto refuse = [&](nec_float modes) {
    char reason[320];
    std::snprintf(reason, sizeof(reason),
      "%s TOO CLOSE TO THE WIRES: A GAP OF %.4g M (%.4g WAVELENGTHS)"
      " NEEDS ABOUT %.0f FLOQUET MODES AT THE PERIODIC TOLERANCE, AT MOST %.0f;"
      " WIDEN THE GAP",
      nearest, prepared.gap_m, gap, modes, max_stack_modes);
    throw nec_geometry_exception(reason);
  };
  const nec_float expected = area * kt_limit2 / (4 * pi());
  if (expected > 2 * max_stack_modes)
    refuse(expected);

  const nec_periodic::vec2 a1 = lattice.reduced_a1(), a2 = lattice.reduced_a2();
  const nec_periodic::vec2 b1 = lattice.reduced_b1(), b2 = lattice.reduced_b2();
  const nec_float reach = std::sqrt(kt_limit2) + std::hypot(scan_wavevector.x, scan_wavevector.y);
  const long p_max = long(std::ceil(reach * std::hypot(a1.x, a1.y) / two_pi()));
  const long q_max = long(std::ceil(reach * std::hypot(a2.x, a2.y) / two_pi()));
  for (long p = -p_max; p <= p_max; ++p)
    for (long q = -q_max; q <= q_max; ++q) {
      prepared_stack_mode mode;
      mode.kt_x = scan_wavevector.x + p * b1.x + q * b2.x;
      mode.kt_y = scan_wavevector.y + p * b1.y + q * b2.y;
      const nec_float kt2 = mode.kt_x * mode.kt_x + mode.kt_y * mode.kt_y;
      if (kt2 > kt_limit2)
        continue;
      mode.kz = std::sqrt(nec_complex(k * k - kt2, 0.0));
      if (mode.kz.imag() > 0)
        mode.kz = std::conj(mode.kz);
      prepared.modes.push_back(mode);
    }
  if (double(prepared.modes.size()) > max_stack_modes)
    refuse(double(prepared.modes.size()));

  // A mode split out of the kernel takes the kernel's kt and kz, so that its
  // stack terms and its split singular part cancel consistently.
  for (const nec_periodic::floquet_mode& split : m_periodic_green->split_modes())
    for (prepared_stack_mode& mode : prepared.modes)
      if (std::hypot(mode.kt_x - split.kt.x, mode.kt_y - split.kt.y) < 1e-9 * k) {
        mode.kt_x = split.kt.x;
        mode.kt_y = split.kt.y;
        mode.split = true;
        mode.kz = split.kz;
      }

  m_prepared_stack = std::move(prepared);
  nec_float nearest_cutoff = 1;  // the smallest |kz| / k
  for (prepared_stack_mode& mode : m_prepared_stack->modes) {
    const nec_complex kz = stack_cutoff_kz(mode.kz, k);
    for (const bool te : {true, false})
      std::tie(mode.above[te ? 0 : 1], mode.below[te ? 0 : 1]) = periodic_stack_side_responses(kz, te);
    nearest_cutoff = std::min(nearest_cutoff, std::abs(kz) / k);
  }
  // Truncation, and the rounding of terms of size k / kz near cut-off.
  return std::exp(-stack_decay) + std::numeric_limits<nec_float>::epsilon() / nearest_cutoff;
}

std::pair<nec_periodic::stack_response, nec_periodic::stack_response>
nec_context::periodic_stack_side_responses(nec_complex kz, bool te) const
{
  const prepared_periodic_stack& stack = *m_prepared_stack;
  const nec_periodic::polarization mode = te ? nec_periodic::polarization::te : nec_periodic::polarization::tm;
  const nec_float k = two_pi();
  const auto respond = [&](const std::optional<prepared_stack_side>& side) {
    return side ? nec_periodic::stack_response_of(side->layers, k, kz, mode, side->beyond)
                : nec_periodic::stack_response{};
  };
  return {respond(stack.above), respond(stack.below)};
}

nec_context::stack_mode_response nec_context::periodic_stack_mode_response(
  const nec_periodic::stack_response& above, const nec_periodic::stack_response& below,
  nec_complex kz, bool te) const
{
  const prepared_periodic_stack& stack = *m_prepared_stack;
  // The voltage reflection is that of the tangential field; on theta-hat
  // amplitudes TM reflects with the opposite sign (theta-hat of the
  // reflected wave has the opposite tangential part).
  const auto field = [te](nec_complex reflection) { return te ? reflection : -reflection; };
  const nec_float rho = te ? -1.0 : 1.0;
  stack_mode_response mode;
  if (stack.above) {
    mode.upper = field(above.reflection);
    mode.upper_z = stack.above->face_z;
    mode.upper_far_z = stack.above->far_z;
    mode.upper_transmission = above.transmission;
    mode.upper_absorbed = above.absorbed;
  }
  if (stack.below) {
    mode.lower = field(below.reflection);
    mode.lower_z = stack.below->face_z;
    mode.lower_far_z = stack.below->far_z;
    mode.lower_transmission = below.transmission;
    mode.lower_absorbed = below.absorbed;
    if (ground.type_perfect())
      mode.lower_in_kernel = rho * std::exp(-2.0 * j_unit * kz * mode.lower_z);
  } else if (ground.type_perfect()) {
    mode.lower = rho;
    mode.lower_in_kernel = rho;
    mode.lower_transmission = 0.0;
  }
  mode.transit = std::exp(-j_unit * kz * (mode.upper_z - mode.lower_z));
  mode.multiple_reflections = 1.0 / (1.0 - mode.upper * mode.lower * mode.transit * mode.transit);
  return mode;
}

nec_complex nec_context::periodic_stack_split_factor(const nec_periodic::floquet_mode& mode,
  bool te, nec_float source_factor) const
{
  const nec_float k = two_pi();
  for (const prepared_stack_mode& stack_mode : m_prepared_stack->modes) {
    if (!stack_mode.split || stack_mode.kt_x != mode.kt.x || stack_mode.kt_y != mode.kt.y)
      continue;
    const int index = te ? 0 : 1;
    const stack_mode_response response = periodic_stack_mode_response(
      stack_mode.above[index], stack_mode.below[index], stack_cutoff_kz(stack_mode.kz, k), te);
    const auto [upper_sigma, lower_sigma] =
      split_sigmas(response.lower, split_kappa(std::hypot(mode.kt.x, mode.kt.y) / k, te));
    const nec_complex joined = response.upper * response.multiple_reflections * upper_sigma +
      (response.lower - response.lower_in_kernel) * lower_sigma;
    return 1.0 + joined / source_factor;
  }
  return 1.0;
}

void nec_context::periodic_stack_fill(nec_periodic::low_rank_update& update)
{
  const prepared_periodic_stack& stack = *m_prepared_stack;
  const int64_t n = m_geometry->n_segments;
  const nec_float k = two_pi();
  const nec_float area = m_periodic_green->lattice().cell_area();
  const nec_float eta = nec_periodic::nec_segment_field_impedance;
  const bool perfect = ground.type_perfect();
  const bool has_lower = stack.below || perfect;

  // The basis functions that each segment's current belongs to.
  struct basis_term {
    int64_t basis;
    nec_float a, b, c;
  };
  std::vector<std::vector<basis_term>> expansion(static_cast<size_t>(n));
  for (int segment = 1; segment <= n; ++segment) {
    m_geometry->trio(segment);
    for (int entry = 0; entry < m_geometry->jsno; ++entry)
      expansion[size_t(segment - 1)].push_back({m_geometry->jco[entry] - 1,
        m_geometry->ax[entry], m_geometry->bx[entry], m_geometry->cx[entry]});
  }
  const auto current = [](const basis_term& term, const nec_periodic::floquet_moments& m) {
    return term.a * m.constant + term.b * m.sine + term.c * m.cosine;
  };

  const size_t size = static_cast<size_t>(n);
  std::vector<nec_complex> transverse_phase(size), from_upper(size), from_lower(size);
  std::vector<nec_periodic::floquet_moments> up_moments(size), down_moments(size);
  std::vector<nec_complex> a(size), b(size), a_up(size), s_down(size), split_u(size), split_v(size);

  // c G (a b^T - sigma u v^T): into the matrix, or for a large term that is
  // not split into the update with the inverse coefficient 1 / (c G).
  const auto add_term = [&](bool split, nec_complex kz, nec_complex coefficient, nec_float size_factor,
    nec_complex inverse, const std::vector<nec_complex>& observed,
    const std::vector<nec_complex>& source, nec_complex sigma) {
    const nec_complex c = -eta * k / (2.0 * area * kz) * coefficient;
    if (split) {
      for (int64_t i = 0; i < n; ++i)
        for (int64_t basis = 0; basis < n; ++basis)
          cm[basis + i * neq] += c * (observed[size_t(i)] * source[size_t(basis)] -
            (sigma != 0.0 ? sigma * split_u[size_t(i)] * split_v[size_t(basis)] : 0.0));
      return;
    }
    if (std::abs(coefficient) * size_factor * k / std::abs(kz) > periodic_stack_low_rank_threshold) {
      update.add(observed, source, (-2.0 * area * kz / (eta * k)) * inverse);
      return;
    }
    // cmset's transposed fill: basis function x, observation i.
    for (int64_t i = 0; i < n; ++i) {
      const nec_complex row = c * observed[size_t(i)];
      for (int64_t basis = 0; basis < n; ++basis)
        cm[basis + i * neq] += row * source[size_t(basis)];
    }
  };

  for (const prepared_stack_mode& mode : stack.modes) {
    const nec_periodic::vec2 kt{mode.kt_x, mode.kt_y};
    const nec_complex kz = stack_cutoff_kz(mode.kz, k);
    const stack_mode_response responses[2] = {
      periodic_stack_mode_response(mode.above[0], mode.below[0], kz, true),
      periodic_stack_mode_response(mode.above[1], mode.below[1], kz, false)};
    const nec_float upper_z = responses[0].upper_z, lower_z = responses[0].lower_z;
    for (int64_t i = 0; i < n; ++i) {
      const nec_float x = m_geometry->x[i], y = m_geometry->y[i], z = m_geometry->z[i];
      const nec_periodic::point direction{m_geometry->cab[i], m_geometry->sab[i], m_geometry->salp[i]};
      transverse_phase[size_t(i)] = std::exp(-j_unit * (kt.x * x + kt.y * y));
      if (stack.above) {
        from_upper[size_t(i)] = std::exp(j_unit * kz * (z - upper_z));
        up_moments[size_t(i)] = nec_periodic::segment_mode_moments(
          {{x, y, z - upper_z}, direction, m_geometry->segment_length[i]}, kt, kz, k);
      }
      if (has_lower) {
        from_lower[size_t(i)] = std::exp(-j_unit * kz * (z - lower_z));
        down_moments[size_t(i)] = nec_periodic::segment_mode_moments(
          {{x, y, z - lower_z}, direction, m_geometry->segment_length[i]}, kt, -kz, k);
      }
    }
    for (const bool te : {true, false}) {
      const stack_mode_response& response = responses[te ? 0 : 1];
      const nec_complex upper = response.upper * response.multiple_reflections;
      const nec_complex lower = response.lower - response.lower_in_kernel;
      if (upper == nec_complex(0.0, 0.0) && lower == nec_complex(0.0, 0.0))
        continue;
      const nec_complex bounce = response.lower * response.transit;  // G_b W
      const polarization_vectors p = polarizations(kt, kz, k, te);
      std::fill(b.begin(), b.end(), nec_complex(0.0, 0.0));
      std::fill(s_down.begin(), s_down.end(), nec_complex(0.0, 0.0));
      for (int64_t i = 0; i < n; ++i) {
        const nec_float ox = m_geometry->cab[i], oy = m_geometry->sab[i], oz = m_geometry->salp[i];
        const nec_complex along_up = dot(p.up, ox, oy, oz), along_down = dot(p.down, ox, oy, oz);
        const nec_complex observed_down = stack.above ? along_down * from_upper[size_t(i)] : 0.0;
        const nec_complex observed_up = has_lower ? along_up * from_lower[size_t(i)] : 0.0;
        a[size_t(i)] = transverse_phase[size_t(i)] * (observed_down + bounce * observed_up);
        a_up[size_t(i)] = transverse_phase[size_t(i)] * observed_up;
        for (const basis_term& term : expansion[size_t(i)]) {
          const nec_complex source_up =
            stack.above ? along_up * current(term, up_moments[size_t(i)]) : 0.0;
          const nec_complex source_down =
            has_lower ? along_down * current(term, down_moments[size_t(i)]) : 0.0;
          b[size_t(term.basis)] += source_up + bounce * source_down;
          s_down[size_t(term.basis)] += source_down;
        }
      }

      // A split mode's part G sigma u v^T joined the kernel's split singular
      // part (periodic_stack_split_factor); the rest is finite at cut-off.
      // Over perfect ground TE has no singular part (source factor 0), and
      // its reflection terms are finite at cut-off by themselves.
      const nec_float source_factor = te ? (perfect ? 0.0 : 1.0) : (perfect ? 2.0 : 1.0);
      std::pair<nec_complex, nec_float> sigmas{0.0, 0.0};
      if (mode.split && source_factor != 0.0) {
        sigmas = split_sigmas(response.lower, split_kappa(std::hypot(kt.x, kt.y) / k, te));
        const auto [tx, ty] = transverse_direction(kt);
        const nec_float px = te ? -ty : 0.0, py = te ? tx : 0.0, pz = te ? 0.0 : 1.0;
        std::fill(split_v.begin(), split_v.end(), nec_complex(0.0, 0.0));
        for (int64_t i = 0; i < n; ++i) {
          const nec_float ox = m_geometry->cab[i], oy = m_geometry->sab[i], oz = m_geometry->salp[i];
          const nec_float projection = px * ox + py * oy + pz * oz;
          split_u[size_t(i)] = transverse_phase[size_t(i)] * projection;
          const nec_periodic::floquet_moments m = nec_periodic::segment_floquet_moments(
            {{m_geometry->x[i], m_geometry->y[i], m_geometry->z[i]}, {ox, oy, oz},
             m_geometry->segment_length[i]}, kt, k);
          for (const basis_term& term : expansion[size_t(i)])
            split_v[size_t(term.basis)] += projection * current(term, m);
        }
      }

      if (upper != nec_complex(0.0, 0.0)) {
        // 1 / (G_a / D) = 1 / G_a - G_b W^2. Near a pole of the lower stack
        // the vectors carry the large G_b W, so their size enters the routing.
        const nec_complex inverse =
          (std::isfinite(std::abs(response.upper)) ? 1.0 / response.upper : nec_complex(0.0, 0.0)) -
          bounce * response.transit;
        const nec_float size_factor = (1.0 + std::abs(bounce)) * (1.0 + std::abs(bounce));
        add_term(mode.split, kz, upper, size_factor, inverse, a, b, sigmas.first);
      }
      if (lower != nec_complex(0.0, 0.0)) {
        const nec_complex inverse = std::isfinite(std::abs(lower)) ? 1.0 / lower : nec_complex(0.0, 0.0);
        add_term(mode.split, kz, lower, 1.0, inverse, a_up, s_down, sigmas.second);
      }
    }
  }
}

namespace {
// The waves at the faces of a mode's air region, from the cell's direct up-
// (s_u at z_a) and down-going (s_d at z_b) waves, summing the reflections
// between the faces: X = (s_u + G_b W s_d) / D going up at z_a and
// Y = (s_d + G_a W s_u) / D going down at z_b.
struct face_waves {
  nec_complex up, down;
};
}

nec_float nec_context::stateful_periodic_dielectric_loss() const
{
  if (!m_prepared_stack)
    return 0;
  const nec_float k = two_pi();
  const nec_float area = m_periodic_green->lattice().cell_area();
  nec_float loss = 0;
  for (const prepared_stack_mode& mode : m_prepared_stack->modes) {
    if (mode.kz == nec_complex(0.0, 0.0))
      continue;
    const nec_periodic::vec2 kt{mode.kt_x, mode.kt_y};
    const nec_complex factor = amplitude_normalization(_wavelength, area, mode.kz, k);
    for (const bool te : {true, false}) {
      const int index = te ? 0 : 1;
      const stack_mode_response response =
        periodic_stack_mode_response(mode.above[index], mode.below[index], mode.kz, te);
      if (response.upper_absorbed == 0.0 && response.lower_absorbed == 0.0)
        continue;
      const polarization_vectors p = polarizations(kt, mode.kz, k, te);
      const nec_complex up =
        factor * dot(p.up, periodic_radiation_vector(kt, mode.kz, response.upper_z, false));
      const nec_complex down =
        factor * dot(p.down, periodic_radiation_vector(kt, -mode.kz, response.lower_z, false));
      const face_waves waves{
        (up + response.lower * response.transit * down) * response.multiple_reflections,
        (down + response.upper * response.transit * up) * response.multiple_reflections};
      loss += 0.5 * (std::norm(waves.up) * response.upper_absorbed +
                     std::norm(waves.down) * response.lower_absorbed);
    }
  }
  return loss;
}

std::pair<nec_complex, nec_complex> nec_context::stateful_periodic_floquet_amplitudes(
  const nec_periodic::floquet_mode& mode, bool above) const
{
  // At cut-off the mode carries no power: its field stays finite (the
  // low-rank update solves it) while the normalization goes to zero.
  if (mode.kz == nec_complex(0.0, 0.0))
    return {};
  const nec_float k = two_pi();
  const nec_float area = m_periodic_green->lattice().cell_area();
  const nec_complex factor = amplitude_normalization(_wavelength, area, mode.kz, k);
  if (!m_prepared_stack) {
    const polarization_vectors te = polarizations(mode.kt, mode.kz, k, true);
    const polarization_vectors tm = polarizations(mode.kt, mode.kz, k, false);
    const std::array<nec_complex, 3> radiation =
      periodic_radiation_vector(mode.kt, above ? mode.kz : -mode.kz);
    return {factor * dot(above ? te.up : te.down, radiation),
            factor * dot(above ? tm.up : tm.down, radiation)};
  }

  // The waves at the faces, transmitted through the stack on that side (if
  // any) and referred back to the origin.
  nec_complex amplitude[2];
  for (const bool te : {true, false}) {
    const auto [upper, lower] = periodic_stack_side_responses(mode.kz, te);
    const stack_mode_response response = periodic_stack_mode_response(upper, lower, mode.kz, te);
    const polarization_vectors p = polarizations(mode.kt, mode.kz, k, te);
    const nec_complex up =
      factor * dot(p.up, periodic_radiation_vector(mode.kt, mode.kz, response.upper_z, false));
    const nec_complex down =
      factor * dot(p.down, periodic_radiation_vector(mode.kt, -mode.kz, response.lower_z, false));
    amplitude[te ? 0 : 1] = above
      ? (up + response.lower * response.transit * down) * response.multiple_reflections *
          response.upper_transmission * std::exp(j_unit * mode.kz * response.upper_far_z)
      : (down + response.upper * response.transit * up) * response.multiple_reflections *
          response.lower_transmission * std::exp(-j_unit * mode.kz * response.lower_far_z);
  }
  return {amplitude[0], amplitude[1]};
}
