import {
  NecConditioningError,
  NecError,
  NecGeometryError,
  NecInputError,
  NecPortError,
  NecRuntimeError,
  NecSolverError,
  NecStateError,
  type NecErrorCode,
  type NecErrorOptions,
} from "./errors.js";
import type {
  CreateNecModelOptions,
  CreateNecWorkerModelOptions,
  EmbeddedFarFieldResult,
  FarFieldResult,
  GeometryCompletionResult,
  ImpedanceResult,
  NecModelState,
  NecWorkerOperation,
  PortDefinition,
  PortSolution,
} from "./types.js";

export function isNodeRuntime(): boolean {
  const runtime = globalThis as typeof globalThis & {
    process?: { versions?: { node?: string } };
    window?: unknown;
  };
  return typeof runtime.process === "object"
    && runtime.process !== null
    && typeof runtime.process.versions === "object"
    && runtime.process.versions !== null
    && typeof runtime.process.versions.node === "string"
    && typeof runtime.window === "undefined";
}

export type WorkerMethod = Exclude<NecWorkerOperation, "create">;

export interface SerializedCreateOptions {
  readonly wasmUrl?: string;
  readonly wasmBinary?: ArrayBuffer;
}

export type WorkerRequest =
  | {
    readonly id: number;
    readonly kind: "create";
    readonly options?: SerializedCreateOptions;
  }
  | {
    readonly id: number;
    readonly kind: "invoke";
    readonly method: WorkerMethod;
    readonly args: readonly unknown[];
  };

export interface SerializedNecError {
  readonly name: string;
  readonly code: NecErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly operation?: string;
  readonly state?: NecModelState;
}

export type WorkerProgressMessage = {
  readonly kind: "progress";
  readonly operation: NecWorkerOperation;
  readonly phase: "start" | "complete";
};

export type WorkerResponse =
  | {
    readonly id: number;
    readonly kind: "ok";
    readonly state: NecModelState;
    readonly result?: unknown;
    readonly transferredBufferCount: number;
  }
  | {
    readonly id: number;
    readonly kind: "error";
    readonly state?: NecModelState;
    readonly error: SerializedNecError;
  }
  | {
    readonly kind: "crash";
    readonly error: SerializedNecError;
  }
  | WorkerProgressMessage;

export function isWorkerResponse(value: unknown): value is WorkerResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const kind = (value as { kind?: unknown }).kind;
  return kind === "ok"
    || kind === "error"
    || kind === "crash"
    || kind === "progress";
}

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return Object.prototype.toString.call(value) === "[object ArrayBuffer]";
}

function visitTransferables(value: unknown, buffers: Set<ArrayBuffer>): void {
  if (value === null || value === undefined) {
    return;
  }
  if (isArrayBuffer(value)) {
    if (value.byteLength > 0) {
      buffers.add(value);
    }
    return;
  }
  if (ArrayBuffer.isView(value)) {
    const buffer = value.buffer;
    if (isArrayBuffer(buffer) && buffer.byteLength > 0) {
      buffers.add(buffer);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      visitTransferables(item, buffers);
    }
    return;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) {
      visitTransferables(item, buffers);
    }
  }
}

/** Collect unique, non-empty ArrayBuffers owned by a structured-cloneable result. */
export function collectTransferables(value: unknown): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  visitTransferables(value, buffers);
  return [...buffers];
}

function errorOptions(
  details: Readonly<Record<string, unknown>> | undefined,
): NecErrorOptions {
  return details === undefined ? {} : { details };
}

