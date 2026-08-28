# WP2 multi-port numerical engine

WP2 extends the deck-free [`nec_stateful_model`](../src/nec_stateful_model.h)
with port admittance and impedance matrices plus arbitrary simultaneous voltage
and current drives. It remains a native C++ layer; WP4 will expose these results
through the versioned C/WASM ABI.

## Matrix extraction and cache

`compute_admittance_matrix()` applies an exact one-volt source to each port in
turn, holds every other registered port at zero volts, and stores the resulting
port currents as one column of \(\mathbf Y\). Matrices are dense and row-major:

```text
index(row, column) = row * portCount + column
```

The row and column order is exactly the order supplied to `define_ports()`.
Every basis excitation reuses the LU factorization retained by WP1. Matrix
extraction therefore advances neither the factorization generation nor the
public solve generation. The extracted matrix is cached for the prepared
configuration; frequency, ground, or load invalidation clears both Y and Z.

Internal basis solves are not consumer solutions. Starting from `prepared`,
the context's temporary results are removed and the model remains prepared. If
a consumer solution already exists, the model re-executes its saved simultaneous
voltage excitation after extraction, then restores the saved public metadata and
generation. A subsequent far-field request therefore still observes the same
consumer excitation.

## Inversion and conditioning

`compute_impedance_matrix()` computes \(\mathbf Z=\mathbf Y^{-1}\) with a
complex Jacobi SVD. The reported condition estimate is the singular-value
ratio \(\sigma_\max/\sigma_\min\), i.e. a two-norm estimate. Empty, malformed,
nonfinite, singular, or nonfinite inversions throw a controlled `nec_exception`.
The default maximum accepted condition estimate is \(10^{12}\); larger values
also fail diagnostically instead of returning an unreliable Z matrix.

The inversion seam is implemented in `nec_port_matrix.cpp`. It is kept separate
from antenna geometry so the singular and ill-conditioned paths have
deterministic unit tests rather than depending on a degenerate physical model.

## Port solutions

`solve_port_voltages_detailed()` performs one simultaneous exact voltage-source
solve and returns the requested voltages, achieved voltages and currents,
active impedances, powers, frequency, and cache generations. The WP1
`solve_port_voltages()` method remains as a current-vector compatibility
wrapper over the detailed solve.

`solve_port_currents()` first forms the required source voltages using

\[
\mathbf V=\mathbf Z\mathbf I
\]

and then performs one simultaneous voltage-source solve. Its result retains
the requested currents separately from the achieved NEC currents. Active
impedance is \(V_i/I_i\), and time-average input power is
\(\tfrac12\operatorname{Re}(V_i I_i^*)\). An exactly zero achieved current is
represented by `NaN + jNaN` active impedance as required by the public API
contract.

## Verification

The WP2 Catch2 cases are in
[`nec_stateful_model_wp2_tb.cpp`](../src/nec_stateful_model_wp2_tb.cpp). They
cover:

- one-port Z agreement with the legacy NEC input impedance;
- reciprocal two-port mutual impedance;
- \(\mathbf Z\mathbf Y\) identity and row-major column extraction;
- direct NEC currents versus \(\mathbf Y\mathbf V\) for arbitrary complex V;
- achieved currents after applying \(\mathbf Z\mathbf I\);
- weight-dependent active impedance and the port power convention;
- matrix cache reuse, frequency invalidation, and generation behavior;
- exact-zero current drive and its NaN active-impedance sentinel;
- deterministic singular and over-limit condition diagnostics.
