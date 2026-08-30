import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { cpus, platform, release, totalmem } from "node:os";
import { dirname, resolve } from "node:path";

import { FIELD_REQUEST, REPRESENTATIONS } from "./array-case.mjs";

const SCHEMA_VERSION = 2;
const PROTOCOL_ID = "symmetry-reference-array-v1";
const packageDirectory = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(packageDirectory, "../..");
const caseScript = resolve(import.meta.dirname, "array-case.mjs");
const invocationDirectory = process.env.INIT_CWD ?? process.cwd();

const HELP = `WASM reference-array symmetry benchmark

Usage:
  node bench/array-benchmark.mjs [options]

Options:
  --sides LIST                 Comma list/ranges (default: 2,4,8,12,16)
  --segments N                 Odd segments per dipole (default: 11)
  --frequency-mhz N            Frequency in MHz (default: 300)
  --backends LIST              explicit,manual-reflection,auto-reflection,deck
  --rounds N                   Fresh processes per case (default: 3)
  --retained-solves N          Changed-current solves after the cold path (default: 10)
  --z-matrix-sides LIST        Full caller-order Z/Y extraction (default: 2,4)
  --timeout-seconds N          Per child process (default: 600)
  --equivalence-tolerance N    Binary64 relative L2 and scaled-max gate (default: 1e-8)
  --module-directory PATH      Built package directory containing index.js and nec2pp.wasm
  --baseline-summary PATH      Compatible pre-feature explicit summary for regression ratios
  --output PATH                Incremental NDJSON plus adjacent .summary.json
  --overwrite                  Replace an existing output
  --fail-fast                  Stop after the first case or correctness failure
  --help                       Show this help
`;

function parseInteger(value, name, minimum = 1) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return parsed;
}

function parseSides(value, name = "side") {
  const sides = new Set();
  if (value === "") return [];
  for (const part of value.split(",")) {
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range !== null) {
      const start = parseInteger(range[1], name);
      const end = parseInteger(range[2], name);
      if (end < start) throw new Error(`${name} range ${part} is descending`);
      for (let side = start; side <= end; side += 1) sides.add(side);
    } else {
      sides.add(parseInteger(part, name));
    }
  }
  return [...sides].sort((left, right) => left - right);
}

