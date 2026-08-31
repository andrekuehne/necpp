import {
  appendFileSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  FAR_FIELD_BACKENDS,
  FAR_FIELD_BENCHMARK_SCHEMA_VERSION,
  FAR_FIELD_GRIDS,
} from "./far-field-case.mjs";
import { fixtureManifest } from "./far-field-fixture-v1.mjs";

const caseScript = resolve(import.meta.dirname, "far-field-case.mjs");

const HELP = `NEC far-field WP0 benchmark

Usage:
  node bench/far-field-benchmark.mjs [options]

Options:
  --module-directory PATH   Built package directory (default: dist)
  --output-directory PATH   Raw/summary artifact directory (required)
  --rounds N                Measured fresh-process rounds (default: 5)
  --warmups N               Untimed fresh-process rounds (default: 1)
  --backends LIST           Comma-separated direct,worker (default: both)
  --grids LIST              Comma-separated primary,secondary (default: both)
  --extract-matrix BOOL     Extract Z before the first solve (default: true)
  --variant NAME            Artifact label (default: release-scalar)
  --build-flags TEXT        Exact build flags recorded in artifacts
  --require-diagnostics BOOL Require native phase probes (default: true)
  --help                    Show this help
`;

function requireInteger(value, name, minimum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return parsed;
}

function listOption(value, allowed, name) {
  const selected = value.split(",").filter(Boolean);
  if (selected.length === 0 || selected.some((item) => !allowed.includes(item))) {
    throw new Error(`${name} must contain only ${allowed.join(",")}`);
  }
  return [...new Set(selected)];
}

