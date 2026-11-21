// Floquet-mode amplitudes of the periodic unit cell at the package seam: the
// (0,0) amplitude against the embedded pattern of the centre element of a
// large finite array, and terminated amplitudes against a fresh solve with
// the generator impedance as loads. Power closure is tested natively.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import {
  NecInputError,
  createNecPeriodicModel,
  terminatedFloquetAmplitudes,
} from "../.test-build/src/index.js";
import {
  FREQUENCY_MHZ,
  WAVENUMBER_PER_M,
  dipoleWire,
  distance,
  finiteArrayCentreFarField,
  magnitude,
} from "./periodic-reference.mjs";

const hasWasm = existsSync(new URL("../.test-build/src/nec2pp.wasm", import.meta.url));
const skip = !hasWasm && "WASM artifacts have not been built";

// NEC's thin-wire field impedance (j eta / (8 pi^2) = j 4.771341189).
const ETA_OHM = 4.771341189 * 8 * Math.PI * Math.PI;
const WAVELENGTH_M = 2 * Math.PI / WAVENUMBER_PER_M;

function findMode(floquet, p, q, side) {
  return floquet.modes.find((mode) => mode.p === p && mode.q === q && mode.side === side);
}

const at = (vector, index) => [vector.real[index], vector.imag[index]];
const times = ([ar, ai], [br, bi]) => [ar * br - ai * bi, ar * bi + ai * br];
const scaled = ([real, imag], factor) => [real * factor, imag * factor];

/** Two tilted, unequal wires: no symmetry relates the two ports. */
async function tiltedPairCell({ loads = [] } = {}) {
  const cell = await createNecPeriodicModel();
  cell.addWire({ tag: 1, segments: 21, start: [-0.2, -0.05, 0.12], end: [0.2, 0.05, 0.36], radiusM: 0.001 });
  cell.addWire({ tag: 2, segments: 17, start: [0.1, 0.15, 0.3], end: [0.3, 0.35, 0.15], radiusM: 0.001 });
  cell.completeGeometry();
  cell.definePorts([{ tag: 1, segment: 11 }, { tag: 2, segment: 9 }]);
  for (const load of loads) cell.addLoad(load);
  cell.setLattice({ a1M: [0.8, 0], a2M: [0.1, 0.7] });
  return cell;
}

