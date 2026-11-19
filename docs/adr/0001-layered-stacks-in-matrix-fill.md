# Layered stacks enter the periodic solve through Floquet-mode reflection terms in the matrix fill

Layered stacks (radomes, substrates below the wires, finite ground) above or below an infinite array are modelled by adding, for each Floquet mode, the TE and TM reflection of the stack directly to the interaction matrix. This is a sum of low-rank terms built from the same modal segment integrals that the Floquet port uses. The usual alternative, chaining a generalized scattering matrix of the array with one of the stack after the solve, was rejected. It would need Floquet-mode excitation (stage 4), including evanescent incident modes whenever the stack is close to the array. The matrix-fill route gives scan impedance with the stack included and needs neither.

## Consequences

- A change of radome needs a new matrix fill and factorization, not just a cheap scattering-matrix product. Chaining remains possible later for frequency-selective-surface work.
- Wires must stay in an air region with a gap to every stack. The number of Floquet modes is set by the decay `exp(-|kz| * 2g)` over that gap, and a gap that would need too many modes is refused.
- Perfect ground stays on the existing image route, because reflection terms converge badly for wires close to the ground.