export function serializeError(error: unknown): SerializedNecError {
  if (error instanceof NecStateError) {
    const serialized: SerializedNecError = {
      name: error.name,
      code: error.code,
      message: error.message,
      operation: error.operation,
      state: error.state,
    };
    return error.details === undefined
      ? serialized
      : { ...serialized, details: error.details };
  }
  if (error instanceof NecError) {
    const serialized: SerializedNecError = {
      name: error.name,
      code: error.code,
      message: error.message,
    };
    return error.details === undefined
      ? serialized
      : { ...serialized, details: error.details };
  }
  if (error instanceof Error) {
    return {
      name: "NecRuntimeError",
      code: "NEC_RUNTIME",
      message: error.message,
    };
  }
  return {
    name: "NecRuntimeError",
    code: "NEC_RUNTIME",
    message: String(error),
  };
}

export function reviveError(serialized: SerializedNecError): NecError {
  switch (serialized.code) {
  case "NEC_STATE":
    return new NecStateError(
      serialized.operation ?? "unknown",
      serialized.state ?? "disposed",
      serialized.message,
    );
  case "NEC_INPUT":
    return new NecInputError(serialized.message, errorOptions(serialized.details));
  case "NEC_GEOMETRY":
    return new NecGeometryError(
      serialized.message,
      errorOptions(serialized.details),
    );
  case "NEC_PORT":
    return new NecPortError(serialized.message, errorOptions(serialized.details));
  case "NEC_CONDITIONING":
    return new NecConditioningError(
      serialized.message,
      errorOptions(serialized.details),
    );
  case "NEC_SOLVER":
    return new NecSolverError(serialized.message, errorOptions(serialized.details));
  default:
    return new NecRuntimeError(
      serialized.message,
      errorOptions(serialized.details),
    );
  }
}

export function snapshotPorts(
  ports: readonly PortDefinition[],
): readonly PortDefinition[] {
  return Object.freeze(ports.map((port) => Object.freeze(
    port.name === undefined
      ? { tag: port.tag, segment: port.segment }
      : { tag: port.tag, segment: port.segment, name: port.name },
  )));
}

function safeNonnegativeInteger(value: unknown, name: string): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 0
  ) {
    throw new NecRuntimeError(`Worker result ${name} is not a safe integer`);
  }
  return value;
}