test("the (0,0) amplitude is the embedded pattern of the inner elements of a large finite array", {
  skip,
  timeout: 600_000,
}, async () => {
  // x-directed half-wave dipoles on a 0.6 x 0.5 wavelength lattice, scanned
  // to 30 degrees in the E-plane (TM, E_theta) and the H-plane (TE, E_phi).
  const a1M = [0.6, 0];
  const a2M = [0, 0.5];
  const areaM2 = a1M[0] * a2M[1];
  const cell = await createNecPeriodicModel();
  try {
    cell.addWire({ tag: 1, segments: 11, start: [-0.24, 0, 0], end: [0.24, 0, 0], radiusM: 0.001 });
    cell.completeGeometry();
    cell.definePorts([{ tag: 1, segment: 6 }]);
    cell.setLattice({ a1M, a2M });
    for (const { phiDeg, component } of [
      { phiDeg: 0, component: "tm" },
      { phiDeg: 90, component: "te" },
    ]) {
      const thetaDeg = 30;
      const scan = cell.computeScanImpedance({
        frequencyMHz: FREQUENCY_MHZ,
        scanDirection: { thetaDeg, phiDeg },
      });
      const main = findMode(scan.floquet, 0, 0, "above");
      assert.ok(main.propagating);
      // A plane-wave mode E_00 and the far field of one cell's current share
      // the radiation vector N:
      //   R exp(j k R) E_far = -j eta k N_t / (4 pi),  E_00 = -eta k N_t / (2 A kz),
      // so R exp(j k R) E_far = j A kz E_00 / (2 pi), and with the power
      // normalization a = E_00 sqrt(A kz / (eta k)):
      //   R exp(j k R) E_far = j sqrt(eta A cos(theta)) a / wavelength.
      const cosTheta = Math.cos((thetaDeg * Math.PI) / 180);
      const amplitude = at(main[component], 0);
      const periodic = times([0, Math.sqrt(ETA_OHM * areaM2 * cosTheta) / WAVELENGTH_M], amplitude);
      const finite = (options) => finiteArrayCentreFarField({
        frequencyMHz: FREQUENCY_MHZ,
        a1M,
        a2M,
        cells: 7,
        wires: [dipoleWire("dipole", [0, 0])],
        ports: [{ wireId: "dipole", segment: 6 }],
        thetaDeg,
        phiDeg,
        ...options,
      });
      const relativeTo = (field) => {
        const reference = component === "tm" ? field.eTheta : field.ePhi;
        return distance(periodic, reference) / magnitude(reference);
      };
      // The centre element alone of a 15 x 15 array. Its pattern ripples with
      // the array size around the periodic value (E-plane 4.6, 2.8, 0.8 and
      // 1.2 % at 11, 15, 21 and 27 cells a side; H-plane 3.6, 6.4, 3.0 and
      // 2.4 %): the edge waves of the finite array.
      const centre = relativeTo(await finite({}));
      assert.ok(centre < 0.1, `phi ${phiDeg}: centre element ${centre}`);
      // The same array driven with the scan phases under a Gaussian taper,
      // which weights the inner elements and suppresses the edge waves:
      // measured 0.04 % (E-plane) and 0.37 % (H-plane), and 0.24 and 0.15 %
      // at 21 x 21 with sigma 2 m.
      const kt0 = WAVENUMBER_PER_M * Math.sin((thetaDeg * Math.PI) / 180);
      const phi = (phiDeg * Math.PI) / 180;
      const psi = [-kt0 * Math.cos(phi) * a1M[0], -kt0 * Math.sin(phi) * a2M[1]];
      const tapered = relativeTo(await finite({ sigmaM: 1.6, psi }));
      assert.ok(tapered < 0.01, `phi ${phiDeg}: tapered array ${tapered}`);
    }
  } finally {
    cell.dispose();
  }
});

test("terminated amplitudes equal a fresh solve with the generator impedance as port loads", {
  skip,
  timeout: 120_000,
}, async () => {
  const generator = [50, 20];
  const scanPhasesRad = [1.1, -0.4];
  const loaded = await tiltedPairCell({
    loads: [1, 2].map((tag, index) => ({
      kind: "impedance",
      target: { tag, firstSegment: [11, 9][index] },
      resistanceOhm: generator[0],
      reactanceOhm: generator[1],
    })),
  });
  const cell = await tiltedPairCell();
  try {
    // A port driven by 1 V across its gap in series with the load is a
    // generator of EMF 1 V and source impedance Zg; 1 W available power is
    // an EMF of sqrt(8 Re Zg).
    const fresh = loaded.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanPhasesRad }).floquet;
    const emf = Math.sqrt(8 * generator[0]);
    for (const normalization of [{ kind: "unit-voltage", valueV: 1 }, { kind: "unit-current", valueA: 1 }]) {
      const result = cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanPhasesRad, normalization });
      const terminated = terminatedFloquetAmplitudes(result, { generatorImpedanceOhm: generator });
      assert.deepEqual(terminated.generatorImpedanceOhm, generator);
      assert.equal(terminated.modes.length, fresh.modes.length);
      // The tolerance policy's metric ||a - b||_2 / max(1, ||a||_2, ||b||_2)
      // over every amplitude.
      let difference = 0;
      let actualNorm = 0;
      let expectedNorm = 0;
      for (const mode of terminated.modes) {
        const reference = findMode(fresh, mode.p, mode.q, mode.side);
        for (const component of ["te", "tm"]) {
          for (let port = 0; port < 2; port += 1) {
            const actual = at(mode[component], port);
            const expected = scaled(at(reference[component], port), emf);
            difference += distance(actual, expected) ** 2;
            actualNorm += magnitude(actual) ** 2;
            expectedNorm += magnitude(expected) ** 2;
          }
        }
        for (let port = 0; port < 2; port += 1) {
          const power = mode.propagating ? (magnitude(at(mode.te, port)) ** 2 + magnitude(at(mode.tm, port)) ** 2) / 2 : 0;
          assert.ok(Math.abs(mode.powerW[port] - power) <= 1e-12, `${mode.powerW[port]} vs ${power}`);
        }
      }
      const epsilon = Math.sqrt(difference) / Math.max(1, Math.sqrt(actualNorm), Math.sqrt(expectedNorm));
      assert.ok(epsilon < 1e-9, `${normalization.kind}: epsilon ${epsilon}`);
    }
  } finally {
    cell.dispose();
    loaded.dispose();
  }
});

