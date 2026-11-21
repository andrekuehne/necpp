import { inputError, requireRecord, validateComplexVector, validateFarFieldGrid } from "./model.js";
import { NEC_FIELD_IMPEDANCE_OHM, necWavenumberPerM } from "./nec-constants.js";
import { finitePair, validLattice } from "./periodic-lattice.js";
import { frame } from "./scan-element-pattern.js";
import type {
  ApproximateActiveImpedance,
  ComplexMatrix,
  ComplexVector,
  EmbeddedFieldNormalization,
  FarFieldResult,
  FloquetSide,
  PeriodicLattice,
  ScanElementPattern,
  ScanPhasesRad,
  WindowedArray,
  WindowedArrayCell,
  WindowedArrayFarFieldRequest,
  WindowedArrayOptions,
} from "./types.js";

/**
 * A windowed array of `pattern`'s cell: the cells `options.cells` driven with
 * `options.excitation` and the steering phases of `options.steering`, every
 * other cell of the infinite array present and terminated. Its far field is
 * the array factor times the scan element pattern.
 */
export function windowedArray(pattern: ScanElementPattern, options: WindowedArrayOptions): WindowedArray {
  const record = requireRecord(options, "options");
  if (typeof requireRecord(pattern, "pattern").evaluate !== "function") {
    inputError("pattern must be a scan element pattern", { name: "pattern" });
  }
  const lattice = validLattice(pattern.lattice, "pattern.lattice");
  const ports = pattern.portCount;
  const steering = requireRecord(record.steering, "options.steering");
  if (
    typeof steering.frequencyMHz !== "number"
    || !(Math.abs(steering.frequencyMHz - pattern.frequencyMHz) <= 1e-12 * pattern.frequencyMHz)
  ) {
    inputError("options.steering must be a scan result at the pattern's frequency", {
      name: "options.steering.frequencyMHz",
      value: steering.frequencyMHz,
    });
  }
  const scanPhasesRad = finitePair(steering.scanPhasesRad, "options.steering.scanPhasesRad");
  const usesVoltage = pattern.normalization.kind === "unit-voltage";
  // Under voltage drive I = Y V, under current drive V = Z I.
  const matrix = portMatrix(
    usesVoltage ? steering.admittance : steering.impedance,
    ports,
    usesVoltage ? "options.steering.admittance" : "options.steering.impedance",
  );
  const cells = validCells(record.cells);
  const count = cells.length * ports;
  const excitation = record.excitation === undefined
    ? { real: new Float64Array(count).fill(1), imag: new Float64Array(count) }
    : validateComplexVector(record.excitation, count, "options.excitation");

  const drive = { real: new Float64Array(count), imag: new Float64Array(count) };
  cells.forEach(([m, n], cell) => {
    const phase = m * scanPhasesRad[0] + n * scanPhasesRad[1];
    const [cos, sin] = [Math.cos(phase), Math.sin(phase)];
    for (let port = 0; port < ports; port += 1) {
      const index = cell * ports + port;
      drive.real[index] = excitation.real[index]! * cos - excitation.imag[index]! * sin;
      drive.imag[index] = excitation.real[index]! * sin + excitation.imag[index]! * cos;
    }
  });
  return new ComputedWindowedArray(
    pattern,
    lattice,
    cells,
    scanPhasesRad,
    Object.freeze(drive),
    steeringActiveImpedances(drive, matrix, cells.length, ports, usesVoltage),
  );
}

function portMatrix(value: unknown, ports: number, name: string): ComplexMatrix {
  const matrix = requireRecord(value, name) as unknown as ComplexMatrix;
  if (matrix.rows !== ports || matrix.columns !== ports) {
    inputError(`${name} must be ${ports} x ${ports}, one row per port of the pattern`, {
      name,
      value: [matrix.rows, matrix.columns],
    });
  }
  return matrix;
}

function validCells(value: unknown): readonly WindowedArrayCell[] {
  if (!Array.isArray(value) || value.length === 0) {
    inputError("options.cells must be a non-empty array of lattice indices [m, n]", { name: "options.cells" });
  }
  const seen = new Set<string>();
  return Object.freeze(value.map((entry: unknown, index) => {
    const name = `options.cells[${index}]`;
    const [m, n] = finitePair(entry, name);
    if (!Number.isSafeInteger(m) || !Number.isSafeInteger(n)) {
      inputError(`${name} must hold integer lattice indices`, { name, value: [m, n] });
    }
    const key = `${m},${n}`;
    if (seen.has(key)) {
      inputError(`${name} repeats the cell [${m}, ${n}]`, { name, value: [m, n] });
    }
    seen.add(key);
    return Object.freeze([m, n] as const);
  }));
}