function parseArguments(argv) {
  const options = {
    sides: "2,4,8,12,16",
    segments: "11",
    frequencyMHz: "300",
    backends: REPRESENTATIONS.join(","),
    rounds: "3",
    retainedSolves: "10",
    zMatrixSides: "2,4",
    timeoutSeconds: "600",
    equivalenceTolerance: "1e-8",
    moduleDirectory: resolve(packageDirectory, "dist"),
    baselineSummary: undefined,
    output: undefined,
    overwrite: false,
    failFast: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--overwrite" || argument === "--fail-fast") {
      options[argument === "--overwrite" ? "overwrite" : "failFast"] = true;
      continue;
    }
    if (!argument.startsWith("--") || argv[index + 1] === undefined) {
      throw new Error(`invalid argument near ${argument}`);
    }
    const mappings = {
      sides: "sides",
      segments: "segments",
      "frequency-mhz": "frequencyMHz",
      backends: "backends",
      rounds: "rounds",
      "retained-solves": "retainedSolves",
      "z-matrix-sides": "zMatrixSides",
      "timeout-seconds": "timeoutSeconds",
      "equivalence-tolerance": "equivalenceTolerance",
      "module-directory": "moduleDirectory",
      "baseline-summary": "baselineSummary",
      output: "output",
    };
    const key = mappings[argument.slice(2)];
    if (key === undefined) throw new Error(`unknown option ${argument}`);
    options[key] = argv[index + 1];
    index += 1;
  }

  const segments = parseInteger(options.segments, "segments");
  if (segments % 2 === 0) throw new Error("segments must be odd");
  const requestedBackends = options.backends.split(",").map((backend) =>
    backend === "stateful" ? "explicit" : backend);
  if (requestedBackends.length === 0
      || requestedBackends.some((backend) => !REPRESENTATIONS.includes(backend) && backend !== "deck")) {
    throw new Error(`backends must contain ${[...REPRESENTATIONS, "deck"].join(", ")}`);
  }
  const backends = [...new Set(requestedBackends)].sort((left, right) =>
    [...REPRESENTATIONS, "deck"].indexOf(left) - [...REPRESENTATIONS, "deck"].indexOf(right));
  if (backends.some((backend) => backend.endsWith("reflection")) && !backends.includes("explicit")) {
    throw new Error("reflection performance requires explicit in --backends as its correctness oracle");
  }
  const sides = parseSides(options.sides);
  if (backends.some((backend) => backend.endsWith("reflection"))
      && sides.some((side) => side % 2 !== 0)) {
    throw new Error("manual and automatic reflection require even --sides");
  }
  const zMatrixSides = parseSides(options.zMatrixSides, "Z-matrix side");
  if (zMatrixSides.some((side) => !sides.includes(side))) {
    throw new Error("z-matrix-sides must be a subset of sides");
  }
  const frequencyMHz = Number(options.frequencyMHz);
  const equivalenceTolerance = Number(options.equivalenceTolerance);
  if (!(frequencyMHz > 0) || !Number.isFinite(frequencyMHz)) {
    throw new Error("frequency-mhz must be positive and finite");
  }
  if (!(equivalenceTolerance >= 0) || !Number.isFinite(equivalenceTolerance)) {
    throw new Error("equivalence-tolerance must be finite and nonnegative");
  }
  const resolveOptional = (value) => value === undefined
    ? undefined
    : resolve(invocationDirectory, value);
  return {
    sides,
    segments,
    frequencyMHz,
    backends,
    rounds: parseInteger(options.rounds, "rounds"),
    retainedSolves: parseInteger(options.retainedSolves, "retained-solves", 0),
    zMatrixSides,
    timeoutMs: parseInteger(options.timeoutSeconds, "timeout-seconds") * 1000,
    equivalenceTolerance,
    moduleDirectory: resolve(invocationDirectory, options.moduleDirectory),
    baselineSummary: resolveOptional(options.baselineSummary),
    output: resolveOptional(options.output),
    overwrite: options.overwrite,
    failFast: options.failFast,
  };
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function stats(values) {
  const finite = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  return finite.length === 0
    ? { median: null, min: null, max: null }
    : { median: median(finite), min: Math.min(...finite), max: Math.max(...finite) };
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function commandOutput(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function packageVersionFor(moduleDirectory) {
  const packageJsonPath = resolve(moduleDirectory, "../package.json");
  return existsSync(packageJsonPath)
    ? JSON.parse(readFileSync(packageJsonPath, "utf8")).version
    : null;
}

function buildMetadata(options) {
  const wasmPath = resolve(options.moduleDirectory, "nec2pp.wasm");
  const indexPath = resolve(options.moduleDirectory, "index.js");
  if (!existsSync(wasmPath) || !existsSync(indexPath)) {
    throw new Error(`${options.moduleDirectory} must contain index.js and nec2pp.wasm`);
  }
  const rootCmake = readFileSync(resolve(repositoryRoot, "CMakeLists.txt"), "utf8");
  const stackMatch = rootCmake.match(/set\(NECPP_WASM_STACK_SIZE\s+(\d+)/);
  const dockerScript = readFileSync(resolve(repositoryRoot, "scripts/build_wasm_docker.ps1"), "utf8");
  const emscriptenMatch = dockerScript.match(/emscripten\/emsdk:([^"\s]+)/);
  const gitStatus = (commandOutput("git", ["status", "--porcelain=v1"]) ?? "")
    .split(/\r?\n/).filter(Boolean);
  return {
    type: "metadata",
    schemaVersion: SCHEMA_VERSION,
    protocol: {
      id: PROTOCOL_ID,
      description: "lambda-scaled Z dipoles over perfect ground; binary64 caller-order checks",
    },
    startedAt: new Date().toISOString(),
    packageVersion: packageVersionFor(options.moduleDirectory),
    nodeVersion: process.version,
    operatingSystem: `${platform()} ${release()}`,
    architecture: process.arch,
    cpuModel: cpus()[0]?.model?.trim() ?? "unknown",
    logicalCpuCount: cpus().length,
    physicalMemoryBytes: totalmem(),
    gitCommit: commandOutput("git", ["rev-parse", "HEAD"]),
    gitDirty: gitStatus.length > 0,
    gitStatus,
    emscriptenVersion: emscriptenMatch?.[1] ?? null,
    wasmStackSizeBytes: stackMatch === null ? null : Number(stackMatch[1]),
    artifact: {
      moduleDirectory: options.moduleDirectory,
      wasmBytes: statSync(wasmPath).size,
      wasmSha256: sha256(wasmPath),
      indexSha256: sha256(indexPath),
    },
    model: {
      frequencyMHz: options.frequencyMHz,
      dipoleLengthWavelengths: 1 / 3,
      centerHeightWavelengths: 1 / 4,
      spacingWavelengths: 1 / 2,
      radiusWavelengths: 1 / 1000,
      segmentsPerDipole: options.segments,
      feedSegment: (options.segments + 1) / 2,
      ground: { kind: "perfect" },
      groundConnection: "none",
      fieldRequest: FIELD_REQUEST,
      currentWeights: "off-broadside deterministic amplitude/phase taper",
    },
    tolerances: {
      complexRelativeL2: options.equivalenceTolerance,
      complexScaledMax: options.equivalenceTolerance,
    },
    options: { ...options },
  };
}

function parseChildResult(result, identity) {
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  let record;
  try {
    record = JSON.parse(lines.at(-1) ?? "");
  } catch {
    const timedOut = result.error?.code === "ETIMEDOUT";
    record = {
      type: "case",
      schemaVersion: SCHEMA_VERSION,
      ok: false,
      ...identity,
      error: {
        category: timedOut ? "timeout" : result.signal !== null ? "wasm-trap" : "runtime",
        name: result.error?.name ?? "ChildProcessError",
        message: result.error?.message
          ?? `benchmark child exited ${result.status}: ${stderr.trim()}`,
        signal: result.signal,
      },
    };
  }
  if (result.status !== 0 && record.ok !== false) {
    record.ok = false;
    record.error = {
      category: result.error?.code === "ETIMEDOUT" ? "timeout" : "wasm-trap",
      name: result.error?.name ?? "ChildProcessError",
      message: result.error?.message ?? `benchmark child exited ${result.status}: ${stderr.trim()}`,
      signal: result.signal,
    };
  }
  return record;
}

function complexMetrics(left, right) {
  if (left.real.length !== right.real.length || left.imag.length !== right.imag.length
      || left.real.length !== left.imag.length) {
    throw new Error("complex result lengths differ");
  }
  let deltaSquared = 0;
  let baselineSquared = 0;
  let maxDelta = 0;
  let maxBaseline = 0;
  for (let index = 0; index < left.real.length; index += 1) {
    const values = [left.real[index], left.imag[index], right.real[index], right.imag[index]];
    if (!values.every(Number.isFinite)) throw new Error(`non-finite complex value at ${index}`);
    const delta = Math.hypot(left.real[index] - right.real[index], left.imag[index] - right.imag[index]);
    const baseline = Math.hypot(right.real[index], right.imag[index]);
    deltaSquared += delta * delta;
    baselineSquared += baseline * baseline;
    maxDelta = Math.max(maxDelta, delta);
    maxBaseline = Math.max(maxBaseline, baseline);
  }
  return {
    relativeL2: Math.sqrt(deltaSquared) / Math.max(Math.sqrt(baselineSquared), 1e-300),
    scaledMax: maxDelta / Math.max(maxBaseline, 1e-300),
  };
}

function realMetrics(left, right) {
  return complexMetrics({ real: left, imag: left.map(() => 0) }, {
    real: right,
    imag: right.map(() => 0),
  });
}

function comparisonRecord(candidate, baseline, tolerance) {
  const metrics = {};
  try {
    for (const name of ["requested", "voltages", "currents", "activeImpedances"]) {
      metrics[`solution.${name}`] = complexMetrics(
        candidate.solution[name],
        baseline.solution[name],
      );
    }
    metrics["solution.powersW"] = realMetrics(candidate.solution.powersW, baseline.solution.powersW);
    if (JSON.stringify(candidate.field.thetaDeg) !== JSON.stringify(baseline.field.thetaDeg)
        || JSON.stringify(candidate.field.phiDeg) !== JSON.stringify(baseline.field.phiDeg)) {
      throw new Error("far-field angle grids differ");
    }
    metrics["field.eTheta"] = complexMetrics(candidate.field.eTheta, baseline.field.eTheta);
    metrics["field.ePhi"] = complexMetrics(candidate.field.ePhi, baseline.field.ePhi);
    if ((candidate.matrices === undefined) !== (baseline.matrices === undefined)) {
      throw new Error("matrix extraction presence differs");
    }
    if (candidate.matrices !== undefined) {
      if (candidate.matrices.order !== baseline.matrices.order) throw new Error("matrix orders differ");
      metrics["matrix.Z"] = complexMetrics(candidate.matrices.impedance, baseline.matrices.impedance);
      metrics["matrix.Y"] = complexMetrics(candidate.matrices.admittance, baseline.matrices.admittance);
    }
    const withinTolerance = Object.values(metrics).every((metric) =>
      metric.relativeL2 <= tolerance && metric.scaledMax <= tolerance);
    return { withinTolerance, metrics };
  } catch (error) {
    return { withinTolerance: false, metrics, error: error.message };
  }
}

function caseSummary(records, backend, side, segments) {
  const matches = records.filter((record) => record.backend === backend && record.side === side);
  const successes = matches.filter((record) => record.ok);
  const timingKeys = backend === "deck"
    ? ["deckBuildMs", "runDeckMs", "coldTotalMs"]
    : [
      "analysisMs", "instantiateMs", "geometryConstructionMs", "geometryCompletionMs",
      "portEnvironmentMs", "prepareMs", "firstSolveMs", "combinedFarFieldMs",
      "impedanceMatrixMs", "retainedSolveMedianMs", "coldTotalMs", "totalWithRetainedSolvesMs",
    ];
  return {
    backend,
    side,
    equations: side * side * segments,
    successCount: successes.length,
    failureCount: matches.length - successes.length,
    failureCategories: matches.filter((record) => !record.ok).map((record) => record.error?.category),
    timingStatsMs: Object.fromEntries(timingKeys.map((key) => [
      key,
      stats(successes.map((record) => record.timings?.[key])),
    ])),
    memoryStatsBytes: backend === "deck" ? undefined : {
      peakObservedRssDelta: stats(successes.map((record) => record.memory?.peakObservedRssDeltaBytes)),
      primaryInteractionMatrix: stats(successes.map((record) => record.memory?.primaryInteractionMatrixBytes)),
    },
  };
}

function performanceRatios(cases, comparisons, options, baseline) {
  const ratios = [];
  const caseAt = (backend, side) => cases.find((value) => value.backend === backend && value.side === side);
  for (const side of options.sides) {
    const explicit = caseAt("explicit", side);
    if (explicit === undefined || explicit.successCount !== options.rounds) continue;
    const candidates = {};
    for (const backend of ["manual-reflection", "auto-reflection"]) {
      const candidate = caseAt(backend, side);
      const checks = comparisons.filter((value) => value.backend === backend && value.side === side);
      if (candidate === undefined || candidate.successCount !== options.rounds
          || checks.length !== options.rounds || checks.some((value) => !value.withinTolerance)) continue;
      candidates[backend] = candidate;
    }
    const manual = candidates["manual-reflection"];
    const auto = candidates["auto-reflection"];
    const result = { side, correctnessPassed: true };
    if (manual !== undefined) {
      result.manualPrepareSpeedup = explicit.timingStatsMs.prepareMs.median
        / manual.timingStatsMs.prepareMs.median;
      result.manualMatrixReduction = explicit.memoryStatsBytes.primaryInteractionMatrix.median
        / manual.memoryStatsBytes.primaryInteractionMatrix.median;
    }
    if (auto !== undefined) {
      result.autoPlannerMs = auto.timingStatsMs.analysisMs.median;
      result.autoPlannerColdPercent = 100 * auto.timingStatsMs.analysisMs.median
        / auto.timingStatsMs.coldTotalMs.median;
    }
    if (manual !== undefined && auto !== undefined) {
      result.autoVsManualPrepareDeltaPercent = 100
        * (auto.timingStatsMs.prepareMs.median - manual.timingStatsMs.prepareMs.median)
        / manual.timingStatsMs.prepareMs.median;
    }
    const baselineCase = baseline?.cases?.find((value) =>
      value.backend === "explicit" && value.side === side);
    if (baselineCase?.timingStatsMs?.prepareMs?.median > 0) {
      result.explicitVsBaselinePrepareDeltaPercent = 100
        * (explicit.timingStatsMs.prepareMs.median - baselineCase.timingStatsMs.prepareMs.median)
        / baselineCase.timingStatsMs.prepareMs.median;
    }
    ratios.push(result);
  }
  return ratios;
}

function evaluatePerformanceGates(ratios, baselineProvided) {
  const at16 = ratios.find(({ side }) => side === 16);
  const large = ratios.filter(({ side }) => side >= 8);
  const parityValues = large.filter((value) =>
    typeof value.autoVsManualPrepareDeltaPercent === "number");
  const plannerValues = large.filter((value) =>
    typeof value.autoPlannerColdPercent === "number");
  const regressionValues = ratios.filter((value) =>
    typeof value.explicitVsBaselinePrepareDeltaPercent === "number");
  const gates = {
    manualPrepare8xAt16: at16?.manualPrepareSpeedup === undefined
      ? { status: "not-evaluated" }
      : { status: at16.manualPrepareSpeedup >= 8 ? "pass" : "miss", value: at16.manualPrepareSpeedup },
    autoManualPrepareParity5Percent: parityValues.length === 0
      ? { status: "not-evaluated" }
      : {
        status: parityValues.every((value) => Math.abs(value.autoVsManualPrepareDeltaPercent) <= 5)
          ? "pass" : "miss",
        values: parityValues.map(({ side, autoVsManualPrepareDeltaPercent }) =>
          ({ side, value: autoVsManualPrepareDeltaPercent })),
      },
    autoPlannerBelow5Percent: plannerValues.length === 0
      ? { status: "not-evaluated" }
      : {
        status: plannerValues.every((value) => value.autoPlannerColdPercent < 5) ? "pass" : "miss",
        values: plannerValues.map(({ side, autoPlannerColdPercent }) =>
          ({ side, value: autoPlannerColdPercent })),
      },
    explicitRegression5Percent: !baselineProvided
      ? { status: "not-evaluated", reason: "no --baseline-summary" }
      : {
        status: regressionValues.length === ratios.length
          && regressionValues.every((value) => value.explicitVsBaselinePrepareDeltaPercent <= 5)
          ? "pass" : "miss",
        values: regressionValues.map(({ side, explicitVsBaselinePrepareDeltaPercent }) => ({
          side,
          value: explicitVsBaselinePrepareDeltaPercent,
        })),
      },
  };
  return {
    ...gates,
    hasMiss: Object.values(gates).some((gate) => gate.status === "miss"),
  };
}

function loadBaseline(path, options) {
  if (path === undefined) return undefined;
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (value.schemaVersion !== SCHEMA_VERSION || value.metadata?.protocol?.id !== PROTOCOL_ID) {
    throw new Error("baseline summary uses an incompatible schema or protocol");
  }
  const baselineOptions = value.metadata.options;
  if (baselineOptions.segments !== options.segments
      || baselineOptions.frequencyMHz !== options.frequencyMHz
      || JSON.stringify(baselineOptions.sides) !== JSON.stringify(options.sides)) {
    throw new Error("baseline summary geometry options do not match this run");
  }
  return value;
}

function validateBaselineEnvironment(baseline, metadata) {
  if (baseline === undefined) return;
  for (const key of [
    "nodeVersion",
    "operatingSystem",
    "architecture",
    "cpuModel",
    "emscriptenVersion",
    "wasmStackSizeBytes",
  ]) {
    if (baseline.metadata[key] !== metadata[key]) {
      throw new Error(`baseline ${key} does not match this run`);
    }
  }
}

function summaryPath(output) {
  return output.endsWith(".ndjson")
    ? `${output.slice(0, -".ndjson".length)}.summary.json`
    : `${output}.summary.json`;
}

function main() {
  if (process.argv.slice(2).includes("--help")) {
    process.stdout.write(HELP);
    return;
  }
  const options = parseArguments(process.argv.slice(2));
  const baseline = loadBaseline(options.baselineSummary, options);
  if (options.output !== undefined) {
    if (existsSync(options.output) && !options.overwrite) {
      throw new Error(`${options.output} already exists; pass --overwrite to replace it`);
    }
    mkdirSync(dirname(options.output), { recursive: true });
    writeFileSync(options.output, "");
  }
  const emit = (record) => {
    const line = `${JSON.stringify(record)}\n`;
    process.stdout.write(line);
    if (options.output !== undefined) appendFileSync(options.output, line);
  };

  const metadata = buildMetadata(options);
  validateBaselineEnvironment(baseline, metadata);
  emit(metadata);
  const records = [];
  const comparisons = [];
  const correctnessPayloads = new Map();
  let hasFailure = false;
  for (const side of options.sides) {
    for (let round = 1; round <= options.rounds; round += 1) {
      for (const backend of options.backends) {
        const identity = {
          backend,
          side,
          round,
          segmentsPerDipole: options.segments,
          equations: side * side * options.segments,
          ports: side * side,
          frequencyMHz: options.frequencyMHz,
        };
        const child = spawnSync(process.execPath, [
          caseScript,
          "--backend", backend,
          "--side", String(side),
          "--segments", String(options.segments),
          "--frequency-mhz", String(options.frequencyMHz),
          "--retained-solves", String(options.retainedSolves),
          "--extract-matrix", String(options.zMatrixSides.includes(side)),
          "--module-directory", options.moduleDirectory,
          "--round", String(round),
        ], {
          cwd: packageDirectory,
          encoding: "utf8",
          timeout: options.timeoutMs,
          maxBuffer: 64 * 1024 * 1024,
          windowsHide: true,
        });
        const record = parseChildResult(child, identity);
        const correctness = record.correctness;
        delete record.correctness;
        records.push(record);
        emit(record);
        if (!record.ok) {
          hasFailure = true;
          if (options.failFast) break;
          continue;
        }
        if (correctness !== undefined) {
          correctnessPayloads.set(`${side}:${round}:${backend}`, correctness);
        }
        if (backend.endsWith("reflection")) {
          const explicit = correctnessPayloads.get(`${side}:${round}:explicit`);
          const comparison = {
            type: "comparison",
            schemaVersion: SCHEMA_VERSION,
            backend,
            side,
            round,
            equations: identity.equations,
            ...(explicit === undefined
              ? { withinTolerance: false, error: "explicit correctness payload is unavailable" }
              : comparisonRecord(correctness, explicit, options.equivalenceTolerance)),
          };
          if (!comparison.withinTolerance) {
            comparison.failureCategory = "correctness";
            hasFailure = true;
          }
          comparisons.push(comparison);
          emit(comparison);
          if (options.failFast && !comparison.withinTolerance) break;
        }
      }
      if (options.failFast && hasFailure) break;
    }
    if (options.failFast && hasFailure) break;
  }

  const cases = options.sides.flatMap((side) => options.backends.map((backend) =>
    caseSummary(records, backend, side, options.segments)));
  const ratios = performanceRatios(cases, comparisons, options, baseline);
  const performanceGates = evaluatePerformanceGates(ratios, baseline !== undefined);
  const summary = {
    type: "summary",
    schemaVersion: SCHEMA_VERSION,
    completedAt: new Date().toISOString(),
    hasFailure,
    numericalChecksPassed: !hasFailure,
    cases,
    comparisons,
    performanceRatios: hasFailure ? [] : ratios,
    performanceGates: hasFailure
      ? { status: "suppressed", reason: "case or numerical correctness failure" }
      : performanceGates,
    baselineArtifact: baseline?.metadata?.artifact,
  };
  emit(summary);
  if (options.output !== undefined) {
    writeFileSync(summaryPath(options.output), `${JSON.stringify({ metadata, ...summary }, null, 2)}\n`);
  }
  if (hasFailure) process.exitCode = 1;
}

main();
