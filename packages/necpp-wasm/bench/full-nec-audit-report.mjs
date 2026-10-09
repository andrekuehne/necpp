// Aggregate full-nec-audit NDJSON records into markdown tables and fitted
// cost exponents.
//   node bench/full-nec-audit-report.mjs out.ndjson [more.ndjson ...]
import { readFileSync } from "node:fs";

const records = process.argv.slice(2).flatMap((path) =>
  readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)));

const f1 = (x) => (x === undefined || x === null || Number.isNaN(x) ? "–" : x.toFixed(1));
const f0 = (x) => (x === undefined || x === null || Number.isNaN(x) ? "–" : x.toFixed(0));
const name = (r) => `${r.case.element} ${r.case.layout} ${r.case.count} ${r.case.ground}`;

function fitExponent(points) {
  // least squares on log-log: y = a * x^b
  const xs = points.map(([x]) => Math.log(x));
  const ys = points.map(([, y]) => Math.log(y));
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0; let den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  const b = num / den;
  return { exponent: b, a: Math.exp(my - b * mx) };
}

function probeStages(record) {
  // Probe stderr lines were saved by the driver next to the NDJSON; records
  // may carry them inline when run through the case runner directly.
  return record.probe ?? null;
}

const caseRecords = records.filter((r) => r.schema === "full-nec-audit-case-v1");
for (const label of [...new Set(caseRecords.map((r) => r.label))]) {
  const group = caseRecords.filter((r) => r.label === label);
  console.log(`\n## ${label} (${group[0].host.cpu}, ${group[0].host.logicalCpus} logical CPUs, Node ${group[0].host.node}, package ${group[0].packageVersion}, engine ${group[0].engineVersion})\n`);
  console.log("| Case | N | P | create | prepare | Z | solve (median) | currents | embedded 1×1 uc | dispose | peak RSS MiB |");
  console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const r of group) {
    const s = r.stages;
    const e11 = r.embedded.find((e) => e.grid === "1x1" && e.normalization === "unit-current");
    console.log(`| ${name(r)} | ${r.case.totalSegments} | ${r.case.totalPorts} | ${f1(s.create?.wallMs)} | ${f1(s.prepare?.wallMs)} | ${f1(s.impedance?.wallMs)} | ${f1(s.solveCurrents?.medianWallMs)} | ${f1(s.currentDistribution?.wallMs)} | ${f1(e11?.wallMs)} | ${f1(s.dispose?.wallMs)} | ${f0(r.peakRssMiB)} |${r.failure ? " FAILURE " + r.failure.message : ""}`);
  }

  console.log("\n### Far fields (ms; r0 = first call incl. pool warm-up/snapshot, r1 = repeat)\n");
  console.log("| Case | Grid | Samples | exact r0 | exact r1 | ring r0 | ring r1 | ring exec | ring rel err | workers | contributions |");
  console.log("|---|---|---:|---:|---:|---:|---:|---|---:|---:|---:|");
  for (const r of group) {
    const grids = [...new Set(r.fields.map((f) => f.grid))];
    for (const grid of grids) {
      const pick = (ev, rep) => r.fields.find((f) => f.grid === grid && f.evaluator === ev && f.repeat === rep);
      const ex0 = pick("exact", 0); const ex1 = pick("exact", 1); const ri0 = pick("ring", 0); const ri1 = pick("ring", 1);
      const contributions = (ex0?.samples ?? 0) * r.case.totalSegments * (r.case.ground === "perfect" ? 2 : 1);
      console.log(`| ${name(r)} | ${grid} | ${ex0?.samples ?? ""} | ${f1(ex0?.wallMs)} | ${f1(ex1?.wallMs)} | ${f1(ri0?.wallMs)} | ${f1(ri1?.wallMs)} | ${ri1?.fieldEvaluation?.execution ?? ri0?.fieldEvaluation?.execution ?? "–"}${(ri1 ?? ri0)?.fieldEvaluation?.fallbackReason ? " (" + (ri1 ?? ri0).fieldEvaluation.fallbackReason + ")" : ""} | ${ri1?.relErrVsExact !== undefined ? ri1.relErrVsExact.toExponential(1) : "–"} | ${ex1?.fieldBackend?.activeWorkerCount ?? ex0?.fieldBackend?.activeWorkerCount ?? "–"} | ${(contributions / 1e6).toFixed(1)}M |`);
    }
  }

  console.log("\n### Embedded far fields (ms)\n");
  console.log("| Case | Grid | Samples/port | Ports | unit-current | unit-voltage | result MiB |");
  console.log("|---|---|---:|---:|---:|---:|---:|");
  for (const r of group) {
    const grids = [...new Set(r.embedded.map((e) => e.grid))];
    for (const grid of grids) {
      const uc = r.embedded.find((e) => e.grid === grid && e.normalization === "unit-current");
      const uv = r.embedded.find((e) => e.grid === grid && e.normalization === "unit-voltage");
      console.log(`| ${name(r)} | ${grid} | ${uc?.samples} | ${uc?.ports} | ${uc?.skipped ? "skipped" : f1(uc?.wallMs)} | ${uv?.skipped ? "skipped" : f1(uv?.wallMs)} | ${((uc?.resultBytes ?? 0) / 2 ** 20).toFixed(1)} |`);
    }
  }

  // Exponent fits over the dipole sunflower perfect-ground series.
  const series = group.filter((r) => r.case.element === "dipole" && r.case.layout === "sunflower" && r.case.ground === "perfect" && !r.failure);
  if (series.length >= 2) {
    console.log("\n### Fitted exponents (dipole sunflower, perfect ground; y = a·N^b over N = segments)\n");
    const fits = [
      ["prepare (fill+LU)", (r) => r.stages.prepare?.wallMs],
      ["computeImpedanceMatrix", (r) => r.stages.impedance?.wallMs],
      ["solveCurrents (median)", (r) => r.stages.solveCurrents?.medianWallMs],
      ["getCurrentDistribution", (r) => r.stages.currentDistribution?.wallMs],
      ["embedded 1x1 unit-current", (r) => r.embedded.find((e) => e.grid === "1x1" && e.normalization === "unit-current")?.wallMs],
      ["embedded 19x72 unit-current", (r) => r.embedded.find((e) => e.grid === "19x72" && e.normalization === "unit-current")?.wallMs],
      ["far field exact 19x72 r1", (r) => r.fields.find((f) => f.grid === "19x72" && f.evaluator === "exact" && f.repeat === 1)?.wallMs],
      ["far field exact 181x360 r1", (r) => r.fields.find((f) => f.grid === "181x360" && f.evaluator === "exact" && f.repeat === 1)?.wallMs],
      ["far field ring 181x360 r1", (r) => r.fields.find((f) => f.grid === "181x360" && f.evaluator === "ring" && f.repeat === 1)?.wallMs],
    ];
    console.log("| Stage | " + series.map((r) => `N=${r.case.totalSegments}`).join(" | ") + " | exponent b |");
    console.log("|---|" + series.map(() => "---:").join("|") + "|---:|");
    for (const [label2, pick] of fits) {
      const pts = series.map((r) => [r.case.totalSegments, pick(r)]).filter(([, y]) => y > 0);
      if (pts.length < 2) continue;
      const fit = fitExponent(pts);
      console.log(`| ${label2} | ${series.map((r) => f1(pick(r))).join(" | ")} | ${fit.exponent.toFixed(2)} |`);
    }
  }
}

