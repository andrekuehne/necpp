import type { FarFieldRequest } from "./types.js";
import type { FarFieldEvaluationSnapshot } from "./model.js";

const PI = Math.PI;
const DEG_TO_RAD = PI / 180;
const TWO_PI = 2 * PI;
const IMPEDANCE = Math.sqrt((4 * PI * 1e-7) / 8.854e-12);
const FIELD_CONSTANT = -IMPEDANCE / (4 * PI);

export interface FarFieldTileRequest {
  readonly radiusM: number;
  readonly thetaStartDeg: number;
  readonly thetaCount: number;
  readonly thetaStepDeg: number;
  readonly phiStartDeg: number;
  readonly phiCount: number;
  readonly phiStepDeg: number;
  readonly start: number;
  readonly count: number;
  readonly jobGeneration: number;
  readonly solutionGeneration: number;
}

export interface FarFieldTileResult {
  readonly start: number;
  readonly count: number;
  readonly jobGeneration: number;
  readonly solutionGeneration: number;
  readonly computeMs: number;
  readonly eThetaReal: Float64Array;
  readonly eThetaImag: Float64Array;
  readonly ePhiReal: Float64Array;
  readonly ePhiImag: Float64Array;
}

const SNAPSHOT_ARRAYS = [
  "x", "y", "z", "cab", "sab", "salp", "segmentHalfLengths",
  "air", "aii", "bir", "bii", "cir", "cii",
] as const;

export function validateFarFieldSnapshot(
  snapshot: FarFieldEvaluationSnapshot,
): void {
  if (snapshot.schemaVersion !== 1) {
    throw new Error(`Unsupported far-field snapshot schema ${snapshot.schemaVersion}`);
  }
  if (snapshot.capability !== "supported") {
    throw new Error(`Far-field snapshot is not supported: ${snapshot.capability}`);
  }
  if (!Number.isSafeInteger(snapshot.modelGeneration)
      || !Number.isSafeInteger(snapshot.solutionGeneration)
      || snapshot.modelGeneration <= 0 || snapshot.solutionGeneration <= 0
      || !Number.isFinite(snapshot.frequencyMHz) || snapshot.frequencyMHz <= 0
      || !Number.isFinite(snapshot.wavelengthM) || snapshot.wavelengthM <= 0
      || !Number.isSafeInteger(snapshot.segmentCount) || snapshot.segmentCount <= 0) {
    throw new Error("Far-field snapshot metadata is invalid");
  }
  for (const name of SNAPSHOT_ARRAYS) {
    const values = snapshot[name];
    if (!(values instanceof Float64Array) || values.length !== snapshot.segmentCount) {
      throw new Error(`Far-field snapshot ${name} length is invalid`);
    }
    for (const value of values) {
      if (!Number.isFinite(value)) {
        throw new Error(`Far-field snapshot ${name} contains a nonfinite value`);
      }
    }
  }
}

export function tileRequest(
  request: FarFieldRequest,
  start: number,
  count: number,
  jobGeneration: number,
  solutionGeneration: number,
): FarFieldTileRequest {
  return {
    radiusM: request.radiusM ?? 1,
    thetaStartDeg: request.theta.startDeg,
    thetaCount: request.theta.count,
    thetaStepDeg: request.theta.stepDeg,
    phiStartDeg: request.phi.startDeg,
    phiCount: request.phi.count,
    phiStepDeg: request.phi.stepDeg,
    start,
    count,
    jobGeneration,
    solutionGeneration,
  };
}

function scaledComponent(
  real: number,
  imag: number,
  wavelengthM: number,
  radiusM: number,
): readonly [number, number] {
  let magnitude = Math.hypot(real, imag) * wavelengthM;
  let phaseDeg = Math.atan2(imag, real) / DEG_TO_RAD;
  if (radiusM >= 1e-20) {
    magnitude /= radiusM;
    const rangeWavelengths = radiusM / wavelengthM;
    phaseDeg += -360 * (rangeWavelengths - Math.floor(rangeWavelengths));
  }
  const phase = phaseDeg * DEG_TO_RAD;
  return [magnitude * Math.cos(phase), magnitude * Math.sin(phase)];
}

