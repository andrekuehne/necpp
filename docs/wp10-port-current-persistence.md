# WP10 - Persisted port-to-current response models

## Status

**Proposed (2026-08-29).**

This workpackage adds a compact prepared-model representation for configurations
that are expensive to factor but are repeatedly excited with different array
weights. The persisted representation contains one voltage-normalized raw NEC
current solution per port plus the port admittance/impedance data required for
voltage- and current-driven operation. It intentionally does not persist the
dense NEC interaction matrix or its LU factors.

The primary target is a wire-only phased array such as a 16 x 16 through
32 x 32 collection of 11-segment dipoles over ground. The design must remain
well-defined for every geometry currently accepted by `nec_stateful_model`, but
the first implementation does not need to extend the public geometry surface
beyond wires.

## Motivation

For a fixed geometry, frequency, ground and loading configuration, NEC solves a
linear system

\[
\mathbf A\mathbf x = \mathbf R\mathbf v,
\]

where `v` is the ordered port-voltage vector and `x` is NEC's raw solved
method-of-moments vector. If one unit-voltage solve is retained for every port,

\[
\mathbf C =
\begin{bmatrix}
\mathbf x_0 & \mathbf x_1 & \dots & \mathbf x_{P-1}
\end{bmatrix},
\]

then any later voltage excitation can be reconstructed without the interaction
matrix:

\[
\mathbf x = \mathbf C\mathbf v.
\]

Port currents follow from

\[
\mathbf i = \mathbf Y\mathbf v,
\]

and a requested current excitation can be handled with

\[
\mathbf v = \mathbf Z\mathbf i, \qquad
\mathbf x = \mathbf C\mathbf v.
\]

After reconstructing `x`, the existing NEC current-coefficient and far-field
code can calculate fields for an arbitrary angular grid. This retains more
capability than persisting fields on one fixed grid while requiring about one
eleventh of the storage of a full LU factorization for an 11-segment,
one-port-per-dipole array.

## Critical numerical distinction

The persisted columns must be the raw solved NEC vector immediately after
`solves()` and before `c_geometry::get_current_coefficients()` mutates that
vector.

The complex current reported at a segment centre is the postprocessed value
`A + C`. It does not retain the separate constant, sine and cosine interpolation
coefficients used by NEC's field integrals. A matrix containing only those
reported centre currents is therefore not sufficient to reproduce exact
far fields in the general case.

The reduced solve path must instead:

1. form one combined raw solution `x = C v`;
2. pass a copy or owned mutable vector to `get_current_coefficients()`;
3. let that routine populate `air/aii`, `bir/bii` and `cir/cii` and produce the
   current vector expected by the existing field code; and
4. mark the context ready for a far-field-only pass without entering matrix
   fill, factorization or triangular solve code.

This invariant needs a focused test. Persisting the already-mutated
`current_vector` must fail that test.

## Representation and storage

Let:

- `P` be the ordered port count;
- `N` be the raw NEC equation count (`neq`); and
- every complex value consist of two IEEE-754 binary64 values, or 16 bytes.

The voltage-normalized current basis occupies `16 * N * P` bytes. A dense port
matrix occupies `16 * P * P` bytes. For 11 wire segments per dipole and one
port per dipole, `N = 11P`.

| Array | Ports | Equations | Raw current basis | Y | Y + Z | Basis + Y + Z |
|---:|---:|---:|---:|---:|---:|---:|
| 8 x 8 | 64 | 704 | 0.69 MiB | 0.06 MiB | 0.13 MiB | 0.81 MiB |
| 12 x 12 | 144 | 1,584 | 3.48 MiB | 0.32 MiB | 0.63 MiB | 4.11 MiB |
| 16 x 16 | 256 | 2,816 | 11.00 MiB | 1.00 MiB | 2.00 MiB | 13.00 MiB |
| 20 x 20 | 400 | 4,400 | 26.86 MiB | 2.44 MiB | 4.88 MiB | 31.74 MiB |
| 24 x 24 | 576 | 6,336 | 55.69 MiB | 5.06 MiB | 10.13 MiB | 65.81 MiB |
| 28 x 28 | 784 | 8,624 | 103.17 MiB | 9.38 MiB | 18.76 MiB | 121.93 MiB |
| 32 x 32 | 1,024 | 11,264 | 176.00 MiB | 16.00 MiB | 32.00 MiB | 208.00 MiB |

