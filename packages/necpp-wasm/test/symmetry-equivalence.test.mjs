import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import {
  analyzeArraySymmetry,
  applyArrayBuildPlan,
  createNecArraySolver,
  createNecModel,
  gatherComplexMatrix,
} from "../.test-build/src/index.js";
import { createReferenceArrayFixture } from "./fixtures/reference-array.mjs";

const hasWasm = existsSync(new URL("../.test-build/src/nec2pp.wasm", import.meta.url));
const exactTolerance = 1e-8;
const copyTolerance = 1e-12;

function dipolePattern(fixture, id = "dipole", kind = "straight-wire-pattern") {
  return {
    id,
    kind,
    wires: [{
      id: "radiator",
      segments: fixture.segments,
      startM: [0, 0, fixture.lowerZM],
      endM: [0, 0, fixture.upperZM],
      radiusM: fixture.radiusM,
    }],
    ports: [{ wireId: "radiator", segment: fixture.feedSegment, name: "feed" }],
  };
}

function gridDescription({
  side = 4,
  centerM = [0, 0],
  ground,
  rowPatterns = false,
  kind = "straight-wire-pattern",
} = {}) {
  const fixture = createReferenceArrayFixture({ side, centerM });
  const selectedGround = ground ?? fixture.ground;
  const patterns = rowPatterns
    ? Array.from({ length: side }, (_, row) => dipolePattern(fixture, `dipole-row-${row}`))
    : [dipolePattern(fixture, "dipole", kind)];
  return {
    fixture,
    description: {
      elements: fixture.wires.map((wire, index) => ({
        id: `element-${index}`,
        positionM: [wire.start[0], wire.start[1]],
        patternId: rowPatterns ? `dipole-row-${Math.floor(index / side)}` : "dipole",
      })),
      patterns,
      ground: selectedGround,
    },
  };
}

function ringDescription({ order, ground = { kind: "perfect" } }) {
  const fixture = createReferenceArrayFixture({ side: 2 });
  const radiusM = fixture.wavelengthM * 0.61;
  return {
    fixture,
    description: {
      elements: Array.from({ length: order }, (_, index) => {
        const angle = 2 * Math.PI * index / order;
        return {
          id: `ring-${index}`,
          positionM: [radiusM * Math.cos(angle), radiusM * Math.sin(angle)],
          patternId: "dipole",
        };
      }),
      patterns: [dipolePattern(fixture)],
      ground,
    },
  };
}

function allFinite(values, label) {
  for (let index = 0; index < values.length; index += 1) {
    assert.ok(Number.isFinite(values[index]), `${label}[${index}] is not finite`);
  }
}

function complexMetrics(left, right, absoluteFloor = 1e-30) {
  assert.equal(left.real.length, right.real.length);
  assert.equal(left.imag.length, right.imag.length);
  allFinite(left.real, "left.real");
  allFinite(left.imag, "left.imag");
  allFinite(right.real, "right.real");
  allFinite(right.imag, "right.imag");
  let deltaSquared = 0;
  let baselineSquared = 0;
  let maxDelta = 0;
  let maxBaseline = 0;
  for (let index = 0; index < left.real.length; index += 1) {
    const delta = Math.hypot(
      left.real[index] - right.real[index],
      left.imag[index] - right.imag[index],
    );
    const baseline = Math.hypot(right.real[index], right.imag[index]);
    deltaSquared += delta * delta;
    baselineSquared += baseline * baseline;
    maxDelta = Math.max(maxDelta, delta);
    maxBaseline = Math.max(maxBaseline, baseline);
  }
  return {
    relativeL2: Math.sqrt(deltaSquared) / Math.max(Math.sqrt(baselineSquared), absoluteFloor),
    scaledMax: maxDelta / Math.max(maxBaseline, absoluteFloor),
  };
}

function assertComplexClose(left, right, tolerance, label) {
  const metrics = complexMetrics(left, right);
  assert.ok(metrics.relativeL2 <= tolerance,
    `${label} relativeL2 ${metrics.relativeL2} exceeds ${tolerance}`);
  assert.ok(metrics.scaledMax <= tolerance,
    `${label} scaledMax ${metrics.scaledMax} exceeds ${tolerance}`);
}

