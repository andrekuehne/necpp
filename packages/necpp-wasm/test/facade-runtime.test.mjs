import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import test from "node:test";

import {
  NecInputError,
  NecStateError,
  abiVersion,
  createNecModel,
  engineVersion,
  packageVersion,
  runDeck,
} from "../.test-build/src/index.js";

const generatedLoader = new URL(
  "../.test-build/src/nec2pp.generated.js",
  import.meta.url,
);
const wasmUrl = new URL("../.test-build/src/nec2pp.wasm", import.meta.url);
const hasWasm = existsSync(generatedLoader) && existsSync(wasmUrl);

const validDeck = `CM TYPESCRIPT FACADE TEST
CE
GW 1 11 0.0 0.0 -0.25 0.0 0.0 0.25 0.001
GE 0
FR 0 1 0 0 300.0
EX 0 1 6 0 1.0 0.0
XQ
EN
`;

function addDipole(model) {
  model.addWire({
    tag: 1,
    segments: 11,
    start: [0, 0, -0.25],
    end: [0, 0, 0.25],
    radiusM: 0.001,
  });
  model.completeGeometry();
  const port = { tag: 1, segment: 6, name: "feed" };
  model.definePorts([port]);
  port.name = "mutated";
  model.addLoad({
    kind: "impedance",
    target: { tag: 1, firstSegment: 1 },
    resistanceOhm: 1,
    reactanceOhm: 0,
  });
  model.clearLoads();
  model.setGround({ kind: "free-space" });
  model.prepare({ frequencyMHz: 300 });
}

test("package, engine, and ABI versions are exported", () => {
  assert.equal(packageVersion, "0.3.0");
  assert.equal(engineVersion, "2.5.0");
  assert.equal(abiVersion, 1);
});

test("loading options reject ambiguous input before module loading", async () => {
  await assert.rejects(
    createNecModel({
      wasmUrl,
      wasmBinary: new Uint8Array([0]),
    }),
    (error) => error instanceof NecInputError && error.code === "NEC_INPUT",
  );
});

test("runDeck honors a pre-start abort without loading WASM", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runDeck(validDeck, { signal: controller.signal }),
    (error) => error instanceof NecInputError && error.code === "NEC_INPUT",
  );
});

test("runDeck validates text before loading WASM", async () => {
  await assert.rejects(
    runDeck(""),
    (error) => error instanceof NecInputError && error.code === "NEC_INPUT",
  );
  await assert.rejects(
    runDeck("CE\0EN\n"),
    (error) => error instanceof NecInputError && error.code === "NEC_INPUT",
  );
});

