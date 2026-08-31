import { createHash } from "node:crypto";

export const FAR_FIELD_FIXTURE_SCHEMA_VERSION = 1;
export const SPEED_OF_LIGHT_M_PER_S = 299_792_458;
export const DESIGN_FREQUENCY_HZ = 10e9;
export const DESIGN_FREQUENCY_MHZ = DESIGN_FREQUENCY_HZ / 1e6;
export const WAVELENGTH_M = SPEED_OF_LIGHT_M_PER_S / DESIGN_FREQUENCY_HZ;

export const PRIMARY_FIELD_GRID = Object.freeze({
  id: "primary-256-display",
  radiusM: 1,
  theta: Object.freeze({ startDeg: 0, count: 181, stepDeg: 0.5 }),
  phi: Object.freeze({ startDeg: 0, count: 360, stepDeg: 1 }),
});

export const STEERING_POINTS = Object.freeze([
  Object.freeze({ id: "broadside", u: 0, v: 0 }),
  Object.freeze({ id: "positive-u", u: 0.25, v: 0 }),
  Object.freeze({ id: "negative-u", u: -0.25, v: 0 }),
  Object.freeze({ id: "positive-v", u: 0, v: 0.25 }),
  Object.freeze({ id: "negative-v", u: 0, v: -0.25 }),
  Object.freeze({ id: "positive-diagonal", u: 0.25, v: 0.25 }),
  Object.freeze({ id: "negative-u-diagonal", u: -0.25, v: 0.25 }),
  Object.freeze({ id: "negative-v-diagonal", u: 0.25, v: -0.25 }),
  Object.freeze({ id: "negative-diagonal", u: -0.25, v: -0.25 }),
  Object.freeze({ id: "near-edge", u: 0.65, v: 0.35 }),
]);

function freezeDeep(value) {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const item of Object.values(value)) freezeDeep(item);
  return Object.freeze(value);
}

