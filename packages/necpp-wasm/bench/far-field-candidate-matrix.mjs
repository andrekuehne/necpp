import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { timingStats } from "./far-field-benchmark.mjs";

const caseScript = resolve(import.meta.dirname, "far-field-case.mjs");
const grids = Object.freeze(["primary", "secondary"]);

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
  for (const required of ["variants", "output-directory"]) {
    if (!values.has(required)) throw new Error(`--${required} is required`);
  }
  const variants = values.get("variants").split(",").map((entry) => {
    const separator = entry.indexOf("=");
    if (separator <= 0 || separator === entry.length - 1) {
      throw new Error("--variants entries must be NAME=PATH");
    }
    return {
      name: entry.slice(0, separator),
      directory: resolve(entry.slice(separator + 1)),
    };
  });
  if (!variants.some(({ name }) => name === "WP1")) {
    throw new Error("--variants must include the WP1 baseline");
  }
  if (new Set(variants.map(({ name }) => name)).size !== variants.length) {
    throw new Error("--variants names must be unique");
  }
  const rounds = Number(values.get("rounds") ?? 5);
  if (!Number.isSafeInteger(rounds) || rounds < 2) {
    throw new Error("--rounds must be an integer >= 2");
  }
  const steeringLimit = Number(values.get("steering-limit") ?? 3);
  if (!Number.isSafeInteger(steeringLimit) || steeringLimit < 2 || steeringLimit > 10) {
    throw new Error("--steering-limit must be an integer from 2 through 10");
  }
  return {
    variants,
    rounds,
    steeringLimit,
    outputDirectory: resolve(values.get("output-directory")),
  };
}

function runCase(options, variant, grid, round) {
  const result = spawnSync(process.execPath, [
    caseScript,
    "--backend", "direct",
    "--grid", grid,
    "--round", String(round),
    "--module-directory", variant.directory,
    "--extract-matrix", "true",
    "--variant", variant.name,
    "--build-flags", `far-field=${variant.name}; diagnostics=ON/256`,
    "--require-diagnostics", "true",
    "--steering-limit", String(options.steeringLimit),
    "--reuse-grid", "false",
  ], {
    cwd: resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  let record;
  try {
    record = JSON.parse(line);
  } catch (error) {
    throw new Error(`${variant.name}/${grid}/${round} was not JSON: ${result.stderr || error.message}`);
  }
  if (result.status !== 0 || record.ok !== true) {
    throw new Error(`${variant.name}/${grid}/${round} failed: ${record.error?.message ?? result.stderr}`);
  }
  return record;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function assertParity(values, rounds, variants) {
  const failures = [];
  let compared = 0;
  for (const grid of grids) {
    for (let round = 0; round < rounds; round += 1) {
      const baseline = values.find(
        (record) => record.variant === "WP1" && record.grid === grid && record.round === round,
      );
      for (const variant of variants) {
        const candidate = values.find(
          (record) => record.variant === variant.name && record.grid === grid && record.round === round,
        );
        for (let state = 0; state < baseline.steering.length; state += 1) {
          compared += 1;
          const expected = baseline.steering[state].checksums.field.sha256;
          const actual = candidate.steering[state].checksums.field.sha256;
          if (actual !== expected) {
            failures.push({ grid, round, state, variant: variant.name, expected, actual });
          }
        }
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(`candidate field parity failed ${failures.length} times`);
  }
  return { compared, failures };
}

function summarizeVariant(values, baselineValues) {
  const repeated = values.flatMap(({ steering }) => steering.slice(1));
  const baselineRepeated = baselineValues.flatMap(({ steering }) => steering.slice(1));
  const fieldMs = repeated.map(({ field }) => field.wallMs);
  const rawMs = repeated.map(({ field }) => field.phases.native.rawAccumulationMs);
  const baselineFieldMedian = median(baselineRepeated.map(({ field }) => field.wallMs));
  const baselineRawMedian = median(
    baselineRepeated.map(({ field }) => field.phases.native.rawAccumulationMs),
  );
  return {
    repeatedFieldMs: timingStats(fieldMs),
    repeatedRawAccumulationMs: timingStats(rawMs),
    fieldSpeedupOverWp1: baselineFieldMedian / median(fieldMs),
    rawSpeedupOverWp1: baselineRawMedian / median(rawMs),
    repeatedOutputBufferAllocations: timingStats(
      repeated.map(({ field }) => field.phases.counts.outputBufferAllocations),
    ),
    createMs: timingStats(values.map(({ timings }) => timings.createMs)),
    wasmBytes: values[0].environment.artifacts.wasm.bytes,
    wasmSha256: values[0].environment.artifacts.wasm.sha256,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  mkdirSync(options.outputDirectory, { recursive: true });
  const rawPath = resolve(options.outputDirectory, "far-field-wp2-candidate-raw.ndjson");
  const summaryPath = resolve(options.outputDirectory, "far-field-wp2-candidate-summary.json");
  writeFileSync(rawPath, "", "utf8");

  for (const grid of grids) {
    for (const variant of options.variants) {
      process.stderr.write(`warm-up ${variant.name}/${grid}\n`);
      runCase(options, variant, grid, -1);
    }
  }

  const values = [];
  for (let round = 0; round < options.rounds; round += 1) {
    for (const grid of grids) {
      const order = options.variants.map(
        (_, index) => options.variants[(index + round) % options.variants.length],
      );
      if (round % 2 === 1) order.reverse();
      for (const variant of order) {
        process.stderr.write(`measure ${variant.name}/${grid} ${round + 1}/${options.rounds}\n`);
        const record = runCase(options, variant, grid, round);
        values.push(record);
        appendFileSync(rawPath, `${JSON.stringify(record)}\n`, "utf8");
      }
    }
  }

  const parity = assertParity(values, options.rounds, options.variants);
  const cases = {};
  for (const grid of grids) {
    const baseline = values.filter(
      (record) => record.variant === "WP1" && record.grid === grid,
    );
    for (const variant of options.variants) {
      const selected = values.filter(
        (record) => record.variant === variant.name && record.grid === grid,
      );
      cases[`${variant.name}:${grid}`] = summarizeVariant(selected, baseline);
    }
  }
  const summary = {
    type: "far-field-wp2-candidate-matrix",
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    configuration: {
      rounds: options.rounds,
      warmups: 1,
      steeringLimit: options.steeringLimit,
      grids,
      variants: options.variants,
    },
    outputParity: parity,
    cases,
  };
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ok: true, rawPath, summaryPath })}\n`);
}

if (process.argv[1] !== undefined
    && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