Y is authoritative for a voltage-normalized basis. Z is derivable by the
existing checked inversion path and may be omitted from the artifact. Storing
both is useful when fast current-driven restoration matters and costs little
relative to the basis. The format must declare which matrices are present and
must never silently substitute a newly inverted Z for a persisted one without
updating conditioning metadata.

In principle Y can also be recovered from the port entries produced during the
basis solves. It should nevertheless be stored explicitly in stable public
port order so that loading and validation do not depend on internal current
index conventions.

## Artifact contract

Use a versioned, self-contained binary artifact rather than serializing C++
objects or WebAssembly memory. The artifact should contain the following
logical sections.

### Header

- fixed magic and format version;
- engine compatibility version and response-layout identifier;
- scalar representation, byte order and complex-value layout;
- unit-voltage normalization identifier;
- equation and port counts;
- section offsets and lengths with checked 64-bit arithmetic;
- presence flags for Y and Z;
- condition estimate and creation metadata; and
- whole-artifact or per-section integrity digests.

### Canonical configuration

- ordered wire definitions, including tags, segment counts, endpoints and
  radii;
- geometry-completion ground-connection mode;
- ordered ports and their resolved absolute segment numbers;
- ordered loads and targets;
- ground kind and numerical parameters;
- frequency;
- integration and extended-kernel settings that can affect the solution;
- electromagnetic medium settings if they become public; and
- any future patches, networks or symmetry metadata before those features are
  accepted by this artifact version.

Floating-point configuration values must be encoded by their binary64 bit
patterns. A hash is useful as a lookup key, but loading must validate the
canonical configuration and dimensions rather than trusting a caller-supplied
hash alone.

### Numerical payload

- the `N x P` raw-current basis in basis-major order:
  `basis[port_index * N + equation_index]`;
- Y in the existing public row-major port order;
- optional Z in the same order; and
- optional validation data such as selected residuals or column norms.

The portable format should use explicit little-endian real/imaginary binary64
pairs. It must not rely on the unspecified serialized layout of
`std::complex`, Eigen objects, `safe_array`, allocator state or raw WASM
pointers.

Compression may be added as a section codec, but uncompressed sizes are the
capacity-planning baseline. Decoding must be bounded and streaming so corrupt
lengths cannot cause an uncontrolled allocation.

## Native design

### Capture the raw solution

Add a narrow context seam that captures the raw solved vector after `solves()`
and before `get_current_coefficients()`. The stateful voltage-source path has no
networks today, so its first implementation can capture the no-network branch
directly. The seam must not change the legacy deck result or expose a borrowed
buffer beyond its documented lifetime.

Prefer one of these ownership models:

1. a callback/consumer invoked with a const view of the raw vector before it is
   mutated; or
2. a model-owned copied vector retrievable immediately after the solve.

The callback/view form avoids an otherwise unnecessary second `N`-value copy
inside the engine, but the copied form is easier to make exception-safe. Choose
after measuring; both are small compared with the LU matrix.

### Build the response model

Add a `nec_port_current_model` value or owned component containing:

- canonical configuration metadata;
- port definitions and absolute port segments;
- `equation_count` and `port_count`;
- the voltage-normalized raw-current basis or a streaming column sink;
- Y, optional Z and the condition estimate; and
- the source factorization generation from which it was built.

Basis generation performs one exact unit-voltage solve per port, matching the
existing admittance extraction convention. For each column it must capture the
raw solution and the achieved port-current column. It must preserve any prior
consumer-visible solution and must not advance the public solve generation,
following the semantics already established by `compute_admittance_matrix()`
and `compute_embedded_far_fields()`.

Do not require the full basis and LU matrix to coexist. At 32 x 32 the LU is
about 1.89 GiB and the basis is another 176 MiB, which exceeds the practical
headroom of the current 2 GiB WASM build. The generation pipeline must support:

1. preparing and retaining LU;
2. solving one basis column;
3. emitting that column to a sink or external staging store;
4. repeating for all ports;
5. discarding `cm` and `ip`; and
6. optionally loading the compact basis back into the reduced model.