function realMetrics(left, right, absoluteFloor = 1e-30) {
  assert.equal(left.length, right.length);
  allFinite(left, "left");
  allFinite(right, "right");
  let deltaSquared = 0;
  let baselineSquared = 0;
  let maxDelta = 0;
  let maxBaseline = 0;
  for (let index = 0; index < left.length; index += 1) {
    const delta = Math.abs(left[index] - right[index]);
    deltaSquared += delta * delta;
    baselineSquared += right[index] * right[index];
    maxDelta = Math.max(maxDelta, delta);
    maxBaseline = Math.max(maxBaseline, Math.abs(right[index]));
  }
  return {
    relativeL2: Math.sqrt(deltaSquared) / Math.max(Math.sqrt(baselineSquared), absoluteFloor),
    scaledMax: maxDelta / Math.max(maxBaseline, absoluteFloor),
  };
}

function assertRealClose(left, right, tolerance, label) {
  const metrics = realMetrics(left, right);
  assert.ok(metrics.relativeL2 <= tolerance,
    `${label} relativeL2 ${metrics.relativeL2} exceeds ${tolerance}`);
  assert.ok(metrics.scaledMax <= tolerance,
    `${label} scaledMax ${metrics.scaledMax} exceeds ${tolerance}`);
}

function matrixProduct(left, right) {
  const order = left.rows;
  assert.equal(left.rows, left.columns);
  assert.equal(right.rows, order);
  assert.equal(right.columns, order);
  const real = new Float64Array(order * order);
  const imag = new Float64Array(order * order);
  for (let row = 0; row < order; row += 1) {
    for (let column = 0; column < order; column += 1) {
      let sumReal = 0;
      let sumImag = 0;
      for (let inner = 0; inner < order; inner += 1) {
        const leftIndex = row * order + inner;
        const rightIndex = inner * order + column;
        sumReal += left.real[leftIndex] * right.real[rightIndex]
          - left.imag[leftIndex] * right.imag[rightIndex];
        sumImag += left.real[leftIndex] * right.imag[rightIndex]
          + left.imag[leftIndex] * right.real[rightIndex];
      }
      real[row * order + column] = sumReal;
      imag[row * order + column] = sumImag;
    }
  }
  return { real, imag };
}

function assertMatrixContract(result, expectedOrder, label) {
  assert.equal(result.impedance.rows, expectedOrder, `${label} impedance rows`);
  assert.equal(result.impedance.columns, expectedOrder, `${label} impedance columns`);
  assert.equal(result.impedance.order, "row-major");
  assert.equal(result.admittance.rows, expectedOrder, `${label} admittance rows`);
  assert.equal(result.admittance.columns, expectedOrder, `${label} admittance columns`);
  allFinite(result.impedance.real, `${label}.Z.real`);
  allFinite(result.impedance.imag, `${label}.Z.imag`);
  allFinite(result.admittance.real, `${label}.Y.real`);
  allFinite(result.admittance.imag, `${label}.Y.imag`);

  const product = matrixProduct(result.impedance, result.admittance);
  const identity = {
    real: Float64Array.from({ length: expectedOrder * expectedOrder }, (_, index) =>
      Math.floor(index / expectedOrder) === index % expectedOrder ? 1 : 0),
    imag: new Float64Array(expectedOrder * expectedOrder),
  };
  assertComplexClose(product, identity, 2e-8, `${label} Z*Y identity`);

  const transpose = { real: new Float64Array(expectedOrder * expectedOrder), imag: new Float64Array(expectedOrder * expectedOrder) };
  for (let row = 0; row < expectedOrder; row += 1) {
    for (let column = 0; column < expectedOrder; column += 1) {
      transpose.real[row * expectedOrder + column] = result.impedance.real[column * expectedOrder + row];
      transpose.imag[row * expectedOrder + column] = result.impedance.imag[column * expectedOrder + row];
    }
  }
  // The 11-segment pulse/basis discretization leaves the explicit 4x4 and 8x8
  // matrices reciprocal to about 1.37e-7 and 2.74e-7 respectively. This is an
  // independent baseline property; representation comparisons retain 1e-8.
  const reciprocityTolerance = expectedOrder >= 64 ? 3e-7 : 2e-7;
  assertComplexClose(result.impedance, transpose, reciprocityTolerance,
    `${label} reciprocal Z`);
}

