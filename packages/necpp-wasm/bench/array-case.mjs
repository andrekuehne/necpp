import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createReferenceArrayFixture } from "../test/fixtures/reference-array.mjs";

export const REPRESENTATIONS = Object.freeze([
  "explicit",
  "manual-reflection",
  "auto-reflection",
]);

export const FIELD_REQUEST = Object.freeze({
  radiusM: 100,
  theta: Object.freeze({ startDeg: 10, count: 9, stepDeg: 10 }),
  phi: Object.freeze({ startDeg: 0, count: 12, stepDeg: 30 }),
});

function requireInteger(value, name, minimum = 1) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return parsed;
}

function requirePositiveNumber(value, name) {
  const parsed = Number(value);
  if (!(parsed > 0) || !Number.isFinite(parsed)) {
    throw new Error(`${name} must be a positive finite number`);
  }
  return parsed;
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
  if (!REPRESENTATIONS.includes(backend) && backend !== "deck") {
    throw new Error(`--backend must be ${[...REPRESENTATIONS, "deck"].join(", ")}`);
  }
  const segments = requireInteger(values.get("segments"), "segments");
  if (segments % 2 === 0) {
    throw new Error("segments must be odd so every dipole has a centre segment");
  }
  return {
    backend,
    side: requireInteger(values.get("side"), "side"),
    segments,
    frequencyMHz: requirePositiveNumber(values.get("frequency-mhz"), "frequency-mhz"),
    retainedSolves: requireInteger(values.get("retained-solves"), "retained-solves", 0),
    round: requireInteger(values.get("round"), "round"),
    extractMatrix: values.get("extract-matrix") === "true",
    moduleDirectory: resolve(values.get("module-directory")),
  };
}

export function createArrayDefinition({ side, segments, frequencyMHz }) {
  const fixture = createReferenceArrayFixture({ side, segments, frequencyMHz });
  return {
    ...fixture,
    description: {
      elements: fixture.wires.map((wire, index) => ({
        id: `element-${index}`,
        positionM: [wire.start[0], wire.start[1]],
        patternId: "reference-dipole",
      })),
      patterns: [{
        id: "reference-dipole",
        kind: "straight-wire-pattern",
        wires: [{
          id: "radiator",
          segments: fixture.segments,
          startM: [0, 0, fixture.lowerZM],
          endM: [0, 0, fixture.upperZM],
          radiusM: fixture.radiusM,
        }],
        ports: [{ wireId: "radiator", segment: fixture.feedSegment, name: "feed" }],
      }],
      ground: fixture.ground,
    },
  };
}

export function buildEquivalentDeck(definition) {
  const lines = [`CM WASM ARRAY BENCHMARK ${definition.side} X ${definition.side}`, "CE"];
  for (const wire of definition.wires) {
    lines.push(["GW", wire.tag, wire.segments, ...wire.start, ...wire.end, wire.radiusM].join(" "));
  }
  lines.push("GE 0", `FR 0 1 0 0 ${definition.frequencyMHz} 0`, "GN 1");
  for (const port of definition.ports) {
    lines.push(`EX 0 ${port.tag} ${port.segment} 0 1 0`);
  }
  lines.push("XQ", "EN");
  return `${lines.join("\n")}\n`;
}

export function parseDeckSourceCurrents(report, expectedCount) {
  const lines = report.split(/\r?\n/);
  const start = lines.findIndex((line) => line.includes("----- ANTENNA INPUT PARAMETERS -----"));
  const end = lines.findIndex((line, index) =>
    index > start && line.includes("----- CURRENTS AND LOCATION -----"));
  if (start < 0 || end < 0) {
    throw new Error("legacy report does not contain source-current tables");
  }
  const currents = [];
  for (const line of lines.slice(start + 1, end)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length >= 11 && /^\d+$/.test(fields[0]) && /^\d+$/.test(fields[1])) {
      const real = Number(fields[4]);
      const imag = Number(fields[5]);
      if (Number.isFinite(real) && Number.isFinite(imag)) {
        currents.push({ real, imag });
      }
    }
  }
  if (currents.length !== expectedCount) {
    throw new Error(`legacy report has ${currents.length} source currents; expected ${expectedCount}`);
  }
  return currents;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function serializeComplex(value) {
  return { real: Array.from(value.real), imag: Array.from(value.imag) };
}

