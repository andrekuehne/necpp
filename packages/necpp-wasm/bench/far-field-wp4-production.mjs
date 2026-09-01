import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

import {
  PRIMARY_FIELD_GRID,
  STEERING_POINTS,
  complexVectorChecksum,
  createFarFieldFixture,
  fixtureManifest,
  sourceGridForDisplay,
  steeringCurrents,
} from "./far-field-fixture-v1.mjs";

const packageDirectory = resolve(import.meta.dirname, "..");
const distDirectory = resolve(packageDirectory, "dist");
const outputDirectory = resolve(
  packageDirectory,
  "bench/evidence/far-field-wp4/node",
);
const measuredStates = 5;

function stats(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const median = sorted.length % 2 === 0
    ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : sorted[Math.floor(sorted.length / 2)];
  return {
    count: sorted.length,
    minimum: sorted[0],
    median,
    maximum: sorted.at(-1),
    p90: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9) - 1)],
  };
}

function memory() {
  const value = process.memoryUsage();
  return {
    rssBytes: value.rss,
    heapUsedBytes: value.heapUsed,
    externalBytes: value.external,
    arrayBuffersBytes: value.arrayBuffers,
  };
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function git(args) {
  return execFileSync("git", args, {
    cwd: resolve(packageDirectory, "../.."),
    encoding: "utf8",
  });
}

function fieldBytes(grid) {
  return (4 * grid.theta.count * grid.phi.count
    + grid.theta.count + grid.phi.count) * 8;
}

function scaledDifference(reference, actual, realName, imagName) {
  let scale = 1;
  let difference = 0;
  for (let index = 0; index < reference[realName].length; index += 1) {
    scale = Math.max(scale, Math.hypot(
      reference[realName][index],
      reference[imagName][index],
    ));
    difference = Math.max(difference, Math.hypot(
      reference[realName][index] - actual[realName][index],
      reference[imagName][index] - actual[imagName][index],
    ));
  }
  return difference / scale;
}

async function timed(body) {
  const started = performance.now();
  const value = await body();
  return { value, ms: performance.now() - started };
}

async function runBackend(api, fixture, fieldWorkers, secondaryGrid) {
  const memoryBefore = memory();
  const creation = await timed(() => api.createNecArraySolver(fixture.description, {
    symmetry: "auto",
    symmetrizer: { positionEpsilonM: 0 },
    fieldWorkers,
  }));
  const solver = creation.value;
  let peakRssBytes = memoryBefore.rssBytes;
  try {
    const prepare = await timed(() => solver.prepare({ frequencyMHz: fixture.frequencyMHz }));
    const warmupCurrents = steeringCurrents(fixture, STEERING_POINTS[0]);
    await solver.solveCurrents(warmupCurrents);
    const warmup = await timed(() => solver.computeFarField(PRIMARY_FIELD_GRID));
    peakRssBytes = Math.max(peakRssBytes, memory().rssBytes);

    const primary = [];
    let lastPrimary;
    for (let index = 0; index < measuredStates; index += 1) {
      const currents = steeringCurrents(fixture, STEERING_POINTS[index]);
      const solve = await timed(() => solver.solveCurrents(currents));
      const field = await timed(() => solver.computeFarField(PRIMARY_FIELD_GRID));
      lastPrimary = field.value;
      primary.push({
        index,
        solveMs: solve.ms,
        fieldMs: field.ms,
        solveAndFieldMs: solve.ms + field.ms,
        requestedChecksum: complexVectorChecksum(currents),
        achievedChecksum: complexVectorChecksum(solve.value.currents),
        factorizationGeneration: solve.value.factorizationGeneration,
        solveGeneration: solve.value.solveGeneration,
        backend: field.value.fieldBackend,
      });
      peakRssBytes = Math.max(peakRssBytes, memory().rssBytes);
    }

    const secondary = [];
    let lastSecondary;
    for (let index = 0; index < measuredStates; index += 1) {
      const field = await timed(() => solver.computeFarField(secondaryGrid));
      lastSecondary = field.value;
      secondary.push({
        index,
        fieldMs: field.ms,
        backend: field.value.fieldBackend,
      });
      peakRssBytes = Math.max(peakRssBytes, memory().rssBytes);
    }
    let cancellation = null;
    if (fieldWorkers !== 1) {
      const stale = solver.computeFarField(PRIMARY_FIELD_GRID);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 40));
      const newest = solver.computeFarField(PRIMARY_FIELD_GRID);
      let staleError;
      try {
        await stale;
      } catch (error) {
        staleError = {
          name: error.name,
          code: error.code,
          reason: error.details?.reason,
        };
      }
      const newestField = await newest;
      cancellation = {
        delayBeforeSupersedeMs: 40,
        staleError,
        newestBackend: newestField.fieldBackend,
        newestSamples: newestField.eThetaReal.length,
      };
    }
    return {
      fieldWorkers,
      createMs: creation.ms,
      prepareMs: prepare.ms,
      warmupMs: warmup.ms,
      warmupBackend: warmup.value.fieldBackend,
      diagnostics: solver.getDiagnostics(),
      primary,
      secondary,
      cancellation,
      summary: {
        primarySolveMs: stats(primary.map((value) => value.solveMs)),
        primaryFieldMs: stats(primary.map((value) => value.fieldMs)),
        primarySolveAndFieldMs: stats(primary.map((value) => value.solveAndFieldMs)),
        secondaryFieldMs: stats(secondary.map((value) => value.fieldMs)),
      },
      memory: {
        before: memoryBefore,
        after: memory(),
        peakRssBytes,
        peakRssDeltaBytes: peakRssBytes - memoryBefore.rssBytes,
      },
      lastPrimary,
      lastSecondary,
    };
  } finally {
    await solver.dispose();
  }
}

