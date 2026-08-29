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

const packageDirectory = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(packageDirectory, "../..");
const caseScript = resolve(import.meta.dirname, "array-case.mjs");
const invocationDirectory = process.env.INIT_CWD ?? process.cwd();

function parseInteger(value, name, minimum = 1) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return parsed;
}

function parseSides(value) {
  const sides = new Set();
  for (const part of value.split(",")) {
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range !== null) {
      const start = parseInteger(range[1], "side");
      const end = parseInteger(range[2], "side");
      if (end < start) {
        throw new Error(`side range ${part} is descending`);
      }
      for (let side = start; side <= end; side += 1) {
        sides.add(side);
      }
    } else {
      sides.add(parseInteger(part, "side"));
    }
  }
  return [...sides].sort((left, right) => left - right);
}

function parseArguments(argv) {
  const options = {
    sides: "2-16",
    segments: "11",
    frequencyMHz: "300",
    backends: "stateful,deck",
    rounds: "1",
    retainedSolves: "10",
    timeoutSeconds: "600",
    equivalenceTolerance: "0.0001",
    output: undefined,
    overwrite: false,
    failFast: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--overwrite") {
      options.overwrite = true;
      continue;
    }
    if (argument === "--fail-fast") {
      options.failFast = true;
      continue;
    }
    if (!argument.startsWith("--") || argv[index + 1] === undefined) {
      throw new Error(`invalid argument near ${argument}`);
    }
    const key = argument.slice(2);
    const mappings = {
      sides: "sides",
      segments: "segments",
      "frequency-mhz": "frequencyMHz",
      backends: "backends",
      rounds: "rounds",
      "retained-solves": "retainedSolves",
      "timeout-seconds": "timeoutSeconds",
      "equivalence-tolerance": "equivalenceTolerance",
      output: "output",
    };
    if (mappings[key] === undefined) {
      throw new Error(`unknown option ${argument}`);
    }
    options[mappings[key]] = argv[index + 1];
    index += 1;
  }
  const segments = parseInteger(options.segments, "segments");
  if (segments % 2 === 0) {
    throw new Error("segments must be odd");
  }
  const backends = options.backends.split(",");
  if (
    backends.length === 0
    || backends.some((backend) => backend !== "stateful" && backend !== "deck")
  ) {
    throw new Error("backends must contain stateful and/or deck");
  }
  const frequencyMHz = Number(options.frequencyMHz);
  const equivalenceTolerance = Number(options.equivalenceTolerance);
  if (!(frequencyMHz > 0) || !Number.isFinite(frequencyMHz)) {
    throw new Error("frequency-mhz must be positive and finite");
  }
  if (!(equivalenceTolerance >= 0) || !Number.isFinite(equivalenceTolerance)) {
    throw new Error("equivalence-tolerance must be finite and nonnegative");
  }
  return {
    sides: parseSides(options.sides),
    segments,
    frequencyMHz,
    backends,
    rounds: parseInteger(options.rounds, "rounds"),
    retainedSolves: parseInteger(options.retainedSolves, "retained-solves", 0),
    timeoutMs: parseInteger(options.timeoutSeconds, "timeout-seconds") * 1000,
    equivalenceTolerance,
    output: options.output === undefined
      ? undefined
      : resolve(invocationDirectory, options.output),
    overwrite: options.overwrite,
    failFast: options.failFast,
  };
}

function median(values) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
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