function complexChecksum(value) {
  let sumReal = 0;
  let sumImag = 0;
  let normSquared = 0;
  for (let index = 0; index < value.real.length; index += 1) {
    sumReal += value.real[index];
    sumImag += value.imag[index];
    normSquared += value.real[index] ** 2 + value.imag[index] ** 2;
  }
  return { sumReal, sumImag, l2Norm: Math.sqrt(normSquared) };
}

function steeringCurrents(definition, solveIndex = 0) {
  const theta = (31 + solveIndex * 3) * Math.PI / 180;
  const phi = (47 + solveIndex * 7) * Math.PI / 180;
  const ux = Math.sin(theta) * Math.cos(phi);
  const uy = Math.sin(theta) * Math.sin(phi);
  const waveNumber = 2 * Math.PI / definition.wavelengthM;
  return {
    real: Float64Array.from(definition.wires, (wire, index) => {
      const phase = -waveNumber * (ux * wire.start[0] + uy * wire.start[1]);
      const amplitude = 0.8 + 0.2 * Math.cos((index + solveIndex) * 0.23);
      return amplitude * Math.cos(phase);
    }),
    imag: Float64Array.from(definition.wires, (wire, index) => {
      const phase = -waveNumber * (ux * wire.start[0] + uy * wire.start[1]);
      const amplitude = 0.8 + 0.2 * Math.cos((index + solveIndex) * 0.23);
      return amplitude * Math.sin(phase);
    }),
  };
}

function scatterFromPlan(plan, portCount) {
  const scatter = new Array(portCount);
  for (const mapping of plan.mappings) {
    if (mapping.callerPortIndices.length !== 1 || mapping.generatedPortIndices.length !== 1) {
      throw new Error("reference benchmark expects one port per element");
    }
    scatter[mapping.callerPortIndices[0]] = mapping.generatedPortIndices[0];
  }
  if (scatter.some((value) => !Number.isSafeInteger(value))) {
    throw new Error("automatic symmetry plan did not map every caller port");
  }
  return scatter;
}

function scatterComplexVector(value, scatter) {
  const real = new Float64Array(scatter.length);
  const imag = new Float64Array(scatter.length);
  for (let caller = 0; caller < scatter.length; caller += 1) {
    real[scatter[caller]] = value.real[caller];
    imag[scatter[caller]] = value.imag[caller];
  }
  return { real, imag };
}

function gatherComplexVector(value, scatter) {
  return {
    real: Float64Array.from(scatter, (native) => value.real[native]),
    imag: Float64Array.from(scatter, (native) => value.imag[native]),
  };
}

function gatherComplexMatrix(value, scatter) {
  const order = scatter.length;
  const real = new Float64Array(order * order);
  const imag = new Float64Array(order * order);
  for (let row = 0; row < order; row += 1) {
    for (let column = 0; column < order; column += 1) {
      const source = scatter[row] * order + scatter[column];
      const target = row * order + column;
      real[target] = value.real[source];
      imag[target] = value.imag[source];
    }
  }
  return { rows: order, columns: order, real, imag };
}

