import type { NecModelState } from "./types.js";

export type NecErrorCode =
  | "NEC_STATE"
  | "NEC_INPUT"
  | "NEC_GEOMETRY"
  | "NEC_PORT"
  | "NEC_SOLVER"
  | "NEC_CONDITIONING"
  | "NEC_RUNTIME";

export interface NecErrorOptions {
  readonly cause?: unknown;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Base class for every package-defined operational error. */
export class NecError<TCode extends NecErrorCode = NecErrorCode> extends Error {
  readonly code: TCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: TCode, message: string, options: NecErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "NecError";
    this.code = code;
    this.details = options.details;
  }
}

export class NecStateError extends NecError<"NEC_STATE"> {
  readonly operation: string;
  readonly state: NecModelState;

  constructor(operation: string, state: NecModelState, message?: string) {
    super(
      "NEC_STATE",
      message ?? `Operation ${operation} is not valid while the model is ${state}`,
      { details: { operation, state } },
    );
    this.name = "NecStateError";
    this.operation = operation;
    this.state = state;
  }
}

export class NecInputError extends NecError<"NEC_INPUT"> {
  constructor(message: string, options?: NecErrorOptions) {
    super("NEC_INPUT", message, options ?? {});
    this.name = "NecInputError";
  }
}

export class NecGeometryError extends NecError<"NEC_GEOMETRY"> {
  constructor(message: string, options?: NecErrorOptions) {
    super("NEC_GEOMETRY", message, options ?? {});
    this.name = "NecGeometryError";
  }
}

export class NecPortError extends NecError<"NEC_PORT"> {
  constructor(message: string, options?: NecErrorOptions) {
    super("NEC_PORT", message, options ?? {});
    this.name = "NecPortError";
  }
}

export class NecSolverError extends NecError<"NEC_SOLVER"> {
  constructor(message: string, options?: NecErrorOptions) {
    super("NEC_SOLVER", message, options ?? {});
    this.name = "NecSolverError";
  }
}

export class NecConditioningError extends NecError<"NEC_CONDITIONING"> {
  constructor(message: string, options?: NecErrorOptions) {
    super("NEC_CONDITIONING", message, options ?? {});
    this.name = "NecConditioningError";
  }
}

export class NecRuntimeError extends NecError<"NEC_RUNTIME"> {
  constructor(message: string, options?: NecErrorOptions) {
    super("NEC_RUNTIME", message, options ?? {});
    this.name = "NecRuntimeError";
  }
}