### Initialize a reduced context

Split context frequency initialization from interaction-matrix construction.
The reduced path still needs to:

- activate medium parameters;
- establish frequency and wavelength;
- scale geometry;
- calculate load data needed by current/loss processing;
- calculate the antenna ground environment; and
- initialize result and far-field lifecycle state.

It must skip `cm` allocation, `cmset()` and `factrs()`.

The native model may continue exposing the public states `prepared` and
`solved`, but it needs an internal prepared-backend discriminator such as:

```text
full_factorization
port_current_response
```

Configuration mutation invalidates either backend identically. Code that
requires unavailable full-factorization capability must fail with a controlled
state/capability error rather than dereferencing empty `cm` or `ip` arrays.

### Execute a reduced voltage solve

For a voltage vector `v`:

1. validate its length and finiteness;
2. calculate `x = C v` with checked dimensions;
3. calculate achieved port currents `i = Y v`;
4. install `x` through the new context current seam;
5. run `get_current_coefficients()` once;
6. construct the existing `nec_port_solution`, including active impedances and
   powers; and
7. transition to `solved`, allowing the unchanged far-field API to run.

The multiplication should initially use a clear, deterministic implementation
and then be benchmarked against an Eigen matrix/vector map. Its storage order
should make one basis column contiguous for generation and streaming. Runtime
access may later use blocking if the basis no longer fits comfortably in
cache.

For `solve_port_currents(i)`, obtain or validate Z, calculate `v = Z i`, and
enter the same voltage-response path. Exact-zero drives must retain the current
API's zero-field and active-impedance behavior.

### Far fields

The normal `compute_far_field()` implementation should remain the public path.
After a reduced solve, the context must contain exactly the current and
interpolation arrays that a full NEC solve would have produced. Far-field code
must not know whether those arrays came from LU back-substitution or a persisted
response basis.

`compute_embedded_far_fields()` can be supported without LU by installing each
persisted basis column and evaluating the requested grid. This is useful but is
not the optimized steering path; callers should solve one combined excitation
and request one combined field.

## Native public API sketch

Names are illustrative; final naming should follow the existing installed C++
surface.

```cpp
struct nec_port_current_artifact_info {
  size_t equation_count;
  size_t port_count;
  bool has_admittance;
  bool has_impedance;
  nec_float frequency_mhz;
  nec_float condition_estimate;
};

class nec_stateful_model {
public:
  void write_port_current_model(nec_port_current_sink& sink);
  void load_port_current_model(nec_port_current_source& source);
  bool uses_port_current_response() const;
};
```

The native serialization layer should accept stream-like sources and sinks so
desktop users are not forced through one giant in-memory byte vector. Separate
artifact codec code from `nec_context`; the context should deal in validated
numeric arrays and configuration, not files.

## Stable C/WASM ABI

Do not expose a single function that requires a complete 208 MiB artifact to
be copied through `_malloc`. Add a cursor/chunk API with explicit begin,
transfer, commit and abort phases. A representative shape is:

```c
int32_t necpp_wasm_v1_port_current_export_begin(model, export_handle_out);
int32_t necpp_wasm_v1_port_current_export_next(
  export_handle, uint8_t* destination, uint32_t capacity,
  uint32_t* written, int32_t* complete);
void necpp_wasm_v1_port_current_export_delete(export_handle);

int32_t necpp_wasm_v1_port_current_import_begin(model, import_handle_out);
int32_t necpp_wasm_v1_port_current_import_write(
  import_handle, const uint8_t* source, uint32_t length);
int32_t necpp_wasm_v1_port_current_import_commit(import_handle);
void necpp_wasm_v1_port_current_import_delete(import_handle);
```

Exact signatures should avoid pointer-sized values that become ambiguous above
2 GiB in JavaScript. Handles and chunks remain 32-bit; cumulative artifact
lengths and section offsets are encoded in the artifact and checked natively.

Import is transactional. Until `commit` has validated configuration, all
sections and integrity data, the target model remains in its prior safe state.
Deleting or abandoning an import handle discards partial state.

Basis creation also needs incremental progress. A long-running synchronous
native call cannot flush chunks asynchronously to browser storage. Either:

- expose one basis-column generation step per ABI call; or
- retain bounded chunks natively and let the TypeScript layer pull them between
  solves.