function buildMetadata(options) {
  const packageJson = JSON.parse(
    readFileSync(resolve(packageDirectory, "package.json"), "utf8"),
  );
  const wasmPath = resolve(packageDirectory, "dist/nec2pp.wasm");
  if (!existsSync(wasmPath)) {
    throw new Error("dist/nec2pp.wasm is missing; run npm run build first");
  }
  const rootCmake = readFileSync(resolve(repositoryRoot, "CMakeLists.txt"), "utf8");
  const stackMatch = rootCmake.match(/set\(NECPP_WASM_STACK_SIZE\s+(\d+)/);
  const dockerScript = readFileSync(
    resolve(repositoryRoot, "scripts/build_wasm_docker.ps1"),
    "utf8",
  );
  const emscriptenMatch = dockerScript.match(/emscripten\/emsdk:([^"\s]+)/);
  return {
    type: "metadata",
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    packageVersion: packageJson.version,
    nodeVersion: process.version,
    operatingSystem: `${platform()} ${release()}`,
    architecture: process.arch,
    cpuModel: cpus()[0]?.model ?? "unknown",
    logicalCpuCount: cpus().length,
    physicalMemoryBytes: totalmem(),
    gitCommit: commandOutput("git", ["rev-parse", "HEAD"]),
    gitDirty: (commandOutput("git", ["status", "--porcelain"]) ?? "").length > 0,
    emscriptenVersion: emscriptenMatch?.[1] ?? null,
    wasmStackSizeBytes: stackMatch === null ? null : Number(stackMatch[1]),
    wasmBytes: statSync(wasmPath).size,
    wasmSha256: sha256(wasmPath),
    options: {
      ...options,
      output: options.output,
      timeoutMs: options.timeoutMs,
    },
  };
}

function compareCurrents(stateful, deck) {
  if (stateful.length !== deck.length) {
    throw new Error("backend source-current counts differ");
  }
  let deltaSquared = 0;
  let referenceSquared = 0;
  let maxAbsoluteDelta = 0;
  for (let index = 0; index < stateful.length; index += 1) {
    const realDelta = stateful[index].real - deck[index].real;
    const imagDelta = stateful[index].imag - deck[index].imag;
    const absoluteDelta = Math.hypot(realDelta, imagDelta);
    deltaSquared += absoluteDelta ** 2;
    referenceSquared += stateful[index].real ** 2 + stateful[index].imag ** 2;
    maxAbsoluteDelta = Math.max(maxAbsoluteDelta, absoluteDelta);
  }
  return {
    sourceCurrentCount: stateful.length,
    relativeL2Error: Math.sqrt(deltaSquared) / Math.max(Math.sqrt(referenceSquared), 1e-300),
    maxAbsoluteDelta,
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
    record = {
      type: "case",
      ok: false,
      ...identity,
      error: {
        name: result.error?.name ?? "ChildProcessError",
        message: result.error?.message
          ?? `benchmark child exited ${result.status}: ${stderr.trim()}`,
      },
    };
  }
  if (result.status !== 0 && record.ok !== false) {
    record.ok = false;
    record.error = {
      name: result.error?.name ?? "ChildProcessError",
      message: result.error?.message
        ?? `benchmark child exited ${result.status}: ${stderr.trim()}`,
    };
  }
  return record;
}

function caseSummary(records, backend, side) {
  const matches = records.filter((record) =>
    record.backend === backend && record.side === side);
  const successes = matches.filter((record) => record.ok);
  const timingKeys = backend === "stateful"
    ? [
      "instantiateMs",
      "geometryMs",
      "prepareMs",
      "firstSolveMs",
      "retainedSolveMedianMs",
      "coldTotalMs",
      "totalWithRetainedSolvesMs",
    ]
    : ["deckBuildMs", "runDeckMs", "coldTotalMs"];
  return {
    backend,
    side,
    equations: side * side * records[0].segmentsPerDipole,
    successCount: successes.length,
    failureCount: matches.length - successes.length,
    medianTimingsMs: Object.fromEntries(timingKeys.map((key) => [
      key,
      median(successes.map((record) => record.timings[key]).filter((value) =>
        typeof value === "number")),
    ])),
    medianRssDeltaBytes: median(successes.map((record) => record.rssDeltaBytes)),
    medianReportBytes: backend === "deck"
      ? median(successes.map((record) => record.reportBytes))
      : undefined,
  };
}

function summaryPath(output) {
  return output.endsWith(".ndjson")
    ? `${output.slice(0, -".ndjson".length)}.summary.json`
    : `${output}.summary.json`;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
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
    if (options.output !== undefined) {
      appendFileSync(options.output, line);
    }
  };

  const metadata = buildMetadata(options);
  emit(metadata);
  const records = [];
  const comparisons = [];
  const pairs = new Map();
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
          "--round", String(round),
        ], {
          cwd: packageDirectory,
          encoding: "utf8",
          timeout: options.timeoutMs,
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true,
        });
        const record = parseChildResult(child, identity);
        const portCurrents = record.portCurrents;
        delete record.portCurrents;
        records.push(record);
        emit(record);
        if (!record.ok) {
          hasFailure = true;
          if (options.failFast) {
            process.exitCode = 1;
            return;
          }
          continue;
        }
        const pairKey = `${side}:${round}`;
        const pair = pairs.get(pairKey) ?? {};
        pair[backend] = portCurrents;
        pairs.set(pairKey, pair);
        if (pair.stateful !== undefined && pair.deck !== undefined) {
          const comparison = {
            type: "comparison",
            side,
            round,
            equations: identity.equations,
            ...compareCurrents(pair.stateful, pair.deck),
          };
          comparison.withinTolerance = comparison.relativeL2Error
            <= options.equivalenceTolerance;
          if (!comparison.withinTolerance) {
            hasFailure = true;
          }
          comparisons.push(comparison);
          emit(comparison);
        }
      }
    }
  }

  const summary = {
    type: "summary",
    schemaVersion: 1,
    completedAt: new Date().toISOString(),
    hasFailure,
    cases: options.sides.flatMap((side) => options.backends.map((backend) =>
      caseSummary(records, backend, side))),
    comparisons,
  };
  emit(summary);
  if (options.output !== undefined) {
    writeFileSync(summaryPath(options.output), `${JSON.stringify({
      metadata,
      ...summary,
    }, null, 2)}\n`);
  }
  if (hasFailure) {
    process.exitCode = 1;
  }
}

main();