function currentVector(count, phaseStep = 0.37) {
  return {
    real: Float64Array.from({ length: count }, (_, index) =>
      (0.7 + 0.02 * index) * Math.cos(phaseStep * index)),
    imag: Float64Array.from({ length: count }, (_, index) =>
      (0.7 + 0.02 * index) * Math.sin(phaseStep * index)),
  };
}

const smokeFieldRequest = {
  radiusM: 1,
  theta: { startDeg: 20, count: 4, stepDeg: 20 },
  phi: { startDeg: 0, count: 4, stepDeg: 90 },
};

async function createPair(description, fixture, symmetrizer) {
  const explicit = await createNecArraySolver(description, { symmetry: "off" });
  let symmetric;
  try {
    symmetric = await createNecArraySolver(description, { symmetry: "require", symmetrizer });
    await Promise.all([
      explicit.prepare({ frequencyMHz: fixture.frequencyMHz }),
      symmetric.prepare({ frequencyMHz: fixture.frequencyMHz }),
    ]);
    return { explicit, symmetric };
  } catch (error) {
    await Promise.all([
      explicit.dispose(),
      ...(symmetric === undefined ? [] : [symmetric.dispose()]),
    ]);
    throw error;
  }
}

async function compareRepresentationCase({
  name,
  description,
  fixture,
  symmetrizer,
  expectedSections,
  tolerance = exactTolerance,
  checkField = true,
}) {
  const { explicit, symmetric } = await createPair(description, fixture, symmetrizer);
  try {
    const explicitDiagnostics = explicit.getDiagnostics();
    const symmetricDiagnostics = symmetric.getDiagnostics();
    assert.equal(explicitDiagnostics.representation, "explicit");
    assert.equal(explicitDiagnostics.symmetry, undefined);
    assert.equal(symmetricDiagnostics.representation, "symmetric");
    assert.equal(symmetricDiagnostics.symmetry.sectionCount, expectedSections);
    assert.equal(symmetricDiagnostics.symmetry.fullSegmentCount,
      description.elements.length * fixture.segments);
    assert.equal(symmetricDiagnostics.symmetry.fundamentalSegmentCount,
      description.elements.length * fixture.segments / expectedSections);

    const [baseline, candidate] = await Promise.all([
      explicit.computeImpedanceMatrix(),
      symmetric.computeImpedanceMatrix(),
    ]);
    assert.equal(baseline.frequencyMHz, fixture.frequencyMHz);
    assert.equal(candidate.frequencyMHz, baseline.frequencyMHz);
    assert.equal(candidate.factorizationGeneration, baseline.factorizationGeneration);
    assertMatrixContract(baseline, description.elements.length, `${name} explicit`);
    assertMatrixContract(candidate, description.elements.length, `${name} symmetric`);
    assertComplexClose(candidate.impedance, baseline.impedance, tolerance, `${name} gathered Z`);
    assertComplexClose(candidate.admittance, baseline.admittance, tolerance, `${name} gathered Y`);

    // Compare named mutual entries and their symmetry-related partners independently
    // from the all-entry metrics so a row/column gather error is localized.
    const order = description.elements.length;
    const namedIndices = [1, order, order * order - 2];
    for (const index of namedIndices.filter((value) => value < order * order)) {
      assertComplexClose(
        { real: Float64Array.of(candidate.impedance.real[index]), imag: Float64Array.of(candidate.impedance.imag[index]) },
        { real: Float64Array.of(baseline.impedance.real[index]), imag: Float64Array.of(baseline.impedance.imag[index]) },
        tolerance,
        `${name} mutual Z[${Math.floor(index / order)},${index % order}]`,
      );
    }

    const currents = currentVector(order);
    const [baselineSolution, candidateSolution] = await Promise.all([
      explicit.solveCurrents(currents),
      symmetric.solveCurrents(currents),
    ]);
    compareSolutions(candidateSolution, baselineSolution, tolerance, `${name} solution`);
    if (checkField) {
      const [baselineField, candidateField] = await Promise.all([
        explicit.computeFarField(smokeFieldRequest),
        symmetric.computeFarField(smokeFieldRequest),
      ]);
      compareFields(candidateField, baselineField, tolerance, `${name} far field`);
    }
    return { baseline, candidate };
  } finally {
    await Promise.all([explicit.dispose(), symmetric.dispose()]);
  }
}

