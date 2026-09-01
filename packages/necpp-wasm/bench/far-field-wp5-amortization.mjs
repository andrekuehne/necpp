import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import {
  PRIMARY_FIELD_GRID,
  STEERING_POINTS,
  WAVELENGTH_M,
  complexVectorChecksum,
  createFarFieldFixture,
  farFieldChecksum,
  sourceGridForDisplay,
  steeringCurrents,
} from "./far-field-fixture-v1.mjs";

const packageDirectory = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(packageDirectory, "../..");
const distDirectory = resolve(packageDirectory, "dist");
const outputDirectory = resolve(packageDirectory, "bench/evidence/far-field-wp5/node");
const PORT_COUNTS = Object.freeze([4, 16, 64]);
const HORIZONS = Object.freeze([1, 4, 16, 64, 256]);
const measuredStates = 5;

export function timingStats(values) {
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    minimum: sorted[0],
    median: sorted.length % 2 === 0
      ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
      : sorted[Math.floor(sorted.length / 2)],
    maximum: sorted.at(-1),
    p90: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9) - 1)],
  };
}

export function embeddedBasisBytes(portCount, samplesPerPort) {
  return portCount * samplesPerPort * 4 * Float64Array.BYTES_PER_ELEMENT;
}

export function breakEvenSteeringCount(setupMs, directPerStateMs, cachedPerStateMs) {
  const saving = directPerStateMs - cachedPerStateMs;
  if (!(saving > 0)) return null;
  return Math.max(1, Math.ceil(setupMs / saving));
}

export function amortizedTotals(setupMs, directPerStateMs, cachedPerStateMs) {
  return Object.fromEntries(HORIZONS.map((states) => [states, {
    directMs: states * directPerStateMs,
    cachedMs: setupMs + states * cachedPerStateMs,
    cachedToDirectRatio: (setupMs + states * cachedPerStateMs)
      / (states * directPerStateMs),
  }]));
}

function squareFixture(portCount) {
  const side = Math.sqrt(portCount);
  if (!Number.isInteger(side)) throw new RangeError("Port count must be a square");
  const frozen = createFarFieldFixture();
  if (portCount === frozen.elementCount) return frozen;
  const elements = [];
  for (let yIndex = 0; yIndex < side; yIndex += 1) {
    for (let xIndex = 0; xIndex < side; xIndex += 1) {
      const index = yIndex * side + xIndex;
      elements.push(Object.freeze({
        id: `element-${index}`,
        positionM: Object.freeze([
          (xIndex - (side - 1) / 2) * 0.5 * WAVELENGTH_M,
          (yIndex - (side - 1) / 2) * 0.5 * WAVELENGTH_M,
        ]),
        patternId: "x-directed-dipole",
      }));
    }
  }
  const description = Object.freeze({
    elements: Object.freeze(elements),
    patterns: frozen.description.patterns,
    groundConnection: frozen.groundConnection,
    ground: frozen.ground,
  });
  return Object.freeze({
    ...frozen,
    id: `wp5-${side}x${side}-x-dipole-v1`,
    side,
    elementCount: portCount,
    segmentCount: portCount * frozen.segmentsPerElement,
    elements: description.elements,
    description,
  });
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

function maybeGc() {
  globalThis.gc?.();
  return memory();
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function git(args) {
  return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" });
}

async function timed(body) {
  const started = performance.now();
  const value = await body();
  return { value, ms: performance.now() - started };
}

function copyWeights(value) {
  return { real: value.real.slice(), imag: value.imag.slice() };
}

export function superposeEmbedded(embedded, weights) {
  const samples = embedded.samplesPerPort;
  const eThetaReal = new Float64Array(samples);
  const eThetaImag = new Float64Array(samples);
  const ePhiReal = new Float64Array(samples);
  const ePhiImag = new Float64Array(samples);
  for (let port = 0; port < embedded.ports.length; port += 1) {
    const weightReal = weights.real[port];
    const weightImag = weights.imag[port];
    const offset = port * samples;
    for (let sample = 0; sample < samples; sample += 1) {
      const source = offset + sample;
      const thetaReal = embedded.eThetaReal[source];
      const thetaImag = embedded.eThetaImag[source];
      const phiReal = embedded.ePhiReal[source];
      const phiImag = embedded.ePhiImag[source];
      eThetaReal[sample] += thetaReal * weightReal - thetaImag * weightImag;
      eThetaImag[sample] += thetaReal * weightImag + thetaImag * weightReal;
      ePhiReal[sample] += phiReal * weightReal - phiImag * weightImag;
      ePhiImag[sample] += phiReal * weightImag + phiImag * weightReal;
    }
  }
  return { eThetaReal, eThetaImag, ePhiReal, ePhiImag };
}

function scaledDifference(reference, actual, realName, imagName) {
  let scale = 1;
  let difference = 0;
  for (let index = 0; index < reference[realName].length; index += 1) {
    scale = Math.max(scale, Math.hypot(reference[realName][index], reference[imagName][index]));
    difference = Math.max(difference, Math.hypot(
      reference[realName][index] - actual[realName][index],
      reference[imagName][index] - actual[imagName][index],
    ));
  }
  return difference / scale;
}

function fieldMetrics(field) {
  let magnitudeSum = 0;
  let peakMagnitude = -1;
  let peakIndex = -1;
  for (let index = 0; index < field.eThetaReal.length; index += 1) {
    const magnitude = field.eThetaReal[index] ** 2 + field.eThetaImag[index] ** 2
      + field.ePhiReal[index] ** 2 + field.ePhiImag[index] ** 2;
    magnitudeSum += magnitude;
    if (magnitude > peakMagnitude) {
      peakMagnitude = magnitude;
      peakIndex = index;
    }
  }
  return { magnitudeSum, peakMagnitude, peakIndex };
}

class ResidentBasisClient {
  #worker = new Worker(new URL("./embedded-resident-worker.mjs", import.meta.url));
  #pending = new Map();
  #nextId = 1;

  constructor() {
    this.#worker.on("message", (message) => {
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      this.#pending.delete(message.id);
      if (message.kind === "error") pending.reject(new Error(message.message));
      else pending.resolve(message);
    });
    this.#worker.on("error", (error) => {
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
    });
  }

  request(message, transfer = []) {
    const id = this.#nextId++;
    return new Promise((resolvePromise, reject) => {
      this.#pending.set(id, { resolve: resolvePromise, reject });
      this.#worker.postMessage({ ...message, id }, transfer);
    });
  }

  initialize(embedded) {
    const basis = {
      portCount: embedded.ports.length,
      samplesPerPort: embedded.samplesPerPort,
      eThetaReal: embedded.eThetaReal,
      eThetaImag: embedded.eThetaImag,
      ePhiReal: embedded.ePhiReal,
      ePhiImag: embedded.ePhiImag,
    };
    return this.request({ kind: "initialize", basis }, [
      basis.eThetaReal.buffer, basis.eThetaImag.buffer,
      basis.ePhiReal.buffer, basis.ePhiImag.buffer,
    ]);
  }

  combine(weights) {
    return this.request({ kind: "combine", weights });
  }

  release() {
    return this.request({ kind: "release" });
  }

  async terminate() {
    await this.#worker.terminate();
  }
}

