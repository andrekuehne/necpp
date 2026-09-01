# WASM array benchmarks

## Far-field WP0 baseline

`far-field-benchmark.mjs` is the versioned baseline harness for
`docs/far-field-performance-upgrade-plan.md`. It is separate from the symmetry
benchmark below because it freezes the visualizer's production case rather
than the symmetry reference model:

- 8 x 8 X-directed dipoles at 10 GHz, lambda/2 spacing, 0.47-lambda length,
  0.001-lambda radius, and 0.25-lambda height;
- 11 segments per element and centre feed at segment 6;
- infinite perfect ground with no structural symmetry substitution;
- asserted `UNSUPPORTED_ELEMENT_PATTERN_TRANSFORM` explicit fallback;
- ten deterministic broadside, axis, diagonal, and near-edge steering states;
- the 181 x 360 primary field and the source field derived by the consumer's
  32 x 32 display policy (currently 69 x 272).

Build an instrumentation-enabled WASM package, preserve its `dist` directory,
then run one untimed warm-up and five measured fresh processes for every
direct/worker and primary/secondary combination:

```powershell
$env:NECPP_ENABLE_PERFORMANCE_DIAGNOSTICS = "ON"
$env:NECPP_ENABLE_WASM_SIMD = "OFF"
.\scripts\build_wasm_docker.ps1
npm --prefix packages/necpp-wasm run build
npm --prefix packages/necpp-wasm run bench:far-field -- `
  --output-directory bench/results/far-field-wp0-scalar `
  --module-directory C:\path\to\preserved\scalar-dist `
  --variant release-scalar-sampled-instrumented `
  --build-flags "-O3 -DNDEBUG -flto -fexceptions; diagnostics=ON/256; simd=OFF"
```

The output directory receives the frozen fixture manifest, raw NDJSON cases,
and a JSON summary with minimum, median, maximum, and p90 timings. Every raw
case records the engine revision, exact artifact hashes and build flags,
Node/V8/OS/CPU identity, RSS samples, CPU time, result bytes, representation
diagnostics, generations, requested/achieved-current checksums, field
checksums, and representative complex samples. The runner fails if any of the
ten updates changes the factorization generation, skips field extraction,
selects a symmetric representation, or differs across direct and worker
checksums.

Use `--module-directory`, `--variant`, and `--build-flags` to run an otherwise
identical `-msimd128` artifact into a second output directory. Benchmark
variants must be run serially. `--rounds 1 --warmups 0 --backends direct
--grids secondary` is available as a short harness smoke test; it is not WP0
evidence.

The diagnostics build attributes raw-kernel work (sampled once per 256
directions), legacy RP-derived work, native and ABI copies, TypeScript
extraction, package residuals, and operation counts. `bench:far-field-overhead`
performs balanced scalar instrumentation/release pairs;
`bench:far-field-simd` performs balanced scalar/SIMD pairs; and
`bench:consumer-trace` records a Chrome performance trace around the sibling
consumer's already-built benchmark. See [FAR_FIELD_WP0_RESULTS.md](FAR_FIELD_WP0_RESULTS.md)
and `bench/evidence/far-field-wp0/` for the accepted commands, findings, and raw
artifacts.

## Symmetry reference benchmark

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

## Far-field WP2 candidate matrix

`far-field-candidate-matrix.mjs` compares independently built WP2 artifacts on
both frozen far-field grids. Each measurement runs in a fresh process, variant
order is balanced, and the run fails unless every candidate field hash is
bitwise-identical to WP1. Pass a comma-separated `NAME=PATH` artifact list that
includes `WP1`:

```powershell
npm --prefix packages/necpp-wasm run bench:far-field-candidates -- `
  --variants "WP1=C:\path\WP1,SELECTED=C:\path\SELECTED" `
  --output-directory packages/necpp-wasm/bench/results/far-field-wp2 `
  --rounds 3 --steering-limit 2
```

`inspect-far-field-wasm.mjs` consumes generated Emscripten JS plus `wasm2wat`
output. It maps the public far-field ABI export to the minified WASM function
and reports SIMD operations reachable through its call graph. See
[FAR_FIELD_WP2_RESULTS.md](FAR_FIELD_WP2_RESULTS.md) and
`bench/evidence/far-field-wp2/` for the accepted WP2 decision and evidence.

For WP2A reassociated candidates, add `--baseline WP2 --equivalence-mode
numeric`. Numeric mode writes temporary component-major f64 field dumps,
compares E-theta and E-phi with relative-L2 and scaled-maximum metrics, records
peak/null/integrated-power deltas, and removes the dumps after the summary is
written:

```powershell
npm --prefix packages/necpp-wasm run bench:far-field-candidates -- `
  --variants "WP2=C:\path\WP2,ACCUM4_TREE=C:\path\ACCUM4_TREE" `
  --baseline WP2 --equivalence-mode numeric `
  --output-directory bench/results/far-field-wp2a `
  --rounds 3 --steering-limit 10
```

Exact-hash mode remains the default for reproducing WP2. See
[FAR_FIELD_WP2A_RESULTS.md](FAR_FIELD_WP2A_RESULTS.md) and
`bench/evidence/far-field-wp2a/` for reduction topologies, measurements,
accuracy, SIMD inspection, and the fallback decision.

## Far-field WP3 worker proof

`far-field-wp3-poc.mjs` measures the versioned O(segments) snapshot, compares
the full NEC evaluator-only and dedicated evaluator artifacts, benchmarks 1,
2, 4, and 8 prewarmed workers, and compares static slabs with bounded tiles:

```powershell
npm --prefix packages/necpp-wasm run bench:far-field-wp3
```

The command writes summary JSON and raw NDJSON to
`bench/evidence/far-field-wp3/node/`. See
[FAR_FIELD_WP3_RESULTS.md](FAR_FIELD_WP3_RESULTS.md) for the WP4 decision.
