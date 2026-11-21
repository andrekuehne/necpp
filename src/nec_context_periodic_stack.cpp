/*
  A layered stack above the wires of a periodic unit cell (issue #32, ADR
  0001): each Floquet mode leaves a source, reflects off the stack and returns
  to an observation point, which adds to the interaction matrix

    Z_refl = sum_pq sum_{TE,TM} c R_eff a b^T,   c = -eta k / (2 A kz),

  with b the mode's moments of the basis functions (the upward wave, with the
  ground image over perfect ground) and a the field of the reflected,
  downward wave at the observation points (with its ground reflection). For
  reflection R at the stack's lower face h and the ground's rho (-1 TE, +1 TM
  in the field convention of the Floquet amplitudes), R_eff = R / (1 - rho R
  exp(-2j kz h)) sums the reflections between the two; phases are referred to
  h, so that evanescent terms decay as exp(-|kz| (2h - z - z')).

  Terms of size 1 / kz near cut-off, and terms near a guided-wave pole of the
  stack (R_eff large), go to the low-rank update with the finite inverse
  coefficient 1 / (c R_eff); the others go into the matrix. Near cut-off the
  stack's TE and TM terms nearly cancel the split singular parts of the
  kernel, so a mode exactly at cut-off is evaluated, consistently in both,
  at the nearest representable state |kz| = sqrt(eps) k.
*/
#include "nec_context.h"

#include "c_geometry.h"
#include "nec_exception.h"
#include "nec_periodic_accuracy.h"
#include "nec_periodic_clearance.h"
#include "nec_periodic_green.h"
#include "nec_periodic_low_rank.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <limits>

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
}

void nec_context::stateful_set_periodic_stack(std::optional<periodic_stack_definition> stack)
{
  m_periodic_stack = std::move(stack);
  m_prepared_stack.reset();
}