function sha256Float64Arrays(...arrays) {
  const hash = createHash("sha256");
  for (const array of arrays) {
    if (!(array instanceof Float64Array)) {
      throw new TypeError("checksum inputs must be Float64Array instances");
    }
    hash.update(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
  }
  return hash.digest("hex");
}

export function complexVectorChecksum(value) {
  if (!(value?.real instanceof Float64Array)
      || !(value?.imag instanceof Float64Array)
      || value.real.length !== value.imag.length) {
    throw new TypeError("complex checksum requires equal Float64Array components");
  }
  let sumReal = 0;
  let sumImag = 0;
  let normSquared = 0;
  for (let index = 0; index < value.real.length; index += 1) {
    sumReal += value.real[index];
    sumImag += value.imag[index];
    normSquared += value.real[index] ** 2 + value.imag[index] ** 2;
  }
  return freezeDeep({
    sha256: sha256Float64Arrays(value.real, value.imag),
    sumReal,
    sumImag,
    l2Norm: Math.sqrt(normSquared),
  });
}

export function farFieldChecksum(field) {
  return Object.freeze({
    sha256: sha256Float64Arrays(
      field.eThetaReal,
      field.eThetaImag,
      field.ePhiReal,
      field.ePhiImag,
    ),
    eTheta: complexVectorChecksum({
      real: field.eThetaReal,
      imag: field.eThetaImag,
    }),
    ePhi: complexVectorChecksum({
      real: field.ePhiReal,
      imag: field.ePhiImag,
    }),
  });
}

export function createFarFieldFixture() {
  const side = 8;
  const segments = 11;
  const spacingM = 0.5 * WAVELENGTH_M;
  const lengthM = 0.47 * WAVELENGTH_M;
  const radiusM = 0.001 * WAVELENGTH_M;
  const heightM = 0.25 * WAVELENGTH_M;
  const feedSegment = 6;
  const elements = [];
  const wires = [];
  const ports = [];

  for (let yIndex = 0; yIndex < side; yIndex += 1) {
    for (let xIndex = 0; xIndex < side; xIndex += 1) {
      const elementIndex = yIndex * side + xIndex;
      const tag = elementIndex + 1;
      const xM = (xIndex - 3.5) * spacingM;
      const yM = (yIndex - 3.5) * spacingM;
      elements.push({
        id: `element-${elementIndex}`,
        positionM: [xM, yM],
        patternId: "x-directed-dipole",
      });
      wires.push({
        tag,
        segments,
        start: [xM - lengthM / 2, yM, heightM],
        end: [xM + lengthM / 2, yM, heightM],
        radiusM,
      });
      ports.push({ tag, segment: feedSegment, name: `port-${elementIndex}` });
    }
  }

  const pattern = {
    id: "x-directed-dipole",
    kind: "straight-wire-pattern",
    wires: [{
      id: "radiator",
      segments,
      startM: [-lengthM / 2, 0, heightM],
      endM: [lengthM / 2, 0, heightM],
      radiusM,
    }],
    ports: [{ wireId: "radiator", segment: feedSegment, name: "feed" }],
  };

  return Object.freeze({
    schemaVersion: FAR_FIELD_FIXTURE_SCHEMA_VERSION,
    id: "pav-ng-8x8-x-dipole-v1",
    speedOfLightMPerS: SPEED_OF_LIGHT_M_PER_S,
    frequencyHz: DESIGN_FREQUENCY_HZ,
    frequencyMHz: DESIGN_FREQUENCY_MHZ,
    wavelengthM: WAVELENGTH_M,
    side,
    elementCount: side * side,
    segmentsPerElement: segments,
    segmentCount: side * side * segments,
    feedSegment,
    spacingM,
    lengthM,
    radiusM,
    heightM,
    groundConnection: "none",
    ground: { kind: "perfect" },
    elements,
    wires,
    ports,
    description: {
      elements,
      patterns: [pattern],
      groundConnection: "none",
      ground: { kind: "perfect" },
    },
  });
}

/** Mirror the consumer's frozen source-grid policy for an n1 x n2 display. */
export function sourceGridForDisplay(fixture, n1, n2, frequencyScale = 1) {
  const thetaSpanDeg = 90;
  const phiSpanDeg = 360;
  const coarsestStepDeg = 5;
  const phaseStepLimitRad = Math.PI / 4;
  const xValues = fixture.elements.map(({ positionM }) => positionM[0]);
  const yValues = fixture.elements.map(({ positionM }) => positionM[1]);
  const apertureLambda = Math.hypot(
    Math.max(...xValues) - Math.min(...xValues),
    Math.max(...yValues) - Math.min(...yValues),
  ) / fixture.wavelengthM + fixture.lengthM / fixture.wavelengthM;
  const kD = 2 * Math.PI * frequencyScale * Math.max(apertureLambda, 1e-12);
  const phaseMaxDeg = (phaseStepLimitRad / kD) * (180 / Math.PI);
  const displayThetaStep = thetaSpanDeg / Math.max(Math.round(n1) - 1, 1);
  const displayPhiStep = phiSpanDeg / Math.max(Math.round(n2), 1);
  const requestedStepDeg = Math.min(
    coarsestStepDeg,
    phaseMaxDeg,
    displayThetaStep,
    displayPhiStep,
  );
  let thetaCount = Math.floor(thetaSpanDeg / requestedStepDeg) + 1;
  let phiCount = Math.max(1, Math.round(phiSpanDeg / requestedStepDeg));
  thetaCount = Math.min(thetaCount, 181);
  phiCount = Math.min(phiCount, 360);

  return Object.freeze({
    id: `consumer-derived-${n1}x${n2}-display`,
    derivation: Object.freeze({
      display: Object.freeze({ n1, n2 }),
      apertureLambda,
      kD,
      requestedStepDeg,
    }),
    radiusM: 1,
    theta: Object.freeze({
      startDeg: 0,
      count: thetaCount,
      stepDeg: thetaSpanDeg / Math.max(thetaCount - 1, 1),
    }),
    phi: Object.freeze({
      startDeg: 0,
      count: phiCount,
      stepDeg: phiSpanDeg / phiCount,
    }),
  });
}

export function steeringCurrents(fixture, point) {
  if (!Number.isFinite(point?.u) || !Number.isFinite(point?.v)
      || point.u ** 2 + point.v ** 2 > 1) {
    throw new RangeError("steering point must be finite and inside the unit disk");
  }
  const real = new Float64Array(fixture.elementCount);
  const imag = new Float64Array(fixture.elementCount);
  for (let index = 0; index < fixture.elementCount; index += 1) {
    const [xM, yM] = fixture.elements[index].positionM;
    const phase = -2 * Math.PI
      * (point.u * xM + point.v * yM) / fixture.wavelengthM;
    real[index] = Math.cos(phase);
    imag[index] = Math.sin(phase);
  }
  return Object.freeze({ real, imag });
}

export function fixtureManifest() {
  const fixture = createFarFieldFixture();
  const secondary = sourceGridForDisplay(fixture, 32, 32);
  const steering = STEERING_POINTS.map((point) => {
    const requested = steeringCurrents(fixture, point);
    return Object.freeze({ ...point, requestedChecksum: complexVectorChecksum(requested) });
  });
  return Object.freeze({
    schemaVersion: FAR_FIELD_FIXTURE_SCHEMA_VERSION,
    fixtureId: fixture.id,
    geometry: Object.freeze({
      side: fixture.side,
      elements: fixture.elementCount,
      segmentsPerElement: fixture.segmentsPerElement,
      totalSegments: fixture.segmentCount,
      frequencyMHz: fixture.frequencyMHz,
      wavelengthM: fixture.wavelengthM,
      spacingM: fixture.spacingM,
      lengthM: fixture.lengthM,
      radiusM: fixture.radiusM,
      heightM: fixture.heightM,
      feedSegment: fixture.feedSegment,
      orientation: "x-directed",
      ground: "infinite-perfect",
      groundConnection: fixture.groundConnection,
    }),
    grids: Object.freeze({ primary: PRIMARY_FIELD_GRID, secondary }),
    steering: Object.freeze(steering),
  });
}
