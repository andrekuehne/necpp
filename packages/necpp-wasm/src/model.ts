import {
  NecConditioningError,
  NecGeometryError,
  NecInputError,
  NecPortError,
  NecRuntimeError,
  NecSolverError,
  NecStateError,
} from "./errors.js";
import { transitionModelState, type ModelOperation } from "./state-machine.js";
import type {
  ComplexMatrix,
  ComplexVector,
  CompleteGeometryOptions,
  EmbeddedFarFieldResult,
  EmbeddedFieldNormalization,
  FarFieldRequest,
  FarFieldResult,
  GeometryCompletionResult,
  GroundModel,
  ImpedanceResult,
  LoadDefinition,
  NecModel,
  NecModelState,
  PortDefinition,
  PortSolution,
  PrepareOptions,
  SegmentSelection,
  WireDefinition,
} from "./types.js";
import type { NecWasmModule } from "./wasm-internal.js";

const STATUS_OK = 0;
const STATUS_STATE = 1;
const STATUS_INPUT = 2;
const STATUS_GEOMETRY = 3;
const STATUS_PORT = 4;
const STATUS_CONDITIONING = 5;
const STATUS_SOLVER = 6;
const STATUS_RUNTIME = 7;

const INT32_MAX = 2_147_483_647;
const FLOAT64_BYTES = Float64Array.BYTES_PER_ELEMENT;
const INT32_BYTES = Int32Array.BYTES_PER_ELEMENT;

const BUFFER = {
  impedanceReal: 0,
  impedanceImag: 1,
  admittanceReal: 2,
  admittanceImag: 3,
  solutionRequestedReal: 4,
  solutionRequestedImag: 5,
  solutionVoltagesReal: 6,
  solutionVoltagesImag: 7,
  solutionCurrentsReal: 8,
  solutionCurrentsImag: 9,
  solutionActiveImpedancesReal: 10,
  solutionActiveImpedancesImag: 11,
  solutionPowersW: 12,
  farFieldThetaDeg: 13,
  farFieldPhiDeg: 14,
  farFieldEThetaReal: 15,
  farFieldEThetaImag: 16,
  farFieldEPhiReal: 17,
  farFieldEPhiImag: 18,
  embeddedThetaDeg: 19,
  embeddedPhiDeg: 20,
  embeddedEThetaReal: 21,
  embeddedEThetaImag: 22,
  embeddedEPhiReal: 23,
  embeddedEPhiImag: 24,
} as const;

const textDecoder = new TextDecoder();

function inputError(message: string, details?: Readonly<Record<string, unknown>>): never {
  throw new NecInputError(message, details === undefined ? {} : { details });
}

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    inputError(`${name} must be a finite number`, { name, value });
  }
  return value;
}

function positiveNumber(value: unknown, name: string): number {
  const number = finiteNumber(value, name);
  if (!(number > 0)) {
    inputError(`${name} must be greater than zero`, { name, value });
  }
  return number;
}

function integerInRange(
  value: unknown,
  name: string,
  minimum: number,
): number {
  if (
    typeof value !== "number"
    || !Number.isInteger(value)
    || value < minimum
    || value > INT32_MAX
  ) {
    inputError(
      `${name} must be an integer from ${minimum} through ${INT32_MAX}`,
      { name, value },
    );
  }
  return value;
}

function requireRecord(
  value: unknown,
  name: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null) {
    inputError(`${name} must be an object`, { name });
  }
  return value as Readonly<Record<string, unknown>>;
}

function validatePoint(value: unknown, name: string): readonly [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) {
    inputError(`${name} must contain exactly three coordinates`, { name });
  }
  return [
    finiteNumber(value[0], `${name}[0]`),
    finiteNumber(value[1], `${name}[1]`),
    finiteNumber(value[2], `${name}[2]`),
  ];
}

function isFloat64Array(value: unknown): value is Float64Array {
  return Object.prototype.toString.call(value) === "[object Float64Array]";
}

