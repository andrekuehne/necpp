import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MessageChannel } from "node:worker_threads";

import {
  applyCurrentQuadratureFixture,
  currentQuadratureFixtures,
} from "../test/fixtures/current-quadrature.mjs";

export const CURRENT_QUADRATURE_WP6_SCHEMA_VERSION = 1;
export const CURRENT_QUADRATURE_WP6_FIXTURES = Object.freeze([
  "dipole",
  "turnstile-insulated",
]);
export const CURRENT_QUADRATURE_WP6_GRIDS = Object.freeze([
  "published",
  "wp0",
]);
export const CURRENT_QUADRATURE_WP6_BACKENDS = Object.freeze([
  "direct",
  "worker",
]);

export const CURRENT_QUADRATURE_WP6_GRIDS_BY_ID = Object.freeze({
  published: Object.freeze({
    id: "published-5-3",
    radiusM: 1,
    theta: Object.freeze({ startDeg: 0, count: 5, stepDeg: 45 }),
    phi: Object.freeze({ startDeg: 0, count: 3, stepDeg: 90 }),
  }),
  wp0: Object.freeze({
    id: "wp0-19-37",
    radiusM: 1,
    theta: Object.freeze({ startDeg: 0, count: 19, stepDeg: 10 }),
    phi: Object.freeze({ startDeg: 0, count: 37, stepDeg: 10 }),
  }),
});

const fourNode = Object.freeze({
  nodes: Float64Array.of(-1, -1 / 3, 1 / 3, 1),
  images: "physical-only",
  modes: "unit-current",
});

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument near ${name ?? "end of command"}`);
    }
    values.set(name.slice(2), value);
  }
  const fixtureId = values.get("fixture");
  const gridId = values.get("grid");
  const backend = values.get("backend") ?? "direct";
  if (!CURRENT_QUADRATURE_WP6_FIXTURES.includes(fixtureId)) {
    throw new Error(`--fixture must be ${CURRENT_QUADRATURE_WP6_FIXTURES.join(" or ")}`);
  }
  if (!CURRENT_QUADRATURE_WP6_GRIDS.includes(gridId)) {
    throw new Error(`--grid must be ${CURRENT_QUADRATURE_WP6_GRIDS.join(" or ")}`);
  }
  if (!CURRENT_QUADRATURE_WP6_BACKENDS.includes(backend)) {
    throw new Error(`--backend must be ${CURRENT_QUADRATURE_WP6_BACKENDS.join(" or ")}`);
  }
  const round = Number(values.get("round"));
  if (!Number.isSafeInteger(round)) {
    throw new Error("--round must be an integer");
  }
  return {
    fixtureId,
    gridId,
    backend,
    round,
    moduleDirectory: resolve(values.get("module-directory")),
  };
}

function memorySnapshot() {
  const usage = process.memoryUsage();
  return {
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
  };
}

async function timed(operation) {
  const wallStart = performance.now();
  const value = await operation();
  return { value, wallMs: performance.now() - wallStart };
}

function sinkPacked(handle) {
  const bytes = new Uint8Array(handle.buffer, 0, Math.min(8, handle.byteLength));
  return handle.byteLength + bytes[0] + bytes[1] + bytes[2] + bytes[3];
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const fixture = currentQuadratureFixtures[options.fixtureId];
  const grid = CURRENT_QUADRATURE_WP6_GRIDS_BY_ID[options.gridId];
  const request = { quadrature: { ...fourNode, nodes: Float64Array.from(fourNode.nodes) }, field: grid };
  const indexUrl = pathToFileURL(resolve(options.moduleDirectory, "index.js")).href;
  const workerUrl = pathToFileURL(resolve(options.moduleDirectory, "worker.js")).href;
  const api = await import(indexUrl);
  const workerApi = options.backend === "worker" ? await import(workerUrl) : null;

  const before = memorySnapshot();
  const created = await timed(() => (
    options.backend === "worker"
      ? workerApi.createNecWorkerModel()
      : api.createNecModel()
  ));
  const model = created.value;
  try {
    const construction = await timed(() =>
      applyCurrentQuadratureFixture(model, fixture));
    const matrix = await timed(() => model.computeImpedanceMatrix());
    let characterizeMs;
    let quadratureBytes;
    let embeddedBytes;
    let retrieveMs;
    let retrieveSink = 0;
    let clientHasLargeBuffers = null;
    let consumerReceivedBytes = null;
    let steerRetransferred = null;
    let afterCharacterizeHeap = null;

    if (options.backend === "direct") {
      const characterized = await timed(() =>
        model.characterizeIsolatedElement(request));
      characterizeMs = characterized.wallMs;
      const result = characterized.value;
      quadratureBytes = result.quadrature.byteLength;
      embeddedBytes = result.embeddedField.byteLength;
      afterCharacterizeHeap = process.memoryUsage().heapUsed;
      const retrieved = await timed(async () => {
        let sink = 0;
        for (let pass = 0; pass < 1000; pass += 1) {
          sink += sinkPacked(result.quadrature);
          sink += sinkPacked(result.embeddedField);
        }
        return sink;
      });
      retrieveMs = retrieved.wallMs / 1000;
      retrieveSink = retrieved.value;
    } else {
      const { port1, port2 } = new MessageChannel();
      const received = new Promise((resolve, reject) => {
        port2.once("message", resolve);
        port2.once("messageerror", reject);
      });
      const characterized = await timed(() =>
        model.characterizeIsolatedElement(request, { destination: port1 }));
      characterizeMs = characterized.wallMs;
      const handoff = characterized.value;
      clientHasLargeBuffers =
        "quadrature" in handoff || "embeddedField" in handoff;
      quadratureBytes = handoff.quadratureByteLength;
      embeddedBytes = handoff.embeddedFieldByteLength;
      const message = await received;
      consumerReceivedBytes =
        message.quadrature.byteLength + message.embeddedField.byteLength;
      const bound = {
        quadrature: message.quadrature.buffer,
        embeddedField: message.embeddedField.buffer,
      };
      const steerStarted = performance.now();
      port2.postMessage({ kind: "steer" });
      retrieveMs = performance.now() - steerStarted;
      steerRetransferred = bound.quadrature.byteLength === quadratureBytes
        && bound.embeddedField.byteLength === embeddedBytes;
      retrieveSink = bound.quadrature.byteLength;
      port1.close();
      port2.close();
      afterCharacterizeHeap = process.memoryUsage().heapUsed;
    }

    const after = memorySnapshot();
    process.stdout.write(`${JSON.stringify({
      ok: true,
      schemaVersion: CURRENT_QUADRATURE_WP6_SCHEMA_VERSION,
      fixture: fixture.id,
      grid: grid.id,
      backend: options.backend,
      round: options.round,
      portCount: fixture.ports.length,
      wireCount: fixture.wires.length,
      quadratureBytes,
      embeddedBytes,
      retrieveSink,
      clientHasLargeBuffers,
      consumerReceivedBytes,
      steerRetransferred,
      timings: {
        createMs: created.wallMs,
        constructionMs: construction.wallMs,
        impedanceMs: matrix.wallMs,
        characterizeMs,
        retrieveMs,
      },
      memory: {
        beforeRssBytes: before.rssBytes,
        afterRssBytes: after.rssBytes,
        afterHeapUsedBytes: after.heapUsedBytes,
        afterCharacterizeHeapBytes: afterCharacterizeHeap,
      },
    })}\n`);
  } finally {
    await Promise.resolve(model.dispose());
  }
}

if (process.argv[1] !== undefined
    && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