/** Exact-binary64 ordinary-wire/free-or-perfect-ground WP3 tile evaluator. */
export function evaluateFarFieldTile(
  snapshot: FarFieldEvaluationSnapshot,
  tile: FarFieldTileRequest,
): FarFieldTileResult {
  validateFarFieldSnapshot(snapshot);
  const total = tile.thetaCount * tile.phiCount;
  if (!Number.isSafeInteger(tile.start) || !Number.isSafeInteger(tile.count)
      || tile.start < 0 || tile.count <= 0 || tile.start + tile.count > total
      || tile.solutionGeneration !== snapshot.solutionGeneration
      || !Number.isFinite(tile.radiusM) || tile.radiusM <= 0) {
    throw new Error("Far-field tile metadata is invalid or stale");
  }
  const eThetaReal = new Float64Array(tile.count);
  const eThetaImag = new Float64Array(tile.count);
  const ePhiReal = new Float64Array(tile.count);
  const ePhiImag = new Float64Array(tile.count);
  const started = performance.now();

  for (let local = 0; local < tile.count; local += 1) {
    const sample = tile.start + local;
    const thetaIndex = sample % tile.thetaCount;
    const phiIndex = Math.floor(sample / tile.thetaCount);
    const thetaDeg = tile.thetaStartDeg + thetaIndex * tile.thetaStepDeg;
    if (snapshot.perfectGround && thetaDeg > 90.01) continue;
    const theta = thetaDeg * DEG_TO_RAD;
    const phi = (tile.phiStartDeg + phiIndex * tile.phiStepDeg) * DEG_TO_RAD;
    const sinTheta = Math.sin(theta);
    const cosTheta = Math.cos(theta);
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    const phx = -sinPhi;
    const phy = cosPhi;
    const thx = cosTheta * phy;
    const thy = -cosTheta * phx;
    const thz = -sinTheta;
    const rox = sinTheta * cosPhi;
    const roy = sinTheta * sinPhi;

    let firstXr = 0; let firstXi = 0;
    let firstYr = 0; let firstYi = 0;
    let firstZr = 0; let firstZi = 0;
    let finalXr = 0; let finalXi = 0;
    let finalYr = 0; let finalYi = 0;
    let finalZr = 0; let finalZi = 0;
    const images = snapshot.perfectGround ? 2 : 1;
    for (let image = 0; image < images; image += 1) {
      const roz = image === 0 ? cosTheta : -cosTheta;
      let xr = 0; let xi = 0;
      let yr = 0; let yi = 0;
      let zr = 0; let zi = 0;
      for (let index = 0; index < snapshot.segmentCount; index += 1) {
        const cab = snapshot.cab[index]!;
        const sab = snapshot.sab[index]!;
        const salp = snapshot.salp[index]!;
        const el = snapshot.segmentHalfLengths[index]!;
        const omega = -(rox * cab + roy * sab + roz * salp);
        const sill = omega * el;
        const top = el + sill;
        const bot = el - sill;
        const a = Math.abs(omega) >= 1e-7
          ? 2 * Math.sin(sill) / omega
          : (2 - omega * omega * el * el / 3) * el;
        const too = Math.abs(top) >= 1e-7
          ? Math.sin(top) / top : 1 - top * top / 6;
        const boo = Math.abs(bot) >= 1e-7
          ? Math.sin(bot) / bot : 1 - bot * bot / 6;
        const b = el * (boo - too);
        const c = el * (boo + too);
        const rr = a * snapshot.air[index]! + b * snapshot.bii[index]!
          + c * snapshot.cir[index]!;
        const ri = a * snapshot.aii[index]! - b * snapshot.bir[index]!
          + c * snapshot.cii[index]!;
        const argument = TWO_PI * (snapshot.x[index]! * rox
          + snapshot.y[index]! * roy + snapshot.z[index]! * roz);
        const sine = Math.sin(argument);
        const cosine = Math.cos(argument);
        const exaReal = cosine * rr - sine * ri;
        const exaImag = cosine * ri + sine * rr;
        xr += exaReal * cab;
        xi += exaImag * cab;
        yr += exaReal * sab;
        yi += exaImag * sab;
        zr += exaReal * salp;
        zi += exaImag * salp;
      }
      if (image === 0) {
        firstXr = xr; firstXi = xi;
        firstYr = yr; firstYi = yi;
        firstZr = zr; firstZi = zi;
        finalXr = xr; finalXi = xi;
        finalYr = yr; finalYi = yi;
        finalZr = zr; finalZi = zi;
      } else {
        finalXr = firstXr - xr; finalXi = firstXi - xi;
        finalYr = firstYr - yr; finalYi = firstYi - yi;
        finalZr = firstZr + zr; finalZi = firstZi + zi;
      }
    }
    const thetaRawReal = finalXr * thx + finalYr * thy + finalZr * thz;
    const thetaRawImag = finalXi * thx + finalYi * thy + finalZi * thz;
    const phiRawReal = finalXr * phx + finalYr * phy;
    const phiRawImag = finalXi * phx + finalYi * phy;
    const thetaScaled = scaledComponent(
      -thetaRawImag * FIELD_CONSTANT,
      thetaRawReal * FIELD_CONSTANT,
      snapshot.wavelengthM,
      tile.radiusM,
    );
    const phiScaled = scaledComponent(
      -phiRawImag * FIELD_CONSTANT,
      phiRawReal * FIELD_CONSTANT,
      snapshot.wavelengthM,
      tile.radiusM,
    );
    eThetaReal[local] = thetaScaled[0];
    eThetaImag[local] = thetaScaled[1];
    ePhiReal[local] = phiScaled[0];
    ePhiImag[local] = phiScaled[1];
  }
  return {
    start: tile.start,
    count: tile.count,
    jobGeneration: tile.jobGeneration,
    solutionGeneration: tile.solutionGeneration,
    computeMs: performance.now() - started,
    eThetaReal,
    eThetaImag,
    ePhiReal,
    ePhiImag,
  };
}
