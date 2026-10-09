// One Full-NEC audit case in one process. Drives the public array-solver API
// through the visualizer's job sequence (create, prepare, Z, solveCurrents,
// getCurrentDistribution, computeFarField exact/ring, computeEmbeddedFarFields)
// and records wall time, CPU time, RSS and result bytes per stage.
//
// Usage:
//   node bench/full-nec-audit-case.mjs --module-directory DIST \
//     --element dipole|crossed|helix --layout sunflower|rect --count N \
//     --ground perfect|free [--symmetry off|auto] [--field-workers auto|1..8] \
//     [--grids 19x72,78x308] [--evaluators exact,ring] [--field-repeats 2] \
//     [--embedded-grids 1x1,19x72] [--embedded-budget-mib 192] \
//     [--steers 3] [--backend solver|direct] [--output file.ndjson] [--label x]
//
// Theta grids run 0..90 deg inclusive (thetaCount points); phi grids run
// 0..360 deg exclusive (phiCount points), i.e. periodic in phi, exactly as the
// visualizer's canonical NEC source grid.

import { appendFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const C0 = 299_792_458;
const FREQUENCY_HZ = 10e9;
const FREQUENCY_MHZ = FREQUENCY_HZ / 1e6;
const LAMBDA = C0 / FREQUENCY_HZ;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument near ${name ?? "end of command"}`);
    }
    values.set(name.slice(2), value);
  }
  const get = (name, fallback) => (values.has(name) ? values.get(name) : fallback);
  const grids = (text) => text.split(",").filter(Boolean).map((item) => {
    if (item === "auto") return { auto: true };
    const [theta, phi] = item.split("x").map(Number);
    if (!Number.isSafeInteger(theta) || !Number.isSafeInteger(phi)) {
      throw new Error(`bad grid ${item}`);
    }
    return { theta, phi };
  });
  return {
    moduleDirectory: resolve(get("module-directory", "dist")),
    element: get("element", "dipole"),
    layout: get("layout", "sunflower"),
    count: Number(get("count", "64")),
    ground: get("ground", "perfect"),
    symmetry: get("symmetry", "off"),
    fieldWorkers: get("field-workers", "auto"),
    grids: grids(get("grids", "19x72,78x308")),
    evaluators: get("evaluators", "exact,ring").split(",").filter(Boolean),
    fieldRepeats: Number(get("field-repeats", "2")),
    embeddedGrids: grids(get("embedded-grids", "1x1")),
    embeddedBudgetMiB: Number(get("embedded-budget-mib", "192")),
    steers: Number(get("steers", "3")),
    backend: get("backend", "solver"),
    output: values.has("output") ? resolve(values.get("output")) : null,
    label: get("label", ""),
    spacingLambda: Number(get("spacing-lambda", "0.5")),
    segments: Number(get("segments", "11")),
  };
}

// --- geometry -----------------------------------------------------------

function positions(layout, count, spacingM) {
  const out = [];
  if (layout === "sunflower") {
    for (let i = 0; i < count; i += 1) {
      const r = spacingM * Math.sqrt((i + 0.5) / Math.PI);
      const a = i * GOLDEN_ANGLE;
      out.push([r * Math.cos(a), r * Math.sin(a)]);
    }
  } else if (layout === "rect") {
    const nx = Math.ceil(Math.sqrt(count));
    const ny = Math.ceil(count / nx);
    for (let i = 0; i < count; i += 1) {
      const ix = i % nx;
      const iy = Math.floor(i / nx);
      out.push([(ix - (nx - 1) / 2) * spacingM, (iy - (ny - 1) / 2) * spacingM]);
    }
  } else {
    throw new Error(`unknown layout ${layout}`);
  }
  return out;
}

function dipolePattern(segments) {
  const half = 0.47 * LAMBDA / 2;
  const h = 0.25 * LAMBDA;
  return {
    id: "dipole",
    kind: "straight-wire-pattern",
    wires: [{ id: "w", segments, startM: [-half, 0, h], endM: [half, 0, h], radiusM: 0.001 * LAMBDA }],
    ports: [{ wireId: "w", segment: (segments + 1) / 2, name: "feed" }],
  };
}

function crossedPattern(segments) {
  const half = 0.47 * LAMBDA / 2;
  const h = 0.25 * LAMBDA;
  const sep = 0.005 * LAMBDA;
  const r = 0.001 * LAMBDA;
  return {
    id: "crossed",
    kind: "straight-wire-pattern",
    wires: [
      { id: "x", segments, startM: [-half, 0, h - sep / 2], endM: [half, 0, h - sep / 2], radiusM: r },
      { id: "y", segments, startM: [0, -half, h + sep / 2], endM: [0, half, h + sep / 2], radiusM: r },
    ],
    ports: [
      { wireId: "x", segment: (segments + 1) / 2, name: "x" },
      { wireId: "y", segment: (segments + 1) / 2, name: "y" },
    ],
  };
}

// Visualizer helix preset 1: D=0.27056, pitch=0.18067, 5 turns, feed 0.04,
// 12 segments per wavelength -> 10 chords per turn, 50 chords + 1 feed = 51.
function helixPattern() {
  const D = 0.27056 * LAMBDA;
  const pitch = 0.18067 * LAMBDA;
  const turns = 5;
  const feed = 0.04 * LAMBDA;
  const wr = 0.001 * LAMBDA;
  const chordsPerTurn = Math.max(1, Math.round(Math.hypot(Math.PI * D, pitch) / LAMBDA * 12));
  const chordCount = Math.max(3, Math.round(chordsPerTurn * turns));
  const radius = D / 2;
  const point = (phi, z0) => [radius * Math.cos(phi), radius * Math.sin(phi), z0 + pitch * phi / (2 * Math.PI)];
  const wires = [{ id: "feed", segments: 1, startM: [radius, 0, 0], endM: [radius, 0, feed], radiusM: wr }];
  let previous = point(0, feed);
  for (let i = 0; i < chordCount; i += 1) {
    const next = point(2 * Math.PI * turns * (i + 1) / chordCount, feed);
    wires.push({ id: `h${i}`, segments: 1, startM: previous, endM: next, radiusM: wr });
    previous = next;
  }
  return {
    id: "helix",
    kind: "straight-wire-pattern",
    wires,
    ports: [{ wireId: "feed", segment: 1, name: "feed" }],
  };
}

function buildDescription(options) {
  const pattern = options.element === "dipole" ? dipolePattern(options.segments)
    : options.element === "crossed" ? crossedPattern(options.segments)
      : options.element === "helix" ? helixPattern()
        : (() => { throw new Error(`unknown element ${options.element}`); })();
  const spacing = (options.element === "helix" && options.spacingLambda < 0.6 ? 0.6 : options.spacingLambda) * LAMBDA;
  const elements = positions(options.layout, options.count, spacing).map((positionM, index) => ({
    id: `e${index}`,
    positionM,
    patternId: pattern.id,
  }));
  const segmentsPerElement = pattern.wires.reduce((sum, wire) => sum + wire.segments, 0);
  return {
    description: {
      elements,
      patterns: [pattern],
      ground: options.ground === "perfect" ? { kind: "perfect" } : { kind: "free-space" },
      groundConnection: options.element === "helix" ? "interpolate" : "none",
    },
    segmentsPerElement,
    portsPerElement: pattern.ports.length,
    totalSegments: segmentsPerElement * elements.length,
    totalPorts: pattern.ports.length * elements.length,
    positions: elements.map((element) => element.positionM),
    apertureLambda: apertureLambda(elements.map((element) => element.positionM), pattern),
  };
}

function apertureLambda(positionsM, pattern) {
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity; let maxR = 0;
  for (const [x, y] of positionsM) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    maxR = Math.max(maxR, Math.hypot(x, y));
  }
  let extent = 0;
  for (const wire of pattern.wires) {
    extent = Math.max(extent, Math.hypot(wire.startM[0], wire.startM[1]), Math.hypot(wire.endM[0], wire.endM[1]));
  }
  return (Math.max(Math.hypot(maxX - minX, maxY - minY), 2 * maxR) + 2 * extent) / LAMBDA;
}

// Visualizer auto-grid rule: step = min(5 deg, 0.886/(aperture*samplesPerHpbw)).
export function autoGrid(aperture, samplesPerHpbw = 8) {
  const step = Math.min(5 * Math.PI / 180, 0.886 / (aperture * samplesPerHpbw));
  return { theta: Math.ceil((Math.PI / 2) / step) + 1, phi: Math.ceil(2 * Math.PI / step) };
}

function gridRequest(grid, evaluator) {
  return {
    radiusM: 1,
    evaluator,
    theta: { startDeg: 0, count: grid.theta, stepDeg: grid.theta > 1 ? 90 / (grid.theta - 1) : 0 },
    phi: { startDeg: 0, count: grid.phi, stepDeg: grid.phi > 1 ? 360 / grid.phi : 0 },
  };
}

function steeringCurrents(positionsM, portsPerElement, u, v) {
  const P = positionsM.length * portsPerElement;
  const real = new Float64Array(P);
  const imag = new Float64Array(P);
  const k = 2 * Math.PI / LAMBDA;
  for (let e = 0; e < positionsM.length; e += 1) {
    const [x, y] = positionsM[e];
    const phase = -k * (x * u + y * v);
    for (let p = 0; p < portsPerElement; p += 1) {
      real[e * portsPerElement + p] = Math.cos(phase);
      imag[e * portsPerElement + p] = Math.sin(phase);
    }
  }
  return { real, imag };
}

// --- timing helpers -----------------------------------------------------

function snapshotMemory() {
  const usage = process.memoryUsage();
  return { rssMiB: usage.rss / 2 ** 20, arrayBuffersMiB: usage.arrayBuffers / 2 ** 20, externalMiB: usage.external / 2 ** 20 };
}

async function timed(fn) {
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  let value; let error = null;
  try { value = await fn(); } catch (caught) { error = caught; }
  const wallMs = performance.now() - t0;
  const cpu = process.cpuUsage(cpu0);
  return { value, error, wallMs, cpuMs: (cpu.user + cpu.system) / 1000, memory: snapshotMemory() };
}

function fieldBytes(field) {
  return field.eThetaReal.byteLength + field.eThetaImag.byteLength + field.ePhiReal.byteLength + field.ePhiImag.byteLength
    + field.thetaDeg.byteLength + field.phiDeg.byteLength;
}

function fieldPeak(field) {
  let peak = 0;
  for (let i = 0; i < field.eThetaReal.length; i += 1) {
    const m = field.eThetaReal[i] ** 2 + field.eThetaImag[i] ** 2 + field.ePhiReal[i] ** 2 + field.ePhiImag[i] ** 2;
    if (m > peak) peak = m;
  }
  return Math.sqrt(peak);
}

function fieldMaxDiff(a, b) {
  let max = 0;
  for (let i = 0; i < a.eThetaReal.length; i += 1) {
    max = Math.max(max,
      Math.abs(a.eThetaReal[i] - b.eThetaReal[i]), Math.abs(a.eThetaImag[i] - b.eThetaImag[i]),
      Math.abs(a.ePhiReal[i] - b.ePhiReal[i]), Math.abs(a.ePhiImag[i] - b.ePhiImag[i]));
  }
  return max;
}

function errorSummary(error) {
  if (!error) return null;
  return { name: error?.name, code: error?.code, message: String(error?.message ?? error).slice(0, 300) };
}

// --- direct (in-process) backend adapter ----------------------------------

async function createDirectSolver(api, description) {
  const model = await api.createNecModel();
  const plan = api.createExplicitArrayBuildPlan(description);
  await api.applyArrayBuildPlan(model, description, plan);
  return {
    prepare: (o) => model.prepare(o),
    computeImpedanceMatrix: () => model.computeImpedanceMatrix(),
    solveCurrents: (c) => model.solveCurrents(c),
    getCurrentDistribution: (o) => model.getCurrentDistribution(o),
    computeFarField: (r) => model.computeFarField(r),
    computeEmbeddedFarFields: (r, n) => model.computeEmbeddedFarFields(r, n),
    getDiagnostics: () => ({ representation: "explicit", field: { backend: "direct" } }),
    dispose: () => model.dispose(),
  };
}

// --- main -----------------------------------------------------------------

export async function runCase(options) {
  const api = await import(pathToFileURL(resolve(options.moduleDirectory, "index.js")).href);
  const model = buildDescription(options);
  const auto = autoGrid(model.apertureLambda);
  options.grids = options.grids.map((grid) => (grid.auto ? auto : grid));
  options.embeddedGrids = options.embeddedGrids.map((grid) => (grid.auto ? auto : grid));
  const record = {
    schema: "full-nec-audit-case-v1",
    label: options.label,
    timestamp: new Date().toISOString(),
    host: { cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemGiB: totalmem() / 2 ** 30, node: process.version },
    moduleDirectory: options.moduleDirectory,
    packageVersion: api.packageVersion, engineVersion: api.engineVersion, abiVersion: api.abiVersion,
    case: {
      element: options.element, layout: options.layout, count: options.count, ground: options.ground,
      symmetry: options.symmetry, fieldWorkers: options.fieldWorkers, backend: options.backend,
      segmentsPerElement: model.segmentsPerElement, totalSegments: model.totalSegments,
      totalPorts: model.totalPorts, apertureLambda: model.apertureLambda,
      autoGrid: auto, autoGridSamples: auto.theta * auto.phi,
      matrixBytes: 16 * model.totalSegments ** 2,
    },
    stages: {},
    fields: [],
    embedded: [],
    memoryStart: snapshotMemory(),
  };
  const stage = (name, result, extra = {}) => {
    record.stages[name] = { wallMs: result.wallMs, cpuMs: result.cpuMs, memory: result.memory, error: errorSummary(result.error), ...extra };
    if (result.error) throw result.error;
    return result.value;
  };

  let solver = null;
  try {
    const creation = await timed(async () => {
      if (options.backend === "direct") return createDirectSolver(api, model.description);
      const solverOptions = { fieldWorkers: options.fieldWorkers === "auto" ? "auto" : Number(options.fieldWorkers) };
      if (options.symmetry === "auto") {
        solverOptions.symmetry = "auto";
        solverOptions.symmetrizer = { positionEpsilonM: 0, allowRotation: false };
      } else {
        solverOptions.symmetry = "off";
      }
      return api.createNecArraySolver(model.description, solverOptions);
    });
    solver = stage("create", creation);
    record.representation = solver.getDiagnostics().representation;

    stage("prepare", await timed(() => solver.prepare({ frequencyMHz: FREQUENCY_MHZ })));
    const impedance = stage("impedance", await timed(() => solver.computeImpedanceMatrix()), {});
    record.stages.impedance.order = impedance.impedance.real.length ** 0.5;
    record.stages.impedance.conditionEstimate = impedance.conditionEstimate ?? null;
    record.stages.impedance.bytes = impedance.impedance.real.byteLength * 4;

    // Steering states: broadside and two scans; each is one solveCurrents.
    const scans = [[0, 0], [0.25, 0], [0.25, 0.25], [-0.5, 0.1], [0.65, 0.35]].slice(0, options.steers);
    const solves = [];
    for (const [u, v] of scans) {
      const peak = steeringCurrents(model.positions, model.portsPerElement, u, v);
      const result = await timed(() => solver.solveCurrents(peak));
      solves.push({ u, v, wallMs: result.wallMs, cpuMs: result.cpuMs, error: errorSummary(result.error),
        radiatedPowerW: result.value?.powerBudget?.radiatedPowerW ?? null });
      if (result.error) throw result.error;
    }
    record.stages.solveCurrents = { solves, medianWallMs: median(solves.map((s) => s.wallMs)), firstWallMs: solves[0].wallMs };

    const distribution = stage("currentDistribution", await timed(() => solver.getCurrentDistribution({ kind: "latest-solution" })));
    record.stages.currentDistribution.segments = distribution.segments?.length ?? distribution.tags?.length ?? null;

    // Far fields: per grid, per evaluator, repeated (first repeat includes
    // pool warm-up and snapshot broadcast).
    const exactByGrid = new Map();
    for (const grid of options.grids) {
      for (const evaluator of options.evaluators) {
        for (let repeat = 0; repeat < options.fieldRepeats; repeat += 1) {
          const result = await timed(() => solver.computeFarField(gridRequest(grid, evaluator)));
          const field = result.value;
          const entry = {
            grid: `${grid.theta}x${grid.phi}`, samples: grid.theta * grid.phi, evaluator, repeat,
            wallMs: result.wallMs, cpuMs: result.cpuMs, memory: result.memory, error: errorSummary(result.error),
            bytes: field ? fieldBytes(field) : null,
            fieldBackend: field?.fieldBackend ?? null,
            fieldEvaluation: field?.fieldEvaluation ?? null,
            diagnostics: field?.diagnostics ? { native: field.diagnostics.native, counts: field.diagnostics.counts,
              wasmCallMs: field.diagnostics.wasmCallMs, typescriptExtractionMs: field.diagnostics.typescriptExtractionMs } : null,
          };
          if (field) {
            const key = entry.grid;
            if (evaluator === "exact") {
              if (!exactByGrid.has(key)) exactByGrid.set(key, field);
              entry.peak = fieldPeak(field);
            } else if (exactByGrid.has(key)) {
              const exact = exactByGrid.get(key);
              entry.peak = fieldPeak(exact);
              entry.maxAbsDiffVsExact = fieldMaxDiff(field, exact);
              entry.relErrVsExact = entry.maxAbsDiffVsExact / entry.peak;
            }
          }
          record.fields.push(entry);
          if (result.error) break;
        }
      }
    }

    // Embedded far fields. unit-current 1x1 is what the app requests today.
    for (const grid of options.embeddedGrids) {
      const samples = grid.theta * grid.phi;
      const resultBytes = model.totalPorts * samples * 4 * 8;
      for (const normalization of [{ kind: "unit-current", valueA: 1 }, { kind: "unit-voltage", valueV: 1 }]) {
        const entry = { grid: `${grid.theta}x${grid.phi}`, samples, normalization: normalization.kind,
          ports: model.totalPorts, resultBytes };
        if (resultBytes > options.embeddedBudgetMiB * 2 ** 20) {
          entry.skipped = `result ${(resultBytes / 2 ** 20).toFixed(0)} MiB exceeds budget`;
          record.embedded.push(entry);
          continue;
        }
        const result = await timed(() => solver.computeEmbeddedFarFields(gridRequest(grid, "exact"), normalization));
        Object.assign(entry, { wallMs: result.wallMs, cpuMs: result.cpuMs, memory: result.memory, error: errorSummary(result.error),
          bytes: result.value ? fieldBytes(result.value) : null, samplesPerPort: result.value?.samplesPerPort ?? null });
        record.embedded.push(entry);
      }
    }

    stage("dispose", await timed(() => solver.dispose()));
    solver = null;
  } catch (error) {
    record.failure = errorSummary(error);
    if (solver) { try { solver.terminate?.(); } catch {} }
  }
  record.memoryEnd = snapshotMemory();
  record.peakRssMiB = process.resourceUsage().maxRSS / 1024;
  return record;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function summarize(record) {
  const s = record.stages;
  const ms = (x) => (x === undefined || x === null ? "   n/a" : x.toFixed(1).padStart(8));
  const lines = [];
  lines.push(`${record.label} ${record.case.element} ${record.case.layout} n=${record.case.count} ${record.case.ground} `
    + `N=${record.case.totalSegments} P=${record.case.totalPorts} backend=${record.case.backend} workers=${record.case.fieldWorkers} rep=${record.representation ?? "?"}`);
  lines.push(`  create ${ms(s.create?.wallMs)}  prepare ${ms(s.prepare?.wallMs)}  Z ${ms(s.impedance?.wallMs)}  `
    + `solve(med) ${ms(s.solveCurrents?.medianWallMs)}  currents ${ms(s.currentDistribution?.wallMs)}  dispose ${ms(s.dispose?.wallMs)}  peakRSS ${record.peakRssMiB?.toFixed(0)} MiB`);
  for (const f of record.fields) {
    lines.push(`  field ${f.grid.padEnd(8)} ${f.evaluator.padEnd(5)} r${f.repeat} ${ms(f.wallMs)} ms`
      + (f.fieldBackend ? ` [${f.fieldBackend.backend} w=${f.fieldBackend.activeWorkerCount} kernel=${f.fieldBackend.kernelMs?.toFixed(0)} warm=${f.fieldBackend.warmupMs?.toFixed(0)} snap=${f.fieldBackend.snapshotCaptureMs?.toFixed(1)}+${f.fieldBackend.snapshotBroadcastMs?.toFixed(1)}]` : "")
      + (f.fieldEvaluation ? ` exec=${f.fieldEvaluation.execution} dirs=${f.fieldEvaluation.evaluatedDirections}${f.fieldEvaluation.fallbackReason ? " fb=" + f.fieldEvaluation.fallbackReason : ""}` : "")
      + (f.relErrVsExact !== undefined ? ` relErr=${f.relErrVsExact.toExponential(2)}` : "")
      + (f.error ? ` ERROR ${f.error.code ?? ""} ${f.error.message}` : ""));
  }
  for (const e of record.embedded) {
    lines.push(`  embedded ${e.grid.padEnd(8)} ${e.normalization.padEnd(12)} ${e.skipped ? "skipped: " + e.skipped : ms(e.wallMs) + " ms"}${e.error ? " ERROR " + e.error.message : ""}`);
  }
  if (record.failure) lines.push(`  FAILURE ${record.failure.code ?? ""} ${record.failure.message}`);
  return lines.join("\n");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const options = parseArgs(process.argv.slice(2));
  const record = await runCase(options);
  if (options.output) appendFileSync(options.output, `${JSON.stringify(record)}\n`);
  console.log(summarize(record));
  process.exit(record.failure ? 1 : 0);
}
