import { NecRuntimeError, NecStateError } from "./errors.js";
import type {
  CompleteGeometryOptions,
  ComplexVector,
  CreateNecModelOptions,
  EmbeddedFieldNormalization,
  FarFieldRequest,
  GroundModel,
  LoadDefinition,
  NecModel,
  NecModelState,
  NecWorkerProgressEvent,
  PortDefinition,
  PrepareOptions,
  WireDefinition,
} from "./types.js";
import {
  collectTransferables,
  serializeError,
  toCreateNecModelOptions,
  type WorkerMethod,
  type WorkerRequest,
  type WorkerResponse,
} from "./worker-protocol.js";

export interface WorkerSession {
  model: NecModel | undefined;
}

export type ModelFactory = (
  options?: CreateNecModelOptions,
) => Promise<NecModel>;

export interface WorkerRuntimeDependencies {
  readonly createModel: ModelFactory;
  readonly emitProgress: (event: NecWorkerProgressEvent) => void;
}

function invokeModel(
  model: NecModel,
  method: WorkerMethod,
  args: readonly unknown[],
): unknown {
  switch (method) {
  case "addWire":
    model.addWire(args[0] as WireDefinition);
    return undefined;
  case "completeGeometry":
    model.completeGeometry(args[0] as CompleteGeometryOptions | undefined);
    return undefined;
  case "definePorts":
    model.definePorts(args[0] as readonly PortDefinition[]);
    return undefined;
  case "addLoad":
    model.addLoad(args[0] as LoadDefinition);
    return undefined;
  case "clearLoads":
    model.clearLoads();
    return undefined;
  case "setGround":
    model.setGround(args[0] as GroundModel);
    return undefined;
  case "prepare":
    model.prepare(args[0] as PrepareOptions);
    return undefined;
  case "computeImpedanceMatrix":
    return model.computeImpedanceMatrix();
  case "solveVoltages":
    return model.solveVoltages(args[0] as ComplexVector);
  case "solveCurrents":
    return model.solveCurrents(args[0] as ComplexVector);
  case "computeFarField":
    return model.computeFarField(args[0] as FarFieldRequest);
  case "computeEmbeddedFarFields":
    return model.computeEmbeddedFarFields(
      args[0] as FarFieldRequest,
      args[1] as EmbeddedFieldNormalization | undefined,
    );
  case "dispose":
    model.dispose();
    return undefined;
  default: {
    const unexpected: never = method;
    throw new NecRuntimeError(`Unsupported worker method ${String(unexpected)}`);
  }
  }
}

async function withProgress<T>(
  emitProgress: (event: NecWorkerProgressEvent) => void,
  operation: NecWorkerProgressEvent["operation"],
  body: () => T | Promise<T>,
): Promise<T> {
  emitProgress({ operation, phase: "start" });
  try {
    return await body();
  } finally {
    emitProgress({ operation, phase: "complete" });
  }
}

export async function handleWorkerRequest(
  session: WorkerSession,
  request: WorkerRequest,
  deps: WorkerRuntimeDependencies,
): Promise<{ response: WorkerResponse; transfer: ArrayBuffer[] }> {
  if (request.kind === "create") {
    if (session.model !== undefined) {
      return {
        response: {
          id: request.id,
          kind: "error",
          state: session.model.state,
          error: serializeError(
            new NecRuntimeError("The worker model has already been created"),
          ),
        },
        transfer: [],
      };
    }
    try {
      const model = await withProgress(
        deps.emitProgress,
        "create",
        () => deps.createModel(toCreateNecModelOptions(request.options)),
      );
      session.model = model;
      return {
        response: {
          id: request.id,
          kind: "ok",
          state: model.state,
          transferredBufferCount: 0,
        },
        transfer: [],
      };
    } catch (error) {
      return {
        response: {
          id: request.id,
          kind: "error",
          error: serializeError(error),
        },
        transfer: [],
      };
    }
  }

  const model = session.model;
  if (model === undefined) {
    return {
      response: {
        id: request.id,
        kind: "error",
        error: serializeError(
          new NecStateError(request.method, "disposed", "The worker model is not created"),
        ),
      },
      transfer: [],
    };
  }

  try {
    const result = await withProgress(
      deps.emitProgress,
      request.method,
      () => invokeModel(model, request.method, request.args),
    );
    if (request.method === "dispose") {
      session.model = undefined;
    }
    const transfer = collectTransferables(result);
    return {
      response: {
        id: request.id,
        kind: "ok",
        state: request.method === "dispose" ? "disposed" : model.state,
        result,
        transferredBufferCount: transfer.length,
      },
      transfer,
    };
  } catch (error) {
    return {
      response: {
        id: request.id,
        kind: "error",
        state: model.state,
        error: serializeError(error),
      },
      transfer: [],
    };
  }
}
