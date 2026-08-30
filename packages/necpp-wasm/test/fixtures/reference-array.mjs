/**
 * Shared executable fixture for symmetry correctness tests and array
 * benchmarks. Coordinates follow docs/01_symmetry_support.md section 7.
 */

const NEC_VACUUM_PERMITTIVITY_F_PER_M = 8.854e-12;
const NEC_VACUUM_PERMEABILITY_H_PER_M = 4 * Math.PI * 1e-7;

export const NEC_ENGINE_SPEED_OF_LIGHT_M_PER_S = 1 / Math.sqrt(
  NEC_VACUUM_PERMITTIVITY_F_PER_M * NEC_VACUUM_PERMEABILITY_H_PER_M,
);

export const XY_REFLECTION_COPY_SIGNS = Object.freeze([
  Object.freeze([1, 1, 1]),
  Object.freeze([1, -1, 1]),
  Object.freeze([-1, 1, 1]),
  Object.freeze([-1, -1, 1]),
]);

function requirePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function requirePositiveNumber(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
}

function requireCenter(centerM) {
  if (
    !Array.isArray(centerM)
    || centerM.length !== 2
    || !centerM.every(Number.isFinite)
  ) {
    throw new Error("centerM must contain two finite coordinates");
  }
}

function wireAt(tag, segments, xM, yM, lowerZM, upperZM, radiusM) {
  return {
    tag,
    segments,
    start: [xM, yM, lowerZM],
    end: [xM, yM, upperZM],
    radiusM,
  };
}

function createXyReflectionFixture({
  side,
  segments,
  wavelengthM,
  lowerZM,
  upperZM,
  radiusM,
}) {
  if (side % 2 !== 0) {
    return undefined;
  }

  const half = side / 2;
  const fundamentalElementCount = half * half;
  const fundamentalWires = [];
  const fundamentalGridIndices = [];
  for (let yIndex = half; yIndex < side; yIndex += 1) {
    for (let xIndex = half; xIndex < side; xIndex += 1) {
      const fundamentalElementIndex = fundamentalWires.length;
      const xQuarterWavelengths = 2 * xIndex - (side - 1);
      const yQuarterWavelengths = 2 * yIndex - (side - 1);
      fundamentalGridIndices.push({
        fundamentalElementIndex,
        xIndex,
        yIndex,
        xQuarterWavelengths,
        yQuarterWavelengths,
      });
      fundamentalWires.push(wireAt(
        fundamentalElementIndex + 1,
        segments,
        xQuarterWavelengths * wavelengthM / 4,
        yQuarterWavelengths * wavelengthM / 4,
        lowerZM,
        upperZM,
        radiusM,
      ));
    }
  }

  const scatterCallerToGenerated = new Array(side * side);
  const gatherGeneratedToCaller = new Array(side * side);
  const generatedTagsByCaller = new Array(side * side);
  const mappingsByCaller = new Array(side * side);
  const copies = XY_REFLECTION_COPY_SIGNS.map((signs, copyIndex) => ({
    index: copyIndex,
    tagOffset: copyIndex * fundamentalElementCount,
    transform: { kind: "cartesian-signs", signs },
  }));

  for (const copy of copies) {
    const [signX, signY] = copy.transform.signs;
    for (const fundamental of fundamentalGridIndices) {
      const xNumerator = signX * fundamental.xQuarterWavelengths;
      const yNumerator = signY * fundamental.yQuarterWavelengths;
      const xIndex = (xNumerator + side - 1) / 2;
      const yIndex = (yNumerator + side - 1) / 2;
      const callerElementIndex = yIndex * side + xIndex;
      const generatedIndex = copy.index * fundamentalElementCount
        + fundamental.fundamentalElementIndex;
      const generatedTag = fundamental.fundamentalElementIndex + 1
        + copy.tagOffset;
      scatterCallerToGenerated[callerElementIndex] = generatedIndex;
      gatherGeneratedToCaller[generatedIndex] = callerElementIndex;
      generatedTagsByCaller[callerElementIndex] = generatedTag;
      mappingsByCaller[callerElementIndex] = {
        callerElementIndex,
        fundamentalElementIndex: fundamental.fundamentalElementIndex,
        copyIndex: copy.index,
        generatedTag,
        generatedPortIndices: [generatedIndex],
      };
    }
  }

  return {
    symmetry: {
      kind: "reflection",
      planes: ["x=0", "y=0"],
      tagIncrement: fundamentalElementCount,
    },
    sectionCount: copies.length,
    fundamentalWires,
    fundamentalPorts: fundamentalWires.map(({ tag }) => ({
      tag,
      segment: (segments + 1) / 2,
    })),
    copies,
    scatterCallerToGenerated,
    gatherGeneratedToCaller,
    generatedTagsByCaller,
    mappingsByCaller,
  };
}

export function createReferenceArrayFixture({
  side = 4,
  segments = 11,
  frequencyMHz = 300,
  centerM = [0, 0],
} = {}) {
  requirePositiveInteger(side, "side");
  requirePositiveInteger(segments, "segments");
  if (segments % 2 === 0) {
    throw new Error("segments must be odd so the feed segment is centered");
  }
  requirePositiveNumber(frequencyMHz, "frequencyMHz");
  requireCenter(centerM);

  const wavelengthM = NEC_ENGINE_SPEED_OF_LIGHT_M_PER_S
    / (frequencyMHz * 1e6);
  const spacingM = wavelengthM / 2;
  const lowerZM = wavelengthM / 12;
  const upperZM = 5 * wavelengthM / 12;
  const radiusM = wavelengthM / 1000;
  const feedSegment = (segments + 1) / 2;
  const wires = [];
  for (let yIndex = 0; yIndex < side; yIndex += 1) {
    for (let xIndex = 0; xIndex < side; xIndex += 1) {
      const tag = yIndex * side + xIndex + 1;
      const xM = centerM[0] + (xIndex - (side - 1) / 2) * spacingM;
      const yM = centerM[1] + (yIndex - (side - 1) / 2) * spacingM;
      wires.push(wireAt(
        tag,
        segments,
        xM,
        yM,
        lowerZM,
        upperZM,
        radiusM,
      ));
    }
  }

  return {
    speedOfLightMPerS: NEC_ENGINE_SPEED_OF_LIGHT_M_PER_S,
    frequencyMHz,
    wavelengthM,
    side,
    centerM: [...centerM],
    segments,
    feedSegment,
    spacingM,
    lowerZM,
    upperZM,
    radiusM,
    wires,
    ports: wires.map(({ tag }) => ({ tag, segment: feedSegment })),
    groundConnection: "none",
    ground: { kind: "perfect" },
    equations: side * side * segments,
    reflection: createXyReflectionFixture({
      side,
      segments,
      wavelengthM,
      lowerZM,
      upperZM,
      radiusM,
    }),
  };
}
