# NEC2++ engine

The NEC-2 method-of-moments engine and its stateful WASM model, as used by array
visualizers that solve or reduce NEC's interaction matrix.

## Language

**NEC basis function**:
NEC-2's own current expansion function, centred on one segment and reaching into its
neighbours and across junctions; the interaction matrix's columns are their amplitudes.
_Avoid_: basis (unqualified), segment basis

**Segment-centre current**:
The current at the centre of one segment, in amperes; the space in which callers give
and receive current vectors.
_Avoid_: basis amplitude, segment coefficient

**Element**:
One positioned copy of a wire pattern; elements share no junctions and so no NEC basis
functions.
_Avoid_: antenna, cell

**Macro basis function (MBF)**:
A fixed, real vector of segment-centre currents over one element's segments, used as a
single unknown of a reduced model.
_Avoid_: piece, characteristic basis function, basis function (unqualified)

**Macro basis**:
The set of macro basis functions assigned to one element.
_Avoid_: basis set, reduced basis

**Reduced interaction block**:
The interaction between the macro bases of two elements, NEC's interaction block
tested and expanded with those macro basis functions.
_Avoid_: squeezed block, Galerkin block
