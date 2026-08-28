import assert from "node:assert/strict";
import { MessageChannel } from "node:worker_threads";
import test from "node:test";

import { NecRuntimeError, NecStateError } from "../.test-build/src/errors.js";
import { createNecWorkerModelFromHost } from "../.test-build/src/worker-client.js";
import { handleWorkerRequest } from "../.test-build/src/worker-runtime.js";

const dipoleWire = {
  tag: 1,
  segments: 11,
  start: [0, 0, -0.25],
  end: [0, 0, 0.25],
  radiusM: 0.001,
};

function snapshotPorts(ports) {
  return Object.freeze(ports.map((port) => Object.freeze({ ...port })));
}

function createFakeModel(overrides = {}) {
  let state = "empty";
  const ports = [];
  const model = {
    get state() {
      return state;
    },
    addWire() {
      state = "geometry-building";
    },
    completeGeometry() {
      state = "geometry-complete";
    },
    definePorts(nextPorts) {
      ports.splice(0, ports.length, ...snapshotPorts(nextPorts));
    },
    addLoad() {},
    clearLoads() {},
    setGround() {},
    prepare() {
      state = "prepared";
    },
    computeImpedanceMatrix() {
      return {
        impedance: {
          rows: 1,
          columns: 1,
          order: "row-major",
          real: new Float64Array([73.1]),
          imag: new Float64Array([42.5]),
        },
        admittance: {
          rows: 1,
          columns: 1,
          order: "row-major",
          real: new Float64Array([0.01]),
          imag: new Float64Array([-0.005]),
        },
        conditionEstimate: 1.5,
        frequencyMHz: 300,
        factorizationGeneration: 1,
      };
    },
    solveVoltages(voltages) {
      state = "solved";
      return {
        drive: "voltage",
        frequencyMHz: 300,
        ports: snapshotPorts(ports),
        requested: {
          real: new Float64Array(voltages.real),
          imag: new Float64Array(voltages.imag),
        },
        voltages: {
          real: new Float64Array(voltages.real),
          imag: new Float64Array(voltages.imag),
        },
        currents: {
          real: new Float64Array([0.01]),
          imag: new Float64Array([0]),
        },
        activeImpedances: {
          real: new Float64Array([73.1]),
          imag: new Float64Array([42.5]),
        },
        powersW: new Float64Array([0.005]),
        factorizationGeneration: 1,
        solveGeneration: 1,
      };
    },
    solveCurrents() {
      state = "solved";
      return model.solveVoltages({
        real: new Float64Array([1]),
        imag: new Float64Array([0]),
      });
    },
    computeFarField() {
      const samples = 2_048;
      return {
        radiusM: 1,
        frequencyMHz: 300,
        thetaDeg: new Float64Array([0, 90]),
        phiDeg: new Float64Array([0]),
        eThetaReal: new Float64Array(samples).fill(1.25),
        eThetaImag: new Float64Array(samples).fill(-0.5),
        ePhiReal: new Float64Array(samples),
        ePhiImag: new Float64Array(samples),
      };
    },
    computeEmbeddedFarFields() {
      return {
        ...model.computeFarField(),
        ports: snapshotPorts(ports),
        normalization: { kind: "unit-voltage", valueV: 1 },
        samplesPerPort: 2_048,
      };
    },
    dispose() {
      state = "disposed";
    },
    ...overrides,
  };
  return model;
}

function createLoopbackHost(createModel, options = {}) {
  const { port1, port2 } = new MessageChannel();
  const session = { model: undefined };
  let queue = Promise.resolve();
  const calls = [];

  port2.on("message", (request) => {
    calls.push(request);
    queue = queue.then(async () => {
      if (options.hang?.filter?.(request) === true) {
        await options.hang.gate;
      }
      const { response, transfer } = await handleWorkerRequest(session, request, {
        createModel,
        emitProgress(event) {
          port2.postMessage({
            kind: "progress",
            operation: event.operation,
            phase: event.phase,
          });
        },
      });
      port2.postMessage(response, transfer);
    });
  });

  return {
    calls,
    postMessage(data, transfer = []) {
      port1.postMessage(data, transfer);
    },
    subscribe(listener) {
      const handler = (value) => listener(value);
      port1.on("message", handler);
      return () => port1.off("message", handler);
    },
    subscribeError() {
      return () => undefined;
    },
    terminate() {
      port1.close();
      port2.close();
    },
  };
}