void nec_context::stateful_check_periodic_stack_entry(const periodic_stack_definition& stack) const
{
  const std::vector<nec_periodic::wire_segment> segments = periodic_wire_segments_m();
  for (size_t index = 0; index < segments.size(); ++index) {
    const nec_periodic::wire_segment& segment = segments[index];
    const nec_float highest = std::max(segment.start[2], segment.end[2]) + segment.radius;
    if (highest < stack.bottom_z_m)
      continue;
    char reason[320];
    std::snprintf(reason, sizeof(reason),
      "CONDUCTOR ENTERS THE LAYERED STACK: SEGMENT %lld (TAG %d) REACHES Z = %.4g M"
      " (AXIS PLUS RADIUS) AND THE STACK STARTS AT Z = %.4g M; WIRES MUST STAY IN"
      " THE AIR BELOW IT",
      static_cast<long long>(index + 1),
      m_geometry->segment_tags[static_cast<int64_t>(index)], highest, stack.bottom_z_m);
    throw nec_geometry_exception(reason);
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
  if (!m_periodic_stack)
    return 0;
  const periodic_stack_definition& stack = *m_periodic_stack;
  nec_float top_m = -std::numeric_limits<nec_float>::infinity();
  for (const nec_periodic::wire_segment& segment : periodic_wire_segments_m())
    top_m = std::max({top_m, segment.start[2], segment.end[2]});

  prepared_periodic_stack prepared;
  prepared.gap_m = stack.bottom_z_m - top_m;
  prepared.bottom_z = stack.bottom_z_m * per_metre;
  prepared.top_z = prepared.bottom_z;
  for (const nec_periodic::dielectric_layer& layer : stack.layers) {
    prepared.layers.push_back({layer.thickness * per_metre, layer.permittivity});
    prepared.top_z += layer.thickness * per_metre;
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
      "LAYERED STACK TOO CLOSE TO THE WIRES: A GAP OF %.4g M (%.4g WAVELENGTHS)"
      " NEEDS ABOUT %.0f FLOQUET MODES AT THE PERIODIC TOLERANCE, AT MOST %.0f;"
      " WIDEN THE GAP",
      prepared.gap_m, gap, modes, max_stack_modes);
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

  nec_float nearest_cutoff = 1;  // the smallest |kz| / k
  for (prepared_stack_mode& mode : prepared.modes) {
    const nec_complex kz = stack_cutoff_kz(mode.kz, k);
    mode.te = nec_periodic::stack_response_of(prepared.layers, k, kz, nec_periodic::polarization::te);
    mode.tm = nec_periodic::stack_response_of(prepared.layers, k, kz, nec_periodic::polarization::tm);
    nearest_cutoff = std::min(nearest_cutoff, std::abs(kz) / k);
  }
  m_prepared_stack = std::move(prepared);
  // Truncation, and the rounding of terms of size k / kz near cut-off.
  return std::exp(-stack_decay) + std::numeric_limits<nec_float>::epsilon() / nearest_cutoff;
}

nec_context::stack_mode_response nec_context::periodic_stack_mode_response(
  const nec_periodic::stack_response& response, nec_complex kz, bool te) const
{
  stack_mode_response mode;
  // The voltage reflection is that of the tangential field; on theta-hat
  // amplitudes TM reflects with the opposite sign (theta-hat of the
  // down-going wave has the opposite tangential part).
  mode.reflection = te ? response.reflection : -response.reflection;
  mode.transmission = response.transmission;
  mode.absorbed = response.absorbed;
  const nec_float rho = ground.type_perfect() ? (te ? -1.0 : 1.0) : 0.0;
  const nec_complex round_trip = std::exp(-2.0 * j_unit * kz * m_prepared_stack->bottom_z);
  mode.multiple_reflections = 1.0 / (1.0 - rho * mode.reflection * round_trip);
  return mode;
}

namespace {
// sigma: the limit at cut-off of a b^T over u v^T, the stack's observation
// and source columns over the kernel's split ones without the source factor
// (sf = 1 + rho): a -> sf u for TE, -(kt / k) sf u for TM.
nec_float split_sigma(nec_float source_factor, nec_float kt_over_k, bool te)
{
  return source_factor * source_factor * (te ? 1.0 : kt_over_k * kt_over_k);
}
}

nec_complex nec_context::periodic_stack_split_factor(const nec_periodic::floquet_mode& mode,
  bool te, nec_float source_factor) const
{
  const nec_float k = two_pi();
  for (const prepared_stack_mode& stack_mode : m_prepared_stack->modes) {
    if (!stack_mode.split || stack_mode.kt_x != mode.kt.x || stack_mode.kt_y != mode.kt.y)
      continue;
    const stack_mode_response response = periodic_stack_mode_response(
      te ? stack_mode.te : stack_mode.tm, stack_cutoff_kz(stack_mode.kz, k), te);
    const nec_float kt_over_k = std::hypot(mode.kt.x, mode.kt.y) / k;
    return 1.0 + response.reflection * response.multiple_reflections *
      split_sigma(source_factor, kt_over_k, te) / source_factor;
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
  const nec_float h = stack.bottom_z;

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

  const size_t size = static_cast<size_t>(n);
  std::vector<nec_complex> transverse_phase(size), up(size), down(size);
  std::vector<nec_periodic::floquet_moments> direct(size), image(size);
  std::vector<nec_complex> a(size), b(size), split_u(size), split_v(size);
  for (const prepared_stack_mode& mode : stack.modes) {
    const nec_periodic::vec2 kt{mode.kt_x, mode.kt_y};
    const nec_complex kz = stack_cutoff_kz(mode.kz, k);
    for (int64_t i = 0; i < n; ++i) {
      const nec_float x = m_geometry->x[i], y = m_geometry->y[i], z = m_geometry->z[i];
      const nec_periodic::point direction{m_geometry->cab[i], m_geometry->sab[i], m_geometry->salp[i]};
      transverse_phase[size_t(i)] = std::exp(-j_unit * (kt.x * x + kt.y * y));
      up[size_t(i)] = std::exp(j_unit * kz * (z - h));
      direct[size_t(i)] = nec_periodic::segment_mode_moments(
        {{x, y, z - h}, direction, m_geometry->segment_length[i]}, kt, kz, k);
      if (perfect) {
        down[size_t(i)] = std::exp(-j_unit * kz * (z + h));
        image[size_t(i)] = nec_periodic::segment_mode_moments(
          {{x, y, z + h}, direction, m_geometry->segment_length[i]}, kt, -kz, k);
      }
    }
    for (const bool te : {true, false}) {
      const stack_mode_response response =
        periodic_stack_mode_response(te ? mode.te : mode.tm, kz, te);
      if (response.reflection == nec_complex(0.0, 0.0))
        continue;
      const nec_float rho = perfect ? (te ? -1.0 : 1.0) : 0.0;
      const polarization_vectors p = polarizations(kt, kz, k, te);
      std::fill(b.begin(), b.end(), nec_complex(0.0, 0.0));
      for (int64_t i = 0; i < n; ++i) {
        const nec_float ox = m_geometry->cab[i], oy = m_geometry->sab[i], oz = m_geometry->salp[i];
        nec_complex observed = dot(p.down, ox, oy, oz) * up[size_t(i)];
        nec_complex source_up = dot(p.up, ox, oy, oz);
        nec_complex source_image = 0.0;
        if (perfect) {
          observed += rho * source_up * down[size_t(i)];
          source_image = rho * dot(p.down, ox, oy, oz);
        }
        a[size_t(i)] = transverse_phase[size_t(i)] * observed;
        const nec_periodic::floquet_moments& d = direct[size_t(i)];
        const nec_periodic::floquet_moments& g = image[size_t(i)];
        for (const basis_term& term : expansion[size_t(i)]) {
          nec_complex value = source_up * (term.a * d.constant + term.b * d.sine + term.c * d.cosine);
          if (perfect)
            value += source_image * (term.a * g.constant + term.b * g.sine + term.c * g.cosine);
          b[size_t(term.basis)] += value;
        }
      }
      const nec_complex effective = response.reflection * response.multiple_reflections;
      if (mode.split) {
        // The part c R_eff sigma u v^T joined the kernel's split singular part
        // (periodic_stack_split_factor); the rest is finite at cut-off.
        const nec_float source_factor = te ? (perfect ? 0.0 : 1.0) : (perfect ? 2.0 : 1.0);
        const nec_float sigma = split_sigma(source_factor, std::hypot(kt.x, kt.y) / k, te);
        if (sigma != 0.0) {
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
              split_v[size_t(term.basis)] += projection *
                (term.a * m.constant + term.b * m.sine + term.c * m.cosine);
          }
        }
        const nec_complex coefficient = -eta * k / (2.0 * area * kz) * effective;
        for (int64_t i = 0; i < n; ++i)
          for (int64_t basis = 0; basis < n; ++basis)
            cm[basis + i * neq] += coefficient * (a[size_t(i)] * b[size_t(basis)] -
              (sigma != 0.0 ? sigma * split_u[size_t(i)] * split_v[size_t(basis)] : 0.0));
        continue;
      }
      if (std::abs(effective) * k / std::abs(kz) > periodic_stack_low_rank_threshold) {
        // 1 / (c R_eff) = (1 / R - rho exp(-2j kz h)) / c.
        const nec_complex round_trip = std::exp(-2.0 * j_unit * kz * h);
        const nec_complex inverse_reflection = std::isfinite(std::abs(response.reflection))
          ? 1.0 / response.reflection : nec_complex(0.0, 0.0);
        update.add(a, b, (-2.0 * area * kz / (eta * k)) * (inverse_reflection - rho * round_trip));
        continue;
      }
      // cmset's transposed fill: basis function x, observation i.
      const nec_complex coefficient = -eta * k / (2.0 * area * kz) * effective;
      for (int64_t i = 0; i < n; ++i) {
        const nec_complex row = coefficient * a[size_t(i)];
        for (int64_t basis = 0; basis < n; ++basis)
          cm[basis + i * neq] += row * b[size_t(basis)];
      }
    }
  }
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
    // The up-going wave at the stack's lower face, power-normalized.
    const std::array<nec_complex, 3> radiation =
      periodic_radiation_vector(kt, mode.kz, m_prepared_stack->bottom_z);
    const nec_complex factor = amplitude_normalization(_wavelength, area, mode.kz, k);
    for (const bool te : {true, false}) {
      const stack_mode_response response =
        periodic_stack_mode_response(te ? mode.te : mode.tm, mode.kz, te);
      const nec_complex incident =
        factor * dot(polarizations(kt, mode.kz, k, te).up, radiation) * response.multiple_reflections;
      loss += 0.5 * std::norm(incident) * response.absorbed;
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
  const polarization_vectors te = polarizations(mode.kt, mode.kz, k, true);
  const polarization_vectors tm = polarizations(mode.kt, mode.kz, k, false);
  if (!m_prepared_stack) {
    const std::array<nec_complex, 3> radiation =
      periodic_radiation_vector(mode.kt, above ? mode.kz : -mode.kz);
    return {factor * dot(above ? te.up : te.down, radiation),
            factor * dot(above ? tm.up : tm.down, radiation)};
  }

  // The up-going wave from the cell (with its ground image), referred to the
  // stack's lower face h.
  const prepared_periodic_stack& stack = *m_prepared_stack;
  const std::array<nec_complex, 3> upward = periodic_radiation_vector(mode.kt, mode.kz, stack.bottom_z);
  const auto response = [&](bool is_te) {
    return periodic_stack_mode_response(nec_periodic::stack_response_of(stack.layers, k, mode.kz,
      is_te ? nec_periodic::polarization::te : nec_periodic::polarization::tm), mode.kz, is_te);
  };
  const stack_mode_response te_response = response(true), tm_response = response(false);
  if (above) {
    // Transmitted through the stack, then referred back to the origin.
    const nec_complex to_origin = std::exp(j_unit * mode.kz * stack.top_z);
    return {factor * dot(te.up, upward) * te_response.multiple_reflections * te_response.transmission * to_origin,
            factor * dot(tm.up, upward) * tm_response.multiple_reflections * tm_response.transmission * to_origin};
  }
  // Below the cell (free space): the down-going wave and the stack's
  // reflection of the up-going one.
  const std::array<nec_complex, 3> downward = periodic_radiation_vector(mode.kt, -mode.kz);
  const nec_complex from_face = std::exp(-j_unit * mode.kz * stack.bottom_z);
  return {factor * (dot(te.down, downward) + te_response.reflection * from_face * dot(te.up, upward)),
          factor * (dot(tm.down, downward) + tm_response.reflection * from_face * dot(tm.up, upward))};
}
