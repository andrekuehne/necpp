import {
  appendFileSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  CURRENT_QUADRATURE_BENCHMARK_SCHEMA_VERSION,
  CURRENT_QUADRATURE_FIXTURES,
  CURRENT_QUADRATURE_GRIDS,
} from "./current-quadrature-case.mjs";

const caseScript = resolve(import.meta.dirname, "current-quadrature-case.mjs");

const HELP = `NEC current-quadrature WP0 baseline

Measures existing unit-current embedded-field solves and the internal
far-field snapshot capture. This is not the prepared-quadrature hot path.

Usage:
  node bench/current-quadrature-baseline.mjs [options]

Options:
  --module-directory PATH   Built package directory (default: dist)
  --output-directory PATH   Raw/summary artifact directory (required)
  --rounds N                Measured fresh-process rounds (default: 3)
  --warmups N               Untimed fresh-process rounds (default: 1)
  --fixtures LIST           dipole,turnstile-insulated (default: both)
  --grids LIST              small,representative (default: both)
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
  return {
    help: false,
    moduleDirectory: resolve(values.get("module-directory") ?? "dist"),
    outputDirectory: resolve(values.get("output-directory")),
    rounds: requireInteger(values.get("rounds") ?? 3, "--rounds", 1),
    warmups: requireInteger(values.get("warmups") ?? 1, "--warmups", 0),
    fixtures: listOption(
      values.get("fixtures") ?? CURRENT_QUADRATURE_FIXTURES.join(","),
      CURRENT_QUADRATURE_FIXTURES,
      "--fixtures",
    ),
    grids: listOption(
      values.get("grids") ?? CURRENT_QUADRATURE_GRIDS.join(","),
      CURRENT_QUADRATURE_GRIDS,
      "--grids",
    ),
  };
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  const index = Math.max(0, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.min(index, sorted.length - 1)];
}

function timingStats(values) {
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

function runChild(options, fixture, grid, round) {
  const result = spawnSync(process.execPath, [
    caseScript,
    "--fixture", fixture,
    "--grid", grid,
    "--round", String(round),
    "--module-directory", options.moduleDirectory,
  ], {
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
      `could not parse ${fixture}/${grid} round ${round}: ${result.stderr || error.message}`,
    );
  }
  if (result.status !== 0 || record.ok !== true) {
    const message = record.error?.message ?? result.stderr.trim() ?? "unknown failure";
    throw new Error(`${fixture}/${grid} round ${round} failed: ${message}`);
  }
  return record;
}

function summarizeGroup(records) {
  return {
    caseCount: records.length,
    portCount: records[0].portCount,
    wireCount: records[0].wireCount,
    fieldSamplesPerPort: records[0].fieldSamplesPerPort,
    embeddedFieldBytes: records[0].embeddedFieldBytes,
    snapshotByteLength: records[0].snapshotByteLength,
    snapshotCapability: records[0].snapshotCapability,
    timings: {
      createMs: timingStats(records.map(({ timings }) => timings.createMs)),
      constructionMs: timingStats(records.map(({ timings }) => timings.constructionMs)),
      impedanceMs: timingStats(records.map(({ timings }) => timings.impedanceMs)),
      embeddedUnitCurrentMs: timingStats(
        records.map(({ timings }) => timings.embeddedUnitCurrentMs),
      ),
      unitCurrentSolveMs: timingStats(
        records.map(({ timings }) => timings.unitCurrentSolveMs),
      ),
      snapshotCaptureMs: timingStats(
        records.map(({ timings }) => timings.snapshotCaptureMs),
      ),
    },
    memory: {
      afterRssBytes: timingStats(records.map(({ memory }) => memory.afterRssBytes)),
    },
  };
}

function summarize(records, options, rawPath) {
  const groups = new Map();
  for (const record of records) {
    const key = `${record.fixture}:${record.grid}`;
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  return {
    type: "current-quadrature-wp0-baseline",
    schemaVersion: CURRENT_QUADRATURE_BENCHMARK_SCHEMA_VERSION,
    measuredAt: new Date().toISOString(),
    command: process.argv.map((value) => JSON.stringify(value)).join(" "),
    configuration: {
      rounds: options.rounds,
      warmups: options.warmups,
      fixtures: options.fixtures,
      grids: options.grids,
      moduleDirectory: options.moduleDirectory,
    },
    budgets: {
      exactCoefficientBytesPerMode: "6 * nSegments * 8",
      exactGeometryBytes: "14 * nSegments * 8",
      internalSnapshotBytes: "13 * nSegments * 8",
      preparedCurrentBytes: "nModes * nSeg * nNodes * nImagePlanes * 16",
      preparedGeometryBytes: "9 * nSeg * nNodes * nImagePlanes * 8",
      embeddedFieldBytes: "4 * nPorts * nTheta * nPhi * 8",
    },
    rawNdjson: rawPath,
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
  const rawPath = resolve(options.outputDirectory, "current-quadrature-wp0-raw.ndjson");
  const summaryPath = resolve(
    options.outputDirectory,
    "current-quadrature-wp0-summary.json",
  );
  writeFileSync(rawPath, "", "utf8");

  for (let round = -options.warmups; round < 0; round += 1) {
    for (const fixture of options.fixtures) {
      for (const grid of options.grids) {
        process.stderr.write(
          `warm-up ${fixture}/${grid} ${round + options.warmups + 1}/${options.warmups}\n`,
        );
        runChild(options, fixture, grid, round);
      }
    }
  }

  const records = [];
  for (let round = 0; round < options.rounds; round += 1) {
    for (const fixture of options.fixtures) {
      for (const grid of options.grids) {
        process.stderr.write(
          `measure ${fixture}/${grid} ${round + 1}/${options.rounds}\n`,
        );
        const record = runChild(options, fixture, grid, round);
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
    cases: records.length,
  })}\n`);
}

if (process.argv[1] !== undefined
    && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
