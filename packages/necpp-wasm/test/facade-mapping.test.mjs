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
  let symmetryKind = -1;
  let sectionCount = 0;
  let fundamentalSegmentCount = 0n;
  let fullSegmentCount = 0n;
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
        const status = complete("completeGeometry", args, 2);
        if (status === 0) {
          symmetryKind = 0;
          sectionCount = 1;
          fundamentalSegmentCount = 3n;
          fullSegmentCount = 3n;
        }
        return status;
      },
      _necpp_wasm_v1_complete_geometry_symmetric(...args) {
        const status = complete("completeGeometrySymmetric", args, 2);
        if (status === 0) {
          symmetryKind = args[2];
          sectionCount = args[2] === 1
            ? 2 ** [1, 2, 4].filter((bit) => (args[3] & bit) !== 0).length
            : args[3];
          fundamentalSegmentCount = 3n;
          fullSegmentCount = 3n * BigInt(sectionCount);
        }
        return status;
      },
      _necpp_wasm_v1_geometry_symmetry_kind() {
        return symmetryKind;
      },
      _necpp_wasm_v1_geometry_section_count() {
        return sectionCount;
      },
      _necpp_wasm_v1_geometry_fundamental_segment_count() {
        return fundamentalSegmentCount;
      },
      _necpp_wasm_v1_geometry_full_segment_count() {
        return fullSegmentCount;
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

function symmetryModel(recording) {
  const model = new WasmNecModel(recording.module, 1);
  model.addWire({
    tag: 1,
    segments: 3,
    start: [0.25, 0.5, 0.75],
    end: [0.25, 0.5, 1.25],
    radiusM: 0.001,
  });
  return model;
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

test("reflection and rotation map every ABI argument and return frozen copy metadata", () => {
  const reflectionRecording = createRecordingModule();
  const reflectionModel = symmetryModel(reflectionRecording);
  const reflection = reflectionModel.completeGeometry({
    groundConnection: "none",
    symmetry: {
      kind: "reflection",
      planes: ["x=0", "z=0", "y=0"],
      tagIncrement: 2,
    },
  });
  assert.deepEqual(
    reflectionRecording.calls.find(([name]) => name === "completeGeometrySymmetric"),
    ["completeGeometrySymmetric", 1, 0, 1, 7, 2],
  );
  assert.deepEqual(reflection, {
    symmetry: {
      kind: "reflection",
      sectionCount: 8,
      fundamentalSegmentCount: 3,
      fullSegmentCount: 24,
      copies: [
        { index: 0, tagOffset: 0, transform: { kind: "cartesian-signs", signs: [1, 1, 1] } },
        { index: 1, tagOffset: 2, transform: { kind: "cartesian-signs", signs: [1, 1, -1] } },
        { index: 2, tagOffset: 4, transform: { kind: "cartesian-signs", signs: [1, -1, 1] } },
        { index: 3, tagOffset: 6, transform: { kind: "cartesian-signs", signs: [1, -1, -1] } },
        { index: 4, tagOffset: 8, transform: { kind: "cartesian-signs", signs: [-1, 1, 1] } },
        { index: 5, tagOffset: 10, transform: { kind: "cartesian-signs", signs: [-1, 1, -1] } },
        { index: 6, tagOffset: 12, transform: { kind: "cartesian-signs", signs: [-1, -1, 1] } },
        { index: 7, tagOffset: 14, transform: { kind: "cartesian-signs", signs: [-1, -1, -1] } },
      ],
    },
  });
  assert.ok(Object.isFrozen(reflection));
  assert.ok(Object.isFrozen(reflection.symmetry));
  assert.ok(Object.isFrozen(reflection.symmetry.copies));
  assert.ok(Object.isFrozen(reflection.symmetry.copies[0].transform));
  assert.ok(Object.isFrozen(reflection.symmetry.copies[0].transform.signs));

  const rotationRecording = createRecordingModule();
  const rotationModel = symmetryModel(rotationRecording);
  const rotation = rotationModel.completeGeometry({
    groundConnection: "interpolate",
    symmetry: {
      kind: "rotational",
      axis: "z",
      order: 4,
      tagIncrement: 3,
    },
  });
  assert.deepEqual(
    rotationRecording.calls.find(([name]) => name === "completeGeometrySymmetric"),
    ["completeGeometrySymmetric", 1, 1, 2, 4, 3],
  );
  assert.deepEqual(
    rotation.symmetry.copies.map((copy) => copy.transform),
    [
      { kind: "rotate-z", angleDeg: 0 },
      { kind: "rotate-z", angleDeg: 90 },
      { kind: "rotate-z", angleDeg: 180 },
      { kind: "rotate-z", angleDeg: 270 },
    ],
  );
});

test("invalid symmetry descriptors fail before native mutation with typed details", () => {
  const invalid = [
    { kind: "reflection", planes: [], tagIncrement: 1 },
    { kind: "reflection", planes: ["x=0", "x=0"], tagIncrement: 1 },
    { kind: "reflection", planes: ["x=y"], tagIncrement: 1 },
    { kind: "reflection", planes: ["x=0"], tagIncrement: 0 },
    { kind: "reflection", planes: ["x=0"], tagIncrement: Number.MAX_SAFE_INTEGER },
    { kind: "reflection", planes: ["x=0"], tagIncrement: 2_147_483_647 },
    { kind: "rotational", axis: "x", order: 4, tagIncrement: 1 },
    { kind: "rotational", axis: "z", order: 1, tagIncrement: 1 },
    { kind: "rotational", axis: "z", order: 2.5, tagIncrement: 1 },
    { kind: "rotational", axis: "z", order: Number.MAX_SAFE_INTEGER, tagIncrement: 1 },
    { kind: "reflection", planes: ["x=0"], order: 2, tagIncrement: 1 },
    { kind: "rotational", axis: "z", order: 2, planes: ["x=0"], tagIncrement: 1 },
  ];
  for (const symmetry of invalid) {
    const recording = createRecordingModule();
    const model = symmetryModel(recording);
    assert.throws(
      () => model.completeGeometry({ symmetry }),
      (error) => error instanceof NecInputError
        && error.code === "NEC_INPUT"
        && error.details?.symmetryFailure === "INVALID_SYMMETRY",
    );
    assert.equal(model.state, "geometry-building");
    assert.equal(
      recording.calls.some(([name]) => name === "completeGeometrySymmetric"),
      false,
    );
  }
});

test("z reflection rejects ground without mutating geometry", () => {
  const recording = createRecordingModule();
  const model = symmetryModel(recording);
  assert.throws(
    () => model.completeGeometry({
      groundConnection: "zero-current",
      symmetry: { kind: "reflection", planes: ["z=0"], tagIncrement: 1 },
    }),
    (error) => error instanceof NecGeometryError
      && error.details?.symmetryFailure === "INCOMPATIBLE_GROUND",
  );
  assert.equal(model.state, "geometry-building");
});

test("signed 64-bit segment counts never narrow to unsafe public numbers", () => {
  const recording = createRecordingModule();
  recording.module._necpp_wasm_v1_geometry_fundamental_segment_count = () =>
    BigInt(Number.MAX_SAFE_INTEGER) + 1n;
  recording.module._necpp_wasm_v1_geometry_full_segment_count = () =>
    2n * (BigInt(Number.MAX_SAFE_INTEGER) + 1n);
  const model = symmetryModel(recording);
  assert.throws(
    () => model.completeGeometry({
      symmetry: { kind: "reflection", planes: ["x=0"], tagIncrement: 1 },
    }),
    (error) => error instanceof NecRuntimeError
      && error.message.includes("safe integer range"),
  );
});

test("z-reflected completion rejects a later non-free-space ground", () => {
  const recording = createRecordingModule();
  const model = symmetryModel(recording);
  model.completeGeometry({
    symmetry: { kind: "reflection", planes: ["z=0"], tagIncrement: 1 },
  });
  assert.throws(
    () => model.setGround({ kind: "perfect" }),
    (error) => error instanceof NecGeometryError
      && error.details?.symmetryFailure === "INCOMPATIBLE_GROUND",
  );
  assert.equal(
    recording.calls.some(([name]) => name === "setGround"),
    false,
  );
  model.setGround({ kind: "free-space" });
  assert.equal(recording.calls.at(-1)[0], "setGround");
});