function validateComplexVector(
  vector: unknown,
  expectedLength: number,
  name: string,
): ComplexVector {
  const record = requireRecord(vector, name);
  const real = record.real;
  const imag = record.imag;
  if (!isFloat64Array(real) || !isFloat64Array(imag)) {
    inputError(`${name}.real and ${name}.imag must be Float64Array instances`);
  }
  if (real.length !== imag.length || real.length !== expectedLength) {
    inputError(`${name} must contain exactly one value per port`, {
      expectedLength,
      realLength: real.length,
      imagLength: imag.length,
    });
  }
  for (let index = 0; index < expectedLength; index += 1) {
    if (!Number.isFinite(real[index]) || !Number.isFinite(imag[index])) {
      inputError(`${name} values must be finite`, { index });
    }
  }
  return { real, imag };
}

interface ValidatedGrid {
  readonly radiusM: number;
  readonly thetaStartDeg: number;
  readonly thetaCount: number;
  readonly thetaStepDeg: number;
  readonly phiStartDeg: number;
  readonly phiCount: number;
  readonly phiStepDeg: number;
  readonly sampleCount: number;
}

function validateGrid(request: unknown, portCountForEmbedded = 1): ValidatedGrid {
  const record = requireRecord(request, "request");
  const theta = requireRecord(record.theta, "request.theta");
  const phi = requireRecord(record.phi, "request.phi");
  const radiusM = record.radiusM === undefined
    ? 1
    : positiveNumber(record.radiusM, "request.radiusM");
  const thetaStartDeg = finiteNumber(theta.startDeg, "request.theta.startDeg");
  const thetaCount = integerInRange(theta.count, "request.theta.count", 1);
  const thetaStepDeg = finiteNumber(theta.stepDeg, "request.theta.stepDeg");
  const phiStartDeg = finiteNumber(phi.startDeg, "request.phi.startDeg");
  const phiCount = integerInRange(phi.count, "request.phi.count", 1);
  const phiStepDeg = finiteNumber(phi.stepDeg, "request.phi.stepDeg");
  const thetaEnd = thetaStartDeg + (thetaCount - 1) * thetaStepDeg;
  const phiEnd = phiStartDeg + (phiCount - 1) * phiStepDeg;
  if (!Number.isFinite(thetaEnd) || !Number.isFinite(phiEnd)) {
    inputError("The requested angle sweep overflows");
  }
  const sampleCount = thetaCount * phiCount;
  if (
    !Number.isSafeInteger(sampleCount)
    || sampleCount > INT32_MAX
    || sampleCount * portCountForEmbedded > INT32_MAX
  ) {
    inputError("The requested far-field array is too large");
  }
  return {
    radiusM,
    thetaStartDeg,
    thetaCount,
    thetaStepDeg,
    phiStartDeg,
    phiCount,
    phiStepDeg,
    sampleCount,
  };
}

function validateTarget(target: unknown): {
  readonly tag: number;
  readonly firstSegment: number;
  readonly lastSegment: number;
} {
  const record = requireRecord(target, "load.target");
  const tag = integerInRange(record.tag, "load.target.tag", 0);
  if (record.firstSegment === undefined) {
    if (record.lastSegment !== undefined) {
      inputError("load.target.lastSegment requires firstSegment");
    }
    return { tag, firstSegment: 0, lastSegment: 0 };
  }
  const firstSegment = integerInRange(
    record.firstSegment,
    "load.target.firstSegment",
    1,
  );
  const lastSegment = record.lastSegment === undefined
    ? firstSegment
    : integerInRange(record.lastSegment, "load.target.lastSegment", 1);
  if (lastSegment < firstSegment) {
    inputError("load.target.lastSegment cannot precede firstSegment");
  }
  return { tag, firstSegment, lastSegment };
}

function snapshotPorts(ports: readonly PortDefinition[]): readonly PortDefinition[] {
  return Object.freeze(ports.map((port) => Object.freeze(
    port.name === undefined
      ? { tag: port.tag, segment: port.segment }
      : { tag: port.tag, segment: port.segment, name: port.name },
  )));
}

function nativeState(value: number): Exclude<NecModelState, "disposed"> {
  switch (value) {
  case 0:
    return "empty";
  case 1:
    return "geometry-building";
  case 2:
    return "geometry-complete";
  case 3:
    return "prepared";
  case 4:
    return "solved";
  default:
    throw new NecRuntimeError(`The native model returned invalid state ${value}`);
  }
}

