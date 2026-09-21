import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import {
  NecCancellationError,
  NecGeometryError,
  NecInputError,
  NecStateError,
  analyzeArraySymmetry,
  applyArrayBuildPlan,
  createNecArraySolver,
  createNecModel,
} from "../.test-build/src/index.js";
import {
  createNecArraySolverWithWorkerFactory,
} from "../.test-build/src/array-solver.js";
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

class ControllableArrayWorker {
  state = "empty";
  hangMethod;
  prepareFailure;
  terminateCount = 0;
  #tail = Promise.resolve();
  #activeReject;
  #ports = [];
  #terminated = false;

  constructor({ hangMethod, prepareFailure } = {}) {
    this.hangMethod = hangMethod;
    this.prepareFailure = prepareFailure;
  }

  #invoke(method, value) {
    const run = this.#tail.then(() => {
      if (this.#terminated) throw new NecCancellationError("terminated");
      if (method === "prepare" && this.prepareFailure !== undefined) {
        const error = this.prepareFailure;
        this.prepareFailure = undefined;
        throw error;
      }
      if (method === this.hangMethod) {
        return new Promise((_, reject) => {
          this.#activeReject = reject;
        });
      }
      return typeof value === "function" ? value() : value;
    });
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }

  addWire() {
    return this.#invoke("addWire", () => {
      this.state = "geometry-building";
    });
  }

  completeGeometry() {
    return this.#invoke("completeGeometry", () => {
      this.state = "geometry-complete";
      return {};
    });
  }

  definePorts(ports) {
    return this.#invoke("definePorts", () => {
      this.#ports = ports;
    });
  }

  addLoad() { return this.#invoke("addLoad"); }
  clearLoads() { return this.#invoke("clearLoads"); }
  setGround() { return this.#invoke("setGround"); }

  prepare() {
    return this.#invoke("prepare", () => {
      this.state = "prepared";
    });
  }

  computeImpedanceMatrix() {
    return this.#invoke("computeImpedanceMatrix", () => {
      const order = this.#ports.length;
      const real = new Float64Array(order * order);
      for (let index = 0; index < order; index += 1) real[index * order + index] = 50;
      const matrix = { rows: order, columns: order, order: "row-major", real, imag: new Float64Array(real.length) };
      return {
        impedance: matrix,
        admittance: { ...matrix, real: Float64Array.from(real, (value) => value === 0 ? 0 : 1 / value) },
        frequencyMHz: 300,
        factorizationGeneration: 1,
      };
    });
  }

  solveCurrents(currents) {
    return this.#invoke("solveCurrents", () => {
      this.state = "solved";
      const copy = (value) => ({ real: new Float64Array(value.real), imag: new Float64Array(value.imag) });
      const voltages = {
        real: Float64Array.from(currents.real, (value) => 50 * value),
        imag: Float64Array.from(currents.imag, (value) => 50 * value),
      };
      return {
        drive: "current",
        frequencyMHz: 300,
        ports: this.#ports,
        requested: copy(currents),
        voltages,
        currents: copy(currents),
        activeImpedances: { real: new Float64Array(this.#ports.length).fill(50), imag: new Float64Array(this.#ports.length) },
        powersW: new Float64Array(this.#ports.length),
        powerBudget: { inputPowerW: 0, radiatedPowerW: 0, structureLossW: 0, networkLossW: 0, efficiencyPercent: null },
        factorizationGeneration: 1,
        solveGeneration: 1,
      };
    });
  }

  solveVoltages(voltages) {
    return this.solveCurrents({
      real: Float64Array.from(voltages.real, (value) => value / 50),
      imag: Float64Array.from(voltages.imag, (value) => value / 50),
    });
  }

  computeFarField() {
    return this.#invoke("computeFarField", () => ({
      radiusM: 1,
      frequencyMHz: 300,
      thetaDeg: Float64Array.of(0),
      phiDeg: Float64Array.of(0),
      eThetaReal: Float64Array.of(0),
      eThetaImag: Float64Array.of(0),
      ePhiReal: Float64Array.of(0),
      ePhiImag: Float64Array.of(0),
    }));
  }

  computeEmbeddedFarFields() { return this.#invoke("computeEmbeddedFarFields"); }
  getCurrentDistribution() { return this.#invoke("getCurrentDistribution"); }
  prepareCurrentQuadrature() { return this.#invoke("prepareCurrentQuadrature"); }
  characterizeIsolatedElement() { return this.#invoke("characterizeIsolatedElement"); }
  cancelFarField() {}
  subscribeProgress() { return () => undefined; }

  async dispose() {
    this.terminate();
  }

  terminate() {
    if (this.#terminated) return;
    this.#terminated = true;
    this.state = "disposed";
    this.terminateCount += 1;
    this.#activeReject?.(new NecCancellationError("terminated"));
    this.#activeReject = undefined;
  }
}

async function assertArrayCancellation(promise, reason) {
  let timer;
  try {
    await assert.rejects(
      Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("array cancellation did not reject within 250 ms")),
            250,
          );
        }),
      ]),
      (error) => (
        error instanceof NecCancellationError
        && error.details?.reason === reason
      ),
    );
  } finally {
    clearTimeout(timer);
  }
}

