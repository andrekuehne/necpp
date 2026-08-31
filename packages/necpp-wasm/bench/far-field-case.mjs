import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { basename, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  PRIMARY_FIELD_GRID,
  STEERING_POINTS,
  complexVectorChecksum,
  createFarFieldFixture,
  farFieldChecksum,
  fixtureManifest,
  sourceGridForDisplay,
  steeringCurrents,
} from "./far-field-fixture-v1.mjs";

export const FAR_FIELD_BENCHMARK_SCHEMA_VERSION = 1;
export const FAR_FIELD_BACKENDS = Object.freeze(["direct", "worker"]);
export const FAR_FIELD_GRIDS = Object.freeze(["primary", "secondary"]);
const repositoryRoot = resolve(import.meta.dirname, "..", "..", "..");

function parseBoolean(value, name) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

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
  const backend = values.get("backend");
  const grid = values.get("grid");
  if (!FAR_FIELD_BACKENDS.includes(backend)) {
    throw new Error(`--backend must be ${FAR_FIELD_BACKENDS.join(" or ")}`);
  }
  if (!FAR_FIELD_GRIDS.includes(grid)) {
    throw new Error(`--grid must be ${FAR_FIELD_GRIDS.join(" or ")}`);
  }
  const round = Number(values.get("round"));
  if (!Number.isSafeInteger(round)) {
    throw new Error("--round must be an integer");
  }
  return {
    backend,
    grid,
    round,
    moduleDirectory: resolve(values.get("module-directory")),
    extractMatrix: parseBoolean(values.get("extract-matrix") ?? "true", "--extract-matrix"),
    variant: values.get("variant") ?? "release-scalar",
    buildFlags: values.get("build-flags") ?? "unknown",
    requireDiagnostics: parseBoolean(
      values.get("require-diagnostics") ?? "true",
      "--require-diagnostics",
    ),
    steeringLimit: Number(values.get("steering-limit") ?? STEERING_POINTS.length),
    reuseGrid: parseBoolean(values.get("reuse-grid") ?? "true", "--reuse-grid"),
  };
}

