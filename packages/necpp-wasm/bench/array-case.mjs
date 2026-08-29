import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const SPEED_OF_LIGHT_M_PER_S = 299_792_458;

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
  if (backend !== "stateful" && backend !== "deck") {
    throw new Error("--backend must be stateful or deck");
  }
  const segments = requireInteger(values.get("segments"), "segments");
  if (segments % 2 === 0) {
    throw new Error("segments must be odd so every dipole has a centre segment");
  }
  return {
    backend,
    side: requireInteger(values.get("side"), "side"),
    segments,
    frequencyMHz: requirePositiveNumber(
      values.get("frequency-mhz"),
      "frequency-mhz",
    ),
    retainedSolves: requireInteger(
      values.get("retained-solves"),
      "retained-solves",
      0,
    ),
    round: requireInteger(values.get("round"), "round"),
  };
}

export function createArrayDefinition({ side, segments, frequencyMHz }) {
  const wavelengthM = SPEED_OF_LIGHT_M_PER_S / (frequencyMHz * 1e6);
  const elementHalfLengthM = wavelengthM / 8;
  const spacingM = wavelengthM / 2;
  const radiusM = wavelengthM / 1000;
  const centreSegment = (segments + 1) / 2;
  const wires = [];
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      const tag = y * side + x + 1;
      const xM = (x - (side - 1) / 2) * spacingM;
      const yM = (y - (side - 1) / 2) * spacingM;
      wires.push({
        tag,
        segments,
        start: [xM, yM, -elementHalfLengthM],
        end: [xM, yM, elementHalfLengthM],
        radiusM,
      });
    }
  }
  return {
    side,
    segments,
    frequencyMHz,
    wavelengthM,
    wires,
    ports: wires.map(({ tag }) => ({ tag, segment: centreSegment })),
    equations: side * side * segments,
  };
}

export function buildEquivalentDeck(definition) {
  const lines = [
    `CM WASM ARRAY BENCHMARK ${definition.side} X ${definition.side}`,
    "CE",
  ];
  for (const wire of definition.wires) {
    lines.push([
      "GW",
      wire.tag,
      wire.segments,
      ...wire.start,
      ...wire.end,
      wire.radiusM,
    ].join(" "));
  }
  lines.push(
    "GE 0",
    `FR 0 1 0 0 ${definition.frequencyMHz} 0`,
  );
  for (const port of definition.ports) {
    lines.push(`EX 0 ${port.tag} ${port.segment} 0 1 0`);
  }
  lines.push("XQ", "EN");
  return `${lines.join("\n")}\n`;
}