test("array factory aborts in-flight geometry without publishing a solver", async () => {
  const { description } = arrayDescription({ side: 1 });
  const model = new ControllableArrayWorker({ hangMethod: "addWire" });
  const controller = new AbortController();
  const creation = createNecArraySolverWithWorkerFactory(
    description,
    { symmetry: "off", signal: controller.signal },
    async () => model,
  );
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();

  await assertArrayCancellation(creation, "aborted");
  assert.equal(model.state, "disposed");
  assert.equal(model.terminateCount, 1);
});

const arrayCancellationPhases = [
  {
    name: "prepare",
    method: "prepare",
    setup: async () => undefined,
    start: (solver) => solver.prepare({ frequencyMHz: 300 }),
    queue: (solver) => solver.computeImpedanceMatrix(),
  },
  {
    name: "impedance matrix",
    method: "computeImpedanceMatrix",
    setup: (solver) => solver.prepare({ frequencyMHz: 300 }),
    start: (solver) => solver.computeImpedanceMatrix(),
    queue: (solver) => solver.solveCurrents({
      real: Float64Array.of(1),
      imag: Float64Array.of(0),
    }),
  },
  {
    name: "solve",
    method: "solveCurrents",
    setup: (solver) => solver.prepare({ frequencyMHz: 300 }),
    start: (solver) => solver.solveCurrents({
      real: Float64Array.of(1),
      imag: Float64Array.of(0),
    }),
    queue: (solver) => solver.computeImpedanceMatrix(),
  },
  {
    name: "field",
    method: "computeFarField",
    setup: async (solver) => {
      await solver.prepare({ frequencyMHz: 300 });
      await solver.solveCurrents({
        real: Float64Array.of(1),
        imag: Float64Array.of(0),
      });
    },
    start: (solver) => solver.computeFarField({
      theta: { startDeg: 0, count: 1, stepDeg: 0 },
      phi: { startDeg: 0, count: 1, stepDeg: 0 },
    }),
    queue: (solver) => solver.computeImpedanceMatrix(),
  },
];

for (const phase of arrayCancellationPhases) {
  test(`array terminate promptly rejects active ${phase.name} and queued work`, async () => {
    const { description } = arrayDescription({ side: 1 });
    const model = new ControllableArrayWorker();
    const solver = await createNecArraySolverWithWorkerFactory(
      description,
      { symmetry: "off" },
      async () => model,
    );
    await phase.setup(solver);
    model.hangMethod = phase.method;

    const active = phase.start(solver);
    const queued = phase.queue(solver);
    await new Promise((resolve) => setImmediate(resolve));
    solver.terminate();

    await assertArrayCancellation(active, "terminated");
    await assertArrayCancellation(queued, "terminated");
    assert.equal(solver.state, "disposed");
    assert.equal(model.terminateCount, 1);
  });
}

test("array termination owns and cancels the automatic explicit-retry candidate", async () => {
  const { description } = arrayDescription({ side: 2 });
  const models = [
    new ControllableArrayWorker({
      prepareFailure: new NecGeometryError("retry explicitly", {
        details: { symmetryFailure: "INCOMPLETE_LOAD_ORBIT" },
      }),
    }),
    new ControllableArrayWorker({ hangMethod: "addWire" }),
  ];
  let factoryCalls = 0;
  const solver = await createNecArraySolverWithWorkerFactory(
    description,
    {
      symmetry: "auto",
      symmetrizer: { positionEpsilonM: 1e-12 },
    },
    async () => models[factoryCalls++],
  );

  const preparation = solver.prepare({ frequencyMHz: 300 });
  for (let attempt = 0; attempt < 20 && factoryCalls < 2; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(factoryCalls, 2, "automatic explicit retry did not start promptly");
  await new Promise((resolve) => setImmediate(resolve));
  solver.terminate();

  await assertArrayCancellation(preparation, "terminated");
  assert.equal(models[0].state, "disposed");
  assert.equal(models[1].state, "disposed");
  assert.equal(models[1].terminateCount, 1);
});

test("array solver creation supports immediate typed cancellation", async () => {
  const { description } = arrayDescription();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    createNecArraySolver(description, {
      symmetry: "off",
      signal: controller.signal,
    }),
    (error) => (
      error instanceof NecCancellationError
      && error.code === "NEC_RUNTIME"
      && error.details?.reason === "aborted"
    ),
  );
});

test("array solver hard termination is idempotent and disposes only that solver", {
  skip: !hasWasm && "WASM artifacts have not been built",
}, async () => {
  const { description, fixture } = arrayDescription({ side: 1 });
  const [candidate, ready] = await Promise.all([
    createNecArraySolver(description, { symmetry: "off" }),
    createNecArraySolver(description, { symmetry: "off" }),
  ]);
  try {
    await ready.prepare({ frequencyMHz: fixture.frequencyMHz });

    candidate.terminate();
    candidate.terminate();
    assert.equal(candidate.state, "disposed");
    await assert.rejects(
      candidate.prepare({ frequencyMHz: fixture.frequencyMHz }),
      NecStateError,
    );

    const matrix = await ready.computeImpedanceMatrix();
    assert.equal(matrix.impedance.rows, 1);
    assert.equal(ready.state, "prepared");
  } finally {
    candidate.terminate();
    await ready.dispose();
  }
});

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
