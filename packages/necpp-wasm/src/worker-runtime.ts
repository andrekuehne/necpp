import { NecRuntimeError, NecStateError } from "./errors.js";
import {
  FarFieldWorkerPool,
  StaleFarFieldJobError,
} from "./field-worker-pool.js";
import {
  validateFarFieldGrid,
  type FarFieldEvaluationSnapshot,
  type WasmNecModel,
} from "./model.js";
import type {
  CompleteGeometryOptions,
  ComplexVector,
  CreateNecModelOptions,
  EmbeddedFieldNormalization,
  FarFieldRequest,
  FarFieldResult,
  FieldBackendDiagnostics,
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
  fieldWorkers?: "auto" | number;
  fieldWorkerAssetBaseUrl?: string;
  fieldPool?: FarFieldWorkerPool;
  wireSegmentCount?: number;
  fullSegmentCount?: number;
  perfectGround?: boolean;
  fieldCancellationGeneration?: number;
}

export type ModelFactory = (
  options?: CreateNecModelOptions,
) => Promise<NecModel>;

export interface WorkerRuntimeDependencies {
  readonly createModel: ModelFactory;
  readonly emitProgress: (event: NecWorkerProgressEvent) => void;
}

const FIELD_TILE_SIZE = 512;
const AUTO_MIN_CONTRIBUTIONS = 250_000;

function resultBytes(request: FarFieldRequest): number {
  return (4 * request.theta.count * request.phi.count
    + request.theta.count + request.phi.count) * Float64Array.BYTES_PER_ELEMENT;
}

function logicalCores(): number {
  const value = globalThis.navigator?.hardwareConcurrency;
  return Number.isInteger(value) && value > 0 ? value : 1;
}

function autoWorkerCount(samples: number): number {
  const cores = logicalCores();
  const candidate = cores >= 8 ? 4 : cores >= 4 ? 2 : 1;
  return Math.min(candidate, Math.ceil(samples / FIELD_TILE_SIZE));
}

function serialDiagnostics(
  session: WorkerSession,
  request: FarFieldRequest,
  totalMs: number,
  fallbackReason: string,
  snapshotCaptureMs = 0,
): FieldBackendDiagnostics {
  return Object.freeze({
    backend: "serial" as const,
    requestedWorkers: session.fieldWorkers ?? 1,
    activeWorkerCount: 1,
    tileSize: FIELD_TILE_SIZE,
    totalTiles: 1,
    completedTiles: 1,
    cancelledTiles: 0,
    cancelledJobs: 0,
    restartedWorkers: 0,
    snapshotBytesPerWorker: 0,
    lastBroadcastBytesPerWorker: 0,
    resultBytes: resultBytes(request),
    geometryReused: false,
    warmupMs: session.fieldPool?.warmupMs ?? 0,
    snapshotCaptureMs,
    snapshotBroadcastMs: 0,
    dispatchMs: 0,
    kernelMs: totalMs,
    mergeMs: 0,
    totalMs,
    fallbackReason,
  });
}

function serialField(
  session: WorkerSession,
  model: NecModel,
  request: FarFieldRequest,
  reason: string,
  snapshotCaptureMs = 0,
): FarFieldResult {
  const started = performance.now();
  const result = model.computeFarField(request);
  const totalMs = performance.now() - started;
  return {
    ...result,
    fieldBackend: serialDiagnostics(
      session,
      request,
      totalMs,
      reason,
      snapshotCaptureMs,
    ),
  };
}