function parseArguments(argv) {
  if (argv.includes("--help")) return { help: true };
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument near ${name ?? "end of command"}`);
    }
    values.set(name.slice(2), value);
  }
  if (!values.has("output-directory")) {
    throw new Error("--output-directory is required");
  }
  const extractMatrix = values.get("extract-matrix") ?? "true";
  if (extractMatrix !== "true" && extractMatrix !== "false") {
    throw new Error("--extract-matrix must be true or false");
  }
  return {
    help: false,
    moduleDirectory: resolve(values.get("module-directory") ?? "dist"),
    outputDirectory: resolve(values.get("output-directory")),
    rounds: requireInteger(values.get("rounds") ?? 5, "--rounds", 1),
    warmups: requireInteger(values.get("warmups") ?? 1, "--warmups", 0),
    backends: listOption(
      values.get("backends") ?? FAR_FIELD_BACKENDS.join(","),
      FAR_FIELD_BACKENDS,
      "--backends",
    ),
    grids: listOption(
      values.get("grids") ?? FAR_FIELD_GRIDS.join(","),
      FAR_FIELD_GRIDS,
      "--grids",
    ),
    extractMatrix,
    variant: values.get("variant") ?? "release-scalar",
    buildFlags: values.get("build-flags") ?? "unknown",
    requireDiagnostics: values.get("require-diagnostics") ?? "true",
  };
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  const index = Math.max(0, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.min(index, sorted.length - 1)];
}

export function timingStats(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
  return {
    count: sorted.length,
    minimum: sorted[0],
    median,
    maximum: sorted.at(-1),
    p90: percentile(sorted, 0.9),
  };
}

function runChild(options, backend, grid, round) {
  const args = [
    caseScript,
    "--backend", backend,
    "--grid", grid,
    "--round", String(round),
    "--module-directory", options.moduleDirectory,
    "--extract-matrix", options.extractMatrix,
    "--variant", options.variant,
    "--build-flags", options.buildFlags,
    "--require-diagnostics", options.requireDiagnostics,
  ];
  const result = spawnSync(process.execPath, args, {
    cwd: resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  let record;
  try {
    record = JSON.parse(lines.at(-1));
  } catch (error) {
    throw new Error(
      `could not parse ${backend}/${grid} round ${round}: ${result.stderr || error.message}`,
    );
  }
  if (result.status !== 0 || record.ok !== true) {
    const message = record.error?.message ?? result.stderr.trim() ?? "unknown failure";
    throw new Error(`${backend}/${grid} round ${round} failed: ${message}`);
  }
  return record;
}

function recordKey(record) {
  return `${record.variant}:${record.backend}:${record.grid}`;
}

function checksumParity(records) {
  const failures = [];
  const byVariantGridRound = new Map();
  for (const record of records) {
    const key = `${record.variant}:${record.grid}:${record.round}`;
    const group = byVariantGridRound.get(key) ?? [];
    group.push(record);
    byVariantGridRound.set(key, group);
  }
  for (const [key, group] of byVariantGridRound) {
    const direct = group.find(({ backend }) => backend === "direct");
    const worker = group.find(({ backend }) => backend === "worker");
    if (direct === undefined || worker === undefined) continue;
    for (let index = 0; index < direct.steering.length; index += 1) {
      const directState = direct.steering[index];
      const workerState = worker.steering[index];
      for (const field of ["requestedCurrents", "achievedCurrents", "field"]) {
        const left = directState.checksums[field].sha256;
        const right = workerState.checksums[field].sha256;
        if (left !== right) failures.push({ key, index, field, direct: left, worker: right });
      }
    }
  }
  return { compared: byVariantGridRound.size, failures };
}

function summarizeGroup(records) {
  const repeatedStates = records.flatMap(({ steering }) => steering.slice(1));
  const initialStates = records.map(({ steering }) => steering[0]);
  return {
    caseCount: records.length,
    steeringStatesPerCase: records[0].steering.length,
    samplesPerField: records[0].steering[0].field.samples,
    resultBytes: records[0].steering[0].field.resultBytes,
    initial: {
      solveMs: timingStats(initialStates.map(({ solve }) => solve.wallMs)),
      fieldMs: timingStats(initialStates.map(({ field }) => field.wallMs)),
      solveAndFieldMs: timingStats(initialStates.map((state) =>
        state.solve.wallMs + state.field.wallMs)),
    },
    repeated: {
      solveMs: timingStats(repeatedStates.map(({ solve }) => solve.wallMs)),
      fieldMs: timingStats(repeatedStates.map(({ field }) => field.wallMs)),
      solveAndFieldMs: timingStats(repeatedStates.map((state) =>
        state.solve.wallMs + state.field.wallMs)),
      phasesMs: {
        validation: timingStats(repeatedStates.map(({ field }) =>
          field.phases?.validationMs)),
        rawAccumulation: timingStats(repeatedStates.map(({ field }) =>
          field.phases?.native.rawAccumulationMs)),
        derivedRpWork: timingStats(repeatedStates.map(({ field }) =>
          field.phases?.native.derivedRpWorkMs)),
        nativeResultCopy: timingStats(repeatedStates.map(({ field }) =>
          field.phases?.native.resultCopyMs)),
        abiResultCopy: timingStats(repeatedStates.map(({ field }) =>
          field.phases?.native.abiResultCopyMs)),
        typescriptExtraction: timingStats(repeatedStates.map(({ field }) =>
          field.phases?.typescriptExtractionMs)),
        facadeResidual: timingStats(repeatedStates.map(({ field }) =>
          field.facadeResidualMs)),
      },
    },
    lifecycle: {
      createMs: timingStats(records.map(({ timings }) => timings.createMs)),
      prepareMs: timingStats(records.map(({ timings }) => timings.prepareMs)),
      matrixMs: timingStats(records.map(({ timings }) => timings.matrixMs)),
      secondGridFieldMs: timingStats(records.map(({ timings }) => timings.secondGridFieldMs)),
      disposeMs: timingStats(records.map(({ timings }) => timings.disposeMs)),
      totalMs: timingStats(records.map(({ timings }) => timings.totalMs)),
    },
    memory: {
      peakRssBytes: timingStats(records.map(({ memory }) => memory.peakRssBytes)),
      peakObservedRssDeltaBytes: timingStats(
        records.map(({ memory }) => memory.peakObservedRssDeltaBytes),
      ),
    },
  };
}

function summarize(records, options, rawPath) {
  const groups = new Map();
  for (const record of records) {
    const key = recordKey(record);
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  const parity = checksumParity(records);
  if (parity.failures.length > 0) {
    throw new Error(`direct/worker checksum parity failed ${parity.failures.length} times`);
  }
  return {
    type: "far-field-summary",
    schemaVersion: FAR_FIELD_BENCHMARK_SCHEMA_VERSION,
    measuredAt: new Date().toISOString(),
    command: process.argv.map((value) => JSON.stringify(value)).join(" "),
    configuration: {
      rounds: options.rounds,
      warmups: options.warmups,
      backends: options.backends,
      grids: options.grids,
      extractMatrix: options.extractMatrix === "true",
      variant: options.variant,
      buildFlags: options.buildFlags,
      requireDiagnostics: options.requireDiagnostics === "true",
      moduleDirectory: options.moduleDirectory,
    },
    fixture: fixtureManifest(),
    rawNdjson: rawPath,
    checksumParity: parity,
    cases: Object.fromEntries(
      [...groups.entries()].map(([key, group]) => [key, summarizeGroup(group)]),
    ),
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  mkdirSync(options.outputDirectory, { recursive: true });
  const rawPath = resolve(options.outputDirectory, "far-field-wp0-raw.ndjson");
  const summaryPath = resolve(options.outputDirectory, "far-field-wp0-summary.json");
  const manifestPath = resolve(options.outputDirectory, "far-field-fixture-v1.json");
  writeFileSync(rawPath, "", "utf8");
  writeFileSync(manifestPath, `${JSON.stringify(fixtureManifest(), null, 2)}\n`, "utf8");

  for (let round = -options.warmups; round < 0; round += 1) {
    for (const grid of options.grids) {
      for (const backend of options.backends) {
        process.stderr.write(`warm-up ${backend}/${grid} ${round + options.warmups + 1}/${options.warmups}\n`);
        runChild(options, backend, grid, round);
      }
    }
  }

  const records = [];
  for (let round = 0; round < options.rounds; round += 1) {
    for (const grid of options.grids) {
      for (const backend of options.backends) {
        process.stderr.write(`measure ${backend}/${grid} ${round + 1}/${options.rounds}\n`);
        const record = runChild(options, backend, grid, round);
        records.push(record);
        appendFileSync(rawPath, `${JSON.stringify(record)}\n`, "utf8");
      }
    }
  }

  const summary = summarize(records, options, rawPath);
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    ok: true,
    rawPath,
    summaryPath,
    manifestPath,
    cases: records.length,
  })}\n`);
}

if (process.argv[1] !== undefined
    && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