function compareSolutions(candidate, baseline, tolerance, label) {
  assert.equal(candidate.drive, baseline.drive);
  assert.equal(candidate.frequencyMHz, baseline.frequencyMHz);
  assert.equal(candidate.factorizationGeneration, baseline.factorizationGeneration);
  assert.equal(candidate.solveGeneration, baseline.solveGeneration);
  assert.deepEqual(candidate.ports, baseline.ports);
  assertComplexClose(candidate.requested, baseline.requested, copyTolerance, `${label} requested`);
  assertComplexClose(candidate.voltages, baseline.voltages, tolerance, `${label} voltages`);
  assertComplexClose(candidate.currents, baseline.currents, tolerance, `${label} currents`);
  assertComplexClose(candidate.activeImpedances, baseline.activeImpedances, tolerance,
    `${label} active impedances`);
  assertRealClose(candidate.powersW, baseline.powersW, tolerance, `${label} powers`);
}

function fieldComponents(field) {
  return [
    [field.eThetaReal, field.eThetaImag, "E_theta"],
    [field.ePhiReal, field.ePhiImag, "E_phi"],
  ];
}

function compareFields(candidate, baseline, tolerance, label) {
  assert.equal(candidate.radiusM, baseline.radiusM);
  assert.equal(candidate.frequencyMHz, baseline.frequencyMHz);
  assert.deepEqual(candidate.thetaDeg, baseline.thetaDeg);
  assert.deepEqual(candidate.phiDeg, baseline.phiDeg);
  for (const [real, imag, component] of fieldComponents(candidate)) {
    const baselineComponent = component === "E_theta"
      ? { real: baseline.eThetaReal, imag: baseline.eThetaImag }
      : { real: baseline.ePhiReal, imag: baseline.ePhiImag };
    assertComplexClose({ real, imag }, baselineComponent, tolerance, `${label} ${component}`);
  }
}

function totalFieldMagnitude(field) {
  return Float64Array.from({ length: field.eThetaReal.length }, (_, index) => Math.hypot(
    field.eThetaReal[index], field.eThetaImag[index],
    field.ePhiReal[index], field.ePhiImag[index],
  ));
}

function maximumIndex(values) {
  let selected = 0;
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] > values[selected]) {
      selected = index;
    }
  }
  return selected;
}

function stablePeakIndex(values, relativeTie = 1e-10) {
  const maximum = values[maximumIndex(values)];
  const floor = maximum * (1 - relativeTie);
  return values.findIndex((value) => value >= floor);
}

function superposeEmbedded(embedded, currents, component) {
  const real = new Float64Array(embedded.samplesPerPort);
  const imag = new Float64Array(embedded.samplesPerPort);
  const basisReal = embedded[`${component}Real`];
  const basisImag = embedded[`${component}Imag`];
  for (let port = 0; port < embedded.ports.length; port += 1) {
    for (let sample = 0; sample < embedded.samplesPerPort; sample += 1) {
      const source = port * embedded.samplesPerPort + sample;
      real[sample] += basisReal[source] * currents.real[port]
        - basisImag[source] * currents.imag[port];
      imag[sample] += basisReal[source] * currents.imag[port]
        + basisImag[source] * currents.real[port];
    }
  }
  return { real, imag };
}

