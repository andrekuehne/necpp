import assert from "node:assert/strict";
import test from "node:test";

import {
  NecConditioningError,
  NecGeometryError,
  NecInputError,
  NecPortError,
  NecRuntimeError,
  NecSolverError,
  NecStateError,
} from "../.test-build/src/errors.js";
import { WasmNecModel } from "../.test-build/src/model.js";

function createRecordingModule() {
  const memory = new ArrayBuffer(65_536);
  const HEAPU8 = new Uint8Array(memory);
  const calls = [];
  let state = 0;
  let nextStatus = 0;
  let allocation = 256;
  let deleted = false;
  HEAPU8.set(new TextEncoder().encode("controlled native failure\0"), 8);

  const complete = (name, args, nextState) => {
    calls.push([name, ...args]);
    const status = nextStatus;
    nextStatus = 0;
    if (status === 0 && nextState !== undefined) {
      state = nextState;
    }
    return status;
  };

  return {
    module: {
      HEAPU8,
      HEAP32: new Int32Array(memory),
      HEAPF64: new Float64Array(memory),
      _malloc(bytes) {
        const pointer = allocation;
        allocation = (allocation + bytes + 7) & ~7;
        return pointer;
      },
      _free() {},
      _necpp_wasm_v1_model_state() {
        return state;
      },
      _necpp_wasm_v1_last_error() {
        return 8;
      },
      _necpp_wasm_v1_add_wire(...args) {
        return complete("addWire", args, 1);
      },
      _necpp_wasm_v1_complete_geometry(...args) {
        return complete("completeGeometry", args, 2);
      },
      _necpp_wasm_v1_define_ports(...args) {
        return complete("definePorts", args);
      },
      _necpp_wasm_v1_add_load(...args) {
        return complete("addLoad", args);
      },
      _necpp_wasm_v1_clear_loads(...args) {
        return complete("clearLoads", args);
      },
      _necpp_wasm_v1_set_ground(...args) {
        return complete("setGround", args);
      },
      _necpp_wasm_v1_model_delete() {
        deleted = true;
      },
    },
    calls,
    setNextStatus(status) {
      nextStatus = status;
    },
    wasDeleted() {
      return deleted;
    },
  };
}

function createConfigurableModel(recording) {
  const model = new WasmNecModel(recording.module, 1);
  model.addWire({
    tag: 1,
    segments: 3,
    start: [0, 0, 0],
    end: [0, 0, 1],
    radiusM: 0.001,
  });
  const completion = model.completeGeometry({
    groundConnection: "zero-current",
  });
  assert.deepEqual(completion, {});
  assert.ok(Object.isFrozen(completion));
  model.definePorts([{ tag: 1, segment: 2 }]);
  return model;
}

test("the facade maps every load, ground, and connection enum to ABI values", () => {
  const recording = createRecordingModule();
  const model = createConfigurableModel(recording);
  assert.equal(
    recording.calls.find(([name]) => name === "completeGeometry")[2],
    2,
  );

  const loads = [
    [
      {
        kind: "series-rlc",
        target: { tag: 1 },
        resistanceOhm: 1,
        inductanceH: 2,
        capacitanceF: 3,
      },
      [0, 1, 0, 0, 1, 2, 3],
    ],
    [
      {
        kind: "parallel-rlc",
        target: { tag: 1, firstSegment: 2 },
        resistanceOhm: 4,
        inductanceH: 5,
        capacitanceF: 6,
      },
      [1, 1, 2, 2, 4, 5, 6],
    ],
    [
      {
        kind: "series-rlc",
        perMeter: true,
        target: { tag: 0, firstSegment: 2, lastSegment: 3 },
        resistanceOhm: 7,
        inductanceH: 8,
        capacitanceF: 9,
      },
      [2, 0, 2, 3, 7, 8, 9],
    ],
    [
      {
        kind: "parallel-rlc",
        perMeter: true,
        target: { tag: 1 },
        resistanceOhm: 10,
        inductanceH: 11,
        capacitanceF: 12,
      },
      [3, 1, 0, 0, 10, 11, 12],
    ],
    [
      {
        kind: "impedance",
        target: { tag: 1, firstSegment: 1, lastSegment: 2 },
        resistanceOhm: 13,
        reactanceOhm: 14,
      },
      [4, 1, 1, 2, 13, 14, 0],
    ],
    [
      {
        kind: "conductivity",
        target: { tag: 1 },
        conductivitySPerM: 15,
      },
      [5, 1, 0, 0, 15, 0, 0],
    ],
  ];

  for (const [load, expected] of loads) {
    model.addLoad(load);
    const call = recording.calls.at(-1);
    assert.equal(call[0], "addLoad");
    assert.deepEqual(call.slice(2), expected);
  }

  const grounds = [
    [{ kind: "free-space" }, [0, 0, 0]],
    [{ kind: "perfect" }, [1, 0, 0]],
    [
      {
        kind: "finite",
        method: "reflection-coefficient",
        relativePermittivity: 13,
        conductivitySPerM: 0.005,
      },
      [2, 13, 0.005],
    ],
    [
      {
        kind: "finite",
        method: "sommerfeld-norton",
        relativePermittivity: 20,
        conductivitySPerM: 0.01,
      },
      [3, 20, 0.01],
    ],
  ];
  for (const [ground, expected] of grounds) {
    model.setGround(ground);
    const call = recording.calls.at(-1);
    assert.equal(call[0], "setGround");
    assert.deepEqual(call.slice(2), expected);
  }

  model.clearLoads();
  assert.equal(recording.calls.at(-1)[0], "clearLoads");
  model.dispose();
  assert.equal(recording.wasDeleted(), true);
});

test("every stable native status becomes its public typed error", () => {
  const recording = createRecordingModule();
  const model = createConfigurableModel(recording);
  const load = {
    kind: "impedance",
    target: { tag: 1 },
    resistanceOhm: 1,
    reactanceOhm: 0,
  };
  const mappings = [
    [1, NecStateError, "NEC_STATE"],
    [2, NecInputError, "NEC_INPUT"],
    [3, NecGeometryError, "NEC_GEOMETRY"],
    [4, NecPortError, "NEC_PORT"],
    [5, NecConditioningError, "NEC_CONDITIONING"],
    [6, NecSolverError, "NEC_SOLVER"],
    [7, NecRuntimeError, "NEC_RUNTIME"],
  ];

  for (const [status, ErrorClass, code] of mappings) {
    recording.setNextStatus(status);
    assert.throws(
      () => model.addLoad(load),
      (error) =>
        error instanceof ErrorClass
        && error.code === code
        && error.message === "controlled native failure",
    );
  }
  model.dispose();
});