async function measureCase(api, portCount, gridName, grid) {
  const fixture = squareFixture(portCount);
  const memoryBefore = maybeGc();
  let peakRssBytes = memoryBefore.rssBytes;
  const solver = await api.createNecArraySolver(fixture.description, {
    symmetry: "auto",
    symmetrizer: { positionEpsilonM: 0 },
    fieldWorkers: 4,
  });
  const resident = new ResidentBasisClient();
  try {
    const prepare = await timed(() => solver.prepare({ frequencyMHz: fixture.frequencyMHz }));
    const firstRequested = steeringCurrents(fixture, STEERING_POINTS[0]);
    const firstSolve = await timed(() => solver.solveCurrents(firstRequested));
    const poolWarmup = await timed(() => solver.computeFarField(grid));
    const generationBeforeBasis = firstSolve.value.solveGeneration;
    const basis = await timed(() => solver.computeEmbeddedFarFields(
      grid, { kind: "unit-current", valueA: 1 },
    ));
    const memoryAfterBasis = maybeGc();
    peakRssBytes = Math.max(peakRssBytes, memoryAfterBasis.rssBytes);
    if (solver.state !== "solved" || basis.value.normalization.kind !== "unit-current") {
      throw new Error("Embedded calculation changed state or normalization");
    }

    const states = [];
    const achieved = [];
    const localFields = [];
    let maxThetaDifference = 0;
    let maxPhiDifference = 0;
    let metricsEquivalent = true;
    let peakIndexExact = true;
    let maximumPeakRelativeError = 0;
    let maximumMagnitudeSumRelativeError = 0;
    let powerClosureEquivalent = true;
    for (let index = 0; index < measuredStates; index += 1) {
      const requested = steeringCurrents(fixture, STEERING_POINTS[index]);
      const solve = await timed(() => solver.solveCurrents(requested));
      const direct = await timed(() => solver.computeFarField(grid));
      const combined = await timed(() => superposeEmbedded(basis.value, solve.value.currents));
      const thetaDifference = scaledDifference(
        direct.value, combined.value, "eThetaReal", "eThetaImag",
      );
      const phiDifference = scaledDifference(
        direct.value, combined.value, "ePhiReal", "ePhiImag",
      );
      maxThetaDifference = Math.max(maxThetaDifference, thetaDifference);
      maxPhiDifference = Math.max(maxPhiDifference, phiDifference);
      const directMetrics = fieldMetrics(direct.value);
      const combinedMetrics = fieldMetrics(combined.value);
      const peakRelativeError = Math.abs(
        directMetrics.peakMagnitude - combinedMetrics.peakMagnitude,
      ) / Math.max(1, directMetrics.peakMagnitude);
      const magnitudeSumRelativeError = Math.abs(
        directMetrics.magnitudeSum - combinedMetrics.magnitudeSum,
      ) / Math.max(1, directMetrics.magnitudeSum);
      maximumPeakRelativeError = Math.max(maximumPeakRelativeError, peakRelativeError);
      maximumMagnitudeSumRelativeError = Math.max(
        maximumMagnitudeSumRelativeError, magnitudeSumRelativeError,
      );
      peakIndexExact &&= directMetrics.peakIndex === combinedMetrics.peakIndex;
      metricsEquivalent &&= peakRelativeError <= 1e-9
        && magnitudeSumRelativeError <= 1e-9;
      powerClosureEquivalent &&= Number.isFinite(solve.value.powerBudget.inputPowerW)
        && Math.abs(solve.value.powersW.reduce((sum, value) => sum + value, 0)
          - solve.value.powerBudget.inputPowerW)
          <= 1e-8 * Math.max(1, Math.abs(solve.value.powerBudget.inputPowerW));
      achieved.push(copyWeights(solve.value.currents));
      localFields.push(combined.value);
      states.push({
        steering: STEERING_POINTS[index],
        solveMs: solve.ms,
        directFieldMs: direct.ms,
        localCombinationMs: combined.ms,
        requestedChecksum: complexVectorChecksum(requested),
        achievedChecksum: complexVectorChecksum(solve.value.currents),
        directChecksum: farFieldChecksum(direct.value),
        thetaScaledMaximum: thetaDifference,
        phiScaledMaximum: phiDifference,
        factorizationGeneration: solve.value.factorizationGeneration,
        solveGeneration: solve.value.solveGeneration,
        fieldBackend: direct.value.fieldBackend,
      });
      peakRssBytes = Math.max(peakRssBytes, memory().rssBytes);
    }

    const basisTransfer = await timed(() => resident.initialize(basis.value));
    const memoryResident = maybeGc();
    peakRssBytes = Math.max(peakRssBytes, memoryResident.rssBytes);
    const residentStates = [];
    let residentThetaDifference = 0;
    let residentPhiDifference = 0;
    for (let index = 0; index < achieved.length; index += 1) {
      const combined = await timed(() => resident.combine(achieved[index]));
      const field = combined.value.field;
      residentThetaDifference = Math.max(residentThetaDifference, scaledDifference(
        localFields[index], field, "eThetaReal", "eThetaImag",
      ));
      residentPhiDifference = Math.max(residentPhiDifference, scaledDifference(
        localFields[index], field, "ePhiReal", "ePhiImag",
      ));
      residentStates.push({
        index,
        roundTripMs: combined.ms,
        workerComputeMs: combined.value.computeMs,
      });
    }
    await resident.release();
    const summary = {
      solveMs: timingStats(states.map((value) => value.solveMs)),
      directFieldMs: timingStats(states.map((value) => value.directFieldMs)),
      localCombinationMs: timingStats(states.map((value) => value.localCombinationMs)),
      residentRoundTripMs: timingStats(residentStates.map((value) => value.roundTripMs)),
      residentComputeMs: timingStats(residentStates.map((value) => value.workerComputeMs)),
    };
    const directPerStateMs = summary.solveMs.median + summary.directFieldMs.median;
    const transferredPerStateMs = summary.solveMs.median + summary.localCombinationMs.median;
    const residentPerStateMs = summary.solveMs.median + summary.residentRoundTripMs.median;
    const residentSetupMs = basis.ms + basisTransfer.ms;
    const generationAfterBasis = states[0].solveGeneration - 1;
    return {
      portCount,
      gridName,
      grid,
      samplesPerPort: grid.theta.count * grid.phi.count,
      basisBytes: embeddedBasisBytes(portCount, grid.theta.count * grid.phi.count),
      estimatedNativePlusTransferredBasisBytes:
        2 * embeddedBasisBytes(portCount, grid.theta.count * grid.phi.count),
      prepareMs: prepare.ms,
      initialSolveMs: firstSolve.ms,
      poolWarmupMs: poolWarmup.ms,
      embeddedBasisWarmupMs: basis.ms,
      residentBasisTransferMs: basisTransfer.ms,
      generationBeforeBasis,
      generationAfterBasis,
      states,
      residentStates,
      summary,
      amortization: {
        method: "measured-median linear model; basis setup measured once",
        directPerStateMs,
        transferredPerStateMs,
        residentPerStateMs,
        transferredBreakEvenStates: breakEvenSteeringCount(
          basis.ms, directPerStateMs, transferredPerStateMs,
        ),
        residentBreakEvenStates: breakEvenSteeringCount(
          residentSetupMs, directPerStateMs, residentPerStateMs,
        ),
        transferredTotals: amortizedTotals(basis.ms, directPerStateMs, transferredPerStateMs),
        residentTotals: amortizedTotals(residentSetupMs, directPerStateMs, residentPerStateMs),
      },
      correctness: {
        directVersusTransferredThetaScaledMaximum: maxThetaDifference,
        directVersusTransferredPhiScaledMaximum: maxPhiDifference,
        transferredVersusResidentThetaScaledMaximum: residentThetaDifference,
        transferredVersusResidentPhiScaledMaximum: residentPhiDifference,
        metricsEquivalent,
        peakIndexExact,
        maximumPeakRelativeError,
        maximumMagnitudeSumRelativeError,
        powerClosureEquivalent,
        statePreserved: generationAfterBasis === generationBeforeBasis,
        callerPortOrderPreserved: basis.value.ports.length === portCount,
      },
      memory: {
        before: memoryBefore,
        afterBasis: memoryAfterBasis,
        resident: memoryResident,
        peakRssBytes,
        peakRssDeltaBytes: peakRssBytes - memoryBefore.rssBytes,
      },
    };
  } finally {
    await resident.terminate();
    await solver.dispose();
  }
}