async function preparedModel(createModel = () => Promise.resolve(createFakeModel())) {
  const host = createLoopbackHost(createModel);
  const model = await createNecWorkerModelFromHost(host);
  await model.addWire(dipoleWire);
  await model.completeGeometry();
  await model.definePorts([{ tag: 1, segment: 6, name: "feed" }]);
  await model.prepare({ frequencyMHz: 300 });
  return { host, model };
}

test("the worker runtime preserves state across serialized requests", async () => {
  const session = { model: undefined };
  const fake = createFakeModel();
  const progress = [];
  const deps = {
    createModel: async () => fake,
    emitProgress(event) {
      progress.push(`${event.operation}:${event.phase}`);
    },
  };

  const created = await handleWorkerRequest(session, { id: 1, kind: "create" }, deps);
  assert.equal(created.response.kind, "ok");
  assert.equal(session.model, fake);

  await handleWorkerRequest(session, {
    id: 2,
    kind: "invoke",
    method: "addWire",
    args: [dipoleWire],
  }, deps);
  assert.equal(fake.state, "geometry-building");

  await handleWorkerRequest(session, {
    id: 3,
    kind: "invoke",
    method: "completeGeometry",
    args: [],
  }, deps);
  assert.equal(fake.state, "geometry-complete");
  assert.ok(progress.includes("create:start"));
  assert.ok(progress.includes("addWire:complete"));
});

test("worker client serializes operations, reports progress, and transfers fields", async () => {
  const progress = [];
  const { model } = await preparedModel();
  const unsubscribe = model.subscribeProgress((event) => {
    progress.push(`${event.operation}:${event.phase}`);
  });

  const matrices = await model.computeImpedanceMatrix();
  assert.equal(matrices.impedance.real[0], 73.1);
  assert.equal(matrices.conditionEstimate, 1.5);

  const voltages = {
    real: new Float64Array([1]),
    imag: new Float64Array([0]),
  };
  const solution = await model.solveVoltages(voltages);
  assert.equal(voltages.real.buffer.byteLength, 8);
  assert.equal(solution.ports[0].name, "feed");
  assert.throws(() => {
    solution.ports[0].name = "mutated";
  }, TypeError);
  assert.equal(solution.ports[0].name, "feed");

  const field = await model.computeFarField({
    theta: { startDeg: 0, count: 2, stepDeg: 90 },
    phi: { startDeg: 0, count: 1, stepDeg: 0 },
  });
  assert.equal(field.eThetaReal.length, 2_048);
  assert.equal(field.eThetaReal[0], 1.25);
  assert.equal(field.eThetaReal.buffer.byteLength, 2_048 * 8);

  unsubscribe();
  await model.dispose();
  assert.equal(model.state, "disposed");
  assert.ok(progress.includes("computeImpedanceMatrix:start"));
  assert.ok(progress.includes("computeFarField:complete"));
});

test("queued worker operations stay serialized per model", async () => {
  const order = [];
  let releasePrepare;
  const hang = {
    filter: (request) => request.method === "prepare",
    gate: new Promise((resolve) => {
      releasePrepare = resolve;
    }),
  };
  const fake = createFakeModel();
  const originalPrepare = fake.prepare.bind(fake);
  const originalMatrix = fake.computeImpedanceMatrix.bind(fake);
  fake.prepare = () => {
    order.push("prepare");
    originalPrepare();
  };
  fake.computeImpedanceMatrix = () => {
    order.push("matrix");
    return originalMatrix();
  };
  const host = createLoopbackHost(async () => fake, { hang });
  const model = await createNecWorkerModelFromHost(host);
  await model.addWire(dipoleWire);
  await model.completeGeometry();
  await model.definePorts([{ tag: 1, segment: 6 }]);

  const prepare = model.prepare({ frequencyMHz: 300 });
  const matrix = model.computeImpedanceMatrix();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, []);
  releasePrepare();
  await prepare;
  await matrix;
  assert.deepEqual(order, ["prepare", "matrix"]);
  await model.dispose();
});