/**
 * Each cell's ports under its own drive, as if the whole infinite array were
 * driven like it: the scan matrix `matrix` (Y under voltage drive, Z under
 * current drive) maps the drive to the response, and the active impedance
 * is V / I.
 */
function steeringActiveImpedances(
  drive: ComplexVector,
  matrix: ComplexMatrix,
  cells: number,
  ports: number,
  usesVoltage: boolean,
): ApproximateActiveImpedance {
  const real = new Float64Array(cells * ports);
  const imag = new Float64Array(cells * ports);
  for (let cell = 0; cell < cells; cell += 1) {
    for (let row = 0; row < ports; row += 1) {
      let responseReal = 0;
      let responseImag = 0;
      for (let column = 0; column < ports; column += 1) {
        const entry = row * ports + column;
        const index = cell * ports + column;
        responseReal += matrix.real[entry]! * drive.real[index]! - matrix.imag[entry]! * drive.imag[index]!;
        responseImag += matrix.real[entry]! * drive.imag[index]! + matrix.imag[entry]! * drive.real[index]!;
      }
      const index = cell * ports + row;
      const [voltage, current] = usesVoltage
        ? [[drive.real[index]!, drive.imag[index]!], [responseReal, responseImag]]
        : [[responseReal, responseImag], [drive.real[index]!, drive.imag[index]!]];
      const currentSquared = current[0]! ** 2 + current[1]! ** 2;
      real[index] = currentSquared === 0 ? Number.NaN : (voltage[0]! * current[0]! + voltage[1]! * current[1]!) / currentSquared;
      imag[index] = currentSquared === 0 ? Number.NaN : (voltage[1]! * current[0]! - voltage[0]! * current[1]!) / currentSquared;
    }
  }
  return Object.freeze({ real, imag, approximate: true as const });
}

class ComputedWindowedArray implements WindowedArray {
  readonly frequencyMHz: number;
  readonly normalization: EmbeddedFieldNormalization;
  readonly lattice: PeriodicLattice;
  readonly cells: readonly WindowedArrayCell[];
  readonly portCount: number;
  readonly scanPhasesRad: ScanPhasesRad;
  readonly drive: ComplexVector;
  readonly activeImpedances: ApproximateActiveImpedance;
  readonly #pattern: ScanElementPattern;

  constructor(
    pattern: ScanElementPattern,
    lattice: PeriodicLattice,
    cells: readonly WindowedArrayCell[],
    scanPhasesRad: ScanPhasesRad,
    drive: ComplexVector,
    activeImpedances: ApproximateActiveImpedance,
  ) {
    this.frequencyMHz = pattern.frequencyMHz;
    this.normalization = pattern.normalization;
    this.lattice = lattice;
    this.cells = cells;
    this.portCount = pattern.portCount;
    this.scanPhasesRad = scanPhasesRad;
    this.drive = drive;
    this.activeImpedances = activeImpedances;
    this.#pattern = pattern;
    Object.freeze(this);
  }

