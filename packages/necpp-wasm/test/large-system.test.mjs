import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import { createNecModel } from "../.test-build/src/index.js";
import { createNecWorkerModel } from "../.test-build/src/worker.js";

const generatedLoader = new URL(
  "../.test-build/src/nec2pp.generated.js",
  import.meta.url,
);
const wasmUrl = new URL("../.test-build/src/nec2pp.wasm", import.meta.url);
const hasWasm = existsSync(generatedLoader) && existsSync(wasmUrl);

const backends = [
  ["direct", createNecModel],
  ["worker", createNecWorkerModel],
];

for (const [backend, createModel] of backends) {
  test(`a 176-equation array solves in ${backend} mode`, {
    skip: !hasWasm && "WASM artifacts have not been built",
  }, async () => {
    const side = 4;
    const segmentsPerDipole = 11;
    const frequencyMHz = 300;
    const wavelengthM = 299_792_458 / (frequencyMHz * 1e6);
    const elementHalfLengthM = wavelengthM / 8;
    const spacingM = wavelengthM / 2;
    const portCount = side * side;
    const model = await createModel();

    try {
      const ports = [];
      for (let y = 0; y < side; y += 1) {
        for (let x = 0; x < side; x += 1) {
          const tag = y * side + x + 1;
          const xM = (x - (side - 1) / 2) * spacingM;
          const yM = (y - (side - 1) / 2) * spacingM;
          await model.addWire({
            tag,
            segments: segmentsPerDipole,
            start: [xM, yM, -elementHalfLengthM],
            end: [xM, yM, elementHalfLengthM],
            radiusM: wavelengthM / 1000,
          });
          ports.push({ tag, segment: (segmentsPerDipole + 1) / 2 });
        }
      }

      await model.completeGeometry();
      await model.definePorts(ports);
      await model.prepare({ frequencyMHz });

      const drive = {
        real: new Float64Array(portCount).fill(1),
        imag: new Float64Array(portCount),
      };
      const first = await model.solveVoltages(drive);
      const second = await model.solveVoltages(drive);

      assert.equal(model.state, "solved");
      assert.equal(first.currents.real.length, portCount);
      assert.ok(first.factorizationGeneration > 0);
      assert.equal(second.factorizationGeneration, first.factorizationGeneration);
      assert.equal(second.solveGeneration, first.solveGeneration + 1);
      for (let index = 0; index < portCount; index += 1) {
        assert.ok(Number.isFinite(second.currents.real[index]));
        assert.ok(Number.isFinite(second.currents.imag[index]));
      }
    } finally {
      await model.dispose();
    }
  });
}
