import assert from "node:assert/strict";
import { MessageChannel } from "node:worker_threads";
import test from "node:test";

import {
  NecInputError,
  NecRuntimeError,
  NecStateError,
} from "../.test-build/src/errors.js";
import {
  collectTransferables,
  reviveCurrentDistribution,
  reviveError,
  reviveIsolatedElementCharacterization,
  reviveIsolatedElementHandoff,
  revivePortSolution,
  revivePreparedTransferHandle,
  serializeCreateOptions,
  serializeError,
} from "../.test-build/src/worker-protocol.js";

function portSolution(powerBudget) {
  return {
    drive: "voltage",
    frequencyMHz: 300,
    ports: [{ tag: 1, segment: 6 }],
    requested: { real: Float64Array.of(1), imag: Float64Array.of(0) },
    voltages: { real: Float64Array.of(1), imag: Float64Array.of(0) },
    currents: { real: Float64Array.of(0.01), imag: Float64Array.of(0) },
    activeImpedances: { real: Float64Array.of(100), imag: Float64Array.of(0) },
    powersW: Float64Array.of(0.005),
    powerBudget,
    factorizationGeneration: 1,
    solveGeneration: 1,
  };
}

test("collectTransferables gathers unique typed-array buffers", () => {
  const real = new Float64Array([1, 2, 3]);
  const imag = new Float64Array([4, 5, 6]);
  const shared = new Float64Array([7]);
  const result = {
    impedance: { real, imag },
    extra: shared,
    again: shared,
  };
  const buffers = collectTransferables(result);
  assert.equal(buffers.length, 3);
  assert.ok(buffers.includes(real.buffer));
  assert.ok(buffers.includes(imag.buffer));
  assert.ok(buffers.includes(shared.buffer));
});

test("transferred result buffers are detached rather than duplicated", async () => {
  const field = {
    eThetaReal: new Float64Array(1_024).fill(3.5),
    eThetaImag: new Float64Array(1_024).fill(-1.25),
  };
  const original = field.eThetaReal[0];
  const transfer = collectTransferables(field);
  assert.equal(transfer.length, 2);

  const { port1, port2 } = new MessageChannel();
  const received = new Promise((resolve) => {
    port2.once("message", resolve);
  });
  port1.postMessage(field, transfer);
  const copy = await received;
  port1.close();
  port2.close();

  assert.equal(copy.eThetaReal[0], original);
  assert.equal(copy.eThetaImag[0], -1.25);
  assert.equal(field.eThetaReal.buffer.byteLength, 0);
  assert.equal(field.eThetaImag.buffer.byteLength, 0);
});

test("worker port solutions validate and freeze the complete power budget", () => {
  const budget = {
    inputPowerW: 0.005,
    radiatedPowerW: 0.004,
    structureLossW: 0.001,
    networkLossW: 0,
    efficiencyPercent: 80,
  };
  const revived = revivePortSolution(portSolution(budget));
  assert.deepEqual(revived.powerBudget, budget);
  assert.equal(Object.isFrozen(revived.powerBudget), true);

  for (const field of [
    "inputPowerW",
    "radiatedPowerW",
    "structureLossW",
    "networkLossW",
  ]) {
    assert.throws(
      () => revivePortSolution(portSolution({ ...budget, [field]: Number.NaN })),
      NecRuntimeError,
    );
  }
  assert.throws(
    () => revivePortSolution(portSolution({ ...budget, efficiencyPercent: Infinity })),
    NecRuntimeError,
  );
  assert.equal(
    revivePortSolution(portSolution({
      inputPowerW: 0,
      radiatedPowerW: 0,
      structureLossW: 0,
      networkLossW: 0,
      efficiencyPercent: null,
    })).powerBudget.efficiencyPercent,
    null,
  );
});

test("typed errors round-trip through the worker protocol", () => {
  const state = reviveError(serializeError(
    new NecStateError("prepare", "empty"),
  ));
  assert.ok(state instanceof NecStateError);
  assert.equal(state.code, "NEC_STATE");
  assert.equal(state.operation, "prepare");
  assert.equal(state.state, "empty");

  const runtime = reviveError(serializeError(new Error("boom")));
  assert.ok(runtime instanceof NecRuntimeError);
  assert.equal(runtime.message, "boom");
});