test("every scan result carries its propagating modes, the evanescent ones asked for, and a closing power budget", {
  skip,
}, async () => {
  const cell = await tiltedPairCell();
  try {
    const result = cell.computeScanImpedance({
      frequencyMHz: FREQUENCY_MHZ,
      scanPhasesRad: [1.1, -0.4],
      evanescentModes: [{ p: 1, q: 0 }, { p: 0, q: 0 }],
    });
    const { floquet } = result;
    assert.deepEqual(floquet.normalization, { kind: "unit-voltage", valueV: 1 });
    assert.equal(floquet.powerBudget.length, 2);
    // The wires' discretization error, about 1e-3 at 21 segments (tested natively).
    for (const { inputW, propagatingW, lossW } of floquet.powerBudget) {
      assert.equal(lossW, 0);
      assert.ok(Math.abs(inputW - propagatingW) < 2e-3 * inputW, `${inputW} vs ${propagatingW}`);
    }
    // (0, 0) is propagating, so asking for it adds nothing; (1, 0) is evanescent.
    assert.equal(floquet.modes.filter((mode) => mode.p === 0 && mode.q === 0).length, 2);
    for (const side of ["above", "below"]) {
      const evanescent = findMode(floquet, 1, 0, side);
      assert.equal(evanescent.propagating, false);
      assert.ok(evanescent.kzRadPerM[1] < 0);
      assert.deepEqual([...evanescent.powerW], [0, 0]);
    }
    for (const mode of floquet.modes) {
      assert.equal(mode.te.real.length, 2);
      const kt2 = mode.ktRadPerM[0] ** 2 + mode.ktRadPerM[1] ** 2;
      assert.equal(mode.propagating, kt2 <= WAVENUMBER_PER_M ** 2);
    }
    assert.ok(Object.isFrozen(floquet));
    assert.ok(Object.isFrozen(floquet.modes[0]));
  } finally {
    cell.dispose();
  }
});

test("Floquet options and terminations are validated", { skip }, async () => {
  const cell = await tiltedPairCell();
  try {
    const request = { frequencyMHz: FREQUENCY_MHZ, scanPhasesRad: [0, 0] };
    for (const options of [
      { normalization: { kind: "unit-voltage", valueV: 2 } },
      { normalization: "unit-voltage" },
      { evanescentModes: [{ p: 0.5, q: 0 }] },
      { evanescentModes: {} },
      { evanescentModes: [{ p: 1 }] },
    ]) {
      assert.throws(() => cell.computeScanImpedance({ ...request, ...options }), NecInputError, JSON.stringify(options));
    }
    const result = cell.computeScanImpedance(request);
    for (const generatorImpedanceOhm of [0, -50, [0, 10], [50], Number.NaN, "50"]) {
      assert.throws(
        () => terminatedFloquetAmplitudes(result, { generatorImpedanceOhm }),
        NecInputError,
        String(generatorImpedanceOhm),
      );
    }
  } finally {
    cell.dispose();
  }
});
