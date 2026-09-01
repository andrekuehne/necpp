import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { runFarFieldCase } from "./far-field-case.mjs";
import { timingStats } from "./far-field-benchmark.mjs";

function argumentsFrom(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument near ${name ?? "end of command"}`);
    }
    values.set(name.slice(2), value);
  }
  for (const required of ["scalar-directory", "simd-directory", "output-directory"]) {
    if (!values.has(required)) throw new Error(`--${required} is required`);
  }
  const rounds = Number(values.get("rounds") ?? 6);
  if (!Number.isSafeInteger(rounds) || rounds < 2) {
    throw new Error("--rounds must be an integer >= 2");
  }
  return {
    rounds,
    scalarDirectory: resolve(values.get("scalar-directory")),
    simdDirectory: resolve(values.get("simd-directory")),
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
  const simd = variant === "simd128";
  return runFarFieldCase({
    backend: "direct",
    grid: "primary",
    round,
    moduleDirectory: simd ? options.simdDirectory : options.scalarDirectory,
    extractMatrix: true,
    variant: simd
      ? "release-simd128-sampled-instrumented"
      : "release-scalar-sampled-instrumented",
    buildFlags: simd
      ? "-O3 -DNDEBUG -flto -fexceptions -msimd128; diagnostics=ON/256; simd=ON"
      : "-O3 -DNDEBUG -flto -fexceptions; diagnostics=ON/256; simd=OFF",
    requireDiagnostics: true,
    steeringLimit: 1,
    reuseGrid: false,
  });
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  mkdirSync(options.outputDirectory, { recursive: true });
  for (const variant of ["scalar", "simd128"]) {
    process.stderr.write(`warm-up ${variant}\n`);
    await runVariant(options, variant, -1);
  }
  const records = [];
  for (let round = 0; round < options.rounds; round += 1) {
    const order = round % 2 === 0 ? ["simd128", "scalar"] : ["scalar", "simd128"];
    for (const variant of order) {
      process.stderr.write(`measure ${variant} ${round + 1}/${options.rounds}\n`);
      records.push(await runVariant(options, variant, round));
    }
  }

  const recordFor = (round, suffix) => records.find(
    (record) => record.round === round && record.variant.endsWith(suffix),
  );
  const pairs = Array.from({ length: options.rounds }, (_, round) => {
    const scalar = recordFor(round, "scalar-sampled-instrumented");
    const simd = recordFor(round, "simd128-sampled-instrumented");
    const scalarFieldMs = scalar.steering[0].field.wallMs;
    const simdFieldMs = simd.steering[0].field.wallMs;
    if (scalar.steering[0].checksums.field.sha256
        !== simd.steering[0].checksums.field.sha256) {
      throw new Error(`field checksum mismatch in SIMD pair ${round}`);
    }
    return {
      round,
      first: round % 2 === 0 ? "simd128" : "scalar",
      scalarFieldMs,
      simdFieldMs,
      simdDeltaPercent: (simdFieldMs / scalarFieldMs - 1) * 100,
    };
  });
  const scalarMs = pairs.map(({ scalarFieldMs }) => scalarFieldMs);
  const simdMs = pairs.map(({ simdFieldMs }) => simdFieldMs);
  const deltas = pairs.map(({ simdDeltaPercent }) => simdDeltaPercent);
  const summary = {
    type: "far-field-simd-comparison",
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    configuration: {
      rounds: options.rounds,
      warmups: 1,
      backend: "direct",
      grid: "primary",
      steeringStatesPerCase: 1,
      reuseGrid: false,
      scalarDirectory: options.scalarDirectory,
      simdDirectory: options.simdDirectory,
    },
    outputParity: { compared: options.rounds, failures: [] },
    fieldMs: { scalar: timingStats(scalarMs), simd128: timingStats(simdMs) },
    simdDeltaPercent: {
      median: median(deltas),
      minimum: Math.min(...deltas),
      maximum: Math.max(...deltas),
    },
    pairs,
  };
  const rawPath = resolve(options.outputDirectory, "far-field-simd-raw.ndjson");
  const summaryPath = resolve(options.outputDirectory, "far-field-simd-summary.json");
  writeFileSync(rawPath, `${records.map(JSON.stringify).join("\n")}\n`, "utf8");
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ok: true, rawPath, summaryPath })}\n`);
}

if (process.argv[1] !== undefined
    && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