test("create options copy wasm bytes and reject invalid overrides", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const serialized = serializeCreateOptions({ wasmBinary: bytes });
  assert.ok(serialized.payload.wasmBinary instanceof ArrayBuffer);
  assert.equal(serialized.transfer.length, 1);
  bytes[0] = 9;
  assert.equal(new Uint8Array(serialized.payload.wasmBinary)[0], 1);

  assert.throws(
    () => serializeCreateOptions({
      wasmUrl: "https://example.test/nec2pp.wasm",
      wasmBinary: bytes,
    }),
    NecInputError,
  );
  assert.throws(
    () => serializeCreateOptions({ wasmBinary: "not WASM" }),
    NecInputError,
  );
});

test("characterization handles transfer to a MessagePort without cloning large buffers", async () => {
  const { transferIsolatedElementCharacterization } = await import(
    "../.test-build/src/handoff.js"
  );
  const quadrature = new ArrayBuffer(64);
  new Uint8Array(quadrature).set([0x4e, 0x45, 0x43, 0x51]);
  const embedded = new ArrayBuffer(64);
  new Uint8Array(embedded).set([0x4e, 0x45, 0x43, 0x46]);
  const characterization = {
    impedance: {
      rows: 1,
      columns: 1,
      order: "row-major",
      real: Float64Array.of(50),
      imag: Float64Array.of(0),
    },
    admittance: {
      rows: 1,
      columns: 1,
      order: "row-major",
      real: Float64Array.of(0.02),
      imag: Float64Array.of(0),
    },
    quadrature: { schemaVersion: 1, byteLength: 64, buffer: quadrature },
    embeddedField: { schemaVersion: 1, byteLength: 64, buffer: embedded },
  };

  const collected = collectTransferables(characterization);
  assert.equal(collected.length, 6);
  assert.ok(collected.includes(quadrature));
  assert.ok(collected.includes(embedded));

  const revivedHandle = revivePreparedTransferHandle({
    schemaVersion: 1,
    byteLength: 64,
    buffer: new Uint8Array(quadrature).slice().buffer,
  });
  assert.equal(revivedHandle.byteLength, 64);
  const revivedCharacterization = reviveIsolatedElementCharacterization({
    ...characterization,
    quadrature: {
      schemaVersion: 1,
      byteLength: 64,
      buffer: new Uint8Array(quadrature).slice().buffer,
    },
    embeddedField: {
      schemaVersion: 1,
      byteLength: 64,
      buffer: new Uint8Array(embedded).slice().buffer,
    },
  });
  assert.equal(revivedCharacterization.quadrature.byteLength, 64);
  const revivedHandoff = reviveIsolatedElementHandoff({
    impedance: characterization.impedance,
    admittance: characterization.admittance,
    quadratureByteLength: 64,
    embeddedFieldByteLength: 64,
  });
  assert.equal(revivedHandoff.quadratureByteLength, 64);
  reviveCurrentDistribution({
    schemaVersion: 1,
    frequencyMHz: 300,
    wavelengthM: 1,
    modeKind: "unit-current",
    modeCount: 1,
    segments: [{ tag: 1, segment: 6, nativeIndex: 5 }],
    startEnds: [{ kind: "free" }],
    endEnds: [{ kind: "free" }],
    centresM: new Float64Array(3),
    startsM: new Float64Array(3),
    endsM: new Float64Array(3),
    tangents: new Float64Array([0, 0, 1]),
    radiiM: new Float64Array([0.001]),
    lengthsM: new Float64Array([1]),
    aReal: new Float64Array(1),
    aImag: new Float64Array(1),
    bReal: new Float64Array(1),
    bImag: new Float64Array(1),
    cReal: new Float64Array(1),
    cImag: new Float64Array(1),
  });

  const { port1, port2 } = new MessageChannel();
  const received = new Promise((resolve) => {
    port2.once("message", resolve);
  });
  const handoff = transferIsolatedElementCharacterization(characterization, port1);
  const message = await received;
  port1.close();
  port2.close();

  assert.equal(handoff.quadratureByteLength, 64);
  assert.equal(handoff.embeddedFieldByteLength, 64);
  assert.equal(handoff.impedance.real[0], 50);
  assert.equal(message.kind, "isolated-element-characterization");
  assert.equal(new Uint8Array(message.quadrature.buffer)[0], 0x4e);
  assert.equal(new Uint8Array(message.embeddedField.buffer)[3], 0x46);
  assert.equal(characterization.quadrature.buffer.byteLength, 0);
  assert.equal(characterization.embeddedField.buffer.byteLength, 0);
  assert.equal(characterization.impedance.real[0], 50);

  assert.throws(
    () => transferIsolatedElementCharacterization(characterization, {
      postMessage() {},
    }),
    (error) => error instanceof NecInputError,
  );
});
