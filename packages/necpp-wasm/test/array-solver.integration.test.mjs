import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import {
  analyzeArraySymmetry,
  applyArrayBuildPlan,
  createNecArraySolver,
  createNecModel,
} from "../.test-build/src/index.js";
import { createReferenceArrayFixture } from "./fixtures/reference-array.mjs";

const hasWasm = existsSync(new URL("../.test-build/src/nec2pp.wasm", import.meta.url));

function arrayDescription({ side = 2, centerM = [0, 0] } = {}) {
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

function relativeError(left, right) {
  let delta = 0;
  let scale = 0;
  for (let index = 0; index < left.length; index += 1) {
    delta += (left[index] - right[index]) ** 2;
    scale += Math.max(left[index] ** 2, right[index] ** 2);
  }
  return Math.sqrt(delta) / Math.max(1, Math.sqrt(scale));
}

function assertPowerBudgetClose(left, right, tolerance = 1e-10) {
  for (const field of [
    "inputPowerW",
    "radiatedPowerW",
    "structureLossW",
    "networkLossW",
  ]) {
    const scale = Math.max(1, Math.abs(left[field]), Math.abs(right[field]));
    assert.ok(
      Math.abs(left[field] - right[field]) <= tolerance * scale,
      `power budget ${field}`,
    );
  }
  if (left.efficiencyPercent === null || right.efficiencyPercent === null) {
    assert.equal(left.efficiencyPercent, right.efficiencyPercent);
  } else {
    assert.ok(
      Math.abs(left.efficiencyPercent - right.efficiencyPercent) <= tolerance,
      "power budget efficiencyPercent",
    );
  }
}

async function exerciseUnbranched(description, fixture, symmetry) {
  const solver = await createNecArraySolver(description, symmetry === "off"
    ? { symmetry }
    : { symmetry, symmetrizer: { positionEpsilonM: 1e-12 } });
  try {
    await solver.prepare({ frequencyMHz: fixture.frequencyMHz });
    const matrices = await solver.computeImpedanceMatrix();
    const count = description.elements.length;
    const currents = {
      real: Float64Array.from({ length: count }, (_, index) => 0.2 + index * 0.07),
      imag: Float64Array.from({ length: count }, (_, index) => -0.03 * index),
    };
    const solution = await solver.solveCurrents(currents);
    const request = {
      radiusM: 1,
      theta: { startDeg: 30, count: 3, stepDeg: 30 },
      phi: { startDeg: 0, count: 3, stepDeg: 60 },
    };
    const field = await solver.computeFarField(request);
    const embedded = await solver.computeEmbeddedFarFields(request);
    return {
      diagnostics: solver.getDiagnostics(),
      matrices,
      solution,
      field,
      embedded,
    };
  } finally {
    await solver.dispose();
  }
}

test("direct and worker application adapters consume the same public plan", {
  skip: !hasWasm && "WASM artifacts have not been built",
}, async () => {
  const { description } = arrayDescription();
  const plan = analyzeArraySymmetry(description, { positionEpsilonM: 0 });
  const direct = await createNecModel();
  try {
    const applied = await applyArrayBuildPlan(direct, description, plan);
    assert.equal(applied.completion.symmetry.sectionCount, 4);
    assert.deepEqual(applied.scatterCallerToNative, [3, 1, 2, 0]);
    assert.deepEqual(applied.callerPorts.map((port) => port.tag), [1, 2, 3, 4]);
  } finally {
    direct.dispose();
  }
});

test("one unbranched facade exposes identical ordinary result shapes", {
  skip: !hasWasm && "WASM artifacts have not been built",
}, async () => {
  const { description, fixture } = arrayDescription();
  const explicit = await exerciseUnbranched(description, fixture, "off");
  const symmetric = await exerciseUnbranched(description, fixture, "auto");
  assert.equal(explicit.diagnostics.representation, "explicit");
  assert.equal(symmetric.diagnostics.representation, "symmetric");
  for (const key of ["matrices", "solution", "field", "embedded"]) {
    assert.deepEqual(
      Object.keys(explicit[key]).sort(),
      Object.keys(symmetric[key]).sort(),
      key,
    );
  }
  assert.deepEqual(explicit.solution.ports, symmetric.solution.ports);
  assertPowerBudgetClose(explicit.solution.powerBudget, symmetric.solution.powerBudget);
  assert.ok(Math.abs(
    explicit.solution.powerBudget.inputPowerW
      - explicit.solution.powersW.reduce((sum, value) => sum + value, 0),
  ) <= 1e-10);
  assert.deepEqual(explicit.embedded.ports, symmetric.embedded.ports);
  assert.deepEqual(symmetric.solution.ports.map((port) => port.tag), [1, 2, 3, 4]);
  for (const result of [symmetric.matrices, symmetric.solution, symmetric.field, symmetric.embedded]) {
    assert.equal("generatedTag" in result, false);
    assert.equal("copyIndex" in result, false);
    assert.equal("symmetry" in result, false);
  }
});

test("rooted arrays preserve both signed connections through explicit and symmetric builds", {
  skip: !hasWasm && "WASM artifacts have not been built",
}, async () => {
  const { description, fixture } = arrayDescription();
  for (const groundConnection of ["interpolate", "zero-current"]) {
    const rooted = structuredClone(description);
    rooted.groundConnection = groundConnection;
    rooted.patterns[0].wires[0].startM[2] = 0;
    rooted.patterns[0].ports[0].segment = 2;
    const explicit = await exerciseUnbranched(rooted, fixture, "off");
    const symmetric = await exerciseUnbranched(rooted, fixture, "auto");
    assertPowerBudgetClose(explicit.solution.powerBudget, symmetric.solution.powerBudget);
    assert.ok(relativeError(
      explicit.matrices.impedance.real,
      symmetric.matrices.impedance.real,
    ) <= 1e-8);
    assert.ok(relativeError(
      explicit.solution.currents.real,
      symmetric.solution.currents.real,
    ) <= 1e-8);
    assert.ok(relativeError(
      explicit.field.eThetaReal,
      symmetric.field.eThetaReal,
    ) <= 1e-8);
  }
});

test("off-origin explicit and centered symmetric complex fields prove the phase sign", {
  skip: !hasWasm && "WASM artifacts have not been built",
}, async () => {
  const { description, fixture } = arrayDescription({ centerM: [0.173, -0.219] });
  const [explicit, symmetric] = await Promise.all([
    exerciseUnbranched(description, fixture, "off"),
    exerciseUnbranched(description, fixture, "auto"),
  ]);
  for (const component of ["eThetaReal", "eThetaImag", "ePhiReal", "ePhiImag"]) {
    assert.ok(
      relativeError(explicit.field[component], symmetric.field[component]) <= 1e-8,
      `${component} combined field`,
    );
    assert.ok(
      relativeError(explicit.embedded[component], symmetric.embedded[component]) <= 1e-8,
      `${component} embedded bases`,
    );
  }
});
