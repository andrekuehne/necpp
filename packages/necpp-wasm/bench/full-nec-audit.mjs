// Full-NEC audit matrix driver: runs full-nec-audit-case.mjs once per case in
// a fresh process and appends every record to one NDJSON file.
//   node bench/full-nec-audit.mjs --module-directory DIST --output out.ndjson [--label scalar] [--only regex] [--timeout-s 1800]
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].slice(2), process.argv[i + 1]);
const moduleDirectory = resolve(args.get("module-directory") ?? "dist");
const output = resolve(args.get("output") ?? "full-nec-audit.ndjson");
const label = args.get("label") ?? "";
const only = args.has("only") ? new RegExp(args.get("only")) : null;
const timeoutS = Number(args.get("timeout-s") ?? "2400");
const fieldWorkers = args.get("field-workers") ?? "auto";

const CASES = [
  // element layout count ground grids embeddedGrids
  ["dipole", "sunflower", 64, "perfect", "19x72,91x181,auto,181x360", "1x1,19x72,auto"],
  ["dipole", "sunflower", 128, "perfect", "19x72,91x181,auto,181x360", "1x1,19x72"],
  ["dipole", "sunflower", 256, "perfect", "19x72,91x181,auto,181x360", "1x1,19x72"],
  ["dipole", "rect", 64, "perfect", "19x72,auto", "1x1,19x72"],
  ["dipole", "rect", 128, "perfect", "19x72,auto", "1x1,19x72"],
  ["dipole", "rect", 256, "perfect", "19x72,auto", "1x1,19x72"],
  ["dipole", "sunflower", 64, "free", "19x72,auto", "1x1,19x72"],
  ["dipole", "sunflower", 128, "free", "19x72,auto", "1x1,19x72"],
  ["dipole", "sunflower", 256, "free", "19x72,auto", "1x1,19x72"],
  ["crossed", "sunflower", 128, "perfect", "19x72,auto", "1x1,19x72"],
  ["crossed", "sunflower", 136, "perfect", "19x72,auto", "1x1,19x72"],
  ["helix", "sunflower", 32, "perfect", "19x72,auto", "1x1,19x72"],
];

for (const [element, layout, count, ground, grids, embedded] of CASES) {
  const name = `${element}-${layout}-${count}-${ground}`;
  if (only && !only.test(name)) continue;
  const argv = [
    "bench/full-nec-audit-case.mjs",
    "--module-directory", moduleDirectory, "--element", element, "--layout", layout,
    "--count", String(count), "--ground", ground, "--grids", grids, "--embedded-grids", embedded,
    "--field-workers", fieldWorkers, "--output", output, "--label", label,
  ];
  const started = Date.now();
  const result = spawnSync(process.execPath, argv, { stdio: ["ignore", "pipe", "pipe"], timeout: timeoutS * 1000, encoding: "utf8" });
  process.stdout.write(`${result.stdout ?? ""}`);
  if (result.stderr) writeFileSync(`${output}.${label}.${name}.stderr.txt`, result.stderr);
  if (result.status !== 0) {
    process.stdout.write(`## ${name} exited ${result.status ?? result.signal} after ${((Date.now() - started) / 1000).toFixed(0)} s\n${(result.stderr ?? "").slice(-2000)}\n`);
  }
}
