export const CURRENT_QUADRATURE_FREQUENCY_MHZ = 300;
export const CURRENT_QUADRATURE_RADIUS_M = 0.001;
export const CURRENT_QUADRATURE_TURNSTILE_OFFSET_M = 0.001;

const dipoleSegments = 11;
const armSegments = 5;

export const currentQuadratureFieldGrid = Object.freeze({
  radiusM: 1,
  theta: Object.freeze({ startDeg: 0, count: 5, stepDeg: 45 }),
  phi: Object.freeze({ startDeg: 0, count: 3, stepDeg: 90 }),
});

export const currentQuadratureFixtures = Object.freeze({
  dipole: Object.freeze({
    id: "dipole",
    wires: Object.freeze([
      Object.freeze({
        tag: 1,
        segments: dipoleSegments,
        start: Object.freeze([0, 0, -0.25]),
        end: Object.freeze([0, 0, 0.25]),
        radiusM: CURRENT_QUADRATURE_RADIUS_M,
      }),
    ]),
    ports: Object.freeze([{ tag: 1, segment: 6, name: "feed" }]),
    groundConnection: "none",
    ground: Object.freeze({ kind: "free-space" }),
  }),
  "rooted-monopole": Object.freeze({
    id: "rooted-monopole",
    wires: Object.freeze([
      Object.freeze({
        tag: 1,
        segments: dipoleSegments,
        start: Object.freeze([0, 0, 0]),
        end: Object.freeze([0, 0, 0.25]),
        radiusM: CURRENT_QUADRATURE_RADIUS_M,
      }),
    ]),
    ports: Object.freeze([{ tag: 1, segment: 1, name: "base" }]),
    groundConnection: "interpolate",
    ground: Object.freeze({ kind: "perfect" }),
  }),
  "bent-multiwire": Object.freeze({
    id: "bent-multiwire",
    wires: Object.freeze([
      Object.freeze({
        tag: 1,
        segments: armSegments,
        start: Object.freeze([-0.25, 0, 0.25]),
        end: Object.freeze([0, 0, 0]),
        radiusM: CURRENT_QUADRATURE_RADIUS_M,
      }),
      Object.freeze({
        tag: 2,
        segments: armSegments,
        start: Object.freeze([0, 0, 0]),
        end: Object.freeze([0.25, 0, 0.25]),
        radiusM: CURRENT_QUADRATURE_RADIUS_M,
      }),
    ]),
    ports: Object.freeze([{ tag: 1, segment: armSegments, name: "junction" }]),
    groundConnection: "none",
    ground: Object.freeze({ kind: "free-space" }),
  }),
  "turnstile-insulated": Object.freeze({
    id: "turnstile-insulated",
    wires: Object.freeze([
      Object.freeze({
        tag: 1,
        segments: dipoleSegments,
        start: Object.freeze([-0.25, 0, CURRENT_QUADRATURE_TURNSTILE_OFFSET_M]),
        end: Object.freeze([0.25, 0, CURRENT_QUADRATURE_TURNSTILE_OFFSET_M]),
        radiusM: CURRENT_QUADRATURE_RADIUS_M,
      }),
      Object.freeze({
        tag: 2,
        segments: dipoleSegments,
        start: Object.freeze([0, -0.25, -CURRENT_QUADRATURE_TURNSTILE_OFFSET_M]),
        end: Object.freeze([0, 0.25, -CURRENT_QUADRATURE_TURNSTILE_OFFSET_M]),
        radiusM: CURRENT_QUADRATURE_RADIUS_M,
      }),
    ]),
    ports: Object.freeze([
      { tag: 1, segment: 6, name: "x-feed" },
      { tag: 2, segment: 6, name: "y-feed" },
    ]),
    groundConnection: "none",
    ground: Object.freeze({ kind: "free-space" }),
  }),
  "turnstile-connected": Object.freeze({
    id: "turnstile-connected",
    wires: Object.freeze([
      Object.freeze({
        tag: 1,
        segments: armSegments,
        start: Object.freeze([-0.25, 0, 0]),
        end: Object.freeze([0, 0, 0]),
        radiusM: CURRENT_QUADRATURE_RADIUS_M,
      }),
      Object.freeze({
        tag: 2,
        segments: armSegments,
        start: Object.freeze([0, 0, 0]),
        end: Object.freeze([0.25, 0, 0]),
        radiusM: CURRENT_QUADRATURE_RADIUS_M,
      }),
      Object.freeze({
        tag: 3,
        segments: armSegments,
        start: Object.freeze([0, -0.25, 0]),
        end: Object.freeze([0, 0, 0]),
        radiusM: CURRENT_QUADRATURE_RADIUS_M,
      }),
      Object.freeze({
        tag: 4,
        segments: armSegments,
        start: Object.freeze([0, 0, 0]),
        end: Object.freeze([0, 0.25, 0]),
        radiusM: CURRENT_QUADRATURE_RADIUS_M,
      }),
    ]),
    ports: Object.freeze([
      { tag: 1, segment: armSegments, name: "x-feed" },
      { tag: 3, segment: armSegments, name: "y-feed" },
    ]),
    groundConnection: "none",
    ground: Object.freeze({ kind: "free-space" }),
  }),
});

export async function applyCurrentQuadratureFixture(model, fixture) {
  for (const item of fixture.wires) {
    await Promise.resolve(model.addWire(item));
  }
  await Promise.resolve(model.completeGeometry({
    groundConnection: fixture.groundConnection,
  }));
  await Promise.resolve(model.definePorts(fixture.ports));
  await Promise.resolve(model.setGround(fixture.ground));
  await Promise.resolve(model.prepare({
    frequencyMHz: CURRENT_QUADRATURE_FREQUENCY_MHZ,
  }));
}

export function unitCurrentVector(portCount, drivenIndex = 0) {
  const real = new Float64Array(portCount);
  const imag = new Float64Array(portCount);
  real[drivenIndex] = 1;
  return { real, imag };
}