export class WasmNecModel implements NecModel {
  #moduleStorage: NecWasmModule | undefined;
  #handle: number;
  #state: NecModelState = "empty";
  #ports: readonly PortDefinition[] = Object.freeze([]);

  constructor(module: NecWasmModule, handle: number) {
    this.#moduleStorage = module;
    this.#handle = handle;
    try {
      this.#state = nativeState(module._necpp_wasm_v1_model_state(handle));
    } catch (cause) {
      if (cause instanceof NecRuntimeError) {
        throw cause;
      }
      throw new NecRuntimeError("Failed to read the new native model state", {
        cause,
      });
    }
    if (this.#state !== "empty") {
      throw new NecRuntimeError(
        `A newly created native model started in unexpected state ${this.#state}`,
      );
    }
  }

  get state(): NecModelState {
    return this.#state;
  }

  get #module(): NecWasmModule {
    if (this.#moduleStorage === undefined) {
      throw new NecRuntimeError("The disposed model no longer has a WASM module");
    }
    return this.#moduleStorage;
  }

  #assertOperation(operation: ModelOperation): void {
    transitionModelState(this.#state, operation);
  }

  #syncState(): void {
    if (this.#handle === 0) {
      this.#state = "disposed";
      return;
    }
    this.#state = nativeState(
      this.#module._necpp_wasm_v1_model_state(this.#handle),
    );
  }

  #decodeBytes(pointer: number, length: number): string {
    if (
      !Number.isSafeInteger(pointer)
      || pointer < 0
      || !Number.isSafeInteger(length)
      || length < 0
      || pointer + length > this.#module.HEAPU8.length
    ) {
      throw new NecRuntimeError("The native module returned an invalid string buffer");
    }
    return textDecoder.decode(this.#module.HEAPU8.slice(pointer, pointer + length));
  }

  #decodeCString(pointer: number): string {
    if (
      !Number.isSafeInteger(pointer)
      || pointer <= 0
      || pointer >= this.#module.HEAPU8.length
    ) {
      return "";
    }
    const end = this.#module.HEAPU8.indexOf(0, pointer);
    if (end < 0) {
      throw new NecRuntimeError("The native module returned an unterminated string");
    }
    return this.#decodeBytes(pointer, end - pointer);
  }

  #lastError(): string {
    try {
      return this.#decodeCString(
        this.#module._necpp_wasm_v1_last_error(this.#handle),
      );
    } catch {
      return "";
    }
  }

  #statusError(status: number, operation: ModelOperation): never {
    const message = this.#lastError() || `${operation} failed with native status ${status}`;
    const details = { operation, nativeStatus: status };
    switch (status) {
    case STATUS_STATE:
      throw new NecStateError(operation, this.#state, message);
    case STATUS_INPUT:
      throw new NecInputError(message, { details });
    case STATUS_GEOMETRY:
      throw new NecGeometryError(message, { details });
    case STATUS_PORT:
      throw new NecPortError(message, { details });
    case STATUS_CONDITIONING:
      throw new NecConditioningError(message, { details });
    case STATUS_SOLVER:
      throw new NecSolverError(message, { details });
    case STATUS_RUNTIME:
      throw new NecRuntimeError(message, { details });
    default:
      throw new NecRuntimeError(
        `${operation} returned unknown native status ${status}`,
        { details },
      );
    }
  }

  #invokeStatus(operation: ModelOperation, call: () => number): void {
    let status: number;
    try {
      status = call();
      this.#syncState();
    } catch (cause) {
      try {
        this.#syncState();
      } catch {
        // Preserve the original boundary failure.
      }
      if (cause instanceof NecRuntimeError) {
        throw cause;
      }
      throw new NecRuntimeError(`${operation} failed at the WASM boundary`, {
        cause,
        details: { operation },
      });
    }
    if (status !== STATUS_OK) {
      this.#statusError(status, operation);
    }
  }

  #readResult<T>(operation: ModelOperation, read: () => T): T {
    try {
      return read();
    } catch (cause) {
      if (cause instanceof NecRuntimeError) {
        throw cause;
      }
      throw new NecRuntimeError(
        `${operation} returned an invalid native result`,
        { cause, details: { operation } },
      );
    }
  }

  #allocate(bytes: number): number {
    let pointer: number;
    try {
      pointer = this.#module._malloc(bytes);
    } catch (cause) {
      throw new NecRuntimeError("WASM memory allocation failed", { cause });
    }
    if (!Number.isSafeInteger(pointer) || pointer <= 0) {
      throw new NecRuntimeError("WASM memory allocation failed");
    }
    return pointer;
  }

  #free(pointer: number): void {
    if (pointer === 0) {
      return;
    }
    try {
      this.#module._free(pointer);
    } catch {
      // Emscripten free is not expected to throw; cleanup remains best-effort.
    }
  }

  #withInt32Pair(
    first: Int32Array,
    second: Int32Array,
    call: (firstPointer: number, secondPointer: number) => number,
  ): number {
    let firstPointer = 0;
    let secondPointer = 0;
    try {
      firstPointer = this.#allocate(first.byteLength);
      secondPointer = this.#allocate(second.byteLength);
      this.#module.HEAP32.set(first, firstPointer / INT32_BYTES);
      this.#module.HEAP32.set(second, secondPointer / INT32_BYTES);
      return call(firstPointer, secondPointer);
    } finally {
      this.#free(secondPointer);
      this.#free(firstPointer);
    }
  }

  #withFloat64Pair(
    first: Float64Array,
    second: Float64Array,
    call: (firstPointer: number, secondPointer: number) => number,
  ): number {
    let firstPointer = 0;
    let secondPointer = 0;
    try {
      firstPointer = this.#allocate(first.byteLength);
      secondPointer = this.#allocate(second.byteLength);
      this.#module.HEAPF64.set(first, firstPointer / FLOAT64_BYTES);
      this.#module.HEAPF64.set(second, secondPointer / FLOAT64_BYTES);
      return call(firstPointer, secondPointer);
    } finally {
      this.#free(secondPointer);
      this.#free(firstPointer);
    }
  }

  #copyBuffer(kind: number, expectedLength: number): Float64Array {
    try {
      const length = this.#module._necpp_wasm_v1_result_buffer_length(
        this.#handle,
        kind,
      );
      const pointer = this.#module._necpp_wasm_v1_result_buffer(this.#handle, kind);
      if (
        length !== expectedLength
        || !Number.isSafeInteger(pointer)
        || pointer < 0
        || pointer % FLOAT64_BYTES !== 0
        || (length > 0 && pointer === 0)
      ) {
        throw new NecRuntimeError(
          `Native result buffer ${kind} has invalid dimensions`,
          { details: { kind, expectedLength, actualLength: length, pointer } },
        );
      }
      const start = pointer / FLOAT64_BYTES;
      const end = start + length;
      if (start < 0 || end > this.#module.HEAPF64.length) {
        throw new NecRuntimeError(`Native result buffer ${kind} is out of bounds`);
      }
      return this.#module.HEAPF64.slice(start, end);
    } catch (cause) {
      if (cause instanceof NecRuntimeError) {
        throw cause;
      }
      throw new NecRuntimeError(`Failed to copy native result buffer ${kind}`, {
        cause,
        details: { kind },
      });
    }
  }

  #matrix(realKind: number, imagKind: number, order: number): ComplexMatrix {
    const length = order * order;
    return {
      rows: order,
      columns: order,
      order: "row-major",
      real: this.#copyBuffer(realKind, length),
      imag: this.#copyBuffer(imagKind, length),
    };
  }

  addWire(wire: WireDefinition): void {
    this.#assertOperation("addWire");
    const record = requireRecord(wire, "wire");
    const tag = integerInRange(record.tag, "wire.tag", 1);
    const segments = integerInRange(record.segments, "wire.segments", 1);
    const start = validatePoint(record.start, "wire.start");
    const end = validatePoint(record.end, "wire.end");
    if (start[0] === end[0] && start[1] === end[1] && start[2] === end[2]) {
      inputError("wire.start and wire.end must be distinct");
    }
    const radiusM = positiveNumber(record.radiusM, "wire.radiusM");
    this.#invokeStatus("addWire", () => this.#module._necpp_wasm_v1_add_wire(
      this.#handle,
      tag,
      segments,
      start[0],
      start[1],
      start[2],
      end[0],
      end[1],
      end[2],
      radiusM,
    ));
  }

  completeGeometry(
    options: CompleteGeometryOptions = {},
  ): GeometryCompletionResult {
    this.#assertOperation("completeGeometry");
    const record = requireRecord(options, "options");
    if (record.symmetry !== undefined) {
      throw new NecRuntimeError(
        "Symmetric geometry completion is reserved by the WP-S0 contract but is not implemented by this runtime yet",
        { details: { operation: "completeGeometry", symmetry: record.symmetry } },
      );
    }
    const connection = record.groundConnection ?? "none";
    const nativeConnection = connection === "none"
      ? 0
      : connection === "interpolate"
        ? 1
        : connection === "zero-current"
          ? 2
          : inputError("Unknown ground connection", { connection });
    this.#invokeStatus(
      "completeGeometry",
      () => this.#module._necpp_wasm_v1_complete_geometry(
        this.#handle,
        nativeConnection,
      ),
    );
    return Object.freeze({});
  }

  definePorts(ports: readonly PortDefinition[]): void {
    this.#assertOperation("definePorts");
    if (!Array.isArray(ports) || ports.length === 0) {
      throw new NecPortError("At least one port is required");
    }
    if (ports.length > INT32_MAX) {
      inputError("Too many ports");
    }
    const tags = new Int32Array(ports.length);
    const segments = new Int32Array(ports.length);
    const copies: PortDefinition[] = [];
    for (let index = 0; index < ports.length; index += 1) {
      const record = requireRecord(ports[index], `ports[${index}]`);
      const tag = integerInRange(record.tag, `ports[${index}].tag`, 1);
      const segment = integerInRange(
        record.segment,
        `ports[${index}].segment`,
        1,
      );
      if (record.name !== undefined && typeof record.name !== "string") {
        inputError(`ports[${index}].name must be a string`);
      }
      tags[index] = tag;
      segments[index] = segment;
      copies.push(record.name === undefined
        ? { tag, segment }
        : { tag, segment, name: record.name as string });
    }
    this.#invokeStatus("definePorts", () => this.#withInt32Pair(
      tags,
      segments,
      (tagsPointer, segmentsPointer) =>
        this.#module._necpp_wasm_v1_define_ports(
          this.#handle,
          tagsPointer,
          segmentsPointer,
          ports.length,
        ),
    ));
    this.#ports = snapshotPorts(copies);
  }

  addLoad(load: LoadDefinition): void {
    this.#assertOperation("addLoad");
    const record = requireRecord(load, "load");
    const target = validateTarget(record.target as SegmentSelection);
    let kind: number;
    let value1: number;
    let value2 = 0;
    let value3 = 0;
    switch (record.kind) {
    case "series-rlc":
    case "parallel-rlc": {
      if (
        record.perMeter !== undefined
        && record.perMeter !== true
        && record.perMeter !== false
      ) {
        inputError("load.perMeter must be boolean when supplied");
      }
      const distributed = record.perMeter === true;
      kind = record.kind === "series-rlc"
        ? (distributed ? 2 : 0)
        : (distributed ? 3 : 1);
      value1 = finiteNumber(record.resistanceOhm, "load.resistanceOhm");
      value2 = finiteNumber(record.inductanceH, "load.inductanceH");
      value3 = finiteNumber(record.capacitanceF, "load.capacitanceF");
      break;
    }
    case "impedance":
      kind = 4;
      value1 = finiteNumber(record.resistanceOhm, "load.resistanceOhm");
      value2 = finiteNumber(record.reactanceOhm, "load.reactanceOhm");
      break;
    case "conductivity":
      kind = 5;
      value1 = positiveNumber(
        record.conductivitySPerM,
        "load.conductivitySPerM",
      );
      break;
    default:
      return inputError("Unknown load kind", { kind: record.kind });
    }
    this.#invokeStatus("addLoad", () => this.#module._necpp_wasm_v1_add_load(
      this.#handle,
      kind,
      target.tag,
      target.firstSegment,
      target.lastSegment,
      value1,
      value2,
      value3,
    ));
  }

  clearLoads(): void {
    this.#assertOperation("clearLoads");
    this.#invokeStatus(
      "clearLoads",
      () => this.#module._necpp_wasm_v1_clear_loads(this.#handle),
    );
  }

  setGround(ground: GroundModel): void {
    this.#assertOperation("setGround");
    const record = requireRecord(ground, "ground");
    let kind: number;
    let relativePermittivity = 0;
    let conductivitySPerM = 0;
    switch (record.kind) {
    case "free-space":
      kind = 0;
      break;
    case "perfect":
      kind = 1;
      break;
    case "finite":
      kind = record.method === "reflection-coefficient"
        ? 2
        : record.method === "sommerfeld-norton"
          ? 3
          : inputError("Unknown finite-ground method", { method: record.method });
      relativePermittivity = positiveNumber(
        record.relativePermittivity,
        "ground.relativePermittivity",
      );
      conductivitySPerM = positiveNumber(
        record.conductivitySPerM,
        "ground.conductivitySPerM",
      );
      break;
    default:
      return inputError("Unknown ground kind", { kind: record.kind });
    }
    this.#invokeStatus("setGround", () => this.#module._necpp_wasm_v1_set_ground(
      this.#handle,
      kind,
      relativePermittivity,
      conductivitySPerM,
    ));
  }

  prepare(options: PrepareOptions): void {
    this.#assertOperation("prepare");
    const record = requireRecord(options, "options");
    const frequencyMHz = positiveNumber(
      record.frequencyMHz,
      "options.frequencyMHz",
    );
    this.#invokeStatus(
      "prepare",
      () => this.#module._necpp_wasm_v1_prepare(this.#handle, frequencyMHz),
    );
  }

  computeImpedanceMatrix(): ImpedanceResult {
    this.#assertOperation("computeImpedanceMatrix");
    this.#invokeStatus(
      "computeImpedanceMatrix",
      () => this.#module._necpp_wasm_v1_compute_impedance(this.#handle),
    );
    return this.#readResult("computeImpedanceMatrix", () => {
      const order = this.#module._necpp_wasm_v1_impedance_order(this.#handle);
      if (order !== this.#ports.length || !Number.isSafeInteger(order)) {
        throw new NecRuntimeError("The native impedance matrix has invalid order");
      }
      const conditionEstimate =
        this.#module._necpp_wasm_v1_impedance_condition_estimate(this.#handle);
      if (!Number.isFinite(conditionEstimate) || conditionEstimate < 0) {
        throw new NecRuntimeError("The native condition estimate is invalid");
      }
      return {
        impedance: this.#matrix(
          BUFFER.impedanceReal,
          BUFFER.impedanceImag,
          order,
        ),
        admittance: this.#matrix(
          BUFFER.admittanceReal,
          BUFFER.admittanceImag,
          order,
        ),
        conditionEstimate,
        frequencyMHz:
          this.#module._necpp_wasm_v1_impedance_frequency_mhz(this.#handle),
        factorizationGeneration:
          this.#module._necpp_wasm_v1_impedance_factorization_generation(
            this.#handle,
          ),
      };
    });
  }

  #solution(drive: "voltage" | "current"): PortSolution {
    const count = this.#module._necpp_wasm_v1_solution_count(this.#handle);
    const nativeDrive = this.#module._necpp_wasm_v1_solution_drive(this.#handle);
    if (
      count !== this.#ports.length
      || !Number.isSafeInteger(count)
      || nativeDrive !== (drive === "voltage" ? 0 : 1)
    ) {
      throw new NecRuntimeError("The native port solution has invalid metadata");
    }
    const complex = (realKind: number, imagKind: number): ComplexVector => ({
      real: this.#copyBuffer(realKind, count),
      imag: this.#copyBuffer(imagKind, count),
    });
    return {
      drive,
      frequencyMHz:
        this.#module._necpp_wasm_v1_solution_frequency_mhz(this.#handle),
      ports: snapshotPorts(this.#ports),
      requested: complex(
        BUFFER.solutionRequestedReal,
        BUFFER.solutionRequestedImag,
      ),
      voltages: complex(
        BUFFER.solutionVoltagesReal,
        BUFFER.solutionVoltagesImag,
      ),
      currents: complex(
        BUFFER.solutionCurrentsReal,
        BUFFER.solutionCurrentsImag,
      ),
      activeImpedances: complex(
        BUFFER.solutionActiveImpedancesReal,
        BUFFER.solutionActiveImpedancesImag,
      ),
      powersW: this.#copyBuffer(BUFFER.solutionPowersW, count),
      factorizationGeneration:
        this.#module._necpp_wasm_v1_solution_factorization_generation(
          this.#handle,
        ),
      solveGeneration:
        this.#module._necpp_wasm_v1_solution_generation(this.#handle),
    };
  }

  solveVoltages(voltages: ComplexVector): PortSolution {
    this.#assertOperation("solveVoltages");
    const vector = validateComplexVector(
      voltages,
      this.#ports.length,
      "voltages",
    );
    this.#invokeStatus("solveVoltages", () => this.#withFloat64Pair(
      vector.real,
      vector.imag,
      (realPointer, imagPointer) =>
        this.#module._necpp_wasm_v1_solve_voltages(
          this.#handle,
          realPointer,
          imagPointer,
          vector.real.length,
        ),
    ));
    return this.#readResult("solveVoltages", () => this.#solution("voltage"));
  }

  solveCurrents(currents: ComplexVector): PortSolution {
    this.#assertOperation("solveCurrents");
    const vector = validateComplexVector(
      currents,
      this.#ports.length,
      "currents",
    );
    this.#invokeStatus("solveCurrents", () => this.#withFloat64Pair(
      vector.real,
      vector.imag,
      (realPointer, imagPointer) =>
        this.#module._necpp_wasm_v1_solve_currents(
          this.#handle,
          realPointer,
          imagPointer,
          vector.real.length,
        ),
    ));
    return this.#readResult("solveCurrents", () => this.#solution("current"));
  }

  #farFieldResult(grid: ValidatedGrid): FarFieldResult {
    const thetaCount =
      this.#module._necpp_wasm_v1_far_field_theta_count(this.#handle);
    const phiCount =
      this.#module._necpp_wasm_v1_far_field_phi_count(this.#handle);
    if (
      thetaCount !== grid.thetaCount
      || phiCount !== grid.phiCount
      || thetaCount * phiCount !== grid.sampleCount
    ) {
      throw new NecRuntimeError("The native far-field result has invalid dimensions");
    }
    return {
      radiusM: this.#module._necpp_wasm_v1_far_field_radius_m(this.#handle),
      frequencyMHz:
        this.#module._necpp_wasm_v1_far_field_frequency_mhz(this.#handle),
      thetaDeg: this.#copyBuffer(BUFFER.farFieldThetaDeg, thetaCount),
      phiDeg: this.#copyBuffer(BUFFER.farFieldPhiDeg, phiCount),
      eThetaReal: this.#copyBuffer(
        BUFFER.farFieldEThetaReal,
        grid.sampleCount,
      ),
      eThetaImag: this.#copyBuffer(
        BUFFER.farFieldEThetaImag,
        grid.sampleCount,
      ),
      ePhiReal: this.#copyBuffer(BUFFER.farFieldEPhiReal, grid.sampleCount),
      ePhiImag: this.#copyBuffer(BUFFER.farFieldEPhiImag, grid.sampleCount),
    };
  }

  computeFarField(request: FarFieldRequest): FarFieldResult {
    this.#assertOperation("computeFarField");
    const grid = validateGrid(request);
    this.#invokeStatus(
      "computeFarField",
      () => this.#module._necpp_wasm_v1_compute_far_field(
        this.#handle,
        grid.radiusM,
        grid.thetaStartDeg,
        grid.thetaCount,
        grid.thetaStepDeg,
        grid.phiStartDeg,
        grid.phiCount,
        grid.phiStepDeg,
      ),
    );
    return this.#readResult(
      "computeFarField",
      () => this.#farFieldResult(grid),
    );
  }

  computeEmbeddedFarFields(
    request: FarFieldRequest,
    normalization: EmbeddedFieldNormalization = {
      kind: "unit-voltage",
      valueV: 1,
    },
  ): EmbeddedFarFieldResult {
    this.#assertOperation("computeEmbeddedFarFields");
    const grid = validateGrid(request, this.#ports.length);
    const record = requireRecord(normalization, "normalization");
    const nativeNormalization = record.kind === "unit-voltage"
      && record.valueV === 1
      ? 0
      : record.kind === "unit-current" && record.valueA === 1
        ? 1
        : inputError("normalization must request exactly one volt or one ampere");
    this.#invokeStatus(
      "computeEmbeddedFarFields",
      () => this.#module._necpp_wasm_v1_compute_embedded_far_fields(
        this.#handle,
        grid.radiusM,
        grid.thetaStartDeg,
        grid.thetaCount,
        grid.thetaStepDeg,
        grid.phiStartDeg,
        grid.phiCount,
        grid.phiStepDeg,
        nativeNormalization,
      ),
    );
    return this.#readResult("computeEmbeddedFarFields", () => {
      const thetaCount =
        this.#module._necpp_wasm_v1_embedded_theta_count(this.#handle);
      const phiCount =
        this.#module._necpp_wasm_v1_embedded_phi_count(this.#handle);
      const portCount =
        this.#module._necpp_wasm_v1_embedded_port_count(this.#handle);
      const samplesPerPort =
        this.#module._necpp_wasm_v1_embedded_samples_per_port(this.#handle);
      const returnedNormalization =
        this.#module._necpp_wasm_v1_embedded_normalization(this.#handle);
      if (
        thetaCount !== grid.thetaCount
        || phiCount !== grid.phiCount
        || portCount !== this.#ports.length
        || samplesPerPort !== grid.sampleCount
        || returnedNormalization !== nativeNormalization
      ) {
        throw new NecRuntimeError(
          "The native embedded far-field result has invalid metadata",
        );
      }
      const totalSamples = samplesPerPort * portCount;
      const resultNormalization: EmbeddedFieldNormalization =
        nativeNormalization === 0
          ? Object.freeze({ kind: "unit-voltage", valueV: 1 })
          : Object.freeze({ kind: "unit-current", valueA: 1 });
      return {
        radiusM: this.#module._necpp_wasm_v1_embedded_radius_m(this.#handle),
        frequencyMHz:
          this.#module._necpp_wasm_v1_embedded_frequency_mhz(this.#handle),
        thetaDeg: this.#copyBuffer(BUFFER.embeddedThetaDeg, thetaCount),
        phiDeg: this.#copyBuffer(BUFFER.embeddedPhiDeg, phiCount),
        eThetaReal: this.#copyBuffer(BUFFER.embeddedEThetaReal, totalSamples),
        eThetaImag: this.#copyBuffer(BUFFER.embeddedEThetaImag, totalSamples),
        ePhiReal: this.#copyBuffer(BUFFER.embeddedEPhiReal, totalSamples),
        ePhiImag: this.#copyBuffer(BUFFER.embeddedEPhiImag, totalSamples),
        ports: snapshotPorts(this.#ports),
        normalization: resultNormalization,
        samplesPerPort,
      };
    });
  }

  dispose(): void {
    if (this.#state === "disposed") {
      return;
    }
    const handle = this.#handle;
    const module = this.#moduleStorage;
    this.#handle = 0;
    this.#moduleStorage = undefined;
    this.#state = "disposed";
    this.#ports = Object.freeze([]);
    try {
      module?._necpp_wasm_v1_model_delete(handle);
    } catch {
      // The ABI promises contained, deterministic cleanup.
    }
  }
}

export function createModelFromModule(module: NecWasmModule): NecModel {
  let handle: number;
  try {
    handle = module._necpp_wasm_v1_model_create();
  } catch (cause) {
    throw new NecRuntimeError("Failed to create the native NEC model", { cause });
  }
  if (!Number.isSafeInteger(handle) || handle <= 0) {
    throw new NecRuntimeError("Failed to create the native NEC model");
  }
  try {
    return new WasmNecModel(module, handle);
  } catch (error) {
    try {
      module._necpp_wasm_v1_model_delete(handle);
    } catch {
      // Preserve the initialization error.
    }
    throw error;
  }
}
