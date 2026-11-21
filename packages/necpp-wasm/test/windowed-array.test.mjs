// Windowed arrays from a scan element pattern, on stub patterns with known amplitudes.
import assert from "node:assert/strict";
import test from "node:test";

import { NecInputError, scanPhasesForDirection, windowedArray } from "../.test-build/src/index.js";
import { FREQUENCY_MHZ, WAVENUMBER_PER_M as K } from "./periodic-reference.mjs";

const WAVELENGTH_M = 2 * Math.PI / K;
// The field impedance behind the Floquet amplitudes' power normalization.
const ETA_OHM = 4.771341189 * 8 * Math.PI * Math.PI;
const DEG = Math.PI / 180;

const lattice = { a1M: [0.5, 0], a2M: [0, 0.4] };
const AREA_M2 = 0.5 * 0.4;

const vector = (values) => ({
  real: Float64Array.from(values.map(([real]) => real)),
  imag: Float64Array.from(values.map(([, imag]) => imag)),
});
const at = (field, index = 0) => ({
  eTheta: [field.eThetaReal[index], field.eThetaImag[index]],
  ePhi: [field.ePhiReal[index], field.ePhiImag[index]],
});
const times = ([ar, ai], [br, bi]) => [ar * br - ai * bi, ar * bi + ai * br];
const plus = ([ar, ai], [br, bi]) => [ar + br, ai + bi];
const cis = (angle) => [Math.cos(angle), Math.sin(angle)];
const near = (actual, expected, tolerance, label) => {
  const scale = Math.max(1e-300, Math.hypot(...expected));
  assert.ok(
    Math.hypot(actual[0] - expected[0], actual[1] - expected[1]) <= tolerance * scale,
    `${label}: ${actual} vs ${expected}`,
  );
};

/**
 * A scan element pattern with amplitudes from `amplitudes(u, v, side)` ->
 * per port { te: [re, im], tm: [re, im] }.
 */
function stubPattern({ ports = 1, sides = ["above", "below"], amplitudes, normalization }) {
  return {
    frequencyMHz: FREQUENCY_MHZ,
    normalization: normalization ?? { kind: "unit-voltage", valueV: 1 },
    portCount: ports,
    sides,
    lattice,
    spacingUV: 0.1,
    woodCircles: [],
    samples: [],
    evaluate({ u, v }, side = "above") {
      assert.ok(sides.includes(side), `no side ${side}`);
      assert.ok(u * u + v * v <= 1 + 1e-12, "outside visible space");
      const values = amplitudes(u, v, side);
      return {
        te: vector(values.map(({ te }) => te)),
        tm: vector(values.map(({ tm }) => tm)),
        interpolationError: new Float64Array(ports),
        sampled: false,
      };
    },
  };
}

/** A scan result at the scan phases of a direction (or given phases), with the given P x P matrices. */
function steeringScan({ thetaDeg = 0, phiDeg = 0, scanPhasesRad, impedance = [[[50, 0]]], admittance }) {
  const matrix = (rows) => ({
    rows: rows.length,
    columns: rows.length,
    ...vector(rows.flat()),
  });
  return {
    frequencyMHz: FREQUENCY_MHZ,
    scanPhasesRad: scanPhasesRad ?? scanPhasesForDirection({ lattice, frequencyMHz: FREQUENCY_MHZ, thetaDeg, phiDeg }),
    impedance: matrix(impedance),
    admittance: matrix(admittance ?? impedance.map((row) => row.map(() => [0, 0]))),
    diagnostics: {},
    floquet: { modes: [], powerBudget: [] },
  };
}

const oneDirection = (thetaDeg, phiDeg, radiusM = 1) => ({
  radiusM,
  theta: { startDeg: thetaDeg, count: 1, stepDeg: 0 },
  phi: { startDeg: phiDeg, count: 1, stepDeg: 0 },
});

/** R exp(jkR) E of one cell driven with 1, from the documented relation to the (0,0) amplitude. */
const elementField = (amplitude, cosTheta) =>
  times([0, Math.sqrt(ETA_OHM * AREA_M2 * Math.abs(cosTheta)) / WAVELENGTH_M], amplitude);

/** Remove exp(-jkR) / R from a field component. */
const unpropagated = (component, radiusM) => times(component, cis(K * radiusM)).map((part) => part * radiusM);

const block = (columns, rows) => {
  const cells = [];
  for (let m = 0; m < columns; m += 1) for (let n = 0; n < rows; n += 1) cells.push([m, n]);
  return cells;
};

test("in the steering direction the cells add in phase", () => {
  const tm = [0.3, -0.2];
  const pattern = stubPattern({ amplitudes: () => [{ te: [0, 0], tm }] });
  const array = windowedArray(pattern, {
    steering: steeringScan({ thetaDeg: 30, phiDeg: 20 }),
    cells: block(4, 3),
  });
  const radiusM = 7;
  const field = at(array.computeFarField(oneDirection(30, 20, radiusM)));
  near(unpropagated(field.eTheta, radiusM), elementField(tm, Math.cos(30 * DEG)).map((part) => 12 * part), 1e-9, "E_theta");
  assert.ok(Math.hypot(...field.ePhi) < 1e-12);
});

