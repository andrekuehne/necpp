import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { createNecModel } from "../dist/index.js";
import { FarFieldWorkerPool } from "../dist/field-worker-pool.js";
import { createFarFieldFixture, PRIMARY_FIELD_GRID } from "./far-field-fixture-v1.mjs";

const outputDirectory = resolve(process.argv[2] ?? "bench/evidence/far-field-wp3/node");
mkdirSync(outputDirectory, { recursive: true });

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: sorted[0], median: sorted[Math.floor(sorted.length / 2)],
    max: sorted.at(-1),
  };
}

function scaledMaximum(reference, candidate, realName, imagName) {
  let scale = 1;
  let difference = 0;
  for (let index = 0; index < reference[realName].length; index += 1) {
    scale = Math.max(scale, Math.hypot(
      reference[realName][index], reference[imagName][index],
    ));
    difference = Math.max(difference, Math.hypot(
      reference[realName][index] - candidate[realName][index],
      reference[imagName][index] - candidate[imagName][index],
    ));
  }
  return difference / scale;
}

function checksum(field) {
  const hash = createHash("sha256");
  for (const name of ["eThetaReal", "eThetaImag", "ePhiReal", "ePhiImag"]) {
    const values = field[name];
    hash.update(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
  }
  return hash.digest("hex");
}

function fileHash(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const fixture = createFarFieldFixture();
const model = await createNecModel();
const setupStarted = performance.now();
for (const wire of fixture.wires) model.addWire(wire);
model.completeGeometry({ groundConnection: "none" });
model.definePorts(fixture.ports);
model.setGround(fixture.ground);
model.prepare({ frequencyMHz: fixture.frequencyMHz });
const phases = new Float64Array(fixture.elementCount);
model.solveVoltages({ real: Float64Array.from(phases, () => 1), imag: phases });
const setupMs = performance.now() - setupStarted;
const snapshotStarted = performance.now();
const snapshot = model.captureFarFieldEvaluationSnapshot();
const snapshotCaptureMs = performance.now() - snapshotStarted;
if (snapshot.capability !== "supported") throw new Error(snapshot.capability);
const serialStarted = performance.now();
const serial = model.computeFarField(PRIMARY_FIELD_GRID);
const serialMs = performance.now() - serialStarted;

const records = [];
for (const workers of [1, 2, 4, 8]) {
  const pool = new FarFieldWorkerPool(workers, 512);
  const startupStarted = performance.now();
  await pool.prewarm();
  const startupMs = performance.now() - startupStarted;
  await pool.setSnapshot(snapshot);
  await pool.computeFarField(PRIMARY_FIELD_GRID); // warm-up
  const measured = [];
  let last;
  for (let round = 0; round < 3; round += 1) {
    last = await pool.computeFarField(PRIMARY_FIELD_GRID);
    measured.push(last.poolDiagnostics.totalMs);
  }
  records.push({
    workers, strategy: "bounded-tiles", tileSize: 512, startupMs,
    fieldMs: stats(measured),
    fieldRunsMs: measured,
    speedupOverOneWorker: null,
    diagnostics: last.poolDiagnostics,
    checksum: checksum(last),
    scaledMaximum: {
      eTheta: scaledMaximum(serial, last, "eThetaReal", "eThetaImag"),
      ePhi: scaledMaximum(serial, last, "ePhiReal", "ePhiImag"),
    },
  });
  pool.dispose();
}
const oneWorkerMedian = records[0].fieldMs.median;
for (const record of records) record.speedupOverOneWorker = oneWorkerMedian / record.fieldMs.median;

const fullArtifactPool = new FarFieldWorkerPool(1, 512, "full-nec");
const fullStartupStarted = performance.now();
await fullArtifactPool.prewarm();
const fullStartupMs = performance.now() - fullStartupStarted;
await fullArtifactPool.setSnapshot(snapshot);
await fullArtifactPool.computeFarField(PRIMARY_FIELD_GRID);
const fullArtifactRunsMs = [];
for (let round = 0; round < 3; round += 1) {
  const field = await fullArtifactPool.computeFarField(PRIMARY_FIELD_GRID);
  fullArtifactRunsMs.push(field.poolDiagnostics.totalMs);
}
fullArtifactPool.dispose();
const artifactShapeComparison = {
  dedicated: {
    startupMs: records[0].startupMs,
    fieldMs: records[0].fieldMs,
  },
  fullNecEvaluatorOnly: {
    startupMs: fullStartupMs,
    fieldMs: stats(fullArtifactRunsMs),
    fieldRunsMs: fullArtifactRunsMs,
  },
};

for (const strategy of ["static-slabs", "bounded-tiles"]) {
  const tileSize = strategy === "static-slabs"
    ? Math.ceil(PRIMARY_FIELD_GRID.theta.count * PRIMARY_FIELD_GRID.phi.count / 4)
    : 512;
  const pool = new FarFieldWorkerPool(4, tileSize);
  await pool.prewarm();
  await pool.setSnapshot(snapshot);
  await pool.computeFarField(PRIMARY_FIELD_GRID);
  const field = await pool.computeFarField(PRIMARY_FIELD_GRID);
  records.push({
    workers: 4, strategy, tileSize,
    fieldMs: { min: field.poolDiagnostics.totalMs,
      median: field.poolDiagnostics.totalMs, max: field.poolDiagnostics.totalMs },
    diagnostics: field.poolDiagnostics,
  });
  pool.dispose();
}

const updatePool = new FarFieldWorkerPool(4, 512);
await updatePool.prewarm();
await updatePool.setSnapshot(snapshot);
model.solveVoltages({ real: Float64Array.from(phases, () => 1), imag: phases });
const updatedSnapshot = model.captureFarFieldEvaluationSnapshot();
await updatePool.setSnapshot(updatedSnapshot);
const updatedField = await updatePool.computeFarField(PRIMARY_FIELD_GRID);
const currentUpdateProbe = {
  modelGeneration: updatedSnapshot.modelGeneration,
  solutionGeneration: updatedSnapshot.solutionGeneration,
  geometryReused: updatedField.poolDiagnostics.geometryReused,
  broadcastBytesPerWorker: updatedField.poolDiagnostics.lastBroadcastBytesPerWorker,
  broadcastMs: updatedField.poolDiagnostics.snapshotBroadcastMs,
};
updatePool.dispose();

const fullWasmBytes = statSync(resolve("dist/nec2pp.wasm")).size;
const evaluatorWorkerBytes = statSync(resolve("dist/field-evaluator-worker.js")).size
  + statSync(resolve("dist/field-evaluator.js")).size
  + statSync(resolve("dist/necpp-field-evaluator.generated.js")).size
  + statSync(resolve("dist/necpp-field-evaluator.wasm")).size;
const snapshotBytes = snapshot.segmentCount * 13 * Float64Array.BYTES_PER_ELEMENT;
const result = {
  type: "far-field-wp3-poc",
  schemaVersion: 1,
  measuredAt: new Date().toISOString(),
  environment: {
    platform: platform(), release: release(), arch: arch(),
    cpu: cpus()[0]?.model, logicalCpus: cpus().length,
    node: process.version,
  },
  fixture: { id: fixture.id, segments: fixture.segmentCount,
    samples: PRIMARY_FIELD_GRID.theta.count * PRIMARY_FIELD_GRID.phi.count },
  setupMs, snapshotCaptureMs, serialMs, serialChecksum: checksum(serial),
  snapshot: {
    schemaVersion: snapshot.schemaVersion,
    modelGeneration: snapshot.modelGeneration,
    solutionGeneration: snapshot.solutionGeneration,
    bytes: snapshotBytes,
    geometryBytes: snapshot.segmentCount * 7 * 8,
    currentBytes: snapshot.segmentCount * 6 * 8,
  },
  retainedMatrixBytes: fixture.segmentCount ** 2 * 16,
  artifactShapes: {
    existingNecWasmBytesPerWorker: fullWasmBytes,
    existingNecWasmSha256: fileHash(resolve("dist/nec2pp.wasm")),
    dedicatedEvaluatorArtifactBytesPerWorker: evaluatorWorkerBytes,
    dedicatedEvaluatorWasmBytesPerWorker:
      statSync(resolve("dist/necpp-field-evaluator.wasm")).size,
    dedicatedEvaluatorWasmSha256:
      fileHash(resolve("dist/necpp-field-evaluator.wasm")),
  },
  artifactShapeComparison,
  boundedMemory: {
    mergedOutputBytes: PRIMARY_FIELD_GRID.theta.count * PRIMARY_FIELD_GRID.phi.count * 4 * 8,
    maximumTileBytesPerWorker: 512 * 4 * 8,
    snapshotBytesPerWorker: snapshotBytes,
  },
  currentUpdateProbe,
  records,
};
writeFileSync(resolve(outputDirectory, "far-field-wp3-summary.json"),
  `${JSON.stringify(result, null, 2)}\n`, "utf8");
writeFileSync(resolve(outputDirectory, "far-field-wp3-raw.ndjson"),
  `${records.map((record) => JSON.stringify({
    type: "far-field-wp3-run", schemaVersion: 1,
    measuredAt: result.measuredAt, fixture: result.fixture, record,
  })).join("\n")}\n`, "utf8");
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
model.dispose();
