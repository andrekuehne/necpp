# necpp issue 32: FEM reference results (CST)

`fem-issue32-results.csv` (this folder) holds the full-wave FEM reference for the necpp issue 32
cell: an infinite strip-dipole array over ground, with (case A) and without (case B) a lossy
dielectric sheet. It uses the spec's layout,
`case,phi_deg,theta_deg,mesh_pass,R_ohm,X_ohm,frac_te00,frac_tm00,frac_sheet_loss`. There are 32
rows: 2 cases x 8 scan states x 2 mesh passes. The `#` lines at the top give the tool, feed, mesh,
conventions, checks and deviations.

## Tool and model

- CST Studio Suite 2024 (2024.3). Frequency domain solver, tetrahedral mesh, second-order
  elements, direct solver in double precision. One discrete frequency, 2.99792458 GHz
  (lambda0 = 100 mm).
- Cell: x -30..30, y -25..25, z 0..100 mm.
  - Unit cell boundaries with the scan angle (rectangular lattice 60 x 50 mm).
  - Electric (PEC) boundary at z = 0.
  - Floquet port at z = 100 mm with 18 modes: TE/TM (0,0), (+-1,0), (0,+-1), (+-1,+-1).
- Strip: zero-thickness PEC sheet at z = 25, x -24..24 (gap -0.5..0.5), y -1..1.
- Feed: discrete face port (S-parameter type, 50 ohm) on the whole 1 x 2 mm gap face between the
  strip edges at x = -0.5 and x = +0.5, directed +x.
  - Z = 50 (1 + S11) / (1 - S11).
  - This matches the ratio of CST's port voltage and current to 1e-13 ohm.
- Sheet (case A): z 40..43, eps_r 4.0, tan d 0.02 at f0, spanning the cell. Case B has the same
  brick as vacuum.
- Scan phase: CST's "outward" convention, a wave travelling toward (theta, phi). This is the phase
  law in the spec.

## How the two mesh passes were produced

- **final:** adaptive refinement at broadside until two consecutive passes changed S by less than
  0.001. All 8 scan states then ran on that mesh in one CST parameter sweep.
  - Case A: pass 12, 34920 tetrahedra.
  - Case B: pass 9, 24669 tetrahedra.
- **previous:** a separate run capped at one pass fewer. Its pass history is identical to passes
  1..N-1 of the final run (same cell counts), so it is the mesh one adaptive pass coarser.
  - Case A: pass 11, 31479 tetrahedra.
  - Case B: pass 8, 21131 tetrahedra.
- **Check of the reused mesh:** a third run adapted at theta 60, phi 90 instead of at broadside.
  - Case A: within 0.26 ohm of final.
  - Case B: within 0.86 ohm of final (at theta 60, where |Z| is about 295 ohm).

## Checks

- **Final against previous mesh:** |dZ| at most 0.17 ohm (case A) and 0.66 ohm (case B, at
  theta 60). It is at most 0.23 ohm in every other state.
- **Passivity:** |S11|^2 + |S_TE00|^2 + |S_TM00|^2 is at most 0.99993.
- **Power balance, case B (lossless):** equals 1 within 1.9e-4.
- **Power balance, case A:** 1 - frac_te00 - frac_tm00 equals CST's volume loss integral in the
  sheet within 3.0e-4. frac_sheet_loss in the CSV is that volume integral.
- **Mirror states:** (15,180), (30,270) and (30,225) reproduce (15,0), (30,90) and (30,45) to
  1e-11 ohm.
- **Higher modes:** every Floquet mode other than (0,0) is evanescent in every state. CST's
  attenuation constants match the analytic ones; the weakest is 33.6 /m for (0,-1) at
  theta 60, phi 90.
- **Solver log:** no warnings except an allocator notice (tbbmalloc).
- **Run time:** 80-160 s per sweep of 8 to 11 scan states on this workstation.

## Deviations

- None in geometry or materials.
- The strip is a zero-thickness sheet, and the feed is a face port over the full gap face. necpp's
  thin wires (radius 0.5 mm) and its gap model differ from this. Case B shows the size of that
  feed-model difference.