function steeringCurrents(fixture, thetaDeg, phiDeg, amplitude) {
  const theta = thetaDeg * Math.PI / 180;
  const phi = phiDeg * Math.PI / 180;
  const ux = Math.sin(theta) * Math.cos(phi);
  const uy = Math.sin(theta) * Math.sin(phi);
  const waveNumber = 2 * Math.PI / fixture.wavelengthM;
  return {
    real: Float64Array.from(fixture.wires, (wire, index) => {
      const phase = -waveNumber * (ux * wire.start[0] + uy * wire.start[1]);
      return amplitude(index) * Math.cos(phase);
    }),
    imag: Float64Array.from(fixture.wires, (wire, index) => {
      const phase = -waveNumber * (ux * wire.start[0] + uy * wire.start[1]);
      return amplitude(index) * Math.sin(phase);
    }),
  };
}

test("WP-S6 R1/R2 reflection matrices and manual/transparent gathering match explicit models", {
  skip: !hasWasm && "WASM artifacts have not been built",
  timeout: 180_000,
}, async () => {
  for (const side of [2, 4]) {
    const { description, fixture } = gridDescription({ side });
    await compareRepresentationCase({
      name: `R${side === 2 ? 1 : 2}`,
      description,
      fixture,
      symmetrizer: { positionEpsilonM: 0, allowRotation: false },
      expectedSections: 4,
    });
  }

  // The low-level path deliberately exposes native copy-major port order. Apply
  // the same transparent plan manually and prove the two-dimensional gather.
  const { description, fixture } = gridDescription({ side: 4 });
  const plan = analyzeArraySymmetry(description, {
    positionEpsilonM: 0,
    allowRotation: false,
  });
  assert.equal(plan.kind, "symmetric");
  const manual = await createNecModel();
  try {
    const application = await applyArrayBuildPlan(manual, description, plan);
    assert.notDeepEqual(application.scatterCallerToNative,
      Array.from({ length: 16 }, (_, index) => index));
    manual.prepare({ frequencyMHz: fixture.frequencyMHz });
    const native = manual.computeImpedanceMatrix();
    const gathered = gatherComplexMatrix(native.impedance, application.scatterCallerToNative);
    const transparent = await createNecArraySolver(description, {
      symmetry: "require",
      symmetrizer: { positionEpsilonM: 0, allowRotation: false },
    });
    try {
      await transparent.prepare({ frequencyMHz: fixture.frequencyMHz });
      const transparentMatrices = await transparent.computeImpedanceMatrix();
      assertComplexClose(gathered, transparentMatrices.impedance, copyTolerance,
        "R2 manual versus transparent gathered Z");
    } finally {
      await transparent.dispose();
    }
  } finally {
    manual.dispose();
  }
});

test("WP-S6 R4, T1, T2, T3, and G1 cover two-section, rotational, and finite-ground modes", {
  skip: !hasWasm && "WASM artifacts have not been built",
  timeout: 180_000,
}, async () => {
  const r4 = gridDescription({ side: 4, rowPatterns: true });
  const r4Plan = analyzeArraySymmetry(r4.description, {
    positionEpsilonM: 0,
    allowRotation: false,
  });
  assert.equal(r4Plan.kind, "symmetric");
  assert.deepEqual(r4Plan.symmetry.planes, ["x=0"]);
  await compareRepresentationCase({
    name: "R4",
    ...r4,
    symmetrizer: { positionEpsilonM: 0, allowRotation: false },
    expectedSections: 2,
  });

  for (const order of [2, 4, 6]) {
    const ring = ringDescription({ order, ground: order === 6 ? { kind: "free-space" } : { kind: "perfect" } });
    await compareRepresentationCase({
      name: `T${order === 2 ? 1 : order === 4 ? 2 : 3}`,
      ...ring,
      symmetrizer: {
        positionEpsilonM: 1e-14,
        allowReflection: false,
        preferredRotationOrders: [order],
      },
      expectedSections: order,
    });
  }

  const g1 = gridDescription({
    side: 4,
    ground: {
      kind: "finite",
      method: "reflection-coefficient",
      relativePermittivity: 13,
      conductivitySPerM: 0.005,
    },
  });
  await compareRepresentationCase({
    name: "G1",
    ...g1,
    symmetrizer: { positionEpsilonM: 0, allowRotation: false },
    expectedSections: 4,
  });
});

