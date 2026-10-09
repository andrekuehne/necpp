// Headless Chromium run of the Full-NEC audit sequence against a built dist.
//   node bench/full-nec-audit-browser.mjs --module-directory DIST --count 64 [--element dipole] [--layout sunflower]
//     [--ground perfect] [--grids 19x72,78x308] [--embedded-grids 1x1] [--field-workers auto] [--output file.ndjson]
// Serves DIST over loopback HTTP without COOP/COEP (like GitHub Pages), so
// the page is not cross-origin isolated and only message-passing workers run.
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { chromium } from "playwright";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].slice(2), process.argv[i + 1]);
const root = resolve(args.get("module-directory") ?? "dist");
const caseOptions = {
  element: args.get("element") ?? "dipole",
  layout: args.get("layout") ?? "sunflower",
  count: Number(args.get("count") ?? "64"),
  ground: args.get("ground") ?? "perfect",
  grids: (args.get("grids") ?? "19x72,78x308").split(","),
  embeddedGrids: (args.get("embedded-grids") ?? "1x1").split(","),
  fieldWorkers: args.get("field-workers") ?? "auto",
  steers: Number(args.get("steers") ?? "3"),
  repeats: Number(args.get("field-repeats") ?? "2"),
};
const output = args.has("output") ? resolve(args.get("output")) : null;

// Browser-side script: same geometry generators as full-nec-audit-case.mjs.
const pageScript = `
import { createNecArraySolver } from "/index.js";
const C0 = 299792458, LAMBDA = C0 / 10e9, GOLDEN = Math.PI * (3 - Math.sqrt(5));
const o = ${JSON.stringify(caseOptions)};
function positions(layout, count, d) {
  const out = [];
  if (layout === "sunflower") for (let i = 0; i < count; i++) { const r = d * Math.sqrt((i + 0.5) / Math.PI), a = i * GOLDEN; out.push([r * Math.cos(a), r * Math.sin(a)]); }
  else { const nx = Math.ceil(Math.sqrt(count)), ny = Math.ceil(count / nx); for (let i = 0; i < count; i++) out.push([((i % nx) - (nx - 1) / 2) * d, (Math.floor(i / nx) - (ny - 1) / 2) * d]); }
  return out;
}
const half = 0.47 * LAMBDA / 2, h = 0.25 * LAMBDA, r = 0.001 * LAMBDA, sep = 0.005 * LAMBDA;
const patterns = {
  dipole: { id: "p", kind: "straight-wire-pattern", wires: [{ id: "w", segments: 11, startM: [-half, 0, h], endM: [half, 0, h], radiusM: r }], ports: [{ wireId: "w", segment: 6 }] },
  crossed: { id: "p", kind: "straight-wire-pattern", wires: [
    { id: "x", segments: 11, startM: [-half, 0, h - sep / 2], endM: [half, 0, h - sep / 2], radiusM: r },
    { id: "y", segments: 11, startM: [0, -half, h + sep / 2], endM: [0, half, h + sep / 2], radiusM: r }], ports: [{ wireId: "x", segment: 6 }, { wireId: "y", segment: 6 }] },
};
const pattern = patterns[o.element];
const pos = positions(o.layout, o.count, 0.5 * LAMBDA);
const description = { elements: pos.map((p, i) => ({ id: "e" + i, positionM: p, patternId: "p" })), patterns: [pattern],
  ground: o.ground === "perfect" ? { kind: "perfect" } : { kind: "free-space" } };
const ppe = pattern.ports.length, P = pos.length * ppe;
const grid = (g, evaluator) => { const [t, p] = g.split("x").map(Number); return { radiusM: 1, evaluator, theta: { startDeg: 0, count: t, stepDeg: t > 1 ? 90 / (t - 1) : 0 }, phi: { startDeg: 0, count: p, stepDeg: p > 1 ? 360 / p : 0 } }; };
const steer = (u, v) => { const re = new Float64Array(P), im = new Float64Array(P), k = 2 * Math.PI / LAMBDA;
  pos.forEach(([x, y], e) => { const ph = -k * (x * u + y * v); for (let q = 0; q < ppe; q++) { re[e * ppe + q] = Math.cos(ph); im[e * ppe + q] = Math.sin(ph); } }); return { real: re, imag: im }; };
const timed = async (fn) => { const t0 = performance.now(); const value = await fn(); return { value, ms: performance.now() - t0 }; };
const result = { isolated: globalThis.crossOriginIsolated, hardwareConcurrency: navigator.hardwareConcurrency, userAgent: navigator.userAgent, stages: {}, fields: [], embedded: [] };
let solver;
try {
  const c = await timed(() => createNecArraySolver(description, { symmetry: "off", fieldWorkers: o.fieldWorkers === "auto" ? "auto" : Number(o.fieldWorkers) }));
  solver = c.value; result.stages.create = c.ms;
  result.stages.prepare = (await timed(() => solver.prepare({ frequencyMHz: 10000 }))).ms;
  result.stages.impedance = (await timed(() => solver.computeImpedanceMatrix())).ms;
  const scans = [[0, 0], [0.25, 0], [0.25, 0.25]].slice(0, o.steers);
  result.stages.solves = [];
  for (const [u, v] of scans) result.stages.solves.push((await timed(() => solver.solveCurrents(steer(u, v)))).ms);
  result.stages.currentDistribution = (await timed(() => solver.getCurrentDistribution({ kind: "latest-solution" }))).ms;
  for (const g of o.grids) for (const evaluator of ["exact", "ring"]) for (let rep = 0; rep < o.repeats; rep++) {
    const f = await timed(() => solver.computeFarField(grid(g, evaluator)));
    const fb = f.value.fieldBackend ?? {};
    result.fields.push({ grid: g, evaluator, repeat: rep, ms: f.ms, backend: fb.backend, workers: fb.activeWorkerCount, kernelMs: fb.kernelMs, warmupMs: fb.warmupMs,
      snapshotMs: (fb.snapshotCaptureMs ?? 0) + (fb.snapshotBroadcastMs ?? 0), execution: f.value.fieldEvaluation?.execution, bytes: f.value.eThetaReal.byteLength * 4 });
  }
  for (const g of o.embeddedGrids) for (const normalization of [{ kind: "unit-current", valueA: 1 }, { kind: "unit-voltage", valueV: 1 }]) {
    const e = await timed(() => solver.computeEmbeddedFarFields(grid(g, "exact"), normalization));
    result.embedded.push({ grid: g, normalization: normalization.kind, ms: e.ms, bytes: e.value.eThetaReal.byteLength * 4 });
  }
  result.stages.dispose = (await timed(() => solver.dispose())).ms;
  result.memory = performance.memory ? { usedJSHeapMB: performance.memory.usedJSHeapSize / 2 ** 20 } : null;
} catch (error) {
  result.error = error?.stack || String(error);
  try { solver?.terminate(); } catch {}
}
window.result = result;
`;

