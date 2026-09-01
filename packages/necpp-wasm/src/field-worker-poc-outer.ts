/** Browser/Node proof harness: solver-owning outer worker plus evaluator children. */
import { createNecModel } from "./index.js";
import { FarFieldWorkerPool } from "./field-worker-pool.js";
import type { WasmNecModel } from "./model.js";

const scope = globalThis as unknown as {
  postMessage(message: unknown): void;
  addEventListener(type: "message", handler: (event: MessageEvent<unknown>) => void): void;
};

scope.addEventListener("message", async () => {
  const model = await createNecModel();
  const pool = new FarFieldWorkerPool(2, 32);
  try {
    model.addWire({
      tag: 1, segments: 11,
      start: [-0.235, 0, 0.25], end: [0.235, 0, 0.25], radiusM: 0.001,
    });
    model.completeGeometry();
    model.definePorts([{ tag: 1, segment: 6 }]);
    model.setGround({ kind: "perfect" });
    model.prepare({ frequencyMHz: 300 });
    model.solveVoltages({ real: new Float64Array([1]), imag: new Float64Array([0]) });
    const snapshot = (model as WasmNecModel).captureFarFieldEvaluationSnapshot();
    await pool.prewarm();
    await pool.setSnapshot(snapshot);
    const field = await pool.computeFarField({
      radiusM: 1,
      theta: { startDeg: 0, count: 31, stepDeg: 3 },
      phi: { startDeg: 0, count: 40, stepDeg: 9 },
    });
    scope.postMessage({
      isolated: globalThis.crossOriginIsolated,
      samples: field.eThetaReal.length,
      finite: field.eThetaReal.every(Number.isFinite),
      workers: field.poolDiagnostics.workers,
      modelGeneration: snapshot.modelGeneration,
      solutionGeneration: snapshot.solutionGeneration,
      capability: snapshot.capability,
    });
  } catch (error) {
    scope.postMessage({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    pool.dispose();
    model.dispose();
  }
});
