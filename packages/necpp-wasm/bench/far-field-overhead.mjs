import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { runFarFieldCase } from "./far-field-case.mjs";
import { timingStats } from "./far-field-benchmark.mjs";

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
  for (const required of [
    "instrumented-directory",
    "uninstrumented-directory",
    "output-directory",
  ]) {
    if (!values.has(required)) throw new Error(`--${required} is required`);
  }
  const rounds = Number(values.get("rounds") ?? 6);
  if (!Number.isSafeInteger(rounds) || rounds < 2) {
    throw new Error("--rounds must be an integer >= 2");
  }
  return {
    rounds,
    instrumentedDirectory: resolve(values.get("instrumented-directory")),
    uninstrumentedDirectory: resolve(values.get("uninstrumented-directory")),
    outputDirectory: resolve(values.get("output-directory")),
  };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

async function runVariant(options, variant, round) {
  const instrumented = variant === "instrumented";
  return runFarFieldCase({
    backend: "direct",
    grid: "primary",
    round,
    moduleDirectory: instrumented
      ? options.instrumentedDirectory
      : options.uninstrumentedDirectory,
    extractMatrix: true,
    variant: instrumented
      ? "release-scalar-sampled-instrumented"
      : "release-scalar-uninstrumented",
    buildFlags: instrumented
      ? "-O3 -DNDEBUG -flto -fexceptions; diagnostics=ON/256; simd=OFF"
      : "-O3 -DNDEBUG -flto -fexceptions; diagnostics=OFF; simd=OFF",
    requireDiagnostics: instrumented,
    steeringLimit: 1,
    reuseGrid: false,
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  mkdirSync(options.outputDirectory, { recursive: true });
  for (const variant of ["uninstrumented", "instrumented"]) {
    process.stderr.write(`warm-up ${variant}\n`);
    await runVariant(options, variant, -1);
  }

  const records = [];
  for (let round = 0; round < options.rounds; round += 1) {
    const order = round % 2 === 0
      ? ["instrumented", "uninstrumented"]
      : ["uninstrumented", "instrumented"];
    for (const variant of order) {
      process.stderr.write(`measure ${variant} ${round + 1}/${options.rounds}\n`);
      records.push(await runVariant(options, variant, round));
    }
  }

  const byVariant = (variant) => records
    .filter((record) => record.variant.endsWith(variant))
    .map((record) => record.steering[0].field.wallMs);
  const instrumentedMs = byVariant("sampled-instrumented");
  const uninstrumentedMs = byVariant("uninstrumented");
  const pairs = Array.from({ length: options.rounds }, (_, round) => {
    const instrumented = records.find(
      (record) => record.round === round && record.variant.endsWith("sampled-instrumented"),
    );
    const uninstrumented = records.find(
      (record) => record.round === round && record.variant.endsWith("uninstrumented"),
    );
    const instrumentedFieldMs = instrumented.steering[0].field.wallMs;
    const uninstrumentedFieldMs = uninstrumented.steering[0].field.wallMs;
    if (instrumented.steering[0].checksums.field.sha256
        !== uninstrumented.steering[0].checksums.field.sha256) {
      throw new Error(`field checksum mismatch in overhead pair ${round}`);
    }
    return {
      round,
      first: round % 2 === 0 ? "instrumented" : "uninstrumented",
      instrumentedFieldMs,
      uninstrumentedFieldMs,
      deltaPercent: (instrumentedFieldMs / uninstrumentedFieldMs - 1) * 100,
    };
  });
  const summary = {
    type: "far-field-instrumentation-overhead",
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    configuration: {
      rounds: options.rounds,
      warmups: 1,
      backend: "direct",
      grid: "primary",
      steeringStatesPerCase: 1,
      reuseGrid: false,
      instrumentedDirectory: options.instrumentedDirectory,
      uninstrumentedDirectory: options.uninstrumentedDirectory,
    },
    outputParity: { compared: options.rounds, failures: [] },
    fieldMs: {
      instrumented: timingStats(instrumentedMs),
      uninstrumented: timingStats(uninstrumentedMs),
    },
    pairedDeltaPercent: {
      median: median(pairs.map(({ deltaPercent }) => deltaPercent)),
      minimum: Math.min(...pairs.map(({ deltaPercent }) => deltaPercent)),
      maximum: Math.max(...pairs.map(({ deltaPercent }) => deltaPercent)),
    },
    pairs,
  };
  const rawPath = resolve(options.outputDirectory, "far-field-overhead-raw.ndjson");
  const summaryPath = resolve(options.outputDirectory, "far-field-overhead-summary.json");
  writeFileSync(rawPath, `${records.map(JSON.stringify).join("\n")}\n`, "utf8");
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ok: true, rawPath, summaryPath })}\n`);
}

if (process.argv[1] !== undefined
    && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
