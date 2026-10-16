import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import {
  NecGeometryError,
  createNecArraySolver,
  createNecModel,
} from "../.test-build/src/index.js";

const hasWasm = existsSync(new URL("../.test-build/src/nec2pp.wasm", import.meta.url));

const COPPER = 5.8e7;
const STAINLESS = 1.4e6;
const ONE_AMP = { real: Float64Array.of(1), imag: Float64Array.of(0) };

// Reference port of NEC-2 ZINT (src/nec_context.cpp, nec_context::zint) as
// applied by an LD 5 load: the real part of the internal impedance per metre
// of a round wire, in ohm/m. Constants, branch thresholds, and polynomial
// coefficients are NEC's own; see docs/wasm-api.md, "Conductivity loads".
function ld5ResistancePerMetre(sigmaSPerM, radiusM, wavelengthM) {
  const sigl = sigmaSPerM * wavelengthM;
  const rolam = radiusM / wavelengthM;
  const x = Math.sqrt(2.368705e3 * sigl) * rolam;
  // br1 = (ber + j bei) / (ber' + j bei'); Z'λ = j sqrt(60/sigl) br1 / rolam.
  let br1;
  if (x > 110) {
    br1 = [0.70710678, -0.70710678];
  } else if (x > 8) {
    const c = (re, im = 0) => [re, im];
    const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
    const mul = (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
    const scale = (a, s) => [a[0] * s, a[1] * s];
    const exp = (a) => scale([Math.cos(a[1]), Math.sin(a[1])], Math.exp(a[0]));
    const horner = (coefficients, d) => coefficients.slice(1)
      .reduce((sum, value) => add(scale(sum, d), value), coefficients[0]);
    const th = (d) => horner([c(6.0e-7, 1.9e-6), c(-3.4e-6, 5.1e-6), c(-2.52e-5),
      c(-9.06e-5, -9.01e-5), c(0, -9.765e-4), c(0.0110486, -0.0110485),
      c(0, -0.3926991)], d);
    const ph = (d) => horner([c(1.6e-6, -3.2e-6), c(1.17e-5, -2.4e-6),
      c(3.46e-5, 3.38e-5), c(5.0e-7, 2.452e-4), c(-1.3813e-3, 1.3811e-3),
      c(-6.25001e-2, -1.0e-7), c(0.7071068, 0.7071068)], d);
    const cn = c(0.7071068, 0.7071068);
    const f = scale(exp(add(scale(cn, -x), th(-8 / x))), Math.sqrt((Math.PI / 2) / x));
    const g = scale(exp(add(scale(cn, x), th(8 / x))), 1 / Math.sqrt(2 * Math.PI * x));
    const jf = scale(mul([0, 1], f), 1 / Math.PI);
    const numerator = add(g, jf);
    const denominator = sub(mul(g, ph(8 / x)), mul(jf, ph(-8 / x)));
    const d2 = denominator[0] ** 2 + denominator[1] ** 2;
    br1 = [
      (numerator[0] * denominator[0] + numerator[1] * denominator[1]) / d2,
      (numerator[1] * denominator[0] - numerator[0] * denominator[1]) / d2,
    ];
  } else {
    const y = (x / 8) ** 2;
    const s = y * y;
    const ber = ((((((-9.01e-6 * s + 1.22552e-3) * s - 0.08349609) * s + 2.6419140) * s
      - 32.363456) * s + 113.77778) * s - 64) * s + 1;
    const bei = ((((((1.1346e-4 * s - 0.01103667) * s + 0.52185615) * s - 10.567658) * s
      + 72.817777) * s - 113.77778) * s + 16) * y;
    const berp = (((((((-3.94e-6 * s + 4.5957e-4) * s - 0.02609253) * s + 0.66047849) * s
      - 6.0681481) * s + 14.222222) * s - 4) * y) * x;
    const beip = ((((((4.609e-5 * s - 3.79386e-3) * s + 0.14677204) * s - 2.3116751) * s
      + 11.377778) * s - 10.666667) * s + 0.5) * x;
    const d2 = berp ** 2 + beip ** 2;
    br1 = [(ber * berp + bei * beip) / d2, (bei * berp - ber * beip) / d2];
  }
  // Re(j * k * br1) = -k * Im(br1); divide λ·(Ω/m) by λ.
  return -Math.sqrt(60 / sigl) * br1[1] / rolam / wavelengthM;
}

// Segment-centre rule NEC uses for PowerBudget.structureLossW.
function centreRuleLossW(distribution, sigmaForTag) {
  let loss = 0;
  distribution.segments.forEach((segment, index) => {
    const sigma = sigmaForTag(segment.tag);
    if (!sigma) return;
    const re = distribution.aReal[index] + distribution.cReal[index];
    const im = distribution.aImag[index] + distribution.cImag[index];
    loss += 0.5 * ld5ResistancePerMetre(sigma, distribution.radiiM[index], distribution.wavelengthM)
      * distribution.lengthsM[index] * (re * re + im * im);
  });
  return loss;
}

const wavelength = (frequencyMHz) => 299.79563769321626 / frequencyMHz;

async function loadedDipole({ frequencyMHz = 1000, sigma = COPPER, segments = 21 } = {}) {
  const lambda = wavelength(frequencyMHz);
  const model = await createNecModel();
  model.addWire({
    tag: 1,
    segments,
    start: [0, 0, -0.235 * lambda],
    end: [0, 0, 0.235 * lambda],
    radiusM: 0.001 * lambda,
  });
  model.completeGeometry();
  model.definePorts([{ tag: 1, segment: (segments + 1) / 2 }]);
  if (sigma) model.addLoad({ kind: "conductivity", target: { tag: 1 }, conductivitySPerM: sigma });
  model.setGround({ kind: "free-space" });
  return model;
}

function helixWires(lambda) {
  const radius = 0.16 * lambda;
  const pitch = 0.23 * lambda;
  const perTurn = 12;
  const point = (index) => [
    radius * Math.cos(2 * Math.PI * index / perTurn),
    radius * Math.sin(2 * Math.PI * index / perTurn),
    0.05 * lambda + pitch * index / perTurn,
  ];
  const wires = [{ tag: 1, segments: 3, start: [radius, 0, 0], end: point(0), radiusM: 0.004 * lambda }];
  for (let index = 0; index < 3 * perTurn; index += 1) {
    wires.push({ tag: index + 2, segments: 2, start: point(index), end: point(index + 1), radiusM: 0.004 * lambda });
  }
  return wires;
}

test("structureLossW is the LD5 segment-centre rule over every ZINT branch",
  { skip: !hasWasm }, async () => {
    for (const [sigma, frequencyMHz, label] of [
      [COPPER, 1000, "x > 110"],
      [1.5e7, 1000, "8 < x <= 110 (brass)"],
      [STAINLESS, 1000, "8 < x <= 110 (stainless)"],
      [1e3, 1000, "x <= 8"],
    ]) {
      const model = await loadedDipole({ sigma, frequencyMHz });
      model.prepare({ frequencyMHz });
      const loss = model.solveCurrents(ONE_AMP).powerBudget.structureLossW;
      const distribution = model.getCurrentDistribution({ kind: "latest-solution" });
      const expected = centreRuleLossW(distribution, () => sigma);
      assert.ok(Math.abs(expected / loss - 1) < 1e-12, `${label}: ${expected} vs ${loss}`);
      model.dispose();
    }
  });

test("GL-4 NECQ samples reproduce structureLossW through the centre current",
  { skip: !hasWasm }, async () => {
    const nodes = Float64Array.of(-0.8611363115940526, -0.3399810435848563,
      0.3399810435848563, 0.8611363115940526);
    const weights = Float64Array.of(0.34785484513745385, 0.6521451548625461,
      0.6521451548625461, 0.34785484513745385);
    const lambda = wavelength(1000);
    const model = await createNecModel();
    for (const wire of helixWires(lambda)) model.addWire(wire);
    model.completeGeometry();
    model.definePorts([{ tag: 1, segment: 2 }]);
    for (let tag = 1; tag <= 37; tag += 1) {
      model.addLoad({ kind: "conductivity", target: { tag }, conductivitySPerM: COPPER });
    }
    model.setGround({ kind: "free-space" });
    model.prepare({ frequencyMHz: 1000 });
    const characterization = model.characterizeIsolatedElement({
      quadrature: { nodes, weights, images: "physical-only", modes: "unit-current" },
      field: { theta: { startDeg: 0, count: 3, stepDeg: 90 }, phi: { startDeg: 0, count: 1, stepDeg: 0 } },
    });
    const view = new DataView(characterization.quadrature.buffer);
    const nSegments = view.getUint32(12, true);
    const nNodes = view.getUint32(16, true);
    const wavelengthM = view.getFloat64(40, true);
    let offset = 64 + 12 * nSegments;
    offset += (8 - (offset % 8)) % 8;
    const sampleCount = nSegments * nNodes;
    const plane = (index) => new Float64Array(characterization.quadrature.buffer,
      offset + 8 * sampleCount * index, sampleCount);
    const radiusM = plane(6);
    const lengthM = plane(7);
    const dsWeight = plane(8);
    const iReal = plane(9);
    const iImag = plane(10);
    const k = 2 * Math.PI / wavelengthM;
    let centreRule = 0;
    let gaussRule = 0;
    for (let segment = 0; segment < nSegments; segment += 1) {
      const base = segment * nNodes;
      const r = ld5ResistancePerMetre(COPPER, radiusM[base], wavelengthM);
      for (let node = 0; node < nNodes; node += 1) {
        gaussRule += 0.5 * r * dsWeight[base + node]
          * (iReal[base + node] ** 2 + iImag[base + node] ** 2);
      }
      // Even part of A + B sin(ks) + C cos(ks) at the two node pairs gives A + C.
      const c1 = Math.cos(k * nodes[3] * lengthM[base] / 2);
      const c2 = Math.cos(k * nodes[2] * lengthM[base] / 2);
      const centre = [iReal, iImag].map((values) => {
        const outer = (values[base] + values[base + 3]) / 2;
        const inner = (values[base + 1] + values[base + 2]) / 2;
        return outer + (outer - inner) * (1 - c1) / (c1 - c2);
      });
      centreRule += 0.5 * r * lengthM[base] * (centre[0] ** 2 + centre[1] ** 2);
    }
    const native = model.solveCurrents(ONE_AMP).powerBudget.structureLossW;
    assert.ok(Math.abs(centreRule / native - 1) < 1e-12, `${centreRule} vs ${native}`);
    // The plain quadrature integral is a different, slightly larger rule here.
    assert.ok(Math.abs(gaussRule / native - 1) > 1e-5);
    assert.ok(Math.abs(gaussRule / native - 1) < 2e-3);
    model.dispose();
  });

test("re-prepare at a new frequency recomputes LD5, stateful and array solver",
  { skip: !hasWasm }, async () => {
    const reused = await loadedDipole();
    reused.prepare({ frequencyMHz: 900 });
    reused.prepare({ frequencyMHz: 1100 });
    const zReused = reused.computeImpedanceMatrix().impedance;
    const fresh = await loadedDipole();
    fresh.prepare({ frequencyMHz: 1100 });
    const zFresh = fresh.computeImpedanceMatrix().impedance;
    assert.deepEqual([zReused.real[0], zReused.imag[0]], [zFresh.real[0], zFresh.imag[0]]);
    reused.dispose();
    fresh.dispose();

    const lambda = wavelength(1000);
    const description = {
      elements: [
        { id: "a", positionM: [-0.25 * lambda, 0], patternId: "dipole" },
        { id: "b", positionM: [0.25 * lambda, 0], patternId: "dipole" },
      ],
      patterns: [{
        id: "dipole",
        kind: "straight-wire-pattern",
        wires: [{
          id: "radiator",
          segments: 21,
          startM: [0, 0, -0.235 * lambda],
          endM: [0, 0, 0.235 * lambda],
          radiusM: 0.001 * lambda,
        }],
        ports: [{ wireId: "radiator", segment: 11 }],
        loads: [{ kind: "conductivity", target: { wireId: "radiator" }, conductivitySPerM: COPPER }],
      }],
      ground: { kind: "free-space" },
    };
    for (const symmetry of ["off", "auto"]) {
      const options = { symmetry, symmetrizer: { positionEpsilonM: 1e-9 } };
      const sweep = await createNecArraySolver(description, options);
      const single = await createNecArraySolver(description, options);
      try {
        await sweep.prepare({ frequencyMHz: 900 });
        await sweep.computeImpedanceMatrix();
        await sweep.prepare({ frequencyMHz: 1100 });
        const swept = (await sweep.computeImpedanceMatrix()).impedance;
        await single.prepare({ frequencyMHz: 1100 });
        const direct = (await single.computeImpedanceMatrix()).impedance;
        assert.deepEqual(Array.from(swept.real), Array.from(direct.real), symmetry);
        assert.deepEqual(Array.from(swept.imag), Array.from(direct.imag), symmetry);
      } finally {
        await sweep.dispose();
        await single.dispose();
      }
    }
  });

test("perfect-ground structureLossW excludes image segments",
  { skip: !hasWasm }, async () => {
    const lambda = wavelength(1000);
    const model = await createNecModel();
    model.addWire({ tag: 1, segments: 11, start: [0, 0, 0], end: [0, 0, 0.235 * lambda], radiusM: 0.001 * lambda });
    model.completeGeometry({ groundConnection: "interpolate" });
    model.definePorts([{ tag: 1, segment: 1 }]);
    model.addLoad({ kind: "conductivity", target: { tag: 1 }, conductivitySPerM: COPPER });
    model.setGround({ kind: "perfect" });
    model.prepare({ frequencyMHz: 1000 });
    const loss = model.solveCurrents(ONE_AMP).powerBudget.structureLossW;
    const distribution = model.getCurrentDistribution({ kind: "latest-solution" });
    assert.equal(distribution.segments.length, 11);
    assert.ok(Math.abs(centreRuleLossW(distribution, () => COPPER) / loss - 1) < 1e-12);
    model.dispose();
  });

test("addLoad rejects a segment range past the end of the tag",
  { skip: !hasWasm }, async () => {
    const model = await loadedDipole({ sigma: 0 });
    for (const target of [
      { tag: 1, firstSegment: 1, lastSegment: 22 },
      { tag: 1, firstSegment: 22 },
    ]) {
      assert.throws(
        () => model.addLoad({ kind: "conductivity", target, conductivitySPerM: COPPER }),
        (error) => error instanceof NecGeometryError
          && /OUT OF RANGE FOR THE TAG/.test(error.message),
      );
    }
    assert.throws(
      () => model.addLoad({ kind: "conductivity", target: { tag: 7 }, conductivitySPerM: COPPER }),
      (error) => error instanceof NecGeometryError && /NO SEGMENT HAS AN ITAG OF 7/.test(error.message),
    );
    model.addLoad({ kind: "conductivity", target: { tag: 1, firstSegment: 1, lastSegment: 21 }, conductivitySPerM: COPPER });
    model.prepare({ frequencyMHz: 1000 });
    assert.ok(model.solveCurrents(ONE_AMP).powerBudget.structureLossW > 0);
    model.dispose();
  });

test("the ring evaluator accepts loaded wires",
  { skip: !hasWasm }, async () => {
    const model = await loadedDipole({ sigma: STAINLESS });
    model.prepare({ frequencyMHz: 1000 });
    model.solveVoltages(ONE_AMP);
    const request = { theta: { startDeg: 0, count: 91, stepDeg: 2 }, phi: { startDeg: 0, count: 180, stepDeg: 2 } };
    const exact = model.computeFarField(request);
    const ring = model.computeFarField({ ...request, evaluator: "ring" });
    assert.equal(ring.fieldEvaluation?.execution, "ring");
    let delta = 0;
    let scale = 0;
    for (const key of ["eThetaReal", "eThetaImag", "ePhiReal", "ePhiImag"]) {
      for (let index = 0; index < exact[key].length; index += 1) {
        delta += (exact[key][index] - ring[key][index]) ** 2;
        scale += exact[key][index] ** 2;
      }
    }
    assert.ok(Math.sqrt(delta / scale) < 1e-9);
    model.dispose();
  });