test("the facade performs a complete stateful solve with owned results", {
  skip: !hasWasm && "WASM artifacts have not been built",
}, async () => {
  const model = await createNecModel();
  assert.equal(model.state, "empty");
  addDipole(model);
  assert.equal(model.state, "prepared");

  const matrices = model.computeImpedanceMatrix();
  assert.equal(matrices.impedance.order, "row-major");
  assert.equal(matrices.impedance.real.length, 1);
  assert.ok(Number.isFinite(matrices.impedance.real[0]));
  assert.ok(Number.isFinite(matrices.impedance.imag[0]));
  assert.ok(matrices.impedance.real[0] > 0);

  const first = model.solveVoltages({
    real: new Float64Array([1]),
    imag: new Float64Array([0]),
  });
  assert.equal(model.state, "solved");
  assert.equal(first.drive, "voltage");
  assert.equal(first.ports[0].name, "feed");
  assert.equal(Object.isFrozen(first.powerBudget), true);
  assert.ok(Number.isFinite(first.powerBudget.inputPowerW));
  assert.ok(Math.abs(first.powerBudget.inputPowerW - first.powersW[0]) <= 1e-12);
  assert.equal(first.powerBudget.structureLossW, 0);
  assert.equal(first.powerBudget.networkLossW, 0);
  assert.ok(Math.abs(
    first.powerBudget.inputPowerW - first.powerBudget.radiatedPowerW,
  ) <= 1e-12);
  const retainedCurrent = [
    first.currents.real[0],
    first.currents.imag[0],
  ];

  const second = model.solveVoltages({
    real: new Float64Array([0.5]),
    imag: new Float64Array([0.25]),
  });
  assert.equal(second.solveGeneration, first.solveGeneration + 1);
  assert.deepEqual(
    [first.currents.real[0], first.currents.imag[0]],
    retainedCurrent,
    "an earlier solution must not alias native result memory",
  );

  const currentDriven = model.solveCurrents({
    real: new Float64Array([0.01]),
    imag: new Float64Array([0]),
  });
  assert.equal(currentDriven.drive, "current");
  assert.equal(currentDriven.requested.real[0], 0.01);
  assert.ok(Number.isFinite(currentDriven.voltages.real[0]));

  const field = model.computeFarField({
    theta: { startDeg: 0, count: 3, stepDeg: 45 },
    phi: { startDeg: 0, count: 2, stepDeg: 90 },
  });
  assert.equal(field.radiusM, 1);
  assert.equal(field.thetaDeg.length, 3);
  assert.equal(field.phiDeg.length, 2);
  assert.equal(field.eThetaReal.length, 6);
  assert.ok(field.eThetaReal.every(Number.isFinite));
  assert.equal(typeof field.diagnostics.instrumentationEnabled, "boolean");
  assert.equal(field.diagnostics.counts.evaluatedDirections, 6);
  assert.equal(field.diagnostics.counts.segments, 11);
  assert.equal(field.diagnostics.counts.groundImages, 1);
  assert.equal(field.diagnostics.counts.segmentDirectionContributions, 66);
  assert.equal(field.diagnostics.counts.outputBufferAllocations, 4);
  assert.equal(field.diagnostics.counts.intermediateBufferAllocations, 0);
  assert.equal(field.diagnostics.counts.complexSampleCopies, 0);
  if (field.diagnostics.instrumentationEnabled) {
    assert.ok(field.diagnostics.native.rawAccumulationMs >= 0);
    assert.ok(field.diagnostics.native.derivedRpWorkMs >= 0);
    assert.ok(field.diagnostics.native.nativeAbiTotalMs <= field.diagnostics.wasmCallMs);
  } else {
    assert.equal(field.diagnostics.native.rawAccumulationMs, 0);
    assert.equal(field.diagnostics.native.derivedRpWorkMs, 0);
    assert.equal(field.diagnostics.native.nativeAbiTotalMs, 0);
  }
  assert.ok(field.diagnostics.typescriptExtractionMs <= field.diagnostics.packageTotalMs);
  const retainedField = field.eThetaReal.slice();

  const embedded = model.computeEmbeddedFarFields({
    radiusM: 1,
    theta: { startDeg: 90, count: 1, stepDeg: 0 },
    phi: { startDeg: 0, count: 1, stepDeg: 0 },
  });
  assert.equal(embedded.normalization.kind, "unit-voltage");
  assert.equal(embedded.samplesPerPort, 1);
  assert.equal(embedded.eThetaReal.length, 1);

  const currentEmbedded = model.computeEmbeddedFarFields({
    radiusM: 1,
    theta: { startDeg: 90, count: 1, stepDeg: 0 },
    phi: { startDeg: 0, count: 1, stepDeg: 0 },
  }, { kind: "unit-current", valueA: 1 });
  assert.equal(currentEmbedded.normalization.kind, "unit-current");
  assert.equal(currentEmbedded.eThetaReal.length, 1);

  const zero = model.solveCurrents({
    real: new Float64Array([0]),
    imag: new Float64Array([0]),
  });
  assert.deepEqual(zero.powerBudget, {
    inputPowerW: 0,
    radiatedPowerW: 0,
    structureLossW: 0,
    networkLossW: 0,
    efficiencyPercent: null,
  });

  assert.throws(
    () => model.solveVoltages({
      real: new Float64Array(0),
      imag: new Float64Array(0),
    }),
    NecInputError,
  );

  model.dispose();
  model.dispose();
  assert.equal(model.state, "disposed");
  assert.deepEqual(field.eThetaReal, retainedField);
  assert.throws(() => model.prepare({ frequencyMHz: 300 }), NecStateError);
});

test("default, explicit URL, and binary WASM loading behave alike", {
  skip: !hasWasm && "WASM artifacts have not been built",
}, async () => {
  const urlModel = await createNecModel({ wasmUrl });
  assert.equal(urlModel.state, "empty");
  urlModel.dispose();

  const bytes = readFileSync(wasmUrl);
  const binaryModel = await createNecModel({ wasmBinary: bytes });
  assert.equal(binaryModel.state, "empty");
  binaryModel.dispose();
});

test("http wasmUrl downloads bytes for a CDN-style origin", {
  skip: !hasWasm && "WASM artifacts have not been built",
}, async () => {
  const bytes = readFileSync(wasmUrl);
  const server = createServer((request, response) => {
    response.writeHead(200, {
      "Content-Type": "application/wasm",
      "Content-Length": bytes.length,
    });
    response.end(bytes);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  try {
    const model = await createNecModel({
      wasmUrl: `http://127.0.0.1:${address.port}/nec2pp.wasm`,
    });
    assert.equal(model.state, "empty");
    model.dispose();
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
});

test("runDeck returns an owned report and engine version", {
  skip: !hasWasm && "WASM artifacts have not been built",
}, async () => {
  const result = await runDeck(validDeck);
  assert.match(result.report, /TYPESCRIPT FACADE TEST/);
  assert.match(result.report, /ANTENNA INPUT PARAMETERS/);
  assert.ok(result.engineVersion.length > 0);

  await assert.rejects(
    runDeck("CE INVALID INPUT\nBOGUS\nEN\n"),
    (error) => error instanceof NecInputError && error.code === "NEC_INPUT",
  );
});