The first option gives the worker client natural progress and cancellation
boundaries and should be preferred.

## TypeScript and worker API

Add explicit artifact operations rather than overloading `prepare()` with
untyped bytes. A possible public direction is:

```ts
interface PortCurrentModelInfo {
  readonly equationCount: number;
  readonly portCount: number;
  readonly frequencyMHz: number;
  readonly conditionEstimate: number;
  readonly byteLength: number;
}

interface NecModel {
  exportPortCurrentModel(options?: PortCurrentExportOptions): Promise<Blob>;
}

function createNecModelFromPortCurrentModel(
  artifact: Blob | ArrayBuffer | Uint8Array,
  options?: CreateNecModelOptions,
): Promise<NecModel>;
```

The final surface may instead use `ReadableStream<Uint8Array>` and
`AsyncIterable<Uint8Array>` where runtime support and declaration ergonomics
are acceptable. The core requirement is bounded chunking; `Blob` is acceptable
only if implementations can build and consume it without first materializing a
second contiguous artifact-sized buffer.

The package owns encoding and validation, not durable-storage policy. Document
Node files and browser IndexedDB/OPFS as expected stores. Do not use
`localStorage` or silently retain large artifacts in a process-global cache.

Worker mode must:

- generate and transfer bounded chunks rather than one recursively cloned
  result object;
- report per-column progress in addition to coarse operation start/complete;
- provide cancellation between basis columns;
- preserve per-model operation serialization; and
- terminate cleanly without leaking an unfinished native import/export handle.

Direct mode remains synchronous for individual numerical steps, but the
high-level artifact orchestration may be asynchronous so it can yield between
columns and storage writes.

## Compatibility and validation rules

An artifact must be rejected when any of the following is true:

- magic, format, response-layout or engine-compatibility version is unsupported;
- section arithmetic overflows or overlaps;
- file length or digest is wrong;
- `N`, `P`, geometry equation count or port count disagree;
- configuration contains unsupported features;
- configuration values, basis values or matrices contain nonfinite data;
- Y or Z dimensions differ from stable port order;
- a persisted Z is singular, over the accepted condition limit or inconsistent
  with Y beyond the defined tolerance;
- the resolved port segments differ from the canonical values; or
- normalization is anything other than the declared unit-voltage convention.

Loading data must never invoke arbitrary pointers, deserialize native object
layouts or trust offsets before bounds checks. Errors should use the existing
input, state, conditioning, solver and runtime taxonomy where possible, with a
specific public artifact error if those categories prove too coarse.

## Work breakdown

### WP10.1 - Raw-current capture seam

- Add the pre-`get_current_coefficients()` capture point.
- Prove the captured vector reproduces the normal postprocessed current arrays.
- Cover exact-zero and multiple simultaneous sources.
- Confirm legacy deck results are unchanged.

Exit criterion: a unit test can capture one raw solve, reinstall it, and match
the original port currents and complex far fields without another call to
`solves()`.

### WP10.2 - In-memory response backend

- Introduce the response-basis data model and backend discriminator.
- Generate C and Y from unit-voltage basis solves.
- Implement reduced voltage/current solve and current installation.
- Route the existing far-field API through the reconstructed current state.
- Support dropping the LU after response construction.

Exit criterion: repeated reduced solves agree with full retained-LU solves for
port values, current coefficients and far fields, while factorization and
triangular-solve counters remain unchanged.

### WP10.3 - Artifact codec

- Define the normative binary layout and compatibility policy.
- Implement streaming native encoder/decoder with bounded allocations.
- Add canonical configuration encoding and integrity checks.
- Make import transactional and failure-safe.

Exit criterion: native round trips are deterministic, corrupted or mismatched
artifacts are rejected, and a loaded model is numerically equivalent to its
source model.

### WP10.4 - Stable C/WASM ABI

- Add opaque import/export cursor handles.
- Add bounded chunk and per-column generation functions.
- Update the exported-function list and handwritten internal declarations.
- Verify memory-growth events do not leave stale JavaScript heap views.

Exit criterion: direct Node can generate, dispose, reload and solve an artifact
larger than the initial WASM heap without an unbounded bridge copy.