/** Validate, copy, and deeply freeze structured-cloned completion metadata. */
export function reviveGeometryCompletionResult(
  value: unknown,
): GeometryCompletionResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new NecRuntimeError("Worker geometry completion result is not an object");
  }
  const record = value as { readonly symmetry?: unknown };
  if (record.symmetry === undefined) {
    return Object.freeze({});
  }
  if (
    typeof record.symmetry !== "object"
    || record.symmetry === null
    || Array.isArray(record.symmetry)
  ) {
    throw new NecRuntimeError("Worker symmetry metadata is not an object");
  }
  const symmetry = record.symmetry as {
    readonly kind?: unknown;
    readonly sectionCount?: unknown;
    readonly fundamentalSegmentCount?: unknown;
    readonly fullSegmentCount?: unknown;
    readonly copies?: unknown;
  };
  if (symmetry.kind !== "reflection" && symmetry.kind !== "rotational") {
    throw new NecRuntimeError("Worker symmetry metadata has an unknown kind");
  }
  const sectionCount = safeNonnegativeInteger(
    symmetry.sectionCount,
    "symmetry.sectionCount",
  );
  const fundamentalSegmentCount = safeNonnegativeInteger(
    symmetry.fundamentalSegmentCount,
    "symmetry.fundamentalSegmentCount",
  );
  const fullSegmentCount = safeNonnegativeInteger(
    symmetry.fullSegmentCount,
    "symmetry.fullSegmentCount",
  );
  if (
    sectionCount < 2
    || BigInt(fullSegmentCount)
      !== BigInt(fundamentalSegmentCount) * BigInt(sectionCount)
    || !Array.isArray(symmetry.copies)
    || symmetry.copies.length !== sectionCount
  ) {
    throw new NecRuntimeError("Worker symmetry metadata has inconsistent counts");
  }
  const copies = symmetry.copies.map((value, position) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new NecRuntimeError(`Worker symmetry copy ${position} is invalid`);
    }
    const copy = value as {
      readonly index?: unknown;
      readonly tagOffset?: unknown;
      readonly transform?: unknown;
    };
    const index = safeNonnegativeInteger(
      copy.index,
      `symmetry.copies[${position}].index`,
    );
    const tagOffset = safeNonnegativeInteger(
      copy.tagOffset,
      `symmetry.copies[${position}].tagOffset`,
    );
    if (index !== position || typeof copy.transform !== "object" || copy.transform === null) {
      throw new NecRuntimeError(`Worker symmetry copy ${position} is inconsistent`);
    }
    const transform = copy.transform as {
      readonly kind?: unknown;
      readonly signs?: unknown;
      readonly angleDeg?: unknown;
    };
    if (symmetry.kind === "reflection") {
      if (
        transform.kind !== "cartesian-signs"
        || !Array.isArray(transform.signs)
        || transform.signs.length !== 3
        || !transform.signs.every((sign) => sign === 1 || sign === -1)
      ) {
        throw new NecRuntimeError(`Worker reflection copy ${position} is invalid`);
      }
      const signs = Object.freeze([
        transform.signs[0],
        transform.signs[1],
        transform.signs[2],
      ] as [1 | -1, 1 | -1, 1 | -1]);
      return Object.freeze({
        index,
        tagOffset,
        transform: Object.freeze({ kind: "cartesian-signs" as const, signs }),
      });
    }
    if (transform.kind !== "rotate-z" || typeof transform.angleDeg !== "number"
      || !Number.isFinite(transform.angleDeg)) {
      throw new NecRuntimeError(`Worker rotational copy ${position} is invalid`);
    }
    return Object.freeze({
      index,
      tagOffset,
      transform: Object.freeze({
        kind: "rotate-z" as const,
        angleDeg: transform.angleDeg,
      }),
    });
  });
  return Object.freeze({
    symmetry: Object.freeze({
      kind: symmetry.kind,
      sectionCount,
      fundamentalSegmentCount,
      fullSegmentCount,
      copies: Object.freeze(copies),
    }),
  });
}

function copyFloat64(value: unknown, name: string): Float64Array {
  if (Object.prototype.toString.call(value) !== "[object Float64Array]") {
    throw new NecRuntimeError(`Worker result ${name} is not a Float64Array`);
  }
  return value as Float64Array;
}

export function revivePortSolution(value: unknown): PortSolution {
  const record = value as PortSolution;
  return {
    drive: record.drive,
    frequencyMHz: record.frequencyMHz,
    ports: snapshotPorts(record.ports),
    requested: {
      real: copyFloat64(record.requested.real, "requested.real"),
      imag: copyFloat64(record.requested.imag, "requested.imag"),
    },
    voltages: {
      real: copyFloat64(record.voltages.real, "voltages.real"),
      imag: copyFloat64(record.voltages.imag, "voltages.imag"),
    },
    currents: {
      real: copyFloat64(record.currents.real, "currents.real"),
      imag: copyFloat64(record.currents.imag, "currents.imag"),
    },
    activeImpedances: {
      real: copyFloat64(record.activeImpedances.real, "activeImpedances.real"),
      imag: copyFloat64(record.activeImpedances.imag, "activeImpedances.imag"),
    },
    powersW: copyFloat64(record.powersW, "powersW"),
    factorizationGeneration: record.factorizationGeneration,
    solveGeneration: record.solveGeneration,
  };
}

export function reviveImpedanceResult(value: unknown): ImpedanceResult {
  const record = value as ImpedanceResult;
  const result: ImpedanceResult = {
    impedance: {
      rows: record.impedance.rows,
      columns: record.impedance.columns,
      order: "row-major",
      real: copyFloat64(record.impedance.real, "impedance.real"),
      imag: copyFloat64(record.impedance.imag, "impedance.imag"),
    },
    admittance: {
      rows: record.admittance.rows,
      columns: record.admittance.columns,
      order: "row-major",
      real: copyFloat64(record.admittance.real, "admittance.real"),
      imag: copyFloat64(record.admittance.imag, "admittance.imag"),
    },
    frequencyMHz: record.frequencyMHz,
    factorizationGeneration: record.factorizationGeneration,
  };
  if (record.conditionEstimate !== undefined) {
    return { ...result, conditionEstimate: record.conditionEstimate };
  }
  return result;
}

