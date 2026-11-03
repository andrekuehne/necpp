# Macro bases are given in segment-centre currents

Status: accepted (2026-11-03)

A reduced-model caller gives each element's macro basis functions as real vectors of
segment-centre currents, and necpp maps them to NEC basis amplitudes itself through the
element's current-to-amplitude map before testing and expanding the interaction blocks.
NEC's interaction matrix is point-matched with columns in NEC basis amplitudes, which
would be cheaper and exact to expose directly, but amplitudes mean nothing to a caller:
it could neither build macro basis functions from incident fields nor inspect currents
without knowing NEC's basis construction. Segment-centre currents are also the space in
which the reduced-basis study behind this feature was done and the space of every current
necpp already reports.

## Consequences

- The mapping must stay local to one element, so an element whose NEC basis functions
  reach another element's wires through a junction is rejected.
- The map must be invertible on every shipped element shape (free ends, both ground
  connection modes, internal junctions); this is tested, not assumed.
- With an identity basis the reduced block is the segment-level impedance in ohms, the
  same matrix a port on every segment would give.