function commandOutput(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function sha256File(path) {
  if (!existsSync(path)) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function memorySnapshot() {
  const usage = process.memoryUsage();
  return {
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
    heapTotalBytes: usage.heapTotal,
    externalBytes: usage.external,
    arrayBuffersBytes: usage.arrayBuffers,
  };
}

function cpuDelta(start) {
  const delta = process.cpuUsage(start);
  return {
    userMs: delta.user / 1000,
    systemMs: delta.system / 1000,
    totalMs: (delta.user + delta.system) / 1000,
  };
}

async function timed(operation) {
  const cpuStart = process.cpuUsage();
  const wallStart = performance.now();
  const value = await operation();
  return {
    value,
    wallMs: performance.now() - wallStart,
    cpu: cpuDelta(cpuStart),
  };
}

function fieldBytes(field) {
  return field.thetaDeg.byteLength
    + field.phiDeg.byteLength
    + field.eThetaReal.byteLength
    + field.eThetaImag.byteLength
    + field.ePhiReal.byteLength
    + field.ePhiImag.byteLength;
}

function representativeFieldSamples(field) {
  const indices = [...new Set([
    0,
    Math.floor(field.eThetaReal.length / 2),
    field.eThetaReal.length - 1,
  ])];
  return indices.map((index) => ({
    index,
    eThetaReal: field.eThetaReal[index],
    eThetaImag: field.eThetaImag[index],
    ePhiReal: field.ePhiReal[index],
    ePhiImag: field.ePhiImag[index],
  }));
}

function assertExplicitFallback(diagnostics) {
  if (diagnostics.representation !== "explicit") {
    throw new Error(`fixture unexpectedly selected ${diagnostics.representation} representation`);
  }
  const reasons = diagnostics.planner?.reasons ?? diagnostics.reasons ?? [];
  if (!reasons.some(({ code }) => code === "UNSUPPORTED_ELEMENT_PATTERN_TRANSFORM")) {
    throw new Error("fixture did not report UNSUPPORTED_ELEMENT_PATTERN_TRANSFORM");
  }
}

async function createDirectAdapter(api, fixture) {
  const creation = await timed(() => api.createNecModel());
  const model = creation.value;
  const construction = await timed(async () => {
    for (const wire of fixture.wires) model.addWire(wire);
    model.completeGeometry({ groundConnection: fixture.groundConnection });
    model.definePorts(fixture.ports.map(({ tag, segment }) => ({ tag, segment })));
    model.setGround(fixture.ground);
  });
  const plan = api.analyzeArraySymmetry(fixture.description, { positionEpsilonM: 0 });
  const diagnostics = {
    representation: plan.kind,
    planner: plan.diagnostics,
  };
  assertExplicitFallback(diagnostics);
  return {
    model,
    timings: { createMs: creation.wallMs, constructionMs: construction.wallMs },
    cpu: { create: creation.cpu, construction: construction.cpu },
    diagnostics,
    expectedTransferredBuffers: 0,
  };
}

async function createWorkerAdapter(api, fixture) {
  const creation = await timed(() => api.createNecArraySolver(fixture.description, {
    symmetry: "auto",
    symmetrizer: { positionEpsilonM: 0 },
  }));
  const model = creation.value;
  const diagnostics = model.getDiagnostics();
  assertExplicitFallback(diagnostics);
  return {
    model,
    timings: { createMs: creation.wallMs, constructionMs: null },
    cpu: { create: creation.cpu, construction: null },
    diagnostics,
    // theta, phi, and four split-complex component buffers.
    expectedTransferredBuffers: 6,
  };
}

export async function runFarFieldCase(options) {
  const steeringLimit = options.steeringLimit ?? STEERING_POINTS.length;
  if (!Number.isSafeInteger(steeringLimit)
      || steeringLimit < 1
      || steeringLimit > STEERING_POINTS.length) {
    throw new Error(`steeringLimit must be between 1 and ${STEERING_POINTS.length}`);
  }
  const fixture = createFarFieldFixture();
  const grid = options.grid === "primary"
    ? PRIMARY_FIELD_GRID
    : sourceGridForDisplay(fixture, 32, 32);
  const moduleUrl = pathToFileURL(resolve(options.moduleDirectory, "index.js")).href;
  const api = await import(moduleUrl);
  const memorySamples = [{ phase: "before-create", ...memorySnapshot() }];
  const totalCpuStart = process.cpuUsage();
  const totalStart = performance.now();
  const adapter = options.backend === "direct"
    ? await createDirectAdapter(api, fixture)
    : await createWorkerAdapter(api, fixture);
  const model = adapter.model;
  memorySamples.push({ phase: "after-create", ...memorySnapshot() });

  try {
    const prepare = await timed(() => model.prepare({ frequencyMHz: fixture.frequencyMHz }));
    memorySamples.push({ phase: "after-prepare", ...memorySnapshot() });
    const matrix = options.extractMatrix
      ? await timed(() => model.computeImpedanceMatrix())
      : null;
    memorySamples.push({ phase: "after-matrix", ...memorySnapshot() });

    const steering = [];
    let factorizationGeneration = matrix?.value.factorizationGeneration ?? null;
    for (let index = 0; index < steeringLimit; index += 1) {
      const point = STEERING_POINTS[index];
      const requested = steeringCurrents(fixture, point);
      const solve = await timed(() => model.solveCurrents(requested));
      if (factorizationGeneration === null) {
        factorizationGeneration = solve.value.factorizationGeneration;
      }
      if (solve.value.factorizationGeneration !== factorizationGeneration) {
        throw new Error("retained steering changed the factorization generation");
      }
      if (solve.value.solveGeneration !== index + 1) {
        throw new Error(
          `solve generation ${solve.value.solveGeneration} does not match steering ${index + 1}`,
        );
      }

      const field = await timed(() => model.computeFarField(grid));
      const fieldDiagnostics = field.value.diagnostics;
      if (options.requireDiagnostics && fieldDiagnostics?.instrumentationEnabled !== true) {
        throw new Error("far-field benchmark requires an instrumentation-enabled artifact");
      }
      const expectedSamples = grid.theta.count * grid.phi.count;
      if (field.value.eThetaReal.length !== expectedSamples
          || field.value.ePhiImag.length !== expectedSamples) {
        throw new Error("far-field extraction returned the wrong sample count");
      }
      steering.push({
        index,
        point,
        initial: index === 0,
        solve: {
          wallMs: solve.wallMs,
          cpu: solve.cpu,
          factorizationGeneration: solve.value.factorizationGeneration,
          solveGeneration: solve.value.solveGeneration,
        },
        field: {
          wallMs: field.wallMs,
          cpu: field.cpu,
          samples: expectedSamples,
          resultBytes: fieldBytes(field.value),
          expectedTransferredBuffers: adapter.expectedTransferredBuffers,
          phases: fieldDiagnostics,
          facadeResidualMs: fieldDiagnostics === undefined
            ? null
            : Math.max(0, field.wallMs - fieldDiagnostics.packageTotalMs),
        },
        checksums: {
          requestedCurrents: complexVectorChecksum(requested),
          achievedCurrents: complexVectorChecksum(solve.value.currents),
          field: farFieldChecksum(field.value),
        },
        representativeFieldSamples: representativeFieldSamples(field.value),
      });
      memorySamples.push({ phase: `after-steering-${index}`, ...memorySnapshot() });
    }

    // A changed field grid must reuse the latest solve and factorization.
    const reuseGrid = options.reuseGrid === false
      ? null
      : options.grid === "primary"
        ? sourceGridForDisplay(fixture, 32, 32)
        : PRIMARY_FIELD_GRID;
    const secondGridField = reuseGrid === null
      ? null
      : await timed(() => model.computeFarField(reuseGrid));
    const last = steering.at(-1);
    const disposeStart = performance.now();
    await model.dispose();
    const disposeMs = performance.now() - disposeStart;
    memorySamples.push({ phase: "after-dispose", ...memorySnapshot() });
    const peakRssBytes = Math.max(...memorySamples.map(({ rssBytes }) => rssBytes));
    const gitStatus = (commandOutput("git", ["status", "--porcelain=v1"]) ?? "")
      .split(/\r?\n/).filter(Boolean);
    const dockerScript = readFileSync(
      resolve(repositoryRoot, "scripts", "build_wasm_docker.ps1"),
      "utf8",
    );
    const emscriptenVersion = dockerScript.match(/emscripten\/emsdk:([^"\s]+)/)?.[1] ?? null;
    const cmake = readFileSync(resolve(repositoryRoot, "CMakeLists.txt"), "utf8");
    const wasmStackSizeBytes = Number(
      cmake.match(/set\(NECPP_WASM_STACK_SIZE\s+(\d+)/)?.[1] ?? Number.NaN,
    );
    const artifact = (name) => {
      const path = resolve(options.moduleDirectory, name);
      return {
        file: basename(path),
        bytes: existsSync(path) ? statSync(path).size : null,
        sha256: sha256File(path),
      };
    };

    return {
      type: "far-field-case",
      schemaVersion: FAR_FIELD_BENCHMARK_SCHEMA_VERSION,
      ok: true,
      backend: options.backend,
      grid: options.grid,
      round: options.round,
      variant: options.variant,
      buildFlags: options.buildFlags,
      fixture: fixtureManifest(),
      selectedGrid: grid,
      representation: adapter.diagnostics,
      environment: {
        measuredAt: new Date().toISOString(),
        engineCommit: commandOutput("git", ["rev-parse", "HEAD"]),
        gitDirty: gitStatus.length > 0,
        gitStatus,
        packageVersion: api.packageVersion,
        engineVersion: api.engineVersion,
        abiVersion: api.abiVersion,
        node: process.version,
        v8: process.versions.v8,
        platform: platform(),
        release: release(),
        architecture: arch(),
        cpu: cpus()[0]?.model ?? "unknown",
        logicalCpuCount: cpus().length,
        totalMemoryBytes: totalmem(),
        toolchain: {
          emscriptenVersion,
          wasmStackSizeBytes: Number.isFinite(wasmStackSizeBytes)
            ? wasmStackSizeBytes
            : null,
          buildFlags: options.buildFlags,
        },
        artifacts: {
          moduleDirectory: options.moduleDirectory,
          index: artifact("index.js"),
          generatedJs: artifact("nec2pp.generated.js"),
          wasm: artifact("nec2pp.wasm"),
        },
      },
      timings: {
        ...adapter.timings,
        prepareMs: prepare.wallMs,
        matrixMs: matrix?.wallMs ?? null,
        secondGridFieldMs: secondGridField?.wallMs ?? null,
        disposeMs,
        totalMs: performance.now() - totalStart,
      },
      cpu: {
        ...adapter.cpu,
        prepare: prepare.cpu,
        matrix: matrix?.cpu ?? null,
        secondGridField: secondGridField?.cpu ?? null,
        total: cpuDelta(totalCpuStart),
      },
      generations: {
        factorization: factorizationGeneration,
        firstSolve: steering[0].solve.solveGeneration,
        lastSolve: last.solve.solveGeneration,
        secondGridAfterSolve: last.solve.solveGeneration,
      },
      secondGridReuse: secondGridField === null
        ? null
        : {
            grid: reuseGrid,
            samples: secondGridField.value.eThetaReal.length,
            resultBytes: fieldBytes(secondGridField.value),
            checksum: farFieldChecksum(secondGridField.value),
          },
      steering,
      memory: {
        samples: memorySamples,
        peakRssBytes,
        peakObservedRssDeltaBytes: peakRssBytes - memorySamples[0].rssBytes,
      },
    };
  } catch (error) {
    try {
      await model.dispose();
    } catch {
      // Preserve the benchmark failure that triggered cleanup.
    }
    throw error;
  }
}

function serializeError(error) {
  return {
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
    code: error?.code,
    stack: error?.stack,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  try {
    process.stdout.write(`${JSON.stringify(await runFarFieldCase(options))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      type: "far-field-case",
      schemaVersion: FAR_FIELD_BENCHMARK_SCHEMA_VERSION,
      ok: false,
      backend: options.backend,
      grid: options.grid,
      round: options.round,
      variant: options.variant,
      error: serializeError(error),
    })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined
    && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
