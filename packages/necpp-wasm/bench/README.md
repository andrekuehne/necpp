# WASM array benchmarks

The reference-array benchmark compares three stateful representations of the
same full caller description:

- `explicit`: every dipole is added independently;
- `manual-reflection`: one positive-X/positive-Y quadrant is expanded across
  `x=0` and `y=0`; and
- `auto-reflection`: the full position list is analyzed and canonicalized by
  the transparent planner before the accepted quadrant is built.

Every case uses the shared Section 7 fixture: 11-segment, centre-fed,
Z-directed lambda/3 dipoles at lambda/4 height, lambda/2 XY spacing, and a
perfect infinite ground. Sizes 2, 4, 8, 12, and 16 correspond to 44, 176, 704,
1,584, and 2,816 equations. A deterministic off-broadside current taper proves
that the excitation need not share the geometry symmetry.

Each representation/size/round runs in a fresh Node process. The runner checks
requested and achieved port quantities, active impedances, powers, and complex
combined far fields against the explicit model. It additionally gathers and
checks complete caller-order complex Z and Y matrices at 2 x 2 and 4 x 4 by
default. No speed or allocation ratio is emitted if a case or numerical check
fails. The `deck` backend remains available as historical formatted-report
coverage, but it is not the binary64 symmetry oracle.

## Run

Build the package, then run the default three-round sweep:

```powershell
npm --prefix packages/necpp-wasm run build
npm --prefix packages/necpp-wasm run bench:array -- `
  --output packages/necpp-wasm/bench/results/symmetry-reference.ndjson
```

The output directory is ignored by Git. NDJSON is appended as each child
finishes; an adjacent `*.summary.json` contains median/min/max statistics,
correctness metrics, ratios, and gate results. Use `--overwrite` to replace an
existing path.

To compare the explicit path with a compatible pre-feature build, first run
that build through this same driver with `--backends explicit` and its `dist`
directory, then pass the resulting summary to the current run:

```powershell
npm --prefix packages/necpp-wasm run bench:array -- `
  --backends explicit `
  --module-directory C:\path\to\pre-feature\dist `
  --output packages/necpp-wasm/bench/results/pre-feature.ndjson

npm --prefix packages/necpp-wasm run bench:array -- `
  --baseline-summary packages/necpp-wasm/bench/results/pre-feature.summary.json `
  --output packages/necpp-wasm/bench/results/current.ndjson
```

The runner rejects a baseline with a different schema, protocol ID, frequency,
segment count, side list, Node/OS/architecture/CPU identity, Emscripten version,
or WASM stack size.

## Options

Run `npm --prefix packages/necpp-wasm run bench:array -- --help` for the
authoritative CLI. Important options are:

```text
--sides 2,4,8,12,16
--segments 11
--frequency-mhz 300
--backends explicit,manual-reflection,auto-reflection
--rounds 3
--retained-solves 10
--z-matrix-sides 2,4       Add 8 for the optional 8 x 8 complete Z/Y workload
--timeout-seconds 600
--equivalence-tolerance 1e-8
--module-directory PATH
--baseline-summary PATH
--output PATH
--overwrite
--fail-fast
```

## Schema version 2

The NDJSON stream contains four record types:

- `metadata`: artifact hashes, versions, OS/CPU/Node/Emscripten information,
  Git commit and exact worktree status, model dimensions, field grid,
  tolerance, and command options;
- `case`: one isolated execution, classified failure or phase timings,
  diagnostics, checksums, observed RSS, and exact primary interaction-matrix
  allocation;
- `comparison`: binary64 relative-L2 and scaled-maximum metrics for each
  manual/automatic result against the same-round explicit result; and
- `summary`: median/min/max case statistics, comparisons, correctness-gated
  ratios, performance gates, and the optional baseline artifact identity.

The measured phases are transparent analysis, module creation, wire
construction, geometry completion/expansion, port and environment setup,
`prepare()`, first current solve, retained changed-current solves, combined
far field, and optional complete Z/Y extraction. `coldTotalMs` includes every
phase through the optional matrix extraction and excludes retained solves.

For this wire-only model, NEC allocates `n * np` complex-double entries for the
primary interaction matrix. The benchmark reports that exact allocation as
`primaryInteractionMatrixBytes`, plus sampled process RSS. It does not present
RSS as an exact WASM heap measurement.

See [RESULTS.md](RESULTS.md) for the curated WP-S7 reference run and the older
stateful-versus-deck historical measurements.