function representationPlan(api, definition, backend) {
  if (backend === "explicit") {
    return {
      wires: definition.wires,
      symmetry: undefined,
      scatterCallerToNative: Array.from({ length: definition.ports.length }, (_, index) => index),
      analysisMs: 0,
      diagnostics: { representation: "explicit", exact: true },
    };
  }
  if (definition.reflection === undefined) {
    throw new Error(`${backend} requires an even-sided reference array`);
  }
  if (backend === "manual-reflection") {
    return {
      wires: definition.reflection.fundamentalWires,
      symmetry: definition.reflection.symmetry,
      scatterCallerToNative: definition.reflection.scatterCallerToGenerated,
      analysisMs: 0,
      diagnostics: {
        representation: "symmetric",
        exact: true,
        sectionCount: definition.reflection.sectionCount,
      },
    };
  }

  const analysisStart = performance.now();
  const plan = api.analyzeArraySymmetry(definition.description, {
    positionEpsilonM: 0,
    allowReflection: true,
    allowRotation: false,
  });
  const analysisMs = performance.now() - analysisStart;
  if (plan.kind !== "symmetric" || plan.symmetry.kind !== "reflection"
      || plan.expansion.sectionCount !== 4) {
    throw new Error("automatic planner did not select four-section XY reflection");
  }
  return {
    wires: plan.fundamentalElements.map((element, index) => ({
      tag: index + 1,
      segments: definition.segments,
      start: [element.positionM[0], element.positionM[1], definition.lowerZM],
      end: [element.positionM[0], element.positionM[1], definition.upperZM],
      radiusM: definition.radiusM,
    })),
    symmetry: plan.symmetry,
    scatterCallerToNative: scatterFromPlan(plan, definition.ports.length),
    analysisMs,
    diagnostics: {
      representation: plan.diagnostics.representation,
      exact: plan.diagnostics.exact,
      sectionCount: plan.expansion.sectionCount,
      maxPositionAdjustmentM: plan.maxPositionAdjustmentM,
    },
  };
}

function gatherSolution(solution, scatter) {
  const powersW = new Float64Array(scatter.length);
  for (let caller = 0; caller < scatter.length; caller += 1) {
    powersW[caller] = solution.powersW[scatter[caller]];
  }
  return {
    requested: gatherComplexVector(solution.requested, scatter),
    voltages: gatherComplexVector(solution.voltages, scatter),
    currents: gatherComplexVector(solution.currents, scatter),
    activeImpedances: gatherComplexVector(solution.activeImpedances, scatter),
    powersW,
  };
}

function solutionPayload(solution) {
  return {
    requested: serializeComplex(solution.requested),
    voltages: serializeComplex(solution.voltages),
    currents: serializeComplex(solution.currents),
    activeImpedances: serializeComplex(solution.activeImpedances),
    powersW: Array.from(solution.powersW),
  };
}

function farFieldPayload(field) {
  return {
    thetaDeg: Array.from(field.thetaDeg),
    phiDeg: Array.from(field.phiDeg),
    eTheta: { real: Array.from(field.eThetaReal), imag: Array.from(field.eThetaImag) },
    ePhi: { real: Array.from(field.ePhiReal), imag: Array.from(field.ePhiImag) },
  };
}

function matrixPayload(result, scatter) {
  const impedance = gatherComplexMatrix(result.impedance, scatter);
  const admittance = gatherComplexMatrix(result.admittance, scatter);
  return {
    order: impedance.rows,
    impedance: serializeComplex(impedance),
    admittance: serializeComplex(admittance),
  };
}

export function primaryInteractionMatrixBytes(fullEquations, sectionCount = 1) {
  if (!Number.isSafeInteger(fullEquations) || fullEquations < 1
      || !Number.isSafeInteger(sectionCount) || sectionCount < 1
      || fullEquations % sectionCount !== 0) {
    throw new Error("matrix dimensions must be positive compatible integers");
  }
  // nec_context::stateful_prepare_frequency allocates n * np complex<double>
  // entries for wire-only symmetry, where np = n / sectionCount.
  return fullEquations * (fullEquations / sectionCount) * 16;
}

