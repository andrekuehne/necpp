# WASM array benchmark

This benchmark compares two public `@necpp-engine/wasm` execution paths over
the same centred square array:

- `stateful`: `createNecModel()`, wire/port construction, `prepare()`, and a
  simultaneous 1 + j0 V solve at every centre-segment port;
- `deck`: `runDeck()` with equivalent `GW`, `GE`, `FR`, and `EX` cards followed
  by `XQ` and `EN`, including parsing and copying the complete formatted NEC
  report back to JavaScript.

The card layout follows the authoritative
[NEC-2 Part 3 manual](https://www.nec2.org/other/nec2prt3.pdf). Each
backend/size/round runs in a fresh Node process so a trap or timeout does not
erase earlier results. The runner emits newline-delimited JSON as cases finish
and can also retain a final JSON summary.

Build the package and run the default 2 x 2 through 16 x 16 sweep with 11
segments per dipole:

```powershell
npm --prefix packages/necpp-wasm run build
npm --prefix packages/necpp-wasm run bench:array -- `
  --output packages/necpp-wasm/bench/results/array-2-16-11seg.ndjson
```

See [RESULTS.md](RESULTS.md) for a three-round 2 x 2 through 16 x 16 comparison
captured with the 4 MiB-stack build.

Useful options:

```text
--sides 2-16                 Inclusive ranges and comma lists are accepted
--segments 11               Must be odd
--frequency-mhz 300
--backends stateful,deck
--rounds 1                   Fresh processes per round
--retained-solves 10         Additional stateful solves after factorization
--timeout-seconds 600        Per backend/size/round
--equivalence-tolerance 1e-4 Relative L2 error after report rounding
--output PATH                Optional NDJSON plus adjacent summary JSON
--overwrite                  Replace an existing output file
--fail-fast                  Stop after the first failure
```

The stateful `coldTotalMs` includes module instantiation, geometry/port calls,
preparation, the first solve, and result copying. Additional retained solves
are excluded from that comparable total and reported separately. The deck
`coldTotalMs` includes deck text generation, module instantiation inside
`runDeck()`, parsing, preparation, the solve, full report formatting, copying
that report, and parsing its source-current table. JavaScript module import
time is excluded from both.

Source currents parsed from the deck's `ANTENNA INPUT PARAMETERS` table are
compared with the stateful port currents. The legacy report prints five-digit
scientific values, so comparison uses a relative tolerance rather than exact
equality.