  computeFarField(request: WindowedArrayFarFieldRequest): FarFieldResult {
    const grid = validateFarFieldGrid(request);
    const pattern = this.#pattern;
    const ports = this.portCount;
    const k = necWavenumberPerM(this.frequencyMHz);
    const { a1M: a1, a2M: a2 } = this.lattice;
    const area = Math.abs(a1[0] * a2[1] - a1[1] * a2[0]);
    // R exp(j k R) E = j sqrt(eta A |cos theta|) (te phi-hat + tm theta-hat) / wavelength per unit drive.
    const fieldScale = Math.sqrt(NEC_FIELD_IMPEDANCE_OHM * area) * k / (2 * Math.PI);
    const positions = this.cells.map(([m, n]) => [m * a1[0] + n * a2[0], m * a1[1] + n * a2[1]] as const);
    const propagation = k * grid.radiusM;
    // j exp(-j k R) / R
    const carrier = [Math.sin(propagation) / grid.radiusM, Math.cos(propagation) / grid.radiusM] as const;

    const thetaDeg = Float64Array.from({ length: grid.thetaCount }, (_, i) => grid.thetaStartDeg + i * grid.thetaStepDeg);
    const phiDeg = Float64Array.from({ length: grid.phiCount }, (_, i) => grid.phiStartDeg + i * grid.phiStepDeg);
    const samples = grid.sampleCount;
    const eThetaReal = new Float64Array(samples);
    const eThetaImag = new Float64Array(samples);
    const ePhiReal = new Float64Array(samples);
    const ePhiImag = new Float64Array(samples);
    const factorReal = new Float64Array(ports);
    const factorImag = new Float64Array(ports);
    for (let phiIndex = 0; phiIndex < grid.phiCount; phiIndex += 1) {
      const phi = phiDeg[phiIndex]! * Math.PI / 180;
      const [cosPhi, sinPhi] = [Math.cos(phi), Math.sin(phi)];
      for (let thetaIndex = 0; thetaIndex < grid.thetaCount; thetaIndex += 1) {
        const theta = thetaDeg[thetaIndex]! * Math.PI / 180;
        const [cosTheta, sinTheta] = [Math.cos(theta), Math.sin(theta)];
        const side: FloquetSide = cosTheta >= 0 ? "above" : "below";
        if (!pattern.sides.includes(side)) continue;
        const u = sinTheta * cosPhi;
        const v = sinTheta * sinPhi;
        const requestedTheta = [cosTheta * cosPhi, cosTheta * sinPhi, -sinTheta] as const;
        const requestedPhi = [-sinPhi, cosPhi, 0] as const;
        const value = pattern.evaluate({ u, v }, side);
        const basis = frame(u, v, side);
        arrayFactor(this.drive, positions, ports, k * u, k * v, factorReal, factorImag);
        // sum over ports of AF_p (te_p phi-hat + tm_p theta-hat), projected on the requested frame.
        let thetaReal = 0;
        let thetaImag = 0;
        let phiReal = 0;
        let phiImag = 0;
        // The components of the te and tm directions along the requested theta-hat and phi-hat.
        const teTmOnTheta = [dot(basis.phi, requestedTheta), dot(basis.theta, requestedTheta)] as const;
        const teTmOnPhi = [dot(basis.phi, requestedPhi), dot(basis.theta, requestedPhi)] as const;
        for (let port = 0; port < ports; port += 1) {
          const fieldThetaReal = teTmOnTheta[0] * value.te.real[port]! + teTmOnTheta[1] * value.tm.real[port]!;
          const fieldThetaImag = teTmOnTheta[0] * value.te.imag[port]! + teTmOnTheta[1] * value.tm.imag[port]!;
          const fieldPhiReal = teTmOnPhi[0] * value.te.real[port]! + teTmOnPhi[1] * value.tm.real[port]!;
          const fieldPhiImag = teTmOnPhi[0] * value.te.imag[port]! + teTmOnPhi[1] * value.tm.imag[port]!;
          const [afReal, afImag] = [factorReal[port]!, factorImag[port]!];
          thetaReal += afReal * fieldThetaReal - afImag * fieldThetaImag;
          thetaImag += afReal * fieldThetaImag + afImag * fieldThetaReal;
          phiReal += afReal * fieldPhiReal - afImag * fieldPhiImag;
          phiImag += afReal * fieldPhiImag + afImag * fieldPhiReal;
        }
        const amplitude = fieldScale * Math.sqrt(Math.abs(cosTheta));
        const [prefactorReal, prefactorImag] = [amplitude * carrier[0], amplitude * carrier[1]];
        const sample = phiIndex * grid.thetaCount + thetaIndex;
        eThetaReal[sample] = prefactorReal * thetaReal - prefactorImag * thetaImag;
        eThetaImag[sample] = prefactorReal * thetaImag + prefactorImag * thetaReal;
        ePhiReal[sample] = prefactorReal * phiReal - prefactorImag * phiImag;
        ePhiImag[sample] = prefactorReal * phiImag + prefactorImag * phiReal;
      }
    }
    return Object.freeze({
      radiusM: grid.radiusM,
      frequencyMHz: this.frequencyMHz,
      thetaDeg,
      phiDeg,
      eThetaReal,
      eThetaImag,
      ePhiReal,
      ePhiImag,
    });
  }
}

/** Per port, the sum over cells of drive * exp(j (kx x + ky y)). */
function arrayFactor(
  drive: ComplexVector,
  positions: readonly (readonly [number, number])[],
  ports: number,
  kx: number,
  ky: number,
  real: Float64Array,
  imag: Float64Array,
): void {
  real.fill(0);
  imag.fill(0);
  positions.forEach(([x, y], cell) => {
    const phase = kx * x + ky * y;
    const [cos, sin] = [Math.cos(phase), Math.sin(phase)];
    for (let port = 0; port < ports; port += 1) {
      const index = cell * ports + port;
      real[port]! += drive.real[index]! * cos - drive.imag[index]! * sin;
      imag[port]! += drive.real[index]! * sin + drive.imag[index]! * cos;
    }
  });
}

function dot(left: readonly number[], right: readonly number[]): number {
  return left[0]! * right[0]! + left[1]! * right[1]! + left[2]! * right[2]!;
}
