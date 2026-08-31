import assert from "node:assert/strict";
import test from "node:test";

import {
  NecGeometryError,
  NecInputError,
  analyzeArraySymmetry,
  applyArrayBuildPlan,
  gatherComplexMatrix,
  gatherComplexVector,
  gatherEmbeddedBasis,
  rephaseFarField,
  scatterComplexVector,
} from "../.test-build/src/index.js";
import { createReferenceArrayFixture } from "./fixtures/reference-array.mjs";

function arrayDescription({ side = 4, centerM = [0, 0] } = {}) {
  const fixture = createReferenceArrayFixture({ side, centerM });
  return {
    fixture,
    description: {
      elements: fixture.wires.map((wire, index) => ({
        id: `element-${index}`,
        positionM: [wire.start[0], wire.start[1]],
        patternId: "dipole",
      })),
      patterns: [{
        id: "dipole",
        kind: "straight-wire-pattern",
        wires: [{
          id: "radiator",
          segments: fixture.segments,
          startM: [0, 0, fixture.lowerZM],
          endM: [0, 0, fixture.upperZM],
          radiusM: fixture.radiusM,
        }],
        ports: [{ wireId: "radiator", segment: fixture.feedSegment, name: "feed" }],
      }],
      ground: fixture.ground,
    },
  };
}

function byId(plan) {
  return Object.fromEntries(plan.mappings.map((mapping) => [
    mapping.callerElementId,
    {
      fundamentalElementIndex: mapping.fundamentalElementIndex,
      copyIndex: mapping.copyIndex,
      generatedTag: mapping.generatedTag,
      generatedPortIndices: mapping.generatedPortIndices,
      adjustment: mapping.positionAdjustmentM,
    },
  ]));
}

test("exact even reference grids choose deterministic four-section XY reflection", () => {
  for (const side of [2, 4, 8]) {
    const { fixture, description } = arrayDescription({ side });
    const plan = analyzeArraySymmetry(description, { positionEpsilonM: 0 });
    assert.equal(plan.kind, "symmetric");
    assert.deepEqual(plan.symmetry.planes, ["x=0", "y=0"]);
    assert.equal(plan.expansion.sectionCount, 4);
    assert.equal(plan.fundamentalElements.length, side * side / 4);
    assert.equal(plan.diagnostics.exact, true);
    assert.equal(plan.diagnostics.canonicalizations.length, side * side);
    assert.equal(plan.mappings.length, side * side);
    assert.equal(structuredClone(plan).kind, "symmetric");
    if (side === 4) {
      assert.deepEqual(
        plan.mappings.flatMap((mapping) => mapping.generatedPortIndices),
        fixture.reflection.scatterCallerToGenerated,
      );
    }
  }
});

test("exact odd reference grids fall back with fixed-element diagnostics", () => {
  for (const side of [3, 5]) {
    const { description } = arrayDescription({ side });
    const plan = analyzeArraySymmetry(description, { positionEpsilonM: 0 });
    assert.equal(plan.kind, "explicit");
    assert.ok(plan.reasons.some((entry) =>
      entry.code === "FIXED_ELEMENT_ON_REFLECTION_PLANE"
      || entry.code === "FIXED_ELEMENT_ON_ROTATION_AXIS"));
    assert.equal(plan.elements.length, side * side);
  }
});

test("exact cardinal rotational symmetry is detected without a hidden epsilon", () => {
  const { description } = arrayDescription({ side: 2 });
  const plan = analyzeArraySymmetry(description, {
    positionEpsilonM: 0,
    allowReflection: false,
  });
  assert.equal(plan.kind, "symmetric");
  assert.equal(plan.symmetry.kind, "rotational");
  assert.equal(plan.symmetry.order, 4);
  assert.deepEqual(
    plan.expansion.copies.map((copy) => copy.transform.angleDeg),
    [0, 90, 180, 270],
  );
});

test("a one-element full description remains a valid explicit fallback", () => {
  const { description } = arrayDescription({ side: 2 });
  const single = { ...description, elements: [description.elements[0]] };
  const plan = analyzeArraySymmetry(single, { positionEpsilonM: 0 });
  assert.equal(plan.kind, "explicit");
  assert.equal(plan.elements.length, 1);
});

