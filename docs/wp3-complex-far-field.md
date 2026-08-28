# WP3 complex far-field engine

WP3 replaces the temporary raw `nec_radiation_pattern` view on
[`nec_stateful_model`](../src/nec_stateful_model.h) with copied bulk complex
fields. It remains a native C++ layer; WP4 will expose the model-owned
contiguous buffers through the versioned C/WASM ABI.

## Combined far fields

`compute_far_field()` samples the latest consumer solution and returns:

- the positive radius and prepared frequency;
- separate theta and phi coordinate axes in degrees;
- complex `E_theta` and `E_phi` vectors in V/m.

The field vectors contain `theta_deg.size() * phi_deg.size()` entries. Theta
varies fastest:

```text
sampleIndex = phiIndex * thetaCount + thetaIndex
```

The requested positive radius is passed to NEC's far-field calculation, so
every value includes the documented `exp(-j k R) / R` propagation factor. An
exactly zero consumer excitation is handled explicitly and returns exact
complex zeros without entering NEC's gain normalization path.

The native result is a deep copy of NEC's temporary radiation-pattern arrays.
It therefore survives replacement of the underlying native result collection.
The future TypeScript facade will immediately copy the WP4 buffers again into
JavaScript-owned typed arrays.

## Embedded far fields

`compute_embedded_far_fields()` returns one basis field per registered port.
Its outer dimension follows the exact `define_ports()` order:

```text
embeddedIndex = portIndex * samplesPerPort + sampleIndex
```

Two normalizations are available:

- `unit_voltage` (default): one volt at the selected port and zero volts at
  every other port;
- `unit_current`: one requested ampere into the selected port and zero
  requested amperes at every other port. The engine obtains each voltage basis
  from the corresponding column of the cached impedance matrix.

Fields can therefore be combined without another native field calculation:

\[
E_\theta=\sum_n w_n E_{\theta,n},\qquad
E_\phi=\sum_n w_n E_{\phi,n}.
\]

Voltage weights are used with the voltage-normalized basis; current weights
are used with the current-normalized basis.

Embedded calculations are internal basis solves. They do not advance the
factorization or solve generations. Starting from `prepared`, they remove the
temporary results and remain prepared. If a consumer solution exists, its
simultaneous voltage excitation, port quantities, state, and public generation
are restored after the basis calculation.

## Verification

The WP3 Catch2 cases are in
[`nec_stateful_model_wp3_tb.cpp`](../src/nec_stateful_model_wp3_tb.cpp). They
cover:

- copied axes, finite complex buffers, and theta-fast indexing;
- the exact complex `exp(-j k DeltaR) R1/R2` radial law;
- voltage-normalized embedded-field superposition;
- current-normalized embedded-field superposition and consumer-solution
  restoration;
- exact-zero fields without NaNs;
- center-fed dipole axial nulls and mirror symmetry;
- deterministic zero entries for angles NEC skips below a ground plane.
