import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { MessageChannel } from "node:worker_threads";

import { createNecWorkerModel } from "../.test-build/src/worker.js";
import {
  applyCurrentQuadratureFixture,
  currentQuadratureFieldGrid,
  currentQuadratureFixtures,
} from "./fixtures/current-quadrature.mjs";

const generatedLoader = new URL(
  "../.test-build/src/nec2pp.generated.js",
  import.meta.url,
);
const wasmUrl = new URL("../.test-build/src/nec2pp.wasm", import.meta.url);
const hasWasm = existsSync(generatedLoader) && existsSync(wasmUrl);
const hasWp4Abi = hasWasm
  && readFileSync(generatedLoader, "utf8").includes(
    "_necpp_wasm_v1_get_current_distribution",
  );
const skip = !hasWp4Abi
  && "WASM artifacts have not been rebuilt with WP4 ABI exports";

const fourNodeQuadrature = {
  nodes: Float64Array.of(-1, -1 / 3, 1 / 3, 1),
  images: "physical-only",
  modes: "unit-current",
};

function packedMagic(buffer) {
  const bytes = new Uint8Array(buffer);
  return String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
}

test("WP4 worker characterization handoff never materializes large buffers on the client",
  { skip }, async () => {
    const model = await createNecWorkerModel();
    const { port1, port2 } = new MessageChannel();
    const received = new Promise((resolve, reject) => {
      port2.once("message", resolve);
      port2.once("messageerror", reject);
    });
    try {
      await applyCurrentQuadratureFixture(model, currentQuadratureFixtures.dipole);
      const handoff = await model.characterizeIsolatedElement(
        {
          quadrature: fourNodeQuadrature,
          field: currentQuadratureFieldGrid,
        },
        { destination: port1 },
      );
      assert.equal(handoff.impedance.rows, 1);
      assert.ok(handoff.quadratureByteLength > 0);
      assert.ok(handoff.embeddedFieldByteLength > 0);
      assert.equal("quadrature" in handoff, false);
      assert.equal("embeddedField" in handoff, false);

      const message = await received;
      assert.equal(message.kind, "isolated-element-characterization");
      assert.equal(message.quadrature.byteLength, handoff.quadratureByteLength);
      assert.equal(
        message.embeddedField.byteLength,
        handoff.embeddedFieldByteLength,
      );
      const necq = new Uint8Array(message.quadrature.buffer);
      const necf = new Uint8Array(message.embeddedField.buffer);
      assert.equal(String.fromCharCode(necq[0], necq[1], necq[2], necq[3]), "NECQ");
      assert.equal(String.fromCharCode(necf[0], necf[1], necf[2], necf[3]), "NECF");

      port2.postMessage({ kind: "steer" });
    } finally {
      port1.close();
      port2.close();
      await model.dispose();
    }
  });

test("WP4 dispose after characterize keeps client-owned packed buffers",
  { skip }, async () => {
    const model = await createNecWorkerModel();
    try {
      await applyCurrentQuadratureFixture(model, currentQuadratureFixtures.dipole);
      const characterization = await model.characterizeIsolatedElement({
        quadrature: fourNodeQuadrature,
        field: currentQuadratureFieldGrid,
      });
      await model.dispose();
      assert.equal(
        characterization.quadrature.buffer.byteLength,
        characterization.quadrature.byteLength,
      );
      assert.equal(
        characterization.embeddedField.buffer.byteLength,
        characterization.embeddedField.byteLength,
      );
      assert.equal(
        packedMagic(characterization.quadrature.buffer),
        "NECQ",
      );
    } finally {
      await model.dispose();
    }
  });

test("WP4 terminate with an open handoff port rejects and does not leak the client",
  { skip }, async () => {
    const model = await createNecWorkerModel();
    const { port1, port2 } = new MessageChannel();
    try {
      await applyCurrentQuadratureFixture(model, currentQuadratureFixtures.dipole);
      const pending = model.characterizeIsolatedElement(
        {
          quadrature: fourNodeQuadrature,
          field: currentQuadratureFieldGrid,
        },
        { destination: port1 },
      );
      model.terminate();
      await pending.catch(() => undefined);
      assert.equal(model.state, "disposed");
    } finally {
      port1.close();
      port2.close();
      model.terminate();
    }
  });