// ---- derived tables ------------------------------------------------------
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

const byLabel = (label) => records.filter((r) => r.label === label && !r.failure);
// Quiet-host reruns (label "clean") are the preferred baseline for ratios.
const baselineFor = (k) => byLabel("clean").find((r) => key(r) === k) ?? byLabel("scalar").find((r) => key(r) === k);
const key = (r) => `${r.case.element}-${r.case.layout}-${r.case.count}-${r.case.ground}`;

// Probe split: NECPP_PROBE lines saved by the driver as <output>.<label>.<case>.stderr.txt
const probeRecords = byLabel("probe");
if (probeRecords.length > 0) {
  console.log("\n## WASM stage split (probe build: scalar + NECPP_AUDIT_PROBE)\n");
  console.log("| Case | N | P | antenna_env | fill | factor | fill share | Y solves (P) | per solve | Z = Y^-1 | heap after prepare MiB | embedded 19x72 uc: solves / fields | uv: solves / fields |");
  console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|");
  for (const r of probeRecords) {
    const dir = dirname(process.argv.slice(2).find((p) => readFileSync(p, "utf8").includes('"label":"probe"')) ?? ".");
    const file = readdirSync(dir).find((f) => f.endsWith(`.probe.${key(r)}.stderr.txt`));
    if (!file) continue;
    const lines = readFileSync(join(dir, file), "utf8").split("\n").filter((l) => l.startsWith("NECPP_PROBE"));
    const parse = (l) => Object.fromEntries(l.split(" ").slice(1).map((kv) => kv.split("=")));
    const stages = lines.map(parse);
    const first = (name) => stages.find((s) => s.stage === name);
    const fill = first("fill"); const factor = first("factor"); const env = first("antenna_env");
    const y = first("admittance_solves"); const inv = first("impedance_invert");
    const ucS = first("embedded_uc_solves"); const ucF = first("embedded_uc_fields");
    const uvS = first("embedded_uv_solves"); const uvF = first("embedded_uv_fields");
    const ms = (s) => (s ? Number(s.ms).toFixed(1) : "–");
    console.log(`| ${name(r)} | ${r.case.totalSegments} | ${r.case.totalPorts} | ${ms(env)} | ${ms(fill)} | ${ms(factor)} | ${fill && factor ? (100 * fill.ms / (Number(fill.ms) + Number(factor.ms))).toFixed(0) + " %" : "–"} | ${ms(y)} | ${y ? (Number(y.ms) / Number(y.n)).toFixed(1) : "–"} | ${ms(inv)} | ${factor ? (Number(factor.heap) / 2 ** 20).toFixed(0) : "–"} | ${ucS ? `${ms(ucS)} / ${ms(ucF)}` : "–"} | ${uvS ? `${ms(uvS)} / ${ms(uvF)}` : "–"} |`);
  }
}

