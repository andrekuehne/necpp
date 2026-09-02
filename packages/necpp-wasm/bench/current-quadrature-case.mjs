import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  applyCurrentQuadratureFixture,
  currentQuadratureFixtures,
  unitCurrentVector,
} from "../test/fixtures/current-quadrature.mjs";

export const CURRENT_QUADRATURE_BENCHMARK_SCHEMA_VERSION = 1;
export const CURRENT_QUADRATURE_FIXTURES = Object.freeze([
  "dipole",
  "turnstile-insulated",
]);
export const CURRENT_QUADRATURE_GRIDS = Object.freeze(["small", "representative"]);

export const CURRENT_QUADRATURE_GRIDS_BY_ID = Object.freeze({
  small: Object.freeze({
    id: "small-19-37",
    radiusM: 1,
    theta: Object.freeze({ startDeg: 0, count: 19, stepDeg: 10 }),
    phi: Object.freeze({ startDeg: 0, count: 37, stepDeg: 10 }),
  }),
  representative: Object.freeze({
    id: "representative-91-73",
    radiusM: 1,
    theta: Object.freeze({ startDeg: 0, count: 91, stepDeg: 2 }),
    phi: Object.freeze({ startDeg: 0, count: 73, stepDeg: 5 }),
  }),
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
  if (!CURRENT_QUADRATURE_FIXTURES.includes(fixtureId)) {
    throw new Error(`--fixture must be ${CURRENT_QUADRATURE_FIXTURES.join(" or ")}`);
  }
  if (!CURRENT_QUADRATURE_GRIDS.includes(gridId)) {
    throw new Error(`--grid must be ${CURRENT_QUADRATURE_GRIDS.join(" or ")}`);
  }
  const round = Number(values.get("round"));
  if (!Number.isSafeInteger(round)) {
    throw new Error("--round must be an integer");
  }
  return {
    fixtureId,
    gridId,
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

function snapshotBytes(snapshot) {
  if (snapshot?.capability !== "supported") return 0;
  return snapshot.segmentCount * 13 * 8;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const fixture = currentQuadratureFixtures[options.fixtureId];
  const grid = CURRENT_QUADRATURE_GRIDS_BY_ID[options.gridId];
  const moduleUrl = pathToFileURL(resolve(options.moduleDirectory, "index.js")).href;
  const api = await import(moduleUrl);

  const before = memorySnapshot();
  const created = await timed(() => api.createNecModel());
  const model = created.value;
  try {
    const construction = await timed(() =>
      applyCurrentQuadratureFixture(model, fixture));
    const matrix = await timed(() => model.computeImpedanceMatrix());
    const embedded = await timed(() => model.computeEmbeddedFarFields(grid, {
      kind: "unit-current",
      valueA: 1,
    }));
    const solved = await timed(() =>
      model.solveCurrents(unitCurrentVector(fixture.ports.length)));
    let snapshotCaptureMs = null;
    let snapshotByteLength = null;
    let snapshotCapability = "unavailable";
    if (typeof model.captureFarFieldEvaluationSnapshot === "function") {
      const captured = await timed(() => model.captureFarFieldEvaluationSnapshot());
      snapshotCaptureMs = captured.wallMs;
      snapshotCapability = captured.value.capability;
      snapshotByteLength = snapshotBytes(captured.value);
    }
    const after = memorySnapshot();
    const field = embedded.value;
    process.stdout.write(`${JSON.stringify({
      ok: true,
      schemaVersion: CURRENT_QUADRATURE_BENCHMARK_SCHEMA_VERSION,
      internal: true,
      fixture: fixture.id,
      grid: grid.id,
      round: options.round,
      portCount: fixture.ports.length,
      wireCount: fixture.wires.length,
      fieldSamplesPerPort: field.samplesPerPort,
      embeddedFieldBytes: field.eThetaReal.byteLength
        + field.eThetaImag.byteLength
        + field.ePhiReal.byteLength
        + field.ePhiImag.byteLength,
      snapshotCapability,
      snapshotByteLength,
      snapshotBytesFormula: "13 * nSegments * 8",
      exactCoefficientBytesPerModeFormula: "6 * nSegments * 8",
      timings: {
        createMs: created.wallMs,
        constructionMs: construction.wallMs,
        impedanceMs: matrix.wallMs,
        embeddedUnitCurrentMs: embedded.wallMs,
        unitCurrentSolveMs: solved.wallMs,
        snapshotCaptureMs,
      },
      memory: {
        beforeRssBytes: before.rssBytes,
        afterRssBytes: after.rssBytes,
        afterHeapUsedBytes: after.heapUsedBytes,
      },
    })}\n`);
  } finally {
    model.dispose();
  }
}

if (process.argv[1] !== undefined
    && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