async function pooledField(
  session: WorkerSession,
  model: NecModel,
  request: FarFieldRequest,
): Promise<FarFieldResult> {
  const requestGeneration = session.fieldCancellationGeneration ?? 0;
  const requested = session.fieldWorkers ?? 1;
  if (requested === 1) {
    return serialField(session, model, request, "explicit-one-worker");
  }
  if (model.state !== "solved") {
    throw new NecStateError("computeFarField", model.state);
  }
  const grid = validateFarFieldGrid(request);
  request = {
    radiusM: grid.radiusM,
    theta: {
      startDeg: grid.thetaStartDeg,
      count: grid.thetaCount,
      stepDeg: grid.thetaStepDeg,
    },
    phi: {
      startDeg: grid.phiStartDeg,
      count: grid.phiCount,
      stepDeg: grid.phiStepDeg,
    },
  };
  const samples = request.theta.count * request.phi.count;
  const segments = session.fullSegmentCount ?? session.wireSegmentCount ?? 0;
  const workers = requested === "auto" ? autoWorkerCount(samples) : requested;
  const contributions = samples * segments * (session.perfectGround ? 2 : 1);
  if (requested === "auto" && contributions < AUTO_MIN_CONTRIBUTIONS) {
    return serialField(session, model, request, "below-auto-threshold");
  }
  if (requested === "auto" && workers < 2) {
    return serialField(session, model, request, "insufficient-hardware-or-grid");
  }

  const snapshotStarted = performance.now();
  const snapshot = (model as WasmNecModel).captureFarFieldEvaluationSnapshot();
  const snapshotCaptureMs = performance.now() - snapshotStarted;
  if (snapshot.capability !== "supported") {
    return serialField(
      session,
      model,
      request,
      `unsupported-${snapshot.capability}`,
      snapshotCaptureMs,
    );
  }

  let pool = session.fieldPool;
  try {
    if (pool === undefined || pool.workerCount !== workers) {
      pool?.dispose();
      pool = new FarFieldWorkerPool(
        workers,
        FIELD_TILE_SIZE,
        "dedicated",
        session.fieldWorkerAssetBaseUrl,
      );
      session.fieldPool = pool;
    }
    await pool.setSnapshot(snapshot as FarFieldEvaluationSnapshot);
    if ((session.fieldCancellationGeneration ?? 0) !== requestGeneration) {
      throw new StaleFarFieldJobError();
    }
    const field = await pool.computeFarField(request);
    const diagnostics = field.poolDiagnostics;
    const dispatchMs = Math.max(
      0,
      diagnostics.dispatchComputeTransferMs - diagnostics.kernelMs,
    );
    return {
      radiusM: field.radiusM,
      frequencyMHz: field.frequencyMHz,
      thetaDeg: field.thetaDeg,
      phiDeg: field.phiDeg,
      eThetaReal: field.eThetaReal,
      eThetaImag: field.eThetaImag,
      ePhiReal: field.ePhiReal,
      ePhiImag: field.ePhiImag,
      fieldBackend: Object.freeze({
        backend: "worker-pool" as const,
        requestedWorkers: requested,
        activeWorkerCount: diagnostics.workers,
        tileSize: diagnostics.tileSize,
        totalTiles: diagnostics.tiles,
        completedTiles: diagnostics.completedTiles,
        cancelledTiles: diagnostics.cancelledTiles,
        cancelledJobs: diagnostics.cancelledJobs,
        restartedWorkers: diagnostics.restartedWorkers,
        snapshotBytesPerWorker: diagnostics.snapshotBytesPerWorker,
        lastBroadcastBytesPerWorker: diagnostics.lastBroadcastBytesPerWorker,
        resultBytes: resultBytes(request),
        geometryReused: diagnostics.geometryReused,
        warmupMs: pool.warmupMs,
        snapshotCaptureMs,
        snapshotBroadcastMs: diagnostics.snapshotBroadcastMs,
        dispatchMs,
        kernelMs: diagnostics.kernelMs,
        mergeMs: diagnostics.mergeMs,
        totalMs: snapshotCaptureMs + diagnostics.snapshotBroadcastMs
          + diagnostics.totalMs,
      }),
    };
  } catch (error) {
    if (error instanceof StaleFarFieldJobError
        || (session.fieldCancellationGeneration ?? 0) !== requestGeneration) {
      throw new NecRuntimeError("Far-field request was superseded", {
        details: { reason: "superseded", boundedTileSize: FIELD_TILE_SIZE },
      });
    }
    pool?.dispose();
    delete session.fieldPool;
    return serialField(
      session,
      model,
      request,
      "worker-pool-failed",
      snapshotCaptureMs,
    );
  }
}

async function invokeModel(
  session: WorkerSession,
  model: NecModel,
  method: WorkerMethod,
  args: readonly unknown[],
): Promise<unknown> {
  switch (method) {
  case "addWire":
    model.addWire(args[0] as WireDefinition);
    session.wireSegmentCount = (session.wireSegmentCount ?? 0)
      + (args[0] as WireDefinition).segments;
    return undefined;
  case "completeGeometry":
    {
      const result = model.completeGeometry(
      args[0] as CompleteGeometryOptions | undefined,
      );
      session.fullSegmentCount = result.symmetry?.fullSegmentCount
        ?? session.wireSegmentCount ?? 0;
      return result;
    }
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
    session.perfectGround = (args[0] as GroundModel).kind === "perfect";
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
    return session.fieldWorkers === undefined
      ? model.computeFarField(args[0] as FarFieldRequest)
      : pooledField(session, model, args[0] as FarFieldRequest);
  case "computeEmbeddedFarFields":
    return model.computeEmbeddedFarFields(
      args[0] as FarFieldRequest,
      args[1] as EmbeddedFieldNormalization | undefined,
    );
  case "dispose":
    session.fieldPool?.dispose();
    delete session.fieldPool;
    model.dispose();
    return undefined;
  default: {
    const unexpected: never = method;
    throw new NecRuntimeError(`Unsupported worker method ${String(unexpected)}`);
  }
  }
}

export function cancelWorkerFarField(session: WorkerSession): void {
  session.fieldCancellationGeneration =
    (session.fieldCancellationGeneration ?? 0) + 1;
  session.fieldPool?.cancelActive();
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
  request: Exclude<WorkerRequest, { readonly kind: "cancel-field" }>,
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
      const fieldWorkers = request.options?.fieldWorkers;
      if (fieldWorkers !== undefined && fieldWorkers !== "auto"
          && (!Number.isInteger(fieldWorkers) || fieldWorkers < 1 || fieldWorkers > 8)) {
        throw new NecRuntimeError("Invalid evaluator worker configuration");
      }
      const model = await withProgress(
        deps.emitProgress,
        "create",
        () => deps.createModel(toCreateNecModelOptions(request.options)),
      );
      session.model = model;
      if (fieldWorkers === undefined) delete session.fieldWorkers;
      else session.fieldWorkers = fieldWorkers;
      const assetBaseUrl = request.options?.fieldWorkerAssetBaseUrl;
      if (assetBaseUrl === undefined) delete session.fieldWorkerAssetBaseUrl;
      else session.fieldWorkerAssetBaseUrl = assetBaseUrl;
      session.wireSegmentCount = 0;
      session.fullSegmentCount = 0;
      session.perfectGround = false;
      session.fieldCancellationGeneration = 0;
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
      () => invokeModel(session, model, request.method, request.args),
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
