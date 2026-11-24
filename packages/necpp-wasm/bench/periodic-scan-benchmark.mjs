// Periodic scan benchmark (issues #52 and #47): the time of a call at a new
// frequency, of a scan change at the same frequency, and of a default scan
// element pattern, for the cells of issue #28 (a 22-segment crossed dipole
// and an 84-segment helix, both over perfect ground) and for grounded cells
// fed at the plane (a 6-segment monopole and the helix rising from the
// plane). Timing only, not a gate.
//
//   node bench/periodic-scan-benchmark.mjs [package directory] [--no-pattern]
//     [--cells=dipole,helix,monopole,grounded-helix]
//
// Without --cells, the cells of issue #28.
//
// The package directory (default: this package) must hold a built dist/.
import { availableParallelism } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const packageDirectory = args.find((arg) => !arg.startsWith("--")) ??
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const withPattern = !args.includes("--no-pattern");
const cellsArgument = args.find((arg) => arg.startsWith("--cells="));
const selected = cellsArgument ? cellsArgument.slice("--cells=".length).split(",") : ["dipole", "helix"];

const { createNecPeriodicModel } = await import(pathToFileURL(path.join(packageDirectory, "dist", "index.js")).href);

const FREQUENCY_MHZ = 299.792458; // about one wavelength per metre

function crossedDipole(cell) {
  cell.addWire({ tag: 1, segments: 11, start: [-0.24, 0, 0.25], end: [0.24, 0, 0.25], radiusM: 0.001 });
  cell.addWire({ tag: 2, segments: 11, start: [0, -0.24, 0.27], end: [0, 0.24, 0.27], radiusM: 0.001 });
  cell.completeGeometry();
  cell.definePorts([{ tag: 1, segment: 6 }, { tag: 2, segment: 6 }]);
  cell.setGround({ kind: "perfect" });
  cell.setLattice({ a1M: [0.5, 0], a2M: [0, 0.5] });
}

function helixStartingAt(z0, groundConnection) {
  return (cell) => {
    // Axial mode, circumference one wavelength, 7 turns of 12 segments.
    const at = (i) => {
      const angle = 2 * Math.PI * i / 12;
      return [0.159 * Math.cos(angle), 0.159 * Math.sin(angle), z0 + 0.23 * i / 12];
    };
    for (let i = 0; i < 84; i += 1)
      cell.addWire({ tag: i + 1, segments: 1, start: at(i), end: at(i + 1), radiusM: 0.002 });
    cell.completeGeometry({ groundConnection });
    cell.definePorts([{ tag: 1, segment: 1 }]);
    cell.setGround({ kind: "perfect" });
    cell.setLattice({ a1M: [0.8, 0], a2M: [0, 0.8] });
  };
}

function monopole(cell) {
  cell.addWire({ tag: 1, segments: 6, start: [0, 0, 0], end: [0, 0, 0.24], radiusM: 0.001 });
  cell.completeGeometry({ groundConnection: "interpolate" });
  cell.definePorts([{ tag: 1, segment: 1 }]);
  cell.setGround({ kind: "perfect" });
  cell.setLattice({ a1M: [0.5, 0], a2M: [0, 0.5] });
}

const cells = {
  dipole: ["crossed dipole, 22 segments, square 0.5", crossedDipole],
  helix: ["helix, 84 segments, square 0.8", helixStartingAt(0.05, "none")],
  monopole: ["grounded monopole, 6 segments, square 0.5", monopole],
  "grounded-helix": ["grounded helix fed at the plane, 84 segments, square 0.8", helixStartingAt(0, "interpolate")],
};
for (const key of selected) {
  if (!Object.hasOwn(cells, key)) throw new Error(`unknown cell "${key}"; expected ${Object.keys(cells).join(", ")}`);
}

const seconds = (start) => (performance.now() - start) / 1000;

for (const key of selected) {
  const [name, build] = cells[key];
  const cell = await createNecPeriodicModel();
  try {
    build(cell);
    let start = performance.now();
    cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanDirection: { thetaDeg: 5, phiDeg: 0 } });
    const newFrequency = seconds(start);
    const changes = 10;
    start = performance.now();
    for (let i = 0; i < changes; i += 1)
      cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanDirection: { thetaDeg: 10 + 5 * i, phiDeg: 13 * i } });
    const scanChange = seconds(start) / changes;
    console.log(`${name}: new frequency ${(1e3 * newFrequency).toFixed(1)} ms, scan change ${(1e3 * scanChange).toFixed(2)} ms`);
    if (withPattern) {
      const workers = Math.min(8, Math.max(1, availableParallelism() - 1));
      start = performance.now();
      const pattern = await cell.computeScanElementPattern({ frequencyMHz: FREQUENCY_MHZ }, { workers });
      console.log(`${name}: default scan element pattern ${seconds(start).toFixed(1)} s, ` +
        `${pattern.samples.length} scan states on ${workers} workers`);
    }
  } finally {
    cell.dispose();
  }
}
