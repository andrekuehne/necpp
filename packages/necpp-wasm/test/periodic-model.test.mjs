import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import {
  NecGeometryError,
  NecInputError,
  NecStateError,
  createNecArraySolver,
  createNecModel,
  createNecPeriodicModel,
} from "../.test-build/src/index.js";
import { setLatticeEntry } from "../.test-build/src/model.js";

const hasWasm = existsSync(new URL("../.test-build/src/nec2pp.wasm", import.meta.url));
const skip = !hasWasm && "WASM artifacts have not been built";

// About one-metre wavelength; the comparisons below never depend on its exact value.
const FREQUENCY_MHZ = 299.792458;
const HALF_LENGTH_M = 0.24;
const RADIUS_M = 0.001;
const SEGMENTS = 11;
const FEED_SEGMENT = 6;

/** A half-wave dipole along x, centred at the origin of the cell. */
function addDipole(model, tag = 1) {
  model.addWire({
    tag,
    segments: SEGMENTS,
    start: [-HALF_LENGTH_M, 0, 0],
    end: [HALF_LENGTH_M, 0, 0],
    radiusM: RADIUS_M,
  });
}

async function dipoleCell(spacingM) {
  const cell = await createNecPeriodicModel();
  addDipole(cell);
  cell.completeGeometry();
  cell.definePorts([{ tag: 1, segment: FEED_SEGMENT }]);
  cell.setLattice({ a1M: [spacingM, 0], a2M: [0, spacingM] });
  return cell;
}

function entry(matrix, row, column) {
  const index = row * matrix.columns + column;
  return [matrix.real[index], matrix.imag[index]];
}

function distance([ar, ai], [br, bi]) {
  return Math.hypot(ar - br, ai - bi);
}

function magnitude([real, imag]) {
  return Math.hypot(real, imag);
}

/**
 * Port voltages at the centre cell of an n x n finite array whose cells are
 * the given wires and ports, driven by port currents with uniform phase
 * progression (psi1, psi2) and a Gaussian amplitude taper of width sigma
 * cells. `driven(portIndex)` selects which ports of each cell carry current;
 * the others are open. The taper suppresses the edge waves that make the
 * centre of a uniformly driven lossless array converge only like n^(-1/2).
 */
async function taperedCentreVoltages({ n, spacingM, psi, sigma, wires, ports, driven }) {
  const half = (n - 1) / 2;
  const elements = [];
  const portsPerCell = ports.length;
  const currents = {
    real: new Float64Array(n * n * portsPerCell),
    imag: new Float64Array(n * n * portsPerCell),
  };
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      const cell = elements.length;
      const amplitude = Math.exp(-((i - half) ** 2 + (j - half) ** 2) / (2 * sigma * sigma));
      const phase = (i - half) * psi[0] + (j - half) * psi[1];
      for (let port = 0; port < portsPerCell; port += 1) {
        if (driven(port)) {
          currents.real[cell * portsPerCell + port] = amplitude * Math.cos(phase);
          currents.imag[cell * portsPerCell + port] = amplitude * Math.sin(phase);
        }
      }
      elements.push({
        id: `cell-${i}-${j}`,
        positionM: [(i - half) * spacingM, (j - half) * spacingM],
        patternId: "cell",
      });
    }
  }
  const solver = await createNecArraySolver({
    elements,
    patterns: [{ id: "cell", kind: "straight-wire-pattern", wires, ports }],
    ground: { kind: "free-space" },
  }, { symmetry: "auto", symmetrizer: { positionEpsilonM: 1e-9 } });
  try {
    await solver.prepare({ frequencyMHz: FREQUENCY_MHZ });
    const solution = await solver.solveCurrents(currents);
    const centre = elements.findIndex((element) => element.id === `cell-${half}-${half}`);
    return Array.from({ length: portsPerCell }, (_, port) => {
      const index = centre * portsPerCell + port;
      return [solution.voltages.real[index], solution.voltages.imag[index]];
    });
  } finally {
    await solver.dispose();
  }
}

const dipoleWire = (id, [x, y]) => ({
  id,
  segments: SEGMENTS,
  startM: [x - HALF_LENGTH_M, y, 0],
  endM: [x + HALF_LENGTH_M, y, 0],
  radiusM: RADIUS_M,
});