test("WP-S6 five canonical beam cases match ports, complex fields, peaks, and embedded superposition", {
  skip: !hasWasm && "WASM artifacts have not been built",
  timeout: 180_000,
}, async () => {
  const { description, fixture } = gridDescription({ side: 4 });
  const { explicit, symmetric } = await createPair(
    description,
    fixture,
    { positionEpsilonM: 0, allowRotation: false },
  );
  const request = {
    radiusM: 2,
    theta: { startDeg: 10, count: 8, stepDeg: 10 },
    phi: { startDeg: 0, count: 8, stepDeg: 45 },
  };
  try {
    const [explicitEmbedded, symmetricEmbedded] = await Promise.all([
      explicit.computeEmbeddedFarFields(request, { kind: "unit-current", valueA: 1 }),
      symmetric.computeEmbeddedFarFields(request, { kind: "unit-current", valueA: 1 }),
    ]);
    assert.deepEqual(symmetricEmbedded.ports, explicitEmbedded.ports);
    assert.equal(symmetricEmbedded.samplesPerPort, explicitEmbedded.samplesPerPort);
    compareFields(symmetricEmbedded, explicitEmbedded, exactTolerance, "R2 embedded bases");

    const cases = [
      { name: "uniform", theta: 0, phi: 0, amplitude: () => 1, intended: undefined },
      { name: "+X", theta: 60, phi: 0, amplitude: () => 1, intended: [60, 0] },
      { name: "+Y", theta: 60, phi: 90, amplitude: () => 1, intended: [60, 90] },
      { name: "diagonal", theta: 50, phi: 45, amplitude: () => 1, intended: [50, 45] },
      {
        name: "asymmetric taper",
        theta: 50,
        phi: 45,
        amplitude: (index) => 0.55 + ((index * 7) % 16) / 30,
        intended: [50, 45],
      },
    ];
    for (const entry of cases) {
      const currents = steeringCurrents(fixture, entry.theta, entry.phi, entry.amplitude);
      const [explicitSolution, symmetricSolution] = await Promise.all([
        explicit.solveCurrents(currents),
        symmetric.solveCurrents(currents),
      ]);
      compareSolutions(symmetricSolution, explicitSolution, exactTolerance, `R2 ${entry.name}`);
      const [explicitField, symmetricField] = await Promise.all([
        explicit.computeFarField(request),
        symmetric.computeFarField(request),
      ]);
      compareFields(symmetricField, explicitField, exactTolerance, `R2 ${entry.name}`);

      const explicitMagnitude = totalFieldMagnitude(explicitField);
      const symmetricMagnitude = totalFieldMagnitude(symmetricField);
      assertRealClose(symmetricMagnitude, explicitMagnitude, exactTolerance,
        `R2 ${entry.name} total magnitude`);
      // Broadside has physically degenerate azimuth samples. Select the first
      // sample within a tight relative tie band so representation-level roundoff
      // cannot turn that degeneracy into a false direction mismatch.
      const explicitPeak = stablePeakIndex(explicitMagnitude);
      const symmetricPeak = stablePeakIndex(symmetricMagnitude);
      assert.equal(symmetricPeak, explicitPeak, `R2 ${entry.name} peak sample`);
      assert.ok(Math.abs(symmetricMagnitude[symmetricPeak] - explicitMagnitude[explicitPeak])
        <= exactTolerance * Math.max(1, explicitMagnitude[explicitPeak]));
      const explicitNormalized = Float64Array.from(explicitMagnitude,
        (value) => value / explicitMagnitude[explicitPeak]);
      const symmetricNormalized = Float64Array.from(symmetricMagnitude,
        (value) => value / symmetricMagnitude[symmetricPeak]);
      assertRealClose(symmetricNormalized, explicitNormalized, exactTolerance,
        `R2 ${entry.name} normalized cuts`);

      for (const [component, fieldReal, fieldImag] of [
        ["eTheta", explicitField.eThetaReal, explicitField.eThetaImag],
        ["ePhi", explicitField.ePhiReal, explicitField.ePhiImag],
      ]) {
        const explicitSuperposition = superposeEmbedded(explicitEmbedded, currents, component);
        const symmetricSuperposition = superposeEmbedded(symmetricEmbedded, currents, component);
        assertComplexClose(explicitSuperposition, { real: fieldReal, imag: fieldImag },
          exactTolerance, `R2 ${entry.name} explicit ${component} superposition`);
        assertComplexClose(symmetricSuperposition, { real: fieldReal, imag: fieldImag },
          exactTolerance, `R2 ${entry.name} symmetric ${component} superposition`);
      }

      if (entry.intended !== undefined) {
        const thetaIndex = [...explicitField.thetaDeg].indexOf(entry.intended[0]);
        const phiIndex = [...explicitField.phiDeg].indexOf(entry.intended[1]);
        assert.ok(thetaIndex >= 0 && phiIndex >= 0);
        const intendedIndex = phiIndex * explicitField.thetaDeg.length + thetaIndex;
        assertComplexClose(
          {
            real: Float64Array.of(symmetricField.eThetaReal[intendedIndex]),
            imag: Float64Array.of(symmetricField.eThetaImag[intendedIndex]),
          },
          {
            real: Float64Array.of(explicitField.eThetaReal[intendedIndex]),
            imag: Float64Array.of(explicitField.eThetaImag[intendedIndex]),
          },
          exactTolerance,
          `R2 ${entry.name} intended-sample phase`,
        );
        const azimuthMagnitudes = Float64Array.from(explicitField.phiDeg, (_, index) =>
          explicitMagnitude[index * explicitField.thetaDeg.length + thetaIndex]);
        const bestAzimuth = explicitField.phiDeg[maximumIndex(azimuthMagnitudes)];
        assert.ok(Math.abs(bestAzimuth - entry.intended[1]) <= 45,
          `R2 ${entry.name} baseline azimuth peak ${bestAzimuth}`);
      }
    }
  } finally {
    await Promise.all([explicit.dispose(), symmetric.dispose()]);
  }
});