const server = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/") {
    response.setHeader("content-type", "text/html");
    response.end(`<!doctype html><script type="module">${pageScript}</script>`);
    return;
  }
  const path = resolve(root, `.${url.pathname}`);
  try {
    if (!path.startsWith(root) || !statSync(path).isFile()) throw new Error("missing");
    response.setHeader("content-type", extname(path) === ".js" ? "text/javascript" : extname(path) === ".wasm" ? "application/wasm" : "application/octet-stream");
    response.end(readFileSync(path));
  } catch {
    response.statusCode = 404;
    response.end("not found");
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const { port } = server.address();
const browser = await chromium.launch({ headless: true, executablePath: process.env.NECPP_CHROMIUM ?? "/opt/pw-browsers/chromium", args: process.env.NECPP_CHROMIUM_ARGS ? process.env.NECPP_CHROMIUM_ARGS.split(" ") : [] });
try {
  const page = await browser.newPage();
  page.on("console", (message) => process.stderr.write(`[page] ${message.text()}\n`));
  page.on("pageerror", (error) => process.stderr.write(`${error.stack || error.message}\n`));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => window.result !== undefined, null, { timeout: 60 * 60 * 1000 });
  const result = await page.evaluate(() => window.result);
  const record = { schema: "full-nec-audit-browser-v1", timestamp: new Date().toISOString(), moduleDirectory: root, case: caseOptions, ...result };
  if (output) appendFileSync(output, `${JSON.stringify(record)}\n`);
  console.log(JSON.stringify(record, null, 1));
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
