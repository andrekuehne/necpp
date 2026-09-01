import { NecInputError, NecRuntimeError, NecStateError } from "./errors.js";
import type {
  CompleteGeometryOptions,
  ComplexVector,
  CreateNecWorkerModelOptions,
  EmbeddedFarFieldResult,
  EmbeddedFieldNormalization,
  FarFieldRequest,
  FarFieldResult,
  GeometryCompletionResult,
  GroundModel,
  ImpedanceResult,
  LoadDefinition,
  NecModelState,
  NecWorkerModel,
  NecWorkerProgressListener,
  PortDefinition,
  PortSolution,
  PrepareOptions,
  WireDefinition,
} from "./types.js";
import {
  cloneFloat64,
  isNodeRuntime,
  isWorkerResponse,
  reviveEmbeddedFarFieldResult,
  reviveError,
  reviveFarFieldResult,
  reviveGeometryCompletionResult,
  reviveImpedanceResult,
  revivePortSolution,
  serializeCreateOptions,
  type SerializedCreateOptions,
  type WorkerFieldPoolOptions,
  type WorkerMethod,
} from "./worker-protocol.js";

export interface WorkerHost {
  postMessage(data: unknown, transfer?: readonly ArrayBuffer[]): void;
  subscribe(listener: (data: unknown) => void): () => void;
  subscribeError(listener: (error: unknown) => void): () => void;
  subscribeExit?(listener: (code: number) => void): () => void;
  terminate(): void;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

function createWebWorker(): Worker {
  return new Worker(new URL("./worker-entry.js", import.meta.url), {
    type: "module",
  });
}

async function openWorkerHost(): Promise<WorkerHost> {
  if (isNodeRuntime()) {
    const { Worker: NodeWorker } = await import("node:worker_threads");
    const worker = new NodeWorker(new URL("./worker-entry.js", import.meta.url));
    return {
      postMessage(data, transfer = []) {
        worker.postMessage(data, transfer);
      },
      subscribe(listener) {
        const handler = (value: unknown): void => {
          listener(value);
        };
        worker.on("message", handler);
        return () => {
          worker.off("message", handler);
        };
      },
      subscribeError(listener) {
        const handler = (error: Error): void => {
          listener(error);
        };
        worker.on("error", handler);
        return () => {
          worker.off("error", handler);
        };
      },
      subscribeExit(listener) {
        const handler = (code: number): void => {
          listener(code);
        };
        worker.on("exit", handler);
        return () => {
          worker.off("exit", handler);
        };
      },
      terminate() {
        void worker.terminate();
      },
    };
  }

  const worker = createWebWorker();
  return {
    postMessage(data, transfer = []) {
      worker.postMessage(data, transfer as Transferable[]);
    },
    subscribe(listener) {
      const handler = (event: MessageEvent<unknown>): void => {
        listener(event.data);
      };
      worker.addEventListener("message", handler);
      return () => {
        worker.removeEventListener("message", handler);
      };
    },
    subscribeError(listener) {
      const errorHandler = (event: ErrorEvent): void => {
        listener(event.error ?? event.message);
      };
      const messageErrorHandler = (): void => {
        listener(new Error("The NEC worker could not deserialize a message"));
      };
      worker.addEventListener("error", errorHandler);
      worker.addEventListener("messageerror", messageErrorHandler);
      return () => {
        worker.removeEventListener("error", errorHandler);
        worker.removeEventListener("messageerror", messageErrorHandler);
      };
    },
    terminate() {
      worker.terminate();
    },
  };
}

function cloneComplexVector(vector: ComplexVector): {
  readonly vector: ComplexVector;
  readonly transfer: ArrayBuffer[];
} {
  const real = cloneFloat64(vector.real);
  const imag = cloneFloat64(vector.imag);
  return {
    vector: { real, imag },
    transfer: [real.buffer, imag.buffer],
  };
}

class WorkerNecModel implements NecWorkerModel {
  readonly #host: WorkerHost;
  #state: NecModelState = "empty";
  #terminated = false;
  #nextId = 1;
  #tail: Promise<void> = Promise.resolve();
  readonly #pending = new Map<number, PendingRequest>();
  readonly #listeners = new Set<NecWorkerProgressListener>();
  readonly #unsubscribeMessage: () => void;
  readonly #unsubscribeError: () => void;
  readonly #unsubscribeExit: () => void;
  readonly #fieldCancellationEnabled: boolean;