test("WP-S6 a complete structural load orbit remains symmetry-equivalent", {
  skip: !hasWasm && "WASM artifacts have not been built",
  timeout: 180_000,
}, async () => {
  const loaded = gridDescription({ side: 2 });
  loaded.description.patterns[0].loads = [{
    kind: "impedance",
    target: { wireId: "radiator", firstSegment: 6, lastSegment: 6 },
    resistanceOhm: 12.5,
    reactanceOhm: -3.25,
  }];
  await compareRepresentationCase({
    name: "loaded R1",
    ...loaded,
    symmetrizer: { positionEpsilonM: 0, allowRotation: false },
    expectedSections: 4,
  });
});

async function compareExplicitFallback(name, value) {
  const [off, automatic] = await Promise.all([
    createNecArraySolver(value.description, { symmetry: "off" }),
    createNecArraySolver(value.description, {
      symmetry: "auto",
      symmetrizer: { positionEpsilonM: 0 },
    }),
  ]);
  try {
    await Promise.all([
      off.prepare({ frequencyMHz: value.fixture.frequencyMHz }),
      automatic.prepare({ frequencyMHz: value.fixture.frequencyMHz }),
    ]);
    assert.equal(off.getDiagnostics().representation, "explicit");
    assert.equal(automatic.getDiagnostics().representation, "explicit");
    const [offMatrix, automaticMatrix] = await Promise.all([
      off.computeImpedanceMatrix(),
      automatic.computeImpedanceMatrix(),
    ]);
    assertComplexClose(automaticMatrix.impedance, offMatrix.impedance, copyTolerance,
      `${name} fallback Z`);
    assert.equal(automaticMatrix.impedance.rows, value.description.elements.length);
    const currents = currentVector(value.description.elements.length, 0.19);
    const [offSolution, automaticSolution] = await Promise.all([
      off.solveCurrents(currents),
      automatic.solveCurrents(currents),
    ]);
    compareSolutions(automaticSolution, offSolution, copyTolerance, `${name} fallback solution`);
    const [offField, automaticField, offEmbedded, automaticEmbedded] = await Promise.all([
      off.computeFarField(smokeFieldRequest),
      automatic.computeFarField(smokeFieldRequest),
      off.computeEmbeddedFarFields(smokeFieldRequest, { kind: "unit-current", valueA: 1 }),
      automatic.computeEmbeddedFarFields(smokeFieldRequest, { kind: "unit-current", valueA: 1 }),
    ]);
    compareFields(automaticField, offField, copyTolerance, `${name} fallback field`);
    compareFields(automaticEmbedded, offEmbedded, copyTolerance, `${name} fallback embedded`);
    assert.equal(automaticSolution.ports.length, value.description.elements.length);
    assert.equal(automaticEmbedded.ports.length, value.description.elements.length);
    for (const result of [automaticMatrix, automaticSolution, automaticField, automaticEmbedded]) {
      assert.equal("generatedTag" in result, false);
      assert.equal("copyIndex" in result, false);
      assert.equal("symmetry" in result, false);
    }
  } finally {
    await Promise.all([off.dispose(), automatic.dispose()]);
  }
}

