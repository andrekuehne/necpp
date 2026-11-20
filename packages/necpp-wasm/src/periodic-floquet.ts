import { NecConditioningError } from "./errors.js";
import { inputError, nativeNormalization, requireRecord, type NativeFloquetRequest } from "./model.js";
import type {
  ComplexVector,
  FloquetModeIndex,
  ScanImpedanceResult,
  TerminatedFloquetAmplitudes,
  TerminatedFloquetMode,
  TerminatedFloquetOptions,
} from "./types.js";

const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;

function modeIndex(value: unknown, name: string): FloquetModeIndex {
  const record = requireRecord(value, name);
  const index = (key: "p" | "q"): number => {
    const entry = record[key];
    if (!Number.isInteger(entry) || (entry as number) < INT32_MIN || (entry as number) > INT32_MAX) {
      inputError(`${name}.${key} must be an integer`, { name: `${name}.${key}`, value: entry });
    }
    return entry as number;
  };
  return Object.freeze({ p: index("p"), q: index("q") });
}

/** @internal The Floquet options of a scan request, validated. */
export function validFloquetRequest(
  request: Readonly<Record<string, unknown>>,
  name: string,
): NativeFloquetRequest {
  const normalization = request.normalization === undefined
    ? 0
    : nativeNormalization(request.normalization, `${name}.normalization`);
  const modes = request.evanescentModes;
  if (modes !== undefined && !Array.isArray(modes)) {
    inputError(`${name}.evanescentModes must be an array of { p, q }`, { name: `${name}.evanescentModes` });
  }
  const evanescentModes = Object.freeze(((modes ?? []) as readonly unknown[]).map((mode, index) =>
    modeIndex(mode, `${name}.evanescentModes[${index}]`)));
  return { normalization, evanescentModes };
}

type Complex = [number, number];

const multiply = ([ar, ai]: Complex, [br, bi]: Complex): Complex => [ar * br - ai * bi, ar * bi + ai * br];
function divide([ar, ai]: Complex, [br, bi]: Complex): Complex {
  const scale = br * br + bi * bi;
  return [(ar * br + ai * bi) / scale, (ai * br - ar * bi) / scale];
}

/** A row-major complex matrix as rows of `[real, imag]`. */
type Matrix = Complex[][];

function matrixOf(values: ComplexVector, order: number): Matrix {
  return Array.from({ length: order }, (_, row) =>
    Array.from({ length: order }, (_, column): Complex =>
      [values.real[row * order + column]!, values.imag[row * order + column]!]));
}

function product(left: Matrix, right: Matrix): Matrix {
  return left.map((row) => right[0]!.map((_, column) => row.reduce<Complex>((sum, entry, inner) => {
    const term = multiply(entry, right[inner]![column]!);
    return [sum[0] + term[0], sum[1] + term[1]];
  }, [0, 0])));
}

/** The inverse of a small complex matrix, by Gauss-Jordan elimination with partial pivoting. */
function inverse(matrix: Matrix): Matrix {
  const order = matrix.length;
  const work = matrix.map((row, index) => [
    ...row.map((entry): Complex => [entry[0], entry[1]]),
    ...Array.from({ length: order }, (_, column): Complex => [column === index ? 1 : 0, 0]),
  ]);
  for (let column = 0; column < order; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < order; row += 1) {
      if (Math.hypot(...work[row]![column]!) > Math.hypot(...work[pivot]![column]!)) pivot = row;
    }
    if (Math.hypot(...work[pivot]![column]!) === 0) {
      throw new NecConditioningError("The terminated port matrix is singular");
    }
    [work[column], work[pivot]] = [work[pivot]!, work[column]!];
    const lead = work[column]!;
    const scale = lead[column]!;
    for (let entry = 0; entry < 2 * order; entry += 1) lead[entry] = divide(lead[entry]!, scale);
    for (let row = 0; row < order; row += 1) {
      if (row === column) continue;
      const factor = work[row]![column]!;
      for (let entry = 0; entry < 2 * order; entry += 1) {
        const term = multiply(factor, lead[entry]!);
        work[row]![entry] = [work[row]![entry]![0] - term[0], work[row]![entry]![1] - term[1]];
      }
    }
  }
  return work.map((row) => row.slice(order));
}

function generatorImpedance(value: unknown): Complex {
  const impedance: unknown[] = typeof value === "number" ? [value, 0] : Array.isArray(value) ? value : [];
  const [resistance, reactance] = impedance;
  if (
    impedance.length !== 2
    || typeof resistance !== "number"
    || typeof reactance !== "number"
    || !Number.isFinite(resistance)
    || !Number.isFinite(reactance)
    || resistance <= 0
  ) {
    inputError(
      "options.generatorImpedanceOhm must be a resistance greater than zero or [resistance, reactance]",
      { name: "options.generatorImpedanceOhm", value },
    );
  }
  return [resistance as number, reactance as number];
}

/**
 * Floquet amplitudes with every port of the cell terminated in the same
 * generator impedance `Zg` and one port driven by a generator of 1 W
 * available power (EMF `sqrt(8 Re Zg)`), derived from a scan result without
 * a new solve. Column `d` of each amplitude vector is the drive of port `d`:
 * with `A` the amplitudes per unit port current, the port currents are
 * `(Z + Zg)^-1 sqrt(8 Re Zg)`, so the terminated amplitudes are
 * `A (Z + Zg)^-1 sqrt(8 Re Zg)`; voltage-normalized amplitudes enter as
 * `A_I = A_V Z`.
 */
export function terminatedFloquetAmplitudes(
  result: ScanImpedanceResult,
  options: TerminatedFloquetOptions,
): TerminatedFloquetAmplitudes {
  const generator = generatorImpedance(requireRecord(options, "options").generatorImpedanceOhm);
  const { impedance, floquet } = result;
  const order = impedance.rows;
  const z = matrixOf(impedance, order);
  const terminated = z.map((row, index) => row.map((entry, column): Complex =>
    column === index ? [entry[0] + generator[0], entry[1] + generator[1]] : entry));
  const emf = Math.sqrt(8 * generator[0]);
  // Port currents per driven port, then the amplitudes per unit current.
  const currents = inverse(terminated).map((row) => row.map(([real, imag]): Complex => [real * emf, imag * emf]));
  const drive = floquet.normalization.kind === "unit-current" ? currents : product(z, currents);
  const modes = floquet.modes.map((mode): TerminatedFloquetMode => {
    const amplitudes = (vector: ComplexVector): ComplexVector => {
      const row: Matrix = [Array.from({ length: order }, (_, port): Complex => [vector.real[port]!, vector.imag[port]!])];
      const [values] = product(row, drive);
      return Object.freeze({
        real: Float64Array.from(values!, (value) => value[0]),
        imag: Float64Array.from(values!, (value) => value[1]),
      });
    };
    const te = amplitudes(mode.te);
    const tm = amplitudes(mode.tm);
    const powerW = new Float64Array(order);
    if (mode.propagating) {
      for (let port = 0; port < order; port += 1) {
        powerW[port] = (te.real[port]! ** 2 + te.imag[port]! ** 2 + tm.real[port]! ** 2 + tm.imag[port]! ** 2) / 2;
      }
    }
    return Object.freeze({
      p: mode.p,
      q: mode.q,
      side: mode.side,
      propagating: mode.propagating,
      ktRadPerM: mode.ktRadPerM,
      kzRadPerM: mode.kzRadPerM,
      te,
      tm,
      powerW,
    });
  });
  return Object.freeze({
    generatorImpedanceOhm: Object.freeze([generator[0], generator[1]] as const),
    modes: Object.freeze(modes),
  });
}