test("array ground connections validate early and reach both builders", async () => {
  const { description } = arrayDescription({ side: 2 });
  assert.throws(
    () => analyzeArraySymmetry({
      ...description,
      ground: { kind: "free-space" },
      groundConnection: "interpolate",
    }, { positionEpsilonM: 0 }),
    NecInputError,
  );
  assert.throws(
    () => analyzeArraySymmetry({
      ...description,
      groundConnection: "unknown",
    }, { positionEpsilonM: 0 }),
    NecInputError,
  );

  for (const [groundConnection, ground] of [
    ["interpolate", { kind: "perfect" }],
    ["zero-current", {
      kind: "finite",
      method: "reflection-coefficient",
      relativePermittivity: 13,
      conductivitySPerM: 0.005,
    }],
  ]) {
    const candidate = { ...description, ground, groundConnection };
    const plans = [
      analyzeArraySymmetry(candidate, { positionEpsilonM: 0 }),
      analyzeArraySymmetry({
        ...candidate,
        elements: [candidate.elements[0]],
      }, { positionEpsilonM: 0 }),
    ];
    for (const plan of plans) {
      const completions = [];
      const grounds = [];
      const model = {
        addWire() {},
        completeGeometry(options) { completions.push(options); return {}; },
        definePorts() {},
        addLoad() {},
        setGround(value) { grounds.push(value); },
      };
      const appliedDescription = plan.kind === "explicit" && plan.elements.length === 1
        ? { ...candidate, elements: [candidate.elements[0]] }
        : candidate;
      await applyArrayBuildPlan(model, appliedDescription, plan);
      assert.equal(completions[0].groundConnection, groundConnection);
      assert.deepEqual(grounds[0], ground);
    }
  }
});

test("input permutations retain canonical geometry and ID-based native mappings", () => {
  const { description } = arrayDescription();
  const original = analyzeArraySymmetry(description, { positionEpsilonM: 0 });
  const permutedDescription = {
    ...description,
    elements: [...description.elements].reverse(),
  };
  const permuted = analyzeArraySymmetry(permutedDescription, { positionEpsilonM: 0 });
  assert.equal(original.kind, "symmetric");
  assert.equal(permuted.kind, "symmetric");
  assert.deepEqual(
    original.fundamentalElements.map((element) => element.positionM),
    permuted.fundamentalElements.map((element) => element.positionM),
  );
  assert.deepEqual(byId(original), byId(permuted));
});

test("epsilon canonicalization reports all adjustments and rejects the first excess", () => {
  const { description } = arrayDescription();
  const epsilon = 1e-5;
  const jittered = {
    ...description,
    elements: description.elements.map((element, index) => ({
      ...element,
      positionM: [
        element.positionM[0] + ((index % 3) - 1) * epsilon / 10,
        element.positionM[1] + ((index % 5) - 2) * epsilon / 12,
      ],
    })),
  };
  const accepted = analyzeArraySymmetry(jittered, { positionEpsilonM: epsilon });
  assert.equal(accepted.kind, "symmetric");
  assert.equal(accepted.diagnostics.exact, false);
  assert.equal(accepted.diagnostics.canonicalizations.length, 16);
  assert.ok(accepted.maxPositionAdjustmentM > 0);
  assert.ok(accepted.maxPositionAdjustmentM <= epsilon);
  for (const canonicalization of accepted.diagnostics.canonicalizations) {
    assert.deepEqual(
      canonicalization.adjustmentM,
      accepted.mappings[canonicalization.callerElementIndex].positionAdjustmentM,
    );
  }

  const outside = structuredClone(description);
  outside.elements[0].positionM[0] += 4 * epsilon;
  const rejected = analyzeArraySymmetry(outside, { positionEpsilonM: epsilon });
  assert.equal(rejected.kind, "explicit");
  assert.ok(rejected.reasons.some((entry) => entry.code === "POSITION_OUTSIDE_EPSILON"));
});

test("ambiguous positions and pattern mismatches reject candidates deterministically", () => {
  const { description } = arrayDescription({ side: 2 });
  const ambiguous = structuredClone(description);
  ambiguous.elements[1].positionM = [...ambiguous.elements[0].positionM];
  const ambiguousPlan = analyzeArraySymmetry(ambiguous, { positionEpsilonM: 1e-9 });
  assert.equal(ambiguousPlan.kind, "explicit");
  assert.ok(ambiguousPlan.diagnostics.candidates.some((candidate) =>
    candidate.reasons.some((entry) => entry.code === "AMBIGUOUS_POSITION_MATCH")));

  const mismatch = structuredClone(description);
  mismatch.patterns.push({ ...mismatch.patterns[0], id: "other" });
  mismatch.elements[3].patternId = "other";
  const mismatchPlan = analyzeArraySymmetry(mismatch, { positionEpsilonM: 0 });
  assert.equal(mismatchPlan.kind, "explicit");
  assert.ok(mismatchPlan.diagnostics.candidates.some((candidate) =>
    candidate.reasons.some((entry) => entry.code === "PATTERN_MISMATCH")));
});