async function main() {
  const api = await import(pathToFileURL(resolve(distDirectory, "index.js")).href);
  const fixture = createFarFieldFixture();
  const secondaryGrid = sourceGridForDisplay(fixture, 32, 32);
  const serial = await runBackend(api, fixture, 1, secondaryGrid);
  const pool = await runBackend(api, fixture, 4, secondaryGrid);
  const primaryFieldSpeedup = serial.summary.primaryFieldMs.median
    / pool.summary.primaryFieldMs.median;
  const primaryEndToEndSpeedup = serial.summary.primarySolveAndFieldMs.median
    / pool.summary.primarySolveAndFieldMs.median;
  const secondaryRatio = pool.summary.secondaryFieldMs.median
    / serial.summary.secondaryFieldMs.median;
  const correctness = {
    eThetaScaledMaximum: scaledDifference(
      serial.lastPrimary,
      pool.lastPrimary,
      "eThetaReal",
      "eThetaImag",
    ),
    ePhiScaledMaximum: scaledDifference(
      serial.lastPrimary,
      pool.lastPrimary,
      "ePhiReal",
      "ePhiImag",
    ),
    secondaryEThetaScaledMaximum: scaledDifference(
      serial.lastSecondary,
      pool.lastSecondary,
      "eThetaReal",
      "eThetaImag",
    ),
  };
  const gates = {
    primaryFieldAtLeast2x: primaryFieldSpeedup >= 2,
    primaryEndToEndAtLeast1_75x: primaryEndToEndSpeedup >= 1.75,
    secondaryNoRegression: secondaryRatio <= 1.05,
    numericalParity: correctness.eThetaScaledMaximum <= 1e-10
      && correctness.ePhiScaledMaximum <= 1e-10
      && correctness.secondaryEThetaScaledMaximum <= 1e-10,
  };
  const publicRecord = (record) => {
    const { lastPrimary, lastSecondary, ...rest } = record;
    return rest;
  };
  const output = {
    type: "far-field-wp4-production",
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    fixture: fixtureManifest(),
    configuration: {
      measuredStates,
      tileSize: 512,
      serialWorkers: 1,
      parallelWorkers: 4,
      primaryGrid: PRIMARY_FIELD_GRID,
      secondaryGrid,
      primaryResultBytes: fieldBytes(PRIMARY_FIELD_GRID),
      secondaryResultBytes: fieldBytes(secondaryGrid),
    },
    environment: {
      node: process.version,
      v8: process.versions.v8,
      platform: platform(),
      release: release(),
      architecture: arch(),
      cpu: cpus()[0]?.model ?? "unknown",
      logicalCpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
      packageVersion: api.packageVersion,
      engineVersion: api.engineVersion,
      engineBaseCommit: git(["rev-parse", "HEAD"]).trim(),
      gitStatus: git(["status", "--short"]).trim().split(/\r?\n/).filter(Boolean),
      trackedDiffSha256: createHash("sha256")
        .update(git(["diff", "--binary"]))
        .digest("hex"),
      build: {
        cmakeBuildType: "Release",
        cxxFlags: "-O3 -DNDEBUG -flto -fexceptions",
        linkFlags: "-O3 -flto -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node",
        performanceDiagnostics: false,
        wasmSimd128: false,
        pthreads: false,
        farFieldOptimizations: "SELECTED",
      },
      artifacts: Object.fromEntries([
        "index.js",
        "worker-entry.js",
        "worker-runtime.js",
        "field-worker-pool.js",
        "field-evaluator.js",
        "necpp-field-evaluator.generated.js",
        "nec2pp.wasm",
        "necpp-field-evaluator.wasm",
        "field-evaluator-worker.js",
      ].map((name) => {
        const path = resolve(distDirectory, name);
        return [name, { bytes: statSync(path).size, sha256: sha256(path) }];
      })),
    },
    serial: publicRecord(serial),
    pool: publicRecord(pool),
    correctness,
    comparison: {
      primaryFieldSpeedup,
      primaryEndToEndSpeedup,
      secondaryParallelToSerialRatio: secondaryRatio,
    },
    gates,
    ok: Object.values(gates).every(Boolean),
  };
  mkdirSync(outputDirectory, { recursive: true });
  const outputPath = resolve(outputDirectory, "far-field-wp4-production.json");
  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ outputPath, ...output.comparison, gates })}\n`);
  if (!output.ok) process.exitCode = 1;
}

await main();