test("broadside scan impedance matches the centre of a large tapered finite array", {
  skip,
  timeout: 300_000,
}, async () => {
  const spacingM = 0.7;
  const cell = await dipoleCell(spacingM);
  try {
    const scan = cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanPhasesRad: [0, 0] });
    const periodic = entry(scan.impedance, 0, 0);
    // Unit current at the centre, so its voltage is its active impedance.
    const [finite] = await taperedCentreVoltages({
      n: 15,
      spacingM,
      psi: [0, 0],
      sigma: 3,
      wires: [dipoleWire("dipole", [0, 0])],
      ports: [{ wireId: "dipole", segment: FEED_SEGMENT }],
      driven: () => true,
    });
    // Measured 3.7 %; it is the finite array's edge error, which falls to
    // 1.6 % at 21 x 21, not periodic-solver error.
    const relative = distance(periodic, finite) / magnitude(periodic);
    assert.ok(relative < 0.05, `periodic ${periodic}, finite ${finite}, relative ${relative}`);
  } finally {
    cell.dispose();
  }
});

test("scan-phase sign: off-broadside mutual scan impedance matches a finite array", {
  skip,
  timeout: 300_000,
}, async () => {
  // Two parallel dipoles, the second offset in x and y. Without the offset in
  // the scan direction, or with a one-port cell, Z(psi) = Z(-psi) and the
  // sign of the scan phases would be invisible.
  const spacingM = 0.7;
  const offset = [0.2, 0.35];
  const psi = [1.2, 0.5];
  const periodicZ01 = async (scanPhasesRad) => {
    const cell = await createNecPeriodicModel();
    try {
      addDipole(cell, 1);
      cell.addWire({
        tag: 2,
        segments: SEGMENTS,
        start: [offset[0] - HALF_LENGTH_M, offset[1], 0],
        end: [offset[0] + HALF_LENGTH_M, offset[1], 0],
        radiusM: RADIUS_M,
      });
      cell.completeGeometry();
      cell.definePorts([{ tag: 1, segment: FEED_SEGMENT }, { tag: 2, segment: FEED_SEGMENT }]);
      cell.setLattice({ a1M: [spacingM, 0], a2M: [0, spacingM] });
      return entry(cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanPhasesRad }).impedance, 0, 1);
    } finally {
      cell.dispose();
    }
  };
  const forward = await periodicZ01(psi);
  const backward = await periodicZ01([-psi[0], -psi[1]]);

  // Drive only the second port of every cell; the open first port of the
  // centre cell then sees Z01(psi) times the unit centre current.
  const [finite] = await taperedCentreVoltages({
    n: 11,
    spacingM,
    psi,
    sigma: 2,
    wires: [dipoleWire("first", [0, 0]), dipoleWire("second", offset)],
    ports: [
      { wireId: "first", segment: FEED_SEGMENT },
      { wireId: "second", segment: FEED_SEGMENT },
    ],
    driven: (port) => port === 1,
  });
  const finiteZ01 = finite;  // the centre current is exactly 1 A
  // Measured 5.7 % against Z01(psi) and 100 % against Z01(-psi).
  const scale = magnitude(forward);
  assert.ok(distance(finiteZ01, forward) / scale < 0.08, `${finiteZ01} vs ${forward}`);
  assert.ok(distance(finiteZ01, backward) / scale > 0.5, `${finiteZ01} vs ${backward}`);
});

test("very large lattice spacing approaches the isolated element", {
  skip,
  timeout: 300_000,
}, async () => {
  const isolatedModel = await createNecModel();
  let isolated;
  try {
    addDipole(isolatedModel);
    isolatedModel.completeGeometry();
    isolatedModel.definePorts([{ tag: 1, segment: FEED_SEGMENT }]);
    isolatedModel.prepare({ frequencyMHz: FREQUENCY_MHZ });
    isolated = entry(isolatedModel.computeImpedanceMatrix().impedance, 0, 0);
  } finally {
    isolatedModel.dispose();
  }

  // Squared spacings (in wavelengths) between sums of two squares, so that no
  // Floquet mode sits near cut-off; near-grazing modes otherwise add terms of
  // order 1 / (A kz) that make the approach erratic.
  const deviations = [];
  for (const spacingM of [Math.sqrt(7), Math.sqrt(47), Math.sqrt(311)]) {
    const cell = await dipoleCell(spacingM);
    try {
      const scan = cell.computeScanImpedance({
        frequencyMHz: FREQUENCY_MHZ,
        scanPhasesRad: [0, 0],
      });
      deviations.push(distance(entry(scan.impedance, 0, 0), isolated) / magnitude(isolated));
    } finally {
      cell.dispose();
    }
  }
  assert.ok(deviations[0] > deviations[1] && deviations[1] > deviations[2], `${deviations}`);
  assert.ok(deviations[2] < 0.08, `${deviations}`);
});