  constructor(
    host: WorkerHost,
    onProgress?: NecWorkerProgressListener,
    fieldCancellationEnabled = false,
  ) {
    this.#host = host;
    this.#fieldCancellationEnabled = fieldCancellationEnabled;
    if (onProgress !== undefined) {
      this.#listeners.add(onProgress);
    }
    this.#unsubscribeMessage = host.subscribe((data) => {
      this.#onMessage(data);
    });
    this.#unsubscribeError = host.subscribeError((error) => {
      this.#failAll(
        new NecRuntimeError("The NEC worker failed", { cause: error }),
      );
    });
    this.#unsubscribeExit = host.subscribeExit?.((code) => {
      if (!this.#terminated) {
        this.#failAll(new NecRuntimeError(
          `The NEC worker exited unexpectedly with code ${code}`,
          { details: { exitCode: code } },
        ));
      }
    }) ?? (() => undefined);
  }

  get state(): NecModelState {
    return this.#state;
  }

  subscribeProgress(listener: NecWorkerProgressListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async initialize(
    options?: CreateNecWorkerModelOptions,
    fieldPool?: WorkerFieldPoolOptions,
  ): Promise<void> {
    const serialized = serializeCreateOptions(options, fieldPool);
    await this.#request(
      serialized.payload === undefined
        ? { kind: "create" }
        : { kind: "create", options: serialized.payload },
      serialized.transfer,
    );
  }

  addWire(wire: WireDefinition): Promise<void> {
    return this.#invokeVoid("addWire", [wire]);
  }

  async completeGeometry(
    options?: CompleteGeometryOptions,
  ): Promise<GeometryCompletionResult> {
    const result = await this.#invoke(
      "completeGeometry",
      options === undefined ? [] : [options],
    );
    return reviveGeometryCompletionResult(result);
  }

  definePorts(ports: readonly PortDefinition[]): Promise<void> {
    return this.#invokeVoid("definePorts", [ports]);
  }

  addLoad(load: LoadDefinition): Promise<void> {
    return this.#invokeVoid("addLoad", [load]);
  }

  clearLoads(): Promise<void> {
    return this.#invokeVoid("clearLoads", []);
  }

  setGround(ground: GroundModel): Promise<void> {
    return this.#invokeVoid("setGround", [ground]);
  }

  prepare(options: PrepareOptions): Promise<void> {
    return this.#invokeVoid("prepare", [options]);
  }

  async computeImpedanceMatrix(): Promise<ImpedanceResult> {
    return reviveImpedanceResult(await this.#invoke("computeImpedanceMatrix", []));
  }

  async solveVoltages(voltages: ComplexVector): Promise<PortSolution> {
    this.#cancelField();
    const cloned = cloneComplexVector(voltages);
    return revivePortSolution(
      await this.#invoke("solveVoltages", [cloned.vector], cloned.transfer),
    );
  }

  async solveCurrents(currents: ComplexVector): Promise<PortSolution> {
    this.#cancelField();
    const cloned = cloneComplexVector(currents);
    return revivePortSolution(
      await this.#invoke("solveCurrents", [cloned.vector], cloned.transfer),
    );
  }

  async computeFarField(request: FarFieldRequest): Promise<FarFieldResult> {
    this.#cancelField();
    return reviveFarFieldResult(await this.#invoke("computeFarField", [request]));
  }

  async computeEmbeddedFarFields(
    request: FarFieldRequest,
    normalization?: EmbeddedFieldNormalization,
  ): Promise<EmbeddedFarFieldResult> {
    const args = normalization === undefined ? [request] : [request, normalization];
    return reviveEmbeddedFarFieldResult(
      await this.#invoke("computeEmbeddedFarFields", args),
    );
  }

  async dispose(): Promise<void> {
    this.#cancelField();
    if (this.#terminated || this.#state === "disposed") {
      this.#state = "disposed";
      this.terminate();
      return;
    }
    try {
      await this.#invoke("dispose", []);
    } finally {
      this.terminate();
    }
  }

  terminate(): void {
    if (this.#terminated) {
      return;
    }
    this.#terminated = true;
    this.#state = "disposed";
    this.#unsubscribeMessage();
    this.#unsubscribeError();
    this.#unsubscribeExit();
    const error = new NecRuntimeError("The NEC worker was terminated");
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
    try {
      this.#host.terminate();
    } catch {
      // Termination is best-effort once outstanding work has been rejected.
    }
  }

  #notify(listenerEvent: { operation: WorkerMethod | "create"; phase: "start" | "complete" }): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(listenerEvent);
      } catch {
        // Progress listeners must not break the worker client.
      }
    }
  }

  #cancelField(): void {
    if (!this.#fieldCancellationEnabled || this.#terminated) return;
    queueMicrotask(() => {
      if (this.#terminated) return;
      try {
        this.#host.postMessage({ kind: "cancel-field" });
      } catch {
        // The ordered request reports a typed worker failure if the host is gone.
      }
    });
  }

  #failAll(error: NecRuntimeError): void {
    if (this.#terminated) {
      return;
    }
    this.#terminated = true;
    this.#state = "disposed";
    this.#unsubscribeMessage();
    this.#unsubscribeError();
    this.#unsubscribeExit();
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
    try {
      this.#host.terminate();
    } catch {
      // The host is already failing.
    }
  }

  #onMessage(data: unknown): void {
    if (!isWorkerResponse(data)) {
      this.#failAll(
        new NecRuntimeError("The NEC worker returned a malformed message"),
      );
      return;
    }
    if (data.kind === "progress") {
      this.#notify(data);
      return;
    }
    if (data.kind === "crash") {
      this.#failAll(new NecRuntimeError(
        data.error.message,
        data.error.details === undefined ? {} : { details: data.error.details },
      ));
      return;
    }
    const pending = this.#pending.get(data.id);
    if (pending === undefined) {
      return;
    }
    this.#pending.delete(data.id);
    if (data.state !== undefined) {
      this.#state = data.state;
    }
    if (data.kind === "ok") {
      pending.resolve(data.result);
      return;
    }
    pending.reject(reviveError(data.error));
  }

  #assertCallable(method: WorkerMethod | "create"): void {
    if (this.#terminated || this.#state === "disposed") {
      if (method === "dispose") {
        return;
      }
      throw new NecStateError(method, "disposed");
    }
  }

  #request(
    body:
      | { readonly kind: "create"; readonly options?: SerializedCreateOptions }
      | {
        readonly kind: "invoke";
        readonly method: WorkerMethod;
        readonly args: readonly unknown[];
      },
    transfer: readonly ArrayBuffer[] = [],
  ): Promise<unknown> {
    this.#assertCallable(
      body.kind === "create" ? "create" : body.method,
    );
    const run = this.#tail.then(() => {
      if (this.#terminated) {
        throw new NecRuntimeError("The NEC worker was terminated");
      }
      return new Promise<unknown>((resolve, reject) => {
        const id = this.#nextId;
        this.#nextId += 1;
        this.#pending.set(id, { resolve, reject });
        try {
          this.#host.postMessage({ ...body, id }, transfer);
        } catch (cause) {
          this.#pending.delete(id);
          reject(new NecRuntimeError("Failed to post a NEC worker request", {
            cause,
          }));
        }
      });
    });
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }

  #invokeVoid(
    method: WorkerMethod,
    args: readonly unknown[],
    transfer: readonly ArrayBuffer[] = [],
  ): Promise<void> {
    return this.#invoke(method, args, transfer).then(() => undefined);
  }

  async #invoke(
    method: WorkerMethod,
    args: readonly unknown[],
    transfer: readonly ArrayBuffer[] = [],
  ): Promise<unknown> {
    if (method !== "dispose") {
      this.#assertCallable(method);
    } else if (this.#terminated || this.#state === "disposed") {
      return undefined;
    }
    return this.#request({ kind: "invoke", method, args }, transfer);
  }
}

export async function createNecWorkerModelFromHost(
  host: WorkerHost,
  options?: CreateNecWorkerModelOptions,
  fieldPool?: WorkerFieldPoolOptions,
): Promise<NecWorkerModel> {
  const model = new WorkerNecModel(
    host,
    options?.onProgress,
    fieldPool !== undefined,
  );
  try {
    await model.initialize(options, fieldPool);
    return model;
  } catch (error) {
    model.terminate();
    throw error;
  }
}

/** Create a stateful NEC model that runs inside a dedicated worker. */
export async function createNecWorkerModel(
  options?: CreateNecWorkerModelOptions,
): Promise<NecWorkerModel> {
  if (options !== undefined && (typeof options !== "object" || options === null)) {
    throw new NecInputError("WASM loading options must be an object");
  }
  const host = await openWorkerHost();
  return createNecWorkerModelFromHost(host, options);
}

/** @internal Array facade: create an outer worker that owns evaluator children. */
export async function createNecArrayWorkerModel(
  fieldPool: WorkerFieldPoolOptions,
): Promise<NecWorkerModel> {
  const host = await openWorkerHost();
  return createNecWorkerModelFromHost(host, undefined, fieldPool);
}