export function parseDeckSourceCurrents(report, expectedCount) {
  const lines = report.split(/\r?\n/);
  const start = lines.findIndex((line) =>
    line.includes("----- ANTENNA INPUT PARAMETERS -----"));
  const end = lines.findIndex((line, index) =>
    index > start && line.includes("----- CURRENTS AND LOCATION -----"));
  if (start < 0 || end < 0) {
    throw new Error("legacy report does not contain source-current tables");
  }
  const currents = [];
  for (const line of lines.slice(start + 1, end)) {
    const fields = line.trim().split(/\s+/);
    if (
      fields.length >= 11
      && /^\d+$/.test(fields[0])
      && /^\d+$/.test(fields[1])
    ) {
      const real = Number(fields[4]);
      const imag = Number(fields[5]);
      if (Number.isFinite(real) && Number.isFinite(imag)) {
        currents.push({ real, imag });
      }
    }
  }
  if (currents.length !== expectedCount) {
    throw new Error(
      `legacy report has ${currents.length} source currents; expected ${expectedCount}`,
    );
  }
  return currents;
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

function currentChecksum(currents) {
  let sumReal = 0;
  let sumImag = 0;
  let normSquared = 0;
  for (const current of currents) {
    sumReal += current.real;
    sumImag += current.imag;
    normSquared += current.real ** 2 + current.imag ** 2;
  }
  return { sumReal, sumImag, l2Norm: Math.sqrt(normSquared) };
}

async function runStateful(api, definition, retainedSolves) {
  const totalStart = performance.now();
  const instantiateStart = performance.now();
  const model = await api.createNecModel();
  const instantiateMs = performance.now() - instantiateStart;
  try {
    const geometryStart = performance.now();
    for (const wire of definition.wires) {
      model.addWire(wire);
    }
    model.completeGeometry();
    model.definePorts(definition.ports);
    const geometryMs = performance.now() - geometryStart;

    const prepareStart = performance.now();
    model.prepare({ frequencyMHz: definition.frequencyMHz });
    const prepareMs = performance.now() - prepareStart;

    const drive = {
      real: new Float64Array(definition.ports.length).fill(1),
      imag: new Float64Array(definition.ports.length),
    };
    const solveStart = performance.now();
    const solution = model.solveVoltages(drive);
    const firstSolveMs = performance.now() - solveStart;
    const coldTotalMs = performance.now() - totalStart;
    const retainedSolveTimesMs = [];
    for (let index = 0; index < retainedSolves; index += 1) {
      const retainedStart = performance.now();
      model.solveVoltages(drive);
      retainedSolveTimesMs.push(performance.now() - retainedStart);
    }
    const currents = Array.from(solution.currents.real, (real, index) => ({
      real,
      imag: solution.currents.imag[index],
    }));
    if (!currents.every(({ real, imag }) =>
      Number.isFinite(real) && Number.isFinite(imag))) {
      throw new Error("stateful solve returned a non-finite source current");
    }
    return {
      engineVersion: api.engineVersion,
      timings: {
        instantiateMs,
        geometryMs,
        prepareMs,
        firstSolveMs,
        coldTotalMs,
        retainedSolveCount: retainedSolves,
        retainedSolveMedianMs: median(retainedSolveTimesMs),
        retainedSolveMinMs: retainedSolveTimesMs.length === 0
          ? null
          : Math.min(...retainedSolveTimesMs),
        retainedSolveMaxMs: retainedSolveTimesMs.length === 0
          ? null
          : Math.max(...retainedSolveTimesMs),
        totalWithRetainedSolvesMs: performance.now() - totalStart,
      },
      currents,
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
  const currents = parseDeckSourceCurrents(
    result.report,
    definition.ports.length,
  );
  return {
    engineVersion: result.engineVersion,
    timings: {
      deckBuildMs,
      runDeckMs,
      coldTotalMs: performance.now() - totalStart,
    },
    reportBytes: Buffer.byteLength(result.report),
    reportLines: result.report.split(/\r?\n/).length,
    deckBytes: Buffer.byteLength(deck),
    currents,
  };
}

function serializeError(error) {
  return {
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
    code: error?.code,
    stack: error?.stack,
    cause: error?.cause === undefined
      ? undefined
      : {
        name: error.cause?.name,
        message: error.cause?.message ?? String(error.cause),
      },
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const api = await import("../dist/index.js");
  const rssBeforeBytes = process.memoryUsage().rss;
  const definitionStart = performance.now();
  const definition = createArrayDefinition(options);
  const definitionMs = performance.now() - definitionStart;
  try {
    const backendResult = options.backend === "stateful"
      ? await runStateful(api, definition, options.retainedSolves)
      : await runDeck(api, definition);
    const rssAfterBytes = process.memoryUsage().rss;
    const currents = backendResult.currents;
    process.stdout.write(`${JSON.stringify({
      type: "case",
      ok: true,
      backend: options.backend,
      side: options.side,
      round: options.round,
      segmentsPerDipole: options.segments,
      equations: definition.equations,
      ports: definition.ports.length,
      frequencyMHz: definition.frequencyMHz,
      definitionMs,
      rssBeforeBytes,
      rssAfterBytes,
      rssDeltaBytes: rssAfterBytes - rssBeforeBytes,
      currentChecksum: currentChecksum(currents),
      firstCurrent: currents[0],
      portCurrents: currents,
      ...backendResult,
      currents: undefined,
    })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      type: "case",
      ok: false,
      backend: options.backend,
      side: options.side,
      round: options.round,
      segmentsPerDipole: options.segments,
      equations: definition.equations,
      ports: definition.ports.length,
      frequencyMHz: definition.frequencyMHz,
      definitionMs,
      error: serializeError(error),
    })}\n`);
    process.exitCode = 1;
  }
}

const entryPoint = process.argv[1] === undefined
  ? undefined
  : pathToFileURL(process.argv[1]).href;
if (entryPoint === import.meta.url) {
  await main();
}