test("a uniform row of cells has its first null where the cells' phases close a full turn", () => {
  // Four cells along a1 (0.5 m) steered to 20 degrees: the first null is at
  // k a1 (sin theta - sin 20 deg) = 2 pi / 4.
  const pattern = stubPattern({ amplitudes: () => [{ te: [0, 0], tm: [1, 0] }] });
  const array = windowedArray(pattern, {
    steering: steeringScan({ thetaDeg: 20, phiDeg: 0 }),
    cells: block(4, 1),
  });
  const nullDeg = Math.asin(Math.sin(20 * DEG) + 2 * Math.PI / (4 * K * 0.5)) / DEG;
  const peak = Math.hypot(...at(array.computeFarField(oneDirection(20, 0))).eTheta);
  assert.ok(Math.hypot(...at(array.computeFarField(oneDirection(nullDeg, 0))).eTheta) < 1e-12 * peak);
});

test("the pattern's field is reported in the frame of the requested angles", () => {
  // A te amplitude at broadside points along phi-hat at phi = 0, the y axis.
  // At theta = 0 the requested phi = 90 deg frame has theta-hat along y.
  const te = [0.1, 0.4];
  const pattern = stubPattern({ amplitudes: () => [{ te, tm: [0, 0] }] });
  const array = windowedArray(pattern, { steering: steeringScan({}), cells: [[0, 0]] });
  const field = at(array.computeFarField(oneDirection(0, 90)));
  near(unpropagated(field.eTheta, 1), elementField(te, 1), 1e-9, "E_theta");
  assert.ok(Math.hypot(...field.ePhi) < 1e-12);
  // In the phi = 0 frame the same field is E_phi.
  const plain = at(array.computeFarField(oneDirection(0, 0)));
  near(unpropagated(plain.ePhi, 1), elementField(te, 1), 1e-9, "E_phi");
});

test("below the cell the pattern's lower side radiates, and over ground nothing does", () => {
  const above = [0.5, 0];
  const below = [0, -0.7];
  const amplitudes = (u, v, side) => [{ te: [0, 0], tm: side === "above" ? above : below }];
  const free = windowedArray(stubPattern({ amplitudes }), { steering: steeringScan({}), cells: [[0, 0]] });
  const thetaDeg = 140;
  near(
    unpropagated(at(free.computeFarField(oneDirection(thetaDeg, 0))).eTheta, 1),
    elementField(below, Math.cos(thetaDeg * DEG)),
    1e-9,
    "below",
  );
  const grounded = windowedArray(stubPattern({ amplitudes, sides: ["above"] }), {
    steering: steeringScan({}),
    cells: [[0, 0]],
  });
  const field = at(grounded.computeFarField(oneDirection(thetaDeg, 0)));
  assert.deepEqual([...field.eTheta, ...field.ePhi], [0, 0, 0, 0]);
});

test("the drive is the excitation with the steering phases, and sets each cell's share", () => {
  const scanPhasesRad = [0.7, -1.1];
  const tm = [1, 0];
  const pattern = stubPattern({ amplitudes: () => [{ te: [0, 0], tm }] });
  const cells = [[0, 0], [2, 1], [-1, 3]];
  const excitation = vector([[2, 0], [0, 0], [0.5, 0.5]]);
  const array = windowedArray(pattern, { steering: steeringScan({ scanPhasesRad }), cells, excitation });
  const expected = cells.map(([m, n], index) =>
    times([excitation.real[index], excitation.imag[index]], cis(m * scanPhasesRad[0] + n * scanPhasesRad[1])));
  expected.forEach((drive, index) => near([array.drive.real[index], array.drive.imag[index]], index === 1 ? [0, 0] : drive, 1e-12, `drive ${index}`));
  // Off broadside, each cell's field carries the phase of its position.
  const [thetaDeg, phiDeg] = [35, 60];
  const [ux, uy] = [Math.sin(thetaDeg * DEG) * Math.cos(phiDeg * DEG), Math.sin(thetaDeg * DEG) * Math.sin(phiDeg * DEG)];
  let factor = [0, 0];
  cells.forEach(([m, n], index) => {
    const x = m * lattice.a1M[0] + n * lattice.a2M[0];
    const y = m * lattice.a1M[1] + n * lattice.a2M[1];
    factor = plus(factor, times(expected[index], cis(K * (ux * x + uy * y))));
  });
  near(
    unpropagated(at(array.computeFarField(oneDirection(thetaDeg, phiDeg))).eTheta, 1),
    times(elementField(tm, Math.cos(thetaDeg * DEG)), factor),
    1e-9,
    "E_theta",
  );
});