test("the client thread keeps a heartbeat while a worker request is outstanding", async () => {
  let release;
  const hang = {
    filter: (request) => request.method === "computeImpedanceMatrix",
    gate: new Promise((resolve) => {
      release = resolve;
    }),
  };
  const host = createLoopbackHost(async () => createFakeModel(), { hang });
  const model = await createNecWorkerModelFromHost(host);
  await model.addWire(dipoleWire);
  await model.completeGeometry();
  await model.definePorts([{ tag: 1, segment: 6 }]);
  await model.prepare({ frequencyMHz: 300 });

  const pending = model.computeImpedanceMatrix();
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
  }, 5);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(ticks > 0, "the client event loop must continue during a worker calculation");
  release();
  await pending;
  clearInterval(timer);
  await model.dispose();
});

test("termination releases the worker and rejects outstanding operations", async () => {
  let release;
  const hang = {
    filter: (request) => request.method === "computeFarField",
    gate: new Promise((resolve) => {
      release = resolve;
    }),
  };
  const host = createLoopbackHost(async () => createFakeModel(), { hang });
  const model = await createNecWorkerModelFromHost(host);
  await model.addWire(dipoleWire);
  await model.completeGeometry();
  await model.definePorts([{ tag: 1, segment: 6 }]);
  await model.prepare({ frequencyMHz: 300 });

  const first = model.computeFarField({
    theta: { startDeg: 0, count: 1, stepDeg: 0 },
    phi: { startDeg: 0, count: 1, stepDeg: 0 },
  });
  const second = model.computeFarField({
    theta: { startDeg: 0, count: 1, stepDeg: 0 },
    phi: { startDeg: 0, count: 1, stepDeg: 0 },
  });
  model.terminate();
  await assert.rejects(first, (error) => (
    error instanceof NecRuntimeError && error.message.includes("terminated")
  ));
  await assert.rejects(second, NecRuntimeError);
  assert.equal(model.state, "disposed");
  await assert.rejects(model.prepare({ frequencyMHz: 300 }), NecStateError);
  model.terminate();
  release();
});

test("two worker models run independently", async () => {
  const firstFake = createFakeModel({
    computeImpedanceMatrix() {
      return {
        ...createFakeModel().computeImpedanceMatrix(),
        impedance: {
          rows: 1,
          columns: 1,
          order: "row-major",
          real: new Float64Array([11]),
          imag: new Float64Array([0]),
        },
      };
    },
  });
  const secondFake = createFakeModel({
    computeImpedanceMatrix() {
      return {
        ...createFakeModel().computeImpedanceMatrix(),
        impedance: {
          rows: 1,
          columns: 1,
          order: "row-major",
          real: new Float64Array([22]),
          imag: new Float64Array([0]),
        },
      };
    },
  });
  const first = await createNecWorkerModelFromHost(
    createLoopbackHost(async () => firstFake),
  );
  const second = await createNecWorkerModelFromHost(
    createLoopbackHost(async () => secondFake),
  );
  await first.addWire(dipoleWire);
  await second.addWire(dipoleWire);
  await first.completeGeometry();
  await second.completeGeometry();
  await first.definePorts([{ tag: 1, segment: 6 }]);
  await second.definePorts([{ tag: 1, segment: 6 }]);
  await first.prepare({ frequencyMHz: 150 });
  await second.prepare({ frequencyMHz: 300 });

  const [firstZ, secondZ] = await Promise.all([
    first.computeImpedanceMatrix(),
    second.computeImpedanceMatrix(),
  ]);
  assert.equal(firstZ.impedance.real[0], 11);
  assert.equal(secondZ.impedance.real[0], 22);

  await first.dispose();
  await second.dispose();
});
