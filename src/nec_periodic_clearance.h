#pragma once
// Clearance between the conductors of a unit cell and their periodic images,
// and the images close enough to need NEC's thin-wire segment field.
//
// The periodic solver models arrays whose cells are electrically separate. A
// conductor that touches, or nearly touches, a periodic image (its own or
// that of another conductor in the cell) would form a connected array, which
// the solver does not support. The check measures distances to images, not
// to a cell wall, which has no unique shape for a non-rectangular lattice.
#include "nec_periodic_green.h"

#include <cstddef>
#include <optional>
#include <vector>

namespace nec_periodic {

// One straight wire segment: its two ends and its radius.
struct wire_segment {
  point start;
  point end;
  double radius = 0;
};

// A segment of the unit cell too close to the image of a segment in another
// cell. The image cell (m, n) sits at m a1 + n a2 of the lattice vectors as
// given; distance is between the segment axes.
struct image_contact {
  std::size_t segment = 0;
  std::size_t image_segment = 0;
  long long m = 0, n = 0;
  double distance = 0;
  double minimum_distance = 0;
};

// Shortest distance between two line segments p1-q1 and p2-q2.
double segment_distance(const point& p1, const point& q1, const point& p2, const point& q2);

// A segment pair, if any, whose axes come no further apart than the sum of
// the two radii plus contact_fraction times the longer segment's length: the conductors touch, or come within NEC's tolerance for
// joining segment ends (SMIN) of touching. Every lattice translation other
// than zero is considered; segments are in the same length unit as the
// lattice.
std::optional<image_contact> find_image_contact(const std::vector<wire_segment>& segments,
                                                const lattice_2d& lattice, double contact_fraction);

// Every lattice translation T other than zero under which an image of some
// segment comes within `reach` of a segment, axis to axis. T and -T come
// together: the image of segment j at T near segment i is the image of i at
// -T near j.
std::vector<vec2> close_image_translations(const std::vector<wire_segment>& segments, const lattice_2d& lattice,
                                           double reach);
}