export function reviveFarFieldResult(value: unknown): FarFieldResult {
  const record = value as FarFieldResult;
  return {
    radiusM: record.radiusM,
    frequencyMHz: record.frequencyMHz,
    thetaDeg: copyFloat64(record.thetaDeg, "thetaDeg"),
    phiDeg: copyFloat64(record.phiDeg, "phiDeg"),
    eThetaReal: copyFloat64(record.eThetaReal, "eThetaReal"),
    eThetaImag: copyFloat64(record.eThetaImag, "eThetaImag"),
    ePhiReal: copyFloat64(record.ePhiReal, "ePhiReal"),
    ePhiImag: copyFloat64(record.ePhiImag, "ePhiImag"),
  };
}

export function reviveEmbeddedFarFieldResult(
  value: unknown,
): EmbeddedFarFieldResult {
  const record = value as EmbeddedFarFieldResult;
  const field = reviveFarFieldResult(record);
  const normalization = record.normalization.kind === "unit-current"
    ? Object.freeze({ kind: "unit-current" as const, valueA: 1 as const })
    : Object.freeze({ kind: "unit-voltage" as const, valueV: 1 as const });
  return {
    ...field,
    ports: snapshotPorts(record.ports),
    normalization,
    samplesPerPort: record.samplesPerPort,
  };
}

export function cloneFloat64(
  source: Float64Array,
): Float64Array<ArrayBuffer> {
  return Float64Array.from(source);
}

export function serializeCreateOptions(
  options: CreateNecWorkerModelOptions | undefined,
): {
  readonly payload?: SerializedCreateOptions;
  readonly transfer: ArrayBuffer[];
} {
  if (options === undefined) {
    return { transfer: [] };
  }
  const payload: {
    wasmUrl?: string;
    wasmBinary?: ArrayBuffer;
  } = {};
  const transfer: ArrayBuffer[] = [];

  if (options.wasmUrl !== undefined && options.wasmBinary !== undefined) {
    throw new NecInputError("wasmUrl and wasmBinary cannot both be supplied");
  }

  if (options.wasmUrl !== undefined) {
    payload.wasmUrl = options.wasmUrl instanceof URL
      ? options.wasmUrl.href
      : options.wasmUrl;
  }

  if (options.wasmBinary !== undefined) {
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      if (options.wasmBinary instanceof Uint8Array) {
        bytes = Uint8Array.from(options.wasmBinary);
      } else if (options.wasmBinary instanceof ArrayBuffer) {
        bytes = new Uint8Array(options.wasmBinary.slice(0));
      } else {
        throw new TypeError("wasmBinary is not an ArrayBuffer or Uint8Array");
      }
    } catch (cause) {
      throw new NecInputError(
        "wasmBinary must be an ArrayBuffer or Uint8Array with readable WASM bytes",
        { cause },
      );
    }
    payload.wasmBinary = bytes.buffer;
    transfer.push(bytes.buffer);
  }

  if (payload.wasmUrl === undefined && payload.wasmBinary === undefined) {
    return { transfer };
  }
  return { payload, transfer };
}

export function toCreateNecModelOptions(
  options: SerializedCreateOptions | undefined,
): CreateNecModelOptions | undefined {
  if (options === undefined) {
    return undefined;
  }
  if (options.wasmBinary !== undefined) {
    return { wasmBinary: options.wasmBinary };
  }
  if (options.wasmUrl !== undefined) {
    return { wasmUrl: options.wasmUrl };
  }
  return undefined;
}
