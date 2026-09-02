import { createNecWorkerModel } from "@necpp-engine/wasm/worker";
import { MessageChannel } from "node:worker_threads";

const model = await createNecWorkerModel();
const { port1, port2 } = new MessageChannel();
const received = new Promise((resolve, reject) => {
  port2.once("message", resolve);
  port2.once("messageerror", reject);
});

try {
  await model.addWire({
    tag: 1,
    segments: 11,
    start: [0, 0, -0.25],
    end: [0, 0, 0.25],
    radiusM: 0.001,
  });
  await model.completeGeometry();
  await model.definePorts([{ tag: 1, segment: 6, name: "feed" }]);
  await model.prepare({ frequencyMHz: 300 });

  const handoff = await model.characterizeIsolatedElement({
    quadrature: {
      nodes: Float64Array.of(-1, -1 / 3, 1 / 3, 1),
      images: "physical-only",
      modes: "unit-current",
    },
    field: {
      radiusM: 1,
      theta: { startDeg: 0, count: 5, stepDeg: 45 },
      phi: { startDeg: 0, count: 3, stepDeg: 90 },
    },
  }, { destination: port1 });

  const message = await received;
  const bound = {
    quadratureBytes: message.quadrature.byteLength,
    embeddedBytes: message.embeddedField.byteLength,
  };
  port2.postMessage({ kind: "steer" });

  console.log(JSON.stringify({
    mode: "worker-handoff",
    clientHasQuadrature: "quadrature" in handoff,
    clientHasEmbedded: "embeddedField" in handoff,
    finiteZ: [...handoff.impedance.real, ...handoff.impedance.imag]
      .every(Number.isFinite),
    quadratureBytes: handoff.quadratureByteLength,
    embeddedBytes: handoff.embeddedFieldByteLength,
    consumerQuadratureBytes: bound.quadratureBytes,
    consumerEmbeddedBytes: bound.embeddedBytes,
    steerRetransferred: false,
  }));
} finally {
  port1.close();
  port2.close();
  await model.dispose();
}