### WP10.5 - TypeScript direct and worker facades

- Add typed artifact metadata and creation/export APIs.
- Add state-machine operations and stable error mapping.
- Add worker protocol chunking, progress and cancellation boundaries.
- Ensure transferred chunks have single, documented ownership.

Exit criterion: clean-package Node and Chromium consumers can persist and
reload the same artifact in direct and worker modes using only public imports.

### WP10.6 - Large-array validation and performance

- Benchmark artifact creation, serialized size, load time, reduced solve time,
  arbitrary-grid far fields and peak memory.
- Use 16 x 16 with 11 segments as the regular large regression.
- Exercise 24 x 24 or 28 x 28 in a scheduled browser/Node gate.
- Attempt 32 x 32 in an environment with documented memory headroom; do not
  claim support solely from size arithmetic.

Exit criterion: loading is materially faster than matrix fill/factorization,
reduced results meet the numerical tolerances below, and peak memory remains
bounded by the documented streaming design.

### WP10.7 - Documentation and release integration

- Document normalization, ordering, compatibility and storage formulas.
- Add Node-file and browser-storage examples.
- Document that artifacts are derived numerical data governed by the package's
  licensing and version-compatibility policy.
- Add changelog and release-test coverage.

Exit criterion: a downstream application can create an artifact once, reload
it in a fresh process, apply complex steering weights and calculate a new
far-field grid without reconstructing LU.

## Numerical verification matrix

Tests must compare the full-factorization and reduced-response paths for:

- one dipole and reciprocal two-port fixtures;
- disconnected four-element and larger planar arrays;
- perfect and finite ground;
- supported loads;
- arbitrary complex voltage weights, including exact zeros;
- arbitrary complex requested currents through Z;
- raw solution vectors before coefficient conversion;
- all six real interpolation arrays after conversion;
- port voltages, currents, active impedances and powers;
- complex `E_theta` and `E_phi` on multiple grids and radii; and
- repeated solves after load, artifact round trip and memory growth.

Use relative residuals/norms rather than comparing only printed source
currents. The primary field acceptance should compare complex components, not
gain magnitude. Tolerances must be established from native round-off evidence;
the artifact uses binary64 and should not introduce a deliberate precision
loss.

## Memory and performance acceptance

Record separately:

- original geometry construction;
- matrix fill and factorization;
- each basis-column solve;
- artifact encode/write and read/decode;
- reduced `C v` reconstruction;
- coefficient regeneration;
- far-field evaluation; and
- peak native, WASM and JavaScript memory.

The generator must not retain LU, the complete response basis and a second
serialized copy in WASM simultaneously. The loader must not require an
artifact-sized `_malloc` scratch buffer. Repeated reduced solves must not
accumulate results or basis copies.

For orientation, the existing 16 x 16, 11-segment benchmark reports about
12.8 seconds to first solution and 17.3 ms per retained-LU solve. WP10 should
measure rather than assume whether `C v` plus coefficient reconstruction is
faster than triangular substitution at each size; its guaranteed benefits are
persistence and the much smaller retained state.

## Non-goals

- Persisting Eigen LU factors or raw WebAssembly memory.
- Treating centre-segment currents as a complete far-field representation.
- Changing NEC field equations or numerical conventions.
- Supporting geometry, frequency, ground or load changes without regenerating
  the artifact.
- Interpolating one response artifact across frequency.
- Quantizing the basis to float32 in the initial implementation.
- Defining a remote artifact registry or browser storage quota policy.

## Definition of Done

WP10 is complete when:

- a versioned self-contained artifact persists the unit-voltage raw-current
  basis and Y, with optional Z;
- a fresh native or WASM model can load it without allocating or factoring the
  NEC interaction matrix;
- voltage- and current-driven solves produce the existing public solution type;
- arbitrary subsequent far-field grids use the existing NEC field evaluator;
- full and reduced paths agree within established complex-current and
  complex-field tolerances;
- invalid, corrupt and incompatible artifacts fail deterministically without
  exposing partial state;
- direct and worker APIs transfer data in bounded chunks;
- peak-memory tests prove that no artifact-sized bridge copy is required; and
- a documented 16 x 16 round trip demonstrates a clear wall-time benefit over
  rebuilding and refactoring the configuration.
