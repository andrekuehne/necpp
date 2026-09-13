import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import {
  NecInputError,
  NecStateError,
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

function currentDescription({ centerM = [0.173, -0.219] } = {}) {
  const { fixture, description } = arrayDescription({ centerM });
  description.patterns[0].wires = [
    {
      id: "lower",
      segments: 3,
      startM: [0, 0, 0.1 * fixture.wavelengthM],
      endM: [0, 0, 0.4 * fixture.wavelengthM],
      radiusM: fixture.radiusM,
    },
    {
      id: "upper",
      segments: 4,
      startM: [0, 0, 0.4 * fixture.wavelengthM],
      endM: [0, 0, 0.8 * fixture.wavelengthM],
      radiusM: fixture.radiusM,
    },
  ];
  description.patterns[0].ports = [{ wireId: "upper", segment: 1, name: "feed" }];
  return { fixture, description };
}

async function solvedCurrentSolver(description, fixture, symmetry) {
  const solver = await createNecArraySolver(description, symmetry === "off"
    ? { symmetry }
    : {
      symmetry,
      symmetrizer: {
        positionEpsilonM: 1e-12,
        allowRotation: false,
      },
    });
  await solver.prepare({ frequencyMHz: fixture.frequencyMHz });
  const count = description.elements.length;
  const current = {
    real: Float64Array.from({ length: count }, (_, index) => {
      const magnitude = 0.25 + 0.11 * index;
      return magnitude * Math.cos(0.37 * index);
    }),
    imag: Float64Array.from({ length: count }, (_, index) => {
      const magnitude = 0.25 + 0.11 * index;
      return magnitude * Math.sin(0.37 * index);
    }),
  };
  await solver.solveCurrents(current);
  return solver;
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

test("array current distributions require a solved state and latest-solution kind", {
  skip: !hasWasm && "WASM artifacts have not been built",
}, async () => {
  const { description, fixture } = arrayDescription();
  const solver = await createNecArraySolver(description, { symmetry: "off" });
  try {
    await assert.rejects(
      solver.getCurrentDistribution({ kind: "latest-solution" }),
      NecStateError,
    );
    await assert.rejects(
      solver.getCurrentDistribution({ kind: "unit-current" }),
      NecInputError,
    );
    await solver.prepare({ frequencyMHz: fixture.frequencyMHz });
    await assert.rejects(
      solver.getCurrentDistribution({ kind: "latest-solution" }),
      NecStateError,
    );
  } finally {
    await solver.dispose();
  }
});

test("array current distributions gather exact complex currents into caller geometry", {
  skip: !hasWasm && "WASM artifacts have not been built",
}, async () => {
  const { description, fixture } = currentDescription();
  const [explicit, symmetric] = await Promise.all([
    solvedCurrentSolver(description, fixture, "off"),
    solvedCurrentSolver(description, fixture, "require"),
  ]);
  try {
    const [explicitCurrents, symmetricCurrents] = await Promise.all([
      explicit.getCurrentDistribution({ kind: "latest-solution" }),
      symmetric.getCurrentDistribution({ kind: "latest-solution" }),
    ]);
    assert.equal(explicitCurrents.modeKind, "latest-solution");
    assert.equal(symmetricCurrents.modeKind, "latest-solution");
    assert.equal(explicitCurrents.modeCount, 1);
    assert.equal(symmetricCurrents.modeCount, 1);

    const expectedSegments = description.elements.flatMap((_, elementIndex) => [
      ...Array.from({ length: 3 }, (_, index) => ({
        tag: 2 * elementIndex + 1,
        segment: index + 1,
      })),
      ...Array.from({ length: 4 }, (_, index) => ({
        tag: 2 * elementIndex + 2,
        segment: index + 1,
      })),
    ]);
    assert.deepEqual(
      explicitCurrents.segments.map(({ tag, segment }) => ({ tag, segment })),
      expectedSegments,
    );
    assert.deepEqual(
      symmetricCurrents.segments.map(({ tag, segment }) => ({ tag, segment })),
      expectedSegments,
    );
    assert.deepEqual(symmetricCurrents.startEnds, explicitCurrents.startEnds);
    assert.deepEqual(symmetricCurrents.endEnds, explicitCurrents.endEnds);
    assert.ok(symmetricCurrents.startEnds.some((end) => end.kind === "segment"));
    assert.ok(symmetricCurrents.endEnds.some((end) => end.kind === "segment"));
    for (const ends of [symmetricCurrents.startEnds, symmetricCurrents.endEnds]) {
      for (const end of ends) {
        if (end.kind === "segment") {
          assert.ok(end.tag >= 1 && end.tag <= 2 * description.elements.length);
        }
      }
    }
    assert.deepEqual(
      [...symmetricCurrents.segments].map((segment) => segment.nativeIndex).sort((a, b) => a - b),
      Array.from({ length: expectedSegments.length }, (_, index) => index),
    );
    assert.ok(symmetricCurrents.segments.some(
      (segment, index) => segment.nativeIndex !== index,
    ));

    for (const name of [
      "centresM", "startsM", "endsM", "tangents", "radiiM", "lengthsM",
      "aReal", "aImag", "bReal", "bImag", "cReal", "cImag",
    ]) {
      assert.ok(
        relativeError(symmetricCurrents[name], explicitCurrents[name]) <= 1e-8,
        `${name} explicit/symmetric parity`,
      );
    }
    assert.ok(Math.abs(symmetricCurrents.centresM[0] - explicitCurrents.centresM[0]) < 1e-12);
    assert.ok(Math.abs(symmetricCurrents.centresM[1] - explicitCurrents.centresM[1]) < 1e-12);

    for (const solver of [explicit, symmetric]) {
      const earlier = await solver.getCurrentDistribution({ kind: "latest-solution" });
      const saved = earlier.aReal.slice();
      const later = await solver.getCurrentDistribution({ kind: "latest-solution" });
      later.aReal.fill(Number.NaN);
      assert.deepEqual(earlier.aReal, saved);
    }
  } finally {
    await Promise.all([explicit.dispose(), symmetric.dispose()]);
  }
});

test("symmetric current geometry reports the planner-canonicalized absolute positions", {
  skip: !hasWasm && "WASM artifacts have not been built",
}, async () => {
  const { description, fixture } = arrayDescription({ side: 4 });
  const epsilon = 1e-5;
  const jittered = structuredClone(description);
  jittered.elements = jittered.elements.map((element, index) => ({
    ...element,
    positionM: [
      element.positionM[0] + ((index % 3) - 1) * epsilon / 10,
      element.positionM[1] + ((index % 5) - 2) * epsilon / 12,
    ],
  }));
  const symmetrizer = {
    positionEpsilonM: epsilon,
    allowRotation: false,
  };
  const plan = analyzeArraySymmetry(jittered, symmetrizer);
  assert.equal(plan.kind, "symmetric");
  assert.equal(plan.diagnostics.exact, false);
  assert.ok(plan.diagnostics.canonicalizations.some(({ distanceM }) => distanceM > 0));

  const solver = await createNecArraySolver(jittered, {
    symmetry: "require",
    symmetrizer,
  });
  try {
    await solver.prepare({ frequencyMHz: fixture.frequencyMHz });
    await solver.solveCurrents({
      real: new Float64Array(jittered.elements.length).fill(0.25),
      imag: Float64Array.from(
        { length: jittered.elements.length },
        (_, index) => 0.1 * Math.sin(0.2 * index),
      ),
    });
    const currents = await solver.getCurrentDistribution({ kind: "latest-solution" });
    for (const canonicalization of plan.diagnostics.canonicalizations) {
      const segment = canonicalization.callerElementIndex * fixture.segments;
      assert.ok(
        Math.abs(currents.centresM[3 * segment] - canonicalization.canonicalPositionM[0]) < 1e-12,
      );
      assert.ok(
        Math.abs(currents.centresM[3 * segment + 1] - canonicalization.canonicalPositionM[1]) < 1e-12,
      );
    }
  } finally {
    await solver.dispose();
  }
});
