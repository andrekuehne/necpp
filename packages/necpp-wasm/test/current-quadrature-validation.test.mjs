import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { MessageChannel } from "node:worker_threads";

import { createNecModel } from "../.test-build/src/index.js";
import { createNecWorkerModel } from "../.test-build/src/worker.js";
import {
  applyCurrentQuadratureFixture,
  currentQuadratureFieldGrid,
  currentQuadratureFixtures,
} from "./fixtures/current-quadrature.mjs";
import {
  complexRelativeError,
  relativeError,
  viewEmbeddedField,
  viewPreparedQuadrature,
} from "./fixtures/current-quadrature-packed.mjs";
import {
  buildCurrentQuadratureFixtures,
} from "../scripts/write-current-quadrature-fixtures.mjs";

const generatedLoader = new URL(
  "../.test-build/src/nec2pp.generated.js",
  import.meta.url,
);
const wasmUrl = new URL("../.test-build/src/nec2pp.wasm", import.meta.url);
const hasWasm = existsSync(generatedLoader) && existsSync(wasmUrl);
const skip = !hasWasm && "WASM artifacts have not been built";
const hasWp4Abi = hasWasm
  && readFileSync(generatedLoader, "utf8").includes(
    "_necpp_wasm_v1_get_current_distribution",
  );
const skipWp4 = skip
  || (!hasWp4Abi && "WASM artifacts have not been rebuilt with WP4 ABI exports");

const unitCurrentTolerance = 1e-7;
const samePathTolerance = 1e-12;
const embeddedTolerance = 1e-7;

const fourNodeQuadrature = Object.freeze({
  nodes: Float64Array.of(-1, -1 / 3, 1 / 3, 1),
  images: "physical-only",
  modes: "unit-current",
});

const characterizationRequest = Object.freeze({
  quadrature: fourNodeQuadrature,
  field: currentQuadratureFieldGrid,
});

const fixtureRoot = dirname(fileURLToPath(new URL(
  "../fixtures/current-quadrature-v1/manifest.json",
  import.meta.url,
)));

function sha256(buffer) {
  return createHash("sha256").update(new Uint8Array(buffer)).digest("hex");
}

function loadNamedBuffer(name) {
  const bytes = readFileSync(join(fixtureRoot, name));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

const manifest = JSON.parse(
  readFileSync(join(fixtureRoot, "manifest.json"), "utf8"),
);

async function withModel(factory, fixture, body) {
  const model = await factory();
  try {
    await applyCurrentQuadratureFixture(model, fixture);
    await body(model);
  } finally {
    await Promise.resolve(model.dispose());
  }
}

function superposePlane(necf, real, imag, weights) {
  const combinedReal = new Float64Array(necf.samplesPerPort);
  const combinedImag = new Float64Array(necf.samplesPerPort);
  for (let port = 0; port < weights.length; port += 1) {
    const weight = weights[port];
    for (let sample = 0; sample < necf.samplesPerPort; sample += 1) {
      const index = port * necf.samplesPerPort + sample;
      const er = real[index];
      const ei = imag[index];
      combinedReal[sample] += weight.re * er - weight.im * ei;
      combinedImag[sample] += weight.re * ei + weight.im * er;
    }
  }
  return { real: combinedReal, imag: combinedImag };
}

test("WP5 published fixtures match on-disk checksums and representative samples",
  async () => {
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.fixtureSchema, "current-quadrature-v1");
    assert.equal(manifest.abiVersion, 1);
    for (const item of manifest.cases) {
      const necqBytes = loadNamedBuffer(item.quadraturePacked.file);
      assert.equal(sha256(necqBytes), item.quadraturePacked.sha256);
      assert.equal(necqBytes.byteLength, item.quadraturePacked.byteLength);
      const necq = viewPreparedQuadrature(necqBytes);
      assert.equal(necq.nSegments, item.quadraturePacked.nSegments);
      assert.equal(necq.nModes, item.quadraturePacked.nModes);
      const feed = item.samples.quadratureFeedSample;
      const currentIndex = necq.currentIndex(
        feed.mode, feed.plane, feed.segmentIndex, feed.node,
      );
      assert.ok(Math.abs(necq.iReal[currentIndex] - feed.current.re) < 1e-15);
      assert.ok(Math.abs(necq.iImag[currentIndex] - feed.current.im) < 1e-15);
      if (item.embeddedPacked !== undefined) {
        const necfBytes = loadNamedBuffer(item.embeddedPacked.file);
        assert.equal(sha256(necfBytes), item.embeddedPacked.sha256);
        const necf = viewEmbeddedField(necfBytes);
        const sample = item.samples.fieldSample;
        const index = necf.sampleIndex(sample.port, sample.thetaIndex, sample.phiIndex);
        assert.ok(Math.abs(necf.eThetaReal[index] - sample.eTheta.re) < 1e-15);
        assert.ok(Math.abs(necf.eThetaImag[index] - sample.eTheta.im) < 1e-15);
      }
    }
  });