test("every prohibited first-release pattern capability stays explicit", () => {
  const prohibited = [
    {
      name: "helix or opaque primitive",
      mutate(value) { value.patterns[0].kind = "helix-pattern"; },
    },
    {
      name: "tilted wire",
      mutate(value) { value.patterns[0].wires[0].endM[0] = 0.1; },
    },
    {
      name: "horizontal wire",
      mutate(value) {
        value.patterns[0].wires[0].startM = [-0.1, 0, 0.2];
        value.patterns[0].wires[0].endM = [0.1, 0, 0.2];
      },
    },
    {
      name: "off-axis wire",
      mutate(value) {
        value.patterns[0].wires[0].startM[1] = 0.01;
        value.patterns[0].wires[0].endM[1] = 0.01;
      },
    },
    {
      name: "nonzero local rotation",
      mutate(value) { value.elements[0].rotationDeg = 10; },
    },
    {
      name: "arc",
      mutate(value) { value.patterns[0].kind = "arc-pattern"; },
    },
    {
      name: "patch",
      mutate(value) { value.patterns[0].kind = "patch-pattern"; },
    },
  ];
  for (const entry of prohibited) {
    const { description } = arrayDescription({ side: 2 });
    const candidate = structuredClone(description);
    entry.mutate(candidate);
    const plan = analyzeArraySymmetry(candidate, { positionEpsilonM: 0 });
    assert.equal(plan.kind, "explicit", entry.name);
    assert.equal(plan.reasons[0].code, "UNSUPPORTED_ELEMENT_PATTERN_TRANSFORM");
    assert.throws(
      () => analyzeArraySymmetry(candidate, {
        positionEpsilonM: 0,
        onUnsupported: "error",
      }),
      (error) => error instanceof NecGeometryError
        && error.details?.symmetryFailure === "UNSUPPORTED_ELEMENT_PATTERN_TRANSFORM",
      entry.name,
    );
  }
});

test("explicit application preserves unsupported local wire rotation", async () => {
  const { description } = arrayDescription({ side: 2 });
  const candidate = structuredClone(description);
  candidate.elements = [{
    ...candidate.elements[0],
    rotationDeg: 90,
  }];
  candidate.patterns[0].wires[0].startM[0] = 0.1;
  candidate.patterns[0].wires[0].endM[0] = 0.1;
  const plan = analyzeArraySymmetry(candidate, { positionEpsilonM: 0 });
  assert.equal(plan.kind, "explicit");
  const wires = [];
  const model = {
    addWire(wire) { wires.push(wire); },
    completeGeometry() { return {}; },
    definePorts() {},
    addLoad() {},
    setGround() {},
  };
  await applyArrayBuildPlan(model, candidate, plan);
  assert.equal(wires.length, 1);
  assert.ok(Math.abs(wires[0].start[0] - candidate.elements[0].positionM[0]) < 1e-12);
  assert.ok(Math.abs(wires[0].start[1]
    - (candidate.elements[0].positionM[1] + 0.1)) < 1e-12);
});

test("synthetic vector, matrix, and embedded-basis mappings are exact", () => {
  const scatter = [2, 0, 3, 1];
  const caller = {
    real: Float64Array.of(10, 20, 30, 40),
    imag: Float64Array.of(-1, -2, -3, -4),
  };
  const native = scatterComplexVector(caller, scatter);
  assert.deepEqual([...native.real], [20, 40, 10, 30]);
  assert.deepEqual(gatherComplexVector(native, scatter), caller);

  const values = Float64Array.from({ length: 16 }, (_, index) => index);
  const gathered = gatherComplexMatrix({
    rows: 4,
    columns: 4,
    order: "row-major",
    real: values,
    imag: Float64Array.from(values, (value) => -value),
  }, scatter);
  assert.equal(gathered.real[1], values[scatter[0] * 4 + scatter[1]]);
  assert.equal(gathered.imag[14], -values[scatter[3] * 4 + scatter[2]]);

  const bases = Float64Array.from({ length: 8 }, (_, index) => index);
  assert.deepEqual([...gatherEmbeddedBasis(bases, 2, scatter)], [4, 5, 0, 1, 6, 7, 2, 3]);
});

test("far-field phase restoration uses the positive propagation-convention sign", () => {
  const speed = 1 / Math.sqrt(8.854e-12 * 4 * Math.PI * 1e-7);
  const frequencyMHz = 300;
  const wavelengthM = speed / (frequencyMHz * 1e6);
  const result = rephaseFarField({
    radiusM: 1,
    frequencyMHz,
    thetaDeg: Float64Array.of(90),
    phiDeg: Float64Array.of(0),
    eThetaReal: Float64Array.of(1),
    eThetaImag: Float64Array.of(0),
    ePhiReal: Float64Array.of(0),
    ePhiImag: Float64Array.of(1),
  }, [wavelengthM / 4, 0]);
  assert.ok(Math.abs(result.eThetaReal[0]) < 1e-12);
  assert.ok(Math.abs(result.eThetaImag[0] - 1) < 1e-12);
  assert.ok(Math.abs(result.ePhiReal[0] + 1) < 1e-12);
  assert.ok(Math.abs(result.ePhiImag[0]) < 1e-12);
});