test("several ports in a cell add their patterns with their own drives", () => {
  const pattern = stubPattern({
    ports: 2,
    amplitudes: () => [{ te: [1, 0], tm: [0, 0] }, { te: [0, 0], tm: [0, 1] }],
  });
  const excitation = vector([[0, 0], [3, 0]]);
  const array = windowedArray(pattern, { steering: steeringScan({ impedance: [[[1, 0], [0, 0]], [[0, 0], [1, 0]]] }), cells: [[0, 0]], excitation });
  const field = at(array.computeFarField(oneDirection(25, 0)));
  near(unpropagated(field.eTheta, 1), elementField([0, 3], Math.cos(25 * DEG)), 1e-9, "E_theta");
  assert.ok(Math.hypot(...field.ePhi) < 1e-12);
});

test("every driven cell is given the scan impedance of the steering state, flagged as an approximation", () => {
  // One port: the scan impedance itself, whatever the taper.
  const single = windowedArray(stubPattern({ amplitudes: () => [{ te: [0, 0], tm: [1, 0] }] }), {
    steering: steeringScan({
      thetaDeg: 10,
      impedance: [[[73, 42]]],
      admittance: [[[73 / (73 * 73 + 42 * 42), -42 / (73 * 73 + 42 * 42)]]],
    }),
    cells: block(2, 2),
    excitation: vector([[1, 0], [0.5, 0], [0, 2], [0.1, -0.1]]),
  });
  assert.equal(single.activeImpedances.approximate, true);
  for (let cell = 0; cell < 4; cell += 1) {
    near([single.activeImpedances.real[cell], single.activeImpedances.imag[cell]], [73, 42], 1e-12, `cell ${cell}`);
  }

  // Two ports under unit-voltage drive: I = Y(psi) V for each cell, Z = V / I;
  // a shorted port (no voltage, current flowing) sees zero.
  const admittance = [[[0.02, 0], [0, 0.01]], [[0.005, 0], [0.01, 0.01]]];
  const pattern = stubPattern({ ports: 2, amplitudes: () => [{ te: [1, 0], tm: [0, 0] }, { te: [0, 0], tm: [1, 0] }] });
  const voltage = windowedArray(pattern, {
    steering: steeringScan({ impedance: [[[1, 0], [0, 0]], [[0, 0], [1, 0]]], admittance }),
    cells: [[0, 0], [1, 0]],
    excitation: vector([[1, 0], [1, 0], [2, 0], [0, 0]]),
  });
  // Cell 0: I = [0.02 + 0.01j, 0.015 + 0.01j]; cell 1: I = [0.04, 0.01].
  const divide = ([ar, ai], [br, bi]) => [(ar * br + ai * bi) / (br * br + bi * bi), (ai * br - ar * bi) / (br * br + bi * bi)];
  const expected = [divide([1, 0], [0.02, 0.01]), divide([1, 0], [0.015, 0.01]), [50, 0], [0, 0]];
  expected.forEach((value, index) =>
    near([voltage.activeImpedances.real[index], voltage.activeImpedances.imag[index]], value, 1e-12, `voltage ${index}`));

  // Under unit-current drive: V = Z(psi) I, Z = V / I; an open port (no
  // current) has no active impedance.
  const current = windowedArray(
    stubPattern({
      ports: 2,
      normalization: { kind: "unit-current", valueA: 1 },
      amplitudes: () => [{ te: [1, 0], tm: [0, 0] }, { te: [0, 0], tm: [1, 0] }],
    }),
    {
      steering: steeringScan({ impedance: [[[60, 10], [5, 0]], [[5, 0], [80, -20]]] }),
      cells: [[0, 0]],
      excitation: vector([[1, 0], [0, 0]]),
    },
  );
  near([current.activeImpedances.real[0], current.activeImpedances.imag[0]], [60, 10], 1e-12, "current 0");
  assert.ok(Number.isNaN(current.activeImpedances.real[1]) && Number.isNaN(current.activeImpedances.imag[1]));
});

test("requests that do not fit the pattern are refused", () => {
  const pattern = stubPattern({ amplitudes: () => [{ te: [0, 0], tm: [1, 0] }] });
  const steering = steeringScan({});
  const refused = (options, pattern_ = pattern) => assert.throws(() => windowedArray(pattern_, options), NecInputError);
  refused({ steering: { ...steering, frequencyMHz: 300.1 }, cells: [[0, 0]] });
  refused({ steering: steeringScan({ impedance: [[[1, 0], [0, 0]], [[0, 0], [1, 0]]] }), cells: [[0, 0]] });
  refused({ steering, cells: [] });
  refused({ steering, cells: [[0, 0.5]] });
  refused({ steering, cells: [[1, 2], [1, 2]] });
  refused({ steering, cells: [[0, 0]], excitation: vector([[1, 0], [1, 0]]) });
  refused({ steering, cells: [[0, 0]], excitation: { real: new Float64Array([Number.NaN]), imag: new Float64Array(1) } });
  const array = windowedArray(pattern, { steering, cells: [[0, 0]] });
  assert.throws(() => array.computeFarField({ theta: { startDeg: 0, count: 0, stepDeg: 1 }, phi: { startDeg: 0, count: 1, stepDeg: 0 } }), NecInputError);
});