test("WP5 regenerated fixtures do not drift from published goldens",
  { skip: skipWp4 }, async () => {
    const bundle = await buildCurrentQuadratureFixtures(createNecModel, {
      abiVersion: manifest.abiVersion,
      engineVersion: manifest.engineVersion,
      packageVersion: manifest.packageVersion,
    });
    for (const [name, buffer] of Object.entries(bundle.files)) {
      const expected = manifest.cases
        .flatMap((item) => [
          item.quadraturePacked,
          item.embeddedPacked,
        ].filter(Boolean))
        .find((packed) => packed.file === name);
      assert.ok(expected, `missing manifest entry for ${name}`);
      assert.equal(sha256(buffer), expected.sha256, name);
    }
  });

test("WP5 direct and worker characterization agree for every fixture",
  { skip: skipWp4 }, async (t) => {
    for (const fixture of Object.values(currentQuadratureFixtures)) {
      await t.test(fixture.id, async () => {
        let direct;
        await withModel(createNecModel, fixture, async (model) => {
          direct = model.characterizeIsolatedElement(characterizationRequest);
        });
        await withModel(createNecWorkerModel, fixture, async (model) => {
          const worker = await model.characterizeIsolatedElement(
            characterizationRequest,
          );
          assert.deepEqual(
            new Uint8Array(worker.quadrature.buffer),
            new Uint8Array(direct.quadrature.buffer),
          );
          assert.deepEqual(
            new Uint8Array(worker.embeddedField.buffer),
            new Uint8Array(direct.embeddedField.buffer),
          );
          assert.ok(
            complexRelativeError(direct.impedance, worker.impedance)
              < samePathTolerance,
          );
        });
      });
    }
  });

test("WP5 characterization NECF matches computeEmbeddedFarFields on a second model",
  { skip: skipWp4 }, async (t) => {
    for (const fixture of Object.values(currentQuadratureFixtures)) {
      await t.test(fixture.id, async () => {
        let packed;
        await withModel(createNecModel, fixture, async (model) => {
          packed = model.characterizeIsolatedElement(characterizationRequest)
            .embeddedField.buffer;
        });
        await withModel(createNecModel, fixture, async (model) => {
          const embedded = model.computeEmbeddedFarFields(
            currentQuadratureFieldGrid,
            { kind: "unit-current", valueA: 1 },
          );
          const necf = viewEmbeddedField(packed);
          assert.equal(necf.nPorts, embedded.ports.length);
          assert.equal(necf.samplesPerPort, embedded.samplesPerPort);
          assert.ok(relativeError(necf.eThetaReal, embedded.eThetaReal)
            < embeddedTolerance);
          assert.ok(relativeError(necf.eThetaImag, embedded.eThetaImag)
            < embeddedTolerance);
          assert.ok(relativeError(necf.ePhiReal, embedded.ePhiReal)
            < embeddedTolerance);
          assert.ok(relativeError(necf.ePhiImag, embedded.ePhiImag)
            < embeddedTolerance);
        });
      });
    }
  });