test("scan impedance is reciprocal as Z(psi) = Z(-psi)^T, not symmetric", {
  skip,
  timeout: 120_000,
}, async () => {
  async function twoPortScanImpedance(scanPhasesRad) {
    const cell = await createNecPeriodicModel();
    try {
      addDipole(cell, 1);
      cell.addWire({
        tag: 2,
        segments: SEGMENTS,
        start: [0.1, 0.2, 0.05],
        end: [0.25, 0.45, 0.2],
        radiusM: RADIUS_M,
      });
      cell.completeGeometry();
      cell.definePorts([{ tag: 1, segment: FEED_SEGMENT }, { tag: 2, segment: FEED_SEGMENT }]);
      cell.setLattice({ a1M: [0.8, 0], a2M: [0.25, 0.75] });
      return cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanPhasesRad }).impedance;
    } finally {
      cell.dispose();
    }
  }

  const forward = await twoPortScanImpedance([1.1, -0.6]);
  const backward = await twoPortScanImpedance([-1.1, 0.6]);
  let scale = 0;
  let reciprocityError = 0;
  for (let row = 0; row < 2; row += 1) {
    for (let column = 0; column < 2; column += 1) {
      scale = Math.max(scale, magnitude(entry(forward, row, column)));
      reciprocityError = Math.max(
        reciprocityError,
        distance(entry(forward, row, column), entry(backward, column, row)),
      );
    }
  }
  // NEC's point matching is not exactly reciprocal: the same cell without a
  // lattice has |Z01 - Z10| / |Z01| = 4.9e-3. The periodic error is 2.5e-4.
  assert.ok(reciprocityError / scale < 1e-3, `${reciprocityError / scale}`);
  const asymmetry = distance(entry(forward, 0, 1), entry(forward, 1, 0))
    / magnitude(entry(forward, 0, 1));
  assert.ok(asymmetry > 0.1, `Z(psi) should not be symmetric: ${asymmetry}`);
});

test("the periodic model validates its lattice and lifecycle", { skip }, async () => {
  const cell = await createNecPeriodicModel();
  assert.equal("computeFarField" in cell, false);
  assert.equal("computeEmbeddedFarFields" in cell, false);
  assert.equal("characterizeIsolatedElement" in cell, false);

  assert.throws(() => cell.setLattice({ a1M: [0.7, 0], a2M: [0, 0.7] }), NecStateError);
  addDipole(cell);
  cell.completeGeometry();
  cell.definePorts([{ tag: 1, segment: FEED_SEGMENT }]);

  const request = { frequencyMHz: FREQUENCY_MHZ, scanPhasesRad: [0, 0] };
  assert.throws(() => cell.computeScanImpedance(request), NecStateError);
  assert.throws(() => cell.setLattice({ a1M: [0.7, 0, 0], a2M: [0, 0.7] }), NecInputError);
  assert.throws(() => cell.setLattice({ a1M: [0.7, 0], a2M: [1.4, 0] }), NecInputError);
  assert.throws(() => cell.setLattice({ a1M: [Number.NaN, 0], a2M: [0, 0.7] }), NecInputError);

  cell.setLattice({ a1M: [0.7, 0], a2M: [0, 0.7] });
  assert.throws(
    () => cell.computeScanImpedance({ ...request, scanPhasesRad: [Infinity, 0] }),
    NecInputError,
  );
  assert.throws(
    () => cell.computeScanImpedance({ ...request, frequencyMHz: -1 }),
    NecInputError,
  );
  const result = cell.computeScanImpedance({ ...request, scanPhasesRad: [0.4, -0.2] });
  assert.equal(result.impedance.rows, 1);
  assert.equal(result.admittance.rows, 1);
  assert.deepEqual(result.scanPhasesRad, [0.4, -0.2]);
  assert.equal(result.frequencyMHz, FREQUENCY_MHZ);
  assert.equal(cell.state, "prepared");

  cell.dispose();
  assert.equal(cell.state, "disposed");
  assert.throws(() => cell.computeScanImpedance(request), NecStateError);
  assert.throws(() => cell.setLattice({ a1M: [0.7, 0], a2M: [0, 0.7] }), NecStateError);
});

test("a symmetric unit cell is refused", { skip }, async () => {
  const model = await createNecModel();
  try {
    model.addWire({ tag: 1, segments: 5, start: [0, 0, 0], end: [0.24, 0, 0], radiusM: RADIUS_M });
    model.completeGeometry({ symmetry: { kind: "reflection", planes: ["x=0"], tagIncrement: 1 } });
    // The periodic model exposes no symmetry; the native refusal guards the ABI.
    assert.throws(() => model[setLatticeEntry]([0.7, 0], [0, 0.7]), NecGeometryError);
  } finally {
    model.dispose();
  }
});