async function runRepresentation(api, definition, backend, retainedSolves, extractMatrix) {
  const totalStart = performance.now();
  const plan = representationPlan(api, definition, backend);
  const memorySamples = [process.memoryUsage().rss];
  const instantiateStart = performance.now();
  const model = await api.createNecModel();
  const instantiateMs = performance.now() - instantiateStart;
  memorySamples.push(process.memoryUsage().rss);
  try {
    const constructionStart = performance.now();
    for (const wire of plan.wires) model.addWire(wire);
    const geometryConstructionMs = performance.now() - constructionStart;
    memorySamples.push(process.memoryUsage().rss);

    const completionStart = performance.now();
    const completion = model.completeGeometry({
      groundConnection: definition.groundConnection,
      ...(plan.symmetry === undefined ? {} : { symmetry: plan.symmetry }),
    });
    const geometryCompletionMs = performance.now() - completionStart;
    memorySamples.push(process.memoryUsage().rss);

    const portEnvironmentStart = performance.now();
    model.definePorts(definition.ports);
    model.setGround(definition.ground);
    const portEnvironmentMs = performance.now() - portEnvironmentStart;

    const prepareStart = performance.now();
    model.prepare({ frequencyMHz: definition.frequencyMHz });
    const prepareMs = performance.now() - prepareStart;
    memorySamples.push(process.memoryUsage().rss);

    const callerCurrents = steeringCurrents(definition);
    const nativeCurrents = scatterComplexVector(callerCurrents, plan.scatterCallerToNative);
    const solveStart = performance.now();
    const nativeSolution = model.solveCurrents(nativeCurrents);
    const firstSolveMs = performance.now() - solveStart;
    const solution = gatherSolution(nativeSolution, plan.scatterCallerToNative);
    memorySamples.push(process.memoryUsage().rss);

    const fieldStart = performance.now();
    const field = model.computeFarField(FIELD_REQUEST);
    const combinedFarFieldMs = performance.now() - fieldStart;
    memorySamples.push(process.memoryUsage().rss);

    let matrices;
    let impedanceMatrixMs = null;
    if (extractMatrix) {
      const matrixStart = performance.now();
      matrices = matrixPayload(model.computeImpedanceMatrix(), plan.scatterCallerToNative);
      impedanceMatrixMs = performance.now() - matrixStart;
      memorySamples.push(process.memoryUsage().rss);
    }
    const coldTotalMs = performance.now() - totalStart;

    const retainedSolveTimesMs = [];
    for (let index = 0; index < retainedSolves; index += 1) {
      const retainedCaller = steeringCurrents(definition, index + 1);
      const retainedNative = scatterComplexVector(retainedCaller, plan.scatterCallerToNative);
      const retainedStart = performance.now();
      model.solveCurrents(retainedNative);
      retainedSolveTimesMs.push(performance.now() - retainedStart);
    }
    memorySamples.push(process.memoryUsage().rss);

    const sectionCount = completion?.symmetry?.sectionCount ?? 1;
    const peakObservedRssBytes = Math.max(...memorySamples);
    return {
      engineVersion: api.engineVersion,
      timings: {
        analysisMs: plan.analysisMs,
        instantiateMs,
        geometryConstructionMs,
        geometryCompletionMs,
        portEnvironmentMs,
        prepareMs,
        firstSolveMs,
        combinedFarFieldMs,
        impedanceMatrixMs,
        coldTotalMs,
        retainedSolveCount: retainedSolves,
        retainedSolveMedianMs: median(retainedSolveTimesMs),
        retainedSolveMinMs: retainedSolveTimesMs.length === 0 ? null : Math.min(...retainedSolveTimesMs),
        retainedSolveMaxMs: retainedSolveTimesMs.length === 0 ? null : Math.max(...retainedSolveTimesMs),
        totalWithRetainedSolvesMs: performance.now() - totalStart,
      },
      representation: {
        ...plan.diagnostics,
        sectionCount,
        fundamentalSegmentCount: completion?.symmetry?.fundamentalSegmentCount ?? definition.equations,
        fullSegmentCount: completion?.symmetry?.fullSegmentCount ?? definition.equations,
      },
      memory: {
        rssBeforeBytes: memorySamples[0],
        peakObservedRssBytes,
        peakObservedRssDeltaBytes: peakObservedRssBytes - memorySamples[0],
        primaryInteractionMatrixBytes: primaryInteractionMatrixBytes(definition.equations, sectionCount),
        explicitPrimaryInteractionMatrixBytes: primaryInteractionMatrixBytes(definition.equations),
      },
      checksums: {
        currents: complexChecksum(solution.currents),
        eTheta: complexChecksum({ real: field.eThetaReal, imag: field.eThetaImag }),
        ePhi: complexChecksum({ real: field.ePhiReal, imag: field.ePhiImag }),
      },
      correctness: {
        solution: solutionPayload(solution),
        field: farFieldPayload(field),
        ...(matrices === undefined ? {} : { matrices }),
      },
    };
  } finally {
    model.dispose();
  }
}

