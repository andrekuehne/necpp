import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEquivalentDeck,
  createArrayDefinition,
  parseDeckSourceCurrents,
} from "../bench/array-case.mjs";

test("array benchmark emits equivalent NEC geometry and excitation cards", () => {
  const definition = createArrayDefinition({
    side: 2,
    segments: 11,
    frequencyMHz: 300,
  });
  const deck = buildEquivalentDeck(definition);
  assert.equal(definition.equations, 44);
  assert.equal(definition.ports.length, 4);
  assert.equal(deck.match(/^GW /gm)?.length, 4);
  assert.equal(deck.match(/^EX 0 /gm)?.length, 4);
  assert.match(deck, /^GE 0$/m);
  assert.match(deck, /^FR 0 1 0 0 300 0$/m);
  assert.match(deck, /^GN 1$/m);
  assert.match(deck, /^XQ$/m);
  assert.match(deck, /^EN$/m);
});

test("array benchmark parses legacy source currents", () => {
  const report = `
                      ----- ANTENNA INPUT PARAMETERS -----
  TAG   SEG       VOLTAGE (VOLTS)         CURRENT (AMPS)         IMPEDANCE (OHMS)        ADMITTANCE (MHOS)     POWER
   1     6  1.0000E+00  0.0000E+00  2.2352E-05  2.1015E-03  5.0610E+00 -4.7581E+02  2.2352E-05  2.1015E-03  1.1176E-05
   2    17  1.0000E+00  0.0000E+00  2.2352E-05  2.1015E-03  5.0610E+00 -4.7581E+02  2.2352E-05  2.1015E-03  1.1176E-05
                        ----- CURRENTS AND LOCATION -----
`;
  assert.deepEqual(parseDeckSourceCurrents(report, 2), [
    { real: 2.2352e-5, imag: 2.1015e-3 },
    { real: 2.2352e-5, imag: 2.1015e-3 },
  ]);
});