async function main() {
  const api = await import(pathToFileURL(resolve(distDirectory, "index.js")).href);
  const baseFixture = createFarFieldFixture();
  const grids = [
    ["primary", PRIMARY_FIELD_GRID],
    ["secondary", sourceGridForDisplay(baseFixture, 32, 32)],
  ];
  const cases = [];
  for (const portCount of PORT_COUNTS) {
    for (const [gridName, grid] of grids) {
      process.stdout.write(`Measuring WP5 ${portCount}-port ${gridName} case...\n`);
      cases.push(await measureCase(api, portCount, gridName, grid));
    }
  }
  const correctnessTolerance = 1e-8;
  const gates = {
    allCasesPresent: cases.length === PORT_COUNTS.length * grids.length,
    numericalParity: cases.every((value) =>
      value.correctness.directVersusTransferredThetaScaledMaximum <= correctnessTolerance
      && value.correctness.directVersusTransferredPhiScaledMaximum <= correctnessTolerance
      && value.correctness.transferredVersusResidentThetaScaledMaximum === 0
      && value.correctness.transferredVersusResidentPhiScaledMaximum === 0),
    lifecycleAndPower: cases.every((value) => value.correctness.statePreserved
      && value.correctness.callerPortOrderPreserved
      && value.correctness.metricsEquivalent
      && value.correctness.powerClosureEquivalent),
  };
  const artifactNames = [
    "index.js", "worker-entry.js", "field-worker-pool.js", "field-evaluator.js",
    "nec2pp.wasm", "necpp-field-evaluator.wasm",
  ];
  const output = {
    type: "far-field-wp5-amortization",
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    configuration: {
      portCounts: PORT_COUNTS,
      horizons: HORIZONS,
      measuredStates,
      fieldWorkers: 4,
      normalization: { kind: "unit-current", valueA: 1 },
      grids: Object.fromEntries(grids),
      residentPrototype: "benchmark-only Node worker; not production package code",
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
      engineCommit: git(["rev-parse", "HEAD"]).trim(),
      gitStatus: git(["status", "--short"]).trim().split(/\r?\n/).filter(Boolean),
      artifacts: Object.fromEntries(artifactNames.map((name) => {
        const path = resolve(distDirectory, name);
        return [name, { bytes: statSync(path).size, sha256: sha256(path) }];
      })),
    },
    cacheIdentityDecision: {
      invalidates: [
        "geometry", "ports/order", "loads", "ground/connection",
        "prepared-frequency", "normalization", "source-grid/radius",
      ],
      doesNotInvalidate: [
        "steering", "taper", "element-enable", "source-power", "matching",
        "target-grid", "view", "polarization",
      ],
    },
    cases,
    gates,
    ok: Object.values(gates).every(Boolean),
  };
  mkdirSync(outputDirectory, { recursive: true });
  const outputPath = resolve(outputDirectory, "far-field-wp5-amortization.json");
  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ outputPath, gates }, null, 2)}\n`);
  if (!output.ok) process.exitCode = 1;
}

if (process.argv[1] !== undefined
    && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