test("WP-S6 N1 and P1 fallbacks retain the unbranched caller contract", {
  skip: !hasWasm && "WASM artifacts have not been built",
  timeout: 180_000,
}, async () => {
  const n1 = gridDescription({ side: 3 });
  const n1Plan = analyzeArraySymmetry(n1.description, { positionEpsilonM: 0 });
  assert.equal(n1Plan.kind, "explicit");
  assert.ok(n1Plan.reasons.some((reason) => reason.code.startsWith("FIXED_ELEMENT")));

  const p1 = gridDescription({ side: 4, kind: "helix-pattern" });
  const p1Plan = analyzeArraySymmetry(p1.description, { positionEpsilonM: 0 });
  assert.equal(p1Plan.kind, "explicit");
  assert.equal(p1Plan.reasons[0].code, "UNSUPPORTED_ELEMENT_PATTERN_TRANSFORM");

  await compareExplicitFallback("N1", n1);
  await compareExplicitFallback("P1", p1);
});

test("WP-S6 O1 restores off-origin complex phase", {
  skip: !hasWasm && "WASM artifacts have not been built",
  timeout: 180_000,
}, async () => {
  const o1 = gridDescription({ side: 4, centerM: [0.173, -0.219] });
  await compareRepresentationCase({
    name: "O1",
    ...o1,
    symmetrizer: { positionEpsilonM: 1e-12, allowRotation: false },
    expectedSections: 4,
  });
});

test("WP-S6 E1 discloses canonicalization and stays within locked numerical bounds", {
  skip: !hasWasm && "WASM artifacts have not been built",
  timeout: 180_000,
}, async () => {
  const e1 = gridDescription({ side: 4 });
  const epsilon = 1e-10 * e1.fixture.wavelengthM;
  const jittered = structuredClone(e1.description);
  jittered.elements = jittered.elements.map((element, index) => ({
    ...element,
    positionM: [
      element.positionM[0] + (((index * 5) % 7) - 3) * epsilon / 12,
      element.positionM[1] + (((index * 3) % 5) - 2) * epsilon / 10,
    ],
  }));
  const plan = analyzeArraySymmetry(jittered, {
    positionEpsilonM: epsilon,
    allowRotation: false,
  });
  assert.equal(plan.kind, "symmetric");
  assert.equal(plan.diagnostics.exact, false);
  assert.equal(plan.diagnostics.canonicalizations.length, 16);
  assert.ok(plan.diagnostics.canonicalizations.every((entry) => entry.distanceM <= epsilon));
  assert.ok(plan.diagnostics.maxPositionAdjustmentM > 0);
  await compareRepresentationCase({
    name: "E1",
    description: jittered,
    fixture: e1.fixture,
    symmetrizer: { positionEpsilonM: epsilon, allowRotation: false },
    expectedSections: 4,
    tolerance: 1e-7,
  });
});

test("WP-S6 R3 8x8 gathered matrix tier", {
  skip: !hasWasm && "WASM artifacts have not been built",
  timeout: 600_000,
}, async () => {
  const r3 = gridDescription({ side: 8 });
  await compareRepresentationCase({
    name: "R3",
    ...r3,
    symmetrizer: { positionEpsilonM: 0, allowRotation: false },
    expectedSections: 4,
    checkField: false,
  });
});
