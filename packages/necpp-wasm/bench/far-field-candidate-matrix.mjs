import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  const baseline = values.get("baseline") ?? "WP1";
  if (!variants.some(({ name }) => name === baseline)) {
    throw new Error(`--variants must include the ${baseline} baseline`);
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
  const equivalenceMode = values.get("equivalence-mode") ?? "exact";
  if (!new Set(["exact", "numeric"]).has(equivalenceMode)) {
    throw new Error("--equivalence-mode must be exact or numeric");
  }
  return {
    variants,
    baseline,
    equivalenceMode,
    rounds,
    steeringLimit,
    outputDirectory: resolve(values.get("output-directory")),
  };
}

function runCase(options, variant, grid, round) {
  const args = [
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
  ];
  if (options.equivalenceMode === "numeric") {
    args.push(
      "--field-dump-directory",
      resolve(options.dumpDirectory, variant.name, grid, String(round)),
    );
  }
  const result = spawnSync(process.execPath, args, {
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

function assertParity(values, rounds, variants, baselineName) {
  const failures = [];
  let compared = 0;
  for (const grid of grids) {
    for (let round = 0; round < rounds; round += 1) {
      const baseline = values.find(
        (record) => record.variant === baselineName && record.grid === grid && record.round === round,
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

function readFieldDump(options, variant, grid, round, state, samples) {
  const path = resolve(options.dumpDirectory, variant, grid, String(round), `${state}.f64`);
  const bytes = readFileSync(path);
  if (bytes.byteLength !== samples * 4 * Float64Array.BYTES_PER_ELEMENT) {
    throw new Error(`${path} has an unexpected field-dump length`);
  }
  const copied = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new Float64Array(copied);
}

function complexMetrics(reference, candidate, realOffset, imagOffset, samples) {
  let differenceSquared = 0;
  let referenceSquared = 0;
  let candidateSquared = 0;
  let maximumDifference = 0;
  let maximumReference = 0;
  let maximumCandidate = 0;
  let finite = true;
  for (let index = 0; index < samples; index += 1) {
    const ar = reference[realOffset + index];
    const ai = reference[imagOffset + index];
    const br = candidate[realOffset + index];
    const bi = candidate[imagOffset + index];
    finite &&= Number.isFinite(ar) && Number.isFinite(ai)
      && Number.isFinite(br) && Number.isFinite(bi);
    const difference = Math.hypot(ar - br, ai - bi);
    const aMagnitude = Math.hypot(ar, ai);
    const bMagnitude = Math.hypot(br, bi);
    differenceSquared += difference * difference;
    referenceSquared += aMagnitude * aMagnitude;
    candidateSquared += bMagnitude * bMagnitude;
    maximumDifference = Math.max(maximumDifference, difference);
    maximumReference = Math.max(maximumReference, aMagnitude);
    maximumCandidate = Math.max(maximumCandidate, bMagnitude);
  }
  const referenceL2 = Math.sqrt(referenceSquared);
  const candidateL2 = Math.sqrt(candidateSquared);
  return {
    finite,
    relativeL2: Math.sqrt(differenceSquared) /
      Math.max(1, referenceL2, candidateL2),
    scaledMaximum: maximumDifference /
      Math.max(1, maximumReference, maximumCandidate),
  };
}

function patternMetrics(values, grid, samples) {
  const thetaCount = grid.theta.count;
  const thetaStart = grid.theta.startDeg * Math.PI / 180;
  const thetaStep = grid.theta.stepDeg * Math.PI / 180;
  let peak = 0;
  let nullMagnitude = Number.POSITIVE_INFINITY;
  let integratedPower = 0;
  for (let index = 0; index < samples; index += 1) {
    const magnitudeSquared = values[index] ** 2 + values[samples + index] ** 2
      + values[2 * samples + index] ** 2 + values[3 * samples + index] ** 2;
    const magnitude = Math.sqrt(magnitudeSquared);
    peak = Math.max(peak, magnitude);
    nullMagnitude = Math.min(nullMagnitude, magnitude);
    const thetaIndex = index % thetaCount;
    const endpointWeight = thetaIndex === 0 || thetaIndex === thetaCount - 1 ? 0.5 : 1;
    integratedPower += endpointWeight * magnitudeSquared *
      Math.sin(thetaStart + thetaIndex * thetaStep);
  }
  integratedPower *= thetaStep * grid.phi.stepDeg * Math.PI / 180;
  return { peak, nullMagnitude, integratedPower };
}

function relativeDifference(left, right) {
  return Math.abs(left - right) / Math.max(1, Math.abs(left), Math.abs(right));
}

function numericComparisons(options, values) {
  const comparisons = [];
  for (const record of values) {
    if (record.variant === options.baseline) continue;
    const baseline = values.find((candidate) =>
      candidate.variant === options.baseline
      && candidate.grid === record.grid
      && candidate.round === record.round);
    for (let state = 0; state < record.steering.length; state += 1) {
      const samples = record.steering[state].field.samples;
      const expected = readFieldDump(
        options, options.baseline, record.grid, record.round, state, samples,
      );
      const actual = readFieldDump(
        options, record.variant, record.grid, record.round, state, samples,
      );
      const expectedPattern = patternMetrics(expected, record.selectedGrid, samples);
      const actualPattern = patternMetrics(actual, record.selectedGrid, samples);
      const eTheta = complexMetrics(expected, actual, 0, samples, samples);
      const ePhi = complexMetrics(expected, actual, 2 * samples, 3 * samples, samples);
      comparisons.push({
        grid: record.grid,
        round: record.round,
        state,
        steeringId: record.steering[state].point.id,
        variant: record.variant,
        eTheta,
        ePhi,
        peakRelativeDifference: relativeDifference(expectedPattern.peak, actualPattern.peak),
        nullAbsoluteDifference: Math.abs(
          expectedPattern.nullMagnitude - actualPattern.nullMagnitude,
        ),
        integratedPowerRelativeDifference: relativeDifference(
          expectedPattern.integratedPower, actualPattern.integratedPower,
        ),
        passes: eTheta.finite && ePhi.finite
          && eTheta.relativeL2 <= 1e-7 && eTheta.scaledMaximum <= 1e-7
          && ePhi.relativeL2 <= 1e-7 && ePhi.scaledMaximum <= 1e-7,
      });
    }
  }
  return comparisons;
}

function summarizeNumerics(comparisons, variant, grid) {
  const selected = comparisons.filter(
    (comparison) => comparison.variant === variant && comparison.grid === grid,
  );
  const maximum = (select) => Math.max(...selected.map(select));
  return {
    comparisons: selected.length,
    failures: selected.filter(({ passes }) => !passes).length,
    maximumRelativeL2: {
      eTheta: maximum(({ eTheta }) => eTheta.relativeL2),
      ePhi: maximum(({ ePhi }) => ePhi.relativeL2),
    },
    maximumScaledMaximum: {
      eTheta: maximum(({ eTheta }) => eTheta.scaledMaximum),
      ePhi: maximum(({ ePhi }) => ePhi.scaledMaximum),
    },
    maximumPeakRelativeDifference: maximum(({ peakRelativeDifference }) =>
      peakRelativeDifference),
    maximumNullAbsoluteDifference: maximum(({ nullAbsoluteDifference }) =>
      nullAbsoluteDifference),
    maximumIntegratedPowerRelativeDifference: maximum(
      ({ integratedPowerRelativeDifference }) => integratedPowerRelativeDifference,
    ),
  };
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
  const fieldSpeedupOverBaseline = baselineFieldMedian / median(fieldMs);
  const rawSpeedupOverBaseline = baselineRawMedian / median(rawMs);
  return {
    repeatedFieldMs: timingStats(fieldMs),
    repeatedRawAccumulationMs: timingStats(rawMs),
    fieldSpeedupOverBaseline,
    rawSpeedupOverBaseline,
    // Schema-v1 compatibility for the existing WP2 evidence consumer.
    fieldSpeedupOverWp1: fieldSpeedupOverBaseline,
    rawSpeedupOverWp1: rawSpeedupOverBaseline,
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
  options.dumpDirectory = resolve(options.outputDirectory, ".field-dumps");
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

  const parity = options.equivalenceMode === "exact"
    ? assertParity(values, options.rounds, options.variants, options.baseline)
    : null;
  const comparisons = options.equivalenceMode === "numeric"
    ? numericComparisons(options, values)
    : [];
  if (comparisons.length > 0) {
    const comparisonPath = resolve(
      options.outputDirectory, "far-field-wp2a-comparisons.ndjson",
    );
    writeFileSync(
      comparisonPath,
      `${comparisons.map((comparison) => JSON.stringify(comparison)).join("\n")}\n`,
      "utf8",
    );
    rmSync(options.dumpDirectory, { recursive: true, force: true });
  }
  const cases = {};
  for (const grid of grids) {
    const baseline = values.filter(
      (record) => record.variant === options.baseline && record.grid === grid,
    );
    for (const variant of options.variants) {
      const selected = values.filter(
        (record) => record.variant === variant.name && record.grid === grid,
      );
      cases[`${variant.name}:${grid}`] = {
        ...summarizeVariant(selected, baseline),
        numerics: variant.name === options.baseline || options.equivalenceMode === "exact"
          ? null
          : summarizeNumerics(comparisons, variant.name, grid),
      };
    }
  }
  const summary = {
    type: "far-field-wp2-candidate-matrix",
    schemaVersion: 2,
    measuredAt: new Date().toISOString(),
    configuration: {
      rounds: options.rounds,
      warmups: 1,
      steeringLimit: options.steeringLimit,
      grids,
      variants: options.variants,
      baseline: options.baseline,
      equivalenceMode: options.equivalenceMode,
    },
    outputParity: parity,
    numericalComparison: options.equivalenceMode === "numeric"
      ? {
          tolerance: 1e-7,
          comparisons: comparisons.length,
          failures: comparisons.filter(({ passes }) => !passes).length,
        }
      : null,
    cases,
  };
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ok: true, rawPath, summaryPath })}\n`);
}

if (process.argv[1] !== undefined
    && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