async function runDeck(api, definition) {
  const totalStart = performance.now();
  const buildStart = performance.now();
  const deck = buildEquivalentDeck(definition);
  const deckBuildMs = performance.now() - buildStart;
  const runStart = performance.now();
  const result = await api.runDeck(deck);
  const runDeckMs = performance.now() - runStart;
  const currents = parseDeckSourceCurrents(result.report, definition.ports.length);
  return {
    engineVersion: result.engineVersion,
    timings: { deckBuildMs, runDeckMs, coldTotalMs: performance.now() - totalStart },
    reportBytes: Buffer.byteLength(result.report),
    reportLines: result.report.split(/\r?\n/).length,
    deckBytes: Buffer.byteLength(deck),
    checksums: {
      sourceCurrents: complexChecksum({
        real: Float64Array.from(currents, ({ real }) => real),
        imag: Float64Array.from(currents, ({ imag }) => imag),
      }),
    },
  };
}

function classifyError(error) {
  if (error?.code === "NEC_CONDITIONING") return "numerical-conditioning";
  if (/alloc|memory|out of bounds/i.test(error?.message ?? "")) return "allocation";
  if (/wasm|trap|unreachable/i.test(error?.message ?? "")) return "wasm-trap";
  return "runtime";
}

function serializeError(error) {
  return {
    category: classifyError(error),
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
    code: error?.code,
    stack: error?.stack,
    cause: error?.cause === undefined
      ? undefined
      : { name: error.cause?.name, message: error.cause?.message ?? String(error.cause) },
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const api = await import(pathToFileURL(resolve(options.moduleDirectory, "index.js")).href);
  const definitionStart = performance.now();
  const definition = createArrayDefinition(options);
  const definitionMs = performance.now() - definitionStart;
  try {
    const backendResult = options.backend === "deck"
      ? await runDeck(api, definition)
      : await runRepresentation(
        api,
        definition,
        options.backend,
        options.retainedSolves,
        options.extractMatrix,
      );
    process.stdout.write(`${JSON.stringify({
      type: "case",
      schemaVersion: 2,
      ok: true,
      backend: options.backend,
      side: options.side,
      round: options.round,
      segmentsPerDipole: options.segments,
      equations: definition.equations,
      ports: definition.ports.length,
      frequencyMHz: definition.frequencyMHz,
      definitionMs,
      matrixExtracted: options.extractMatrix,
      ...backendResult,
    })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      type: "case",
      schemaVersion: 2,
      ok: false,
      backend: options.backend,
      side: options.side,
      round: options.round,
      segmentsPerDipole: options.segments,
      equations: definition.equations,
      ports: definition.ports.length,
      frequencyMHz: definition.frequencyMHz,
      definitionMs,
      matrixExtracted: options.extractMatrix,
      error: serializeError(error),
    })}\n`);
    process.exitCode = 1;
  }
}

const entryPoint = process.argv[1] === undefined ? undefined : pathToFileURL(process.argv[1]).href;
if (entryPoint === import.meta.url) await main();