test("WP5 worker handoff transfers each fixture once",
  { skip: skipWp4 }, async (t) => {
    for (const fixture of Object.values(currentQuadratureFixtures)) {
      await t.test(fixture.id, async () => {
        const model = await createNecWorkerModel();
        const { port1, port2 } = new MessageChannel();
        const received = new Promise((resolve, reject) => {
          port2.once("message", resolve);
          port2.once("messageerror", reject);
        });
        try {
          await applyCurrentQuadratureFixture(model, fixture);
          const handoff = await model.characterizeIsolatedElement(
            characterizationRequest,
            { destination: port1 },
          );
          assert.equal("quadrature" in handoff, false);
          assert.equal("embeddedField" in handoff, false);
          const message = await received;
          assert.equal(message.kind, "isolated-element-characterization");
          assert.equal(
            message.quadrature.byteLength,
            handoff.quadratureByteLength,
          );
          viewPreparedQuadrature(message.quadrature.buffer);
          viewEmbeddedField(message.embeddedField.buffer);
        } finally {
          port1.close();
          port2.close();
          await model.dispose();
        }
      });
    }
  });

test("WP5 insulated turnstile superposition uses NEC embedded fields",
  { skip: skipWp4 }, async () => {
    const fixture = currentQuadratureFixtures["turnstile-insulated"];
    await withModel(createNecModel, fixture, async (model) => {
      const characterized = model.characterizeIsolatedElement(
        characterizationRequest,
      );
      const z01 = Math.hypot(
        characterized.impedance.real[1],
        characterized.impedance.imag[1],
      );
      const z00 = Math.hypot(
        characterized.impedance.real[0],
        characterized.impedance.imag[0],
      );
      assert.ok(z01 < 1e-6 * z00);
      const necf = viewEmbeddedField(characterized.embeddedField.buffer);
      const drive = [{ re: 1, im: 0 }, { re: 0, im: 1 }];
      const combinedTheta = superposePlane(
        necf, necf.eThetaReal, necf.eThetaImag, drive,
      );
      const combinedPhi = superposePlane(
        necf, necf.ePhiReal, necf.ePhiImag, drive,
      );
      const solved = model.solveCurrents({
        real: Float64Array.of(1, 0),
        imag: Float64Array.of(0, 1),
      });
      assert.ok(complexRelativeError(
        solved.currents,
        { real: Float64Array.of(1, 0), imag: Float64Array.of(0, 1) },
      ) < unitCurrentTolerance);
      const field = model.computeFarField(currentQuadratureFieldGrid);
      assert.ok(complexRelativeError(combinedTheta, {
        real: field.eThetaReal,
        imag: field.eThetaImag,
      }) < embeddedTolerance);
      assert.ok(complexRelativeError(combinedPhi, {
        real: field.ePhiReal,
        imag: field.ePhiImag,
      }) < embeddedTolerance);
    });
  });

test("WP6 repeated packed retrieve does not grow heap by packed size",
  { skip: skipWp4 }, async () => {
    await withModel(createNecModel, currentQuadratureFixtures.dipole, async (model) => {
      model.computeImpedanceMatrix();
      const characterized = model.characterizeIsolatedElement(characterizationRequest);
      const packedBytes = characterized.quadrature.byteLength
        + characterized.embeddedField.byteLength;
      const before = process.memoryUsage().heapUsed;
      let sink = 0;
      for (let pass = 0; pass < 1000; pass += 1) {
        sink += characterized.quadrature.byteLength;
        sink += characterized.embeddedField.byteLength;
        sink += new Uint8Array(characterized.quadrature.buffer, 0, 4)[0];
        sink += new Uint8Array(characterized.embeddedField.buffer, 0, 4)[0];
      }
      const after = process.memoryUsage().heapUsed;
      assert.equal(sink > 0, true);
      assert.equal(characterized.quadrature.byteLength, 4072);
      assert.equal(characterized.embeddedField.byteLength, 608);
      assert.ok(
        after - before < 50 * packedBytes,
        `heap grew by ${after - before} bytes over 1000 retrieves of ${packedBytes} B`,
      );
    });
  });
