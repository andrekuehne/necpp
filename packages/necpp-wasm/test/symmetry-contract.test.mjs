import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  NecInputError,
  rotationalOrder,
} from "../.test-build/src/index.js";
import {
  createReferenceArrayFixture,
  NEC_ENGINE_SPEED_OF_LIGHT_M_PER_S,
} from "./fixtures/reference-array.mjs";

const golden = JSON.parse(readFileSync(
  new URL("../../../tests/data/symmetry_reference_array_4x4.json", import.meta.url),
  "utf8",
));

test("rotationalOrder validates the signed 32-bit native contract", () => {
  assert.equal(rotationalOrder(2), 2);
  assert.equal(rotationalOrder(2_147_483_647), 2_147_483_647);
  for (const invalid of [1, 0, -2, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => rotationalOrder(invalid),
      (error) => error instanceof NecInputError
        && error.code === "NEC_INPUT"
        && error.details?.symmetryFailure === "INVALID_SYMMETRY",
    );
  }
});

test("the shared 4x4 reference fixture matches the language-neutral golden data", () => {
  const fixture = createReferenceArrayFixture();
  const reflection = fixture.reflection;
  assert.ok(reflection);
  assert.equal(fixture.speedOfLightMPerS, NEC_ENGINE_SPEED_OF_LIGHT_M_PER_S);
  assert.equal(fixture.speedOfLightMPerS, golden.speedOfLightMPerS);
  assert.equal(fixture.frequencyMHz, golden.frequencyMHz);
  assert.equal(fixture.side, golden.side);
  assert.equal(fixture.segments, golden.segments);
  assert.equal(fixture.feedSegment, golden.feedSegment);
  assert.equal(fixture.groundConnection, "none");
  assert.deepEqual(fixture.ground, { kind: "perfect" });

  const expectedCallerCoordinates = golden.callerCoordinateQuarterWavelengths
    .map(([x, y]) => [x * fixture.wavelengthM / 4, y * fixture.wavelengthM / 4]);
  assert.deepEqual(
    fixture.wires.map((wire) => [wire.start[0], wire.start[1]]),
    expectedCallerCoordinates,
  );
  assert.deepEqual(
    fixture.wires.map(({ tag }) => tag),
    Array.from({ length: 16 }, (_, index) => index + 1),
  );
  assert.ok(fixture.wires.every((wire) =>
    wire.start[2] === golden.wireZTwelfths[0] * fixture.wavelengthM / 12
    && wire.end[2] === golden.wireZTwelfths[1] * fixture.wavelengthM / 12
    && wire.radiusM === fixture.wavelengthM / golden.radiusWavelengthDenominator));
  assert.equal(fixture.lowerZM, fixture.wavelengthM / 12);
  assert.equal(fixture.upperZM, 5 * fixture.wavelengthM / 12);

  const expectedFundamentalCoordinates = golden
    .fundamentalCoordinateQuarterWavelengths
    .map(([x, y]) => [x * fixture.wavelengthM / 4, y * fixture.wavelengthM / 4]);
  assert.deepEqual(
    reflection.fundamentalWires.map((wire) => [wire.start[0], wire.start[1]]),
    expectedFundamentalCoordinates,
  );
  assert.deepEqual(
    reflection.copies.map((copy) => copy.transform.signs),
    golden.copySigns,
  );
  assert.deepEqual(
    reflection.copies.map((copy) => copy.tagOffset),
    golden.copyTagOffsets,
  );
  assert.deepEqual(
    reflection.scatterCallerToGenerated,
    golden.scatterCallerToGenerated,
  );
  assert.deepEqual(
    reflection.gatherGeneratedToCaller,
    golden.gatherGeneratedToCaller,
  );
  assert.deepEqual(
    reflection.generatedTagsByCaller,
    golden.generatedTagsByCaller,
  );

  for (const mapping of reflection.mappingsByCaller) {
    const fundamental = reflection.fundamentalWires[
      mapping.fundamentalElementIndex
    ];
    const copy = reflection.copies[mapping.copyIndex];
    const caller = fixture.wires[mapping.callerElementIndex];
    const [signX, signY] = copy.transform.signs;
    assert.deepEqual(
      [signX * fundamental.start[0], signY * fundamental.start[1]],
      [caller.start[0], caller.start[1]],
    );
    assert.equal(
      reflection.gatherGeneratedToCaller[
        reflection.scatterCallerToGenerated[mapping.callerElementIndex]
      ],
      mapping.callerElementIndex,
    );
  }
});

test("odd-sided reference arrays deliberately expose no reflection fixture", () => {
  assert.equal(createReferenceArrayFixture({ side: 3 }).reflection, undefined);
});