// simd vs scalar
const simd = byLabel("simd");
if (simd.length > 0) {
  console.log("\n## simd128 vs scalar (same cases, ratio simd / scalar)\n");
  console.log("| Case | prepare | Z | solve | exact field (largest grid, r1) | ring field (largest grid, r1) | embedded 19x72 uc |");
  console.log("|---|---:|---:|---:|---:|---:|---:|");
  for (const s of simd) {
    const b = baselineFor(key(s));
    if (!b) continue;
    const ratio = (a, c) => (a > 0 && c > 0 ? (a / c).toFixed(2) + "x" : "–");
    const largest = (r, ev) => r.fields.filter((f) => f.evaluator === ev && f.repeat === 1).sort((x, y) => y.samples - x.samples)[0]?.wallMs;
    const emb = (r) => r.embedded.find((e) => e.grid === "19x72" && e.normalization === "unit-current")?.wallMs;
    console.log(`| ${name(s)} | ${ratio(s.stages.prepare?.wallMs, b.stages.prepare?.wallMs)} | ${ratio(s.stages.impedance?.wallMs, b.stages.impedance?.wallMs)} | ${ratio(s.stages.solveCurrents?.medianWallMs, b.stages.solveCurrents?.medianWallMs)} | ${ratio(largest(s, "exact"), largest(b, "exact"))} | ${ratio(largest(s, "ring"), largest(b, "ring"))} | ${ratio(emb(s), emb(b))} |`);
  }
}

// serial vs pool
const serial = byLabel("serial");
if (serial.length > 0) {
  console.log("\n## Serial field path (fieldWorkers: 1) vs auto pool\n");
  console.log("| Case | Grid | serial exact r1 | pool exact r1 | speed-up | serial ring r1 | pool ring r1 | speed-up | pool workers |");
  console.log("|---|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const s of serial) {
    const b = baselineFor(key(s));
    if (!b) continue;
    for (const grid of [...new Set(s.fields.map((f) => f.grid))]) {
      const pick = (r, ev) => r.fields.find((f) => f.grid === grid && f.evaluator === ev && f.repeat === 1)?.wallMs;
      const se = pick(s, "exact"), pe = pick(b, "exact"), sr = pick(s, "ring"), pr = pick(b, "ring");
      const w = b.fields.find((f) => f.grid === grid && f.repeat === 1)?.fieldBackend?.activeWorkerCount;
      console.log(`| ${name(s)} | ${grid} | ${f1(se)} | ${f1(pe)} | ${se && pe ? (se / pe).toFixed(2) + "x" : "–"} | ${f1(sr)} | ${f1(pr)} | ${sr && pr ? (sr / pr).toFixed(2) + "x" : "–"} | ${w ?? "–"} |`);
    }
  }
}

// browser records
const browser = records.filter((r) => r.schema === "full-nec-audit-browser-v1");
if (browser.length > 0) {
  console.log("\n## Headless Chromium (no COOP/COEP; crossOriginIsolated reported per row)\n");
  console.log("| Case | dist | isolated | cores | create | prepare | Z | solve (median) | currents | fields (grid: exact r1 / ring r1, workers) | embedded 1x1 uc / uv | embedded 19x72 uc / uv |");
  console.log("|---|---|---|---:|---:|---:|---:|---:|---:|---|---|---|");
  for (const r of browser) {
    if (r.error) { console.log(`| ${r.case.element} ${r.case.layout} ${r.case.count} | ${r.moduleDirectory.split("/").pop()} | ERROR ${r.error.slice(0, 120)} |`); continue; }
    const solves = [...(r.stages.solves ?? [])].sort((a, b) => a - b);
    const med = solves.length ? solves[Math.floor(solves.length / 2)] : null;
    const fields = [...new Set(r.fields.map((f) => f.grid))].map((g) => {
      const e = r.fields.find((f) => f.grid === g && f.evaluator === "exact" && f.repeat === 1);
      const q = r.fields.find((f) => f.grid === g && f.evaluator === "ring" && f.repeat === 1);
      return `${g}: ${f1(e?.ms)} / ${f1(q?.ms)} (${e?.workers ?? "–"}w)`;
    }).join("; ");
    const emb = (g) => `${f1(r.embedded.find((e) => e.grid === g && e.normalization === "unit-current")?.ms)} / ${f1(r.embedded.find((e) => e.grid === g && e.normalization === "unit-voltage")?.ms)}`;
    console.log(`| ${r.case.element} ${r.case.layout} ${r.case.count} ${r.case.ground} | ${r.moduleDirectory.split("/").pop()} | ${r.isolated} | ${r.hardwareConcurrency} | ${f1(r.stages.create)} | ${f1(r.stages.prepare)} | ${f1(r.stages.impedance)} | ${f1(med)} | ${f1(r.stages.currentDistribution)} | ${fields} | ${emb("1x1")} | ${emb("19x72")} |`);
  }
}
