#include "nec_periodic_clearance.h"

#include <algorithm>
#include <cmath>

namespace nec_periodic {
namespace {
constexpr double pi = 3.141592653589793238462643383279502884;

point minus(const point& a, const point& b) { return {a[0] - b[0], a[1] - b[1], a[2] - b[2]}; }
point plus_scaled(const point& a, const point& d, double s) {
  return {a[0] + s * d[0], a[1] + s * d[1], a[2] + s * d[2]};
}
double dot(const point& a, const point& b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
double length(const point& a) { return std::sqrt(dot(a, a)); }
double clamp01(double value) { return std::min(1.0, std::max(0.0, value)); }
point translated(const point& a, double tx, double ty) { return {a[0] + tx, a[1] + ty, a[2]}; }
}

// Closest points of two segments (Ericson, Real-Time Collision Detection,
// section 5.1.9), with the parameters clamped to the segments.
double segment_distance(const point& p1, const point& q1, const point& p2, const point& q2) {
  const point d1 = minus(q1, p1), d2 = minus(q2, p2), r = minus(p1, p2);
  const double a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  // Degenerate segments are points; NEC segments never are, but stay safe.
  const double tiny = 1e-300;
  double s = 0, t = 0;
  if(a <= tiny && e <= tiny) return length(r);
  if(a <= tiny) {
    t = clamp01(f / e);
  } else {
    const double c = dot(d1, r);
    if(e <= tiny) {
      s = clamp01(-c / a);
    } else {
      const double b = dot(d1, d2);
      const double denominator = a * e - b * b;
      s = denominator > 0 ? clamp01((b * f - c * e) / denominator) : 0.0;
      t = (b * s + f) / e;
      if(t < 0) {
        t = 0;
        s = clamp01(-c / a);
      } else if(t > 1) {
        t = 1;
        s = clamp01((b - c) / a);
      }
    }
  }
  return length(minus(plus_scaled(p1, d1, s), plus_scaled(p2, d2, t)));
}

namespace {
double segment_length(const wire_segment& segment) { return length(minus(segment.end, segment.start)); }

double segment_distance(const wire_segment& own, const wire_segment& other, const vec2& translation) {
  return nec_periodic::segment_distance(own.start, own.end, translated(other.start, translation.x, translation.y),
                                        translated(other.end, translation.x, translation.y));
}

// Lattice translations, other than zero and one of each pair T, -T, under
// which an image of some segment may come within `reach` of a segment, axis
// to axis. A pair (i, j) at T is the pair (j, i) at -T, so half the
// translations cover every pair.
std::vector<vec2> candidate_translations(const std::vector<wire_segment>& segments, const lattice_2d& lattice,
                                         double reach) {
  // The in-plane extent of the cell plus the longest segment and the reach
  // bounds the translations worth checking.
  double longest = 0;
  double low_x = segments[0].start[0], high_x = low_x, low_y = segments[0].start[1], high_y = low_y;
  for(const wire_segment& segment : segments) {
    longest = std::max(longest, segment_length(segment));
    for(const point& end : {segment.start, segment.end}) {
      low_x = std::min(low_x, end[0]);
      high_x = std::max(high_x, end[0]);
      low_y = std::min(low_y, end[1]);
      high_y = std::max(high_y, end[1]);
    }
  }
  const double search_radius = std::hypot(high_x - low_x, high_y - low_y) + longest + reach;

  // Enumerate over the reduced vectors, which keeps the index range tight
  // for skewed lattice vectors: |m| <= R |b1| / (2 pi) for every point within R.
  const vec2 a1 = lattice.reduced_a1(), a2 = lattice.reduced_a2();
  const vec2 b1 = lattice.reduced_b1(), b2 = lattice.reduced_b2();
  const long long m_max = static_cast<long long>(std::ceil(search_radius * std::hypot(b1.x, b1.y) / (2 * pi)));
  const long long n_max = static_cast<long long>(std::ceil(search_radius * std::hypot(b2.x, b2.y) / (2 * pi)));
  std::vector<vec2> translations;
  for(long long m = 0; m <= m_max; ++m)
    for(long long n = -n_max; n <= n_max; ++n) {
      if(m == 0 && n <= 0) continue;
      const vec2 translation{m * a1.x + n * a2.x, m * a1.y + n * a2.y};
      if(std::hypot(translation.x, translation.y) <= search_radius) translations.push_back(translation);
    }
  return translations;
}
}

std::optional<image_contact> find_image_contact(const std::vector<wire_segment>& segments,
                                                const lattice_2d& lattice, double contact_fraction) {
  if(segments.empty()) return std::nullopt;
  // The largest threshold of any pair bounds the search.
  double largest_radius = 0, longest = 0;
  for(const wire_segment& segment : segments) {
    largest_radius = std::max(largest_radius, segment.radius);
    longest = std::max(longest, segment_length(segment));
  }
  const double reach = 2 * largest_radius + contact_fraction * longest;

  for(const vec2& translation : candidate_translations(segments, lattice, reach)) {
    for(std::size_t i = 0; i < segments.size(); ++i) {
      const wire_segment& own = segments[i];
      for(std::size_t k = 0; k < segments.size(); ++k) {
        const wire_segment& other = segments[k];
        const double minimum_distance = own.radius + other.radius +
                                        contact_fraction * std::max(segment_length(own), segment_length(other));
        const double distance = segment_distance(own, other, translation);
        if(distance > minimum_distance) continue;
        // Report the image cell along the lattice vectors as given.
        const vec2 given_b1 = lattice.b1(), given_b2 = lattice.b2();
        return image_contact{i,
                             k,
                             std::llround((translation.x * given_b1.x + translation.y * given_b1.y) / (2 * pi)),
                             std::llround((translation.x * given_b2.x + translation.y * given_b2.y) / (2 * pi)),
                             distance,
                             minimum_distance};
      }
    }
  }
  return std::nullopt;
}

std::vector<vec2> close_image_translations(const std::vector<wire_segment>& segments, const lattice_2d& lattice,
                                           double reach) {
  std::vector<vec2> close;
  if(segments.empty()) return close;
  for(const vec2& translation : candidate_translations(segments, lattice, reach)) {
    bool is_close = false;
    for(std::size_t i = 0; i < segments.size() && !is_close; ++i)
      for(std::size_t k = 0; k < segments.size() && !is_close; ++k)
        is_close = segment_distance(segments[i], segments[k], translation) <= reach;
    if(is_close) {
      close.push_back(translation);
      close.push_back({-translation.x, -translation.y});
    }
  }
  return close;
}
}
