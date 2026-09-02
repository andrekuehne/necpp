import { createNecModel } from "./index.js";
import { NecRuntimeError } from "./errors.js";
import {
  isNodeRuntime,
  isWorkerResponse,
  serializeError,
  type WorkerRequest,
  type WorkerResponse,
} from "./worker-protocol.js";
import {
  cancelWorkerFarField,
  handleWorkerRequest,
  type WorkerSession,
} from "./worker-runtime.js";

interface WorkerParent {
  postMessage(value: unknown, transfer?: readonly (ArrayBuffer | MessagePort)[]): void;
  onMessage(listener: (value: unknown) => void): void;
}

async function connectParent(): Promise<WorkerParent> {
  if (typeof document !== "undefined") {
    throw new NecRuntimeError("NEC worker entry must run inside a worker");
  }
  if (isNodeRuntime()) {
    const { parentPort } = await import("node:worker_threads");
    if (parentPort === null) {
      throw new NecRuntimeError("NEC worker entry must run inside a worker");
    }
    return {
      postMessage(value, transfer = []) {
        parentPort.postMessage(
          value,
          transfer as readonly import("node:worker_threads").Transferable[],
        );
      },
      onMessage(listener) {
        parentPort.on("message", listener);
      },
    };
  }

  const scope = globalThis as typeof globalThis & {
    postMessage: (message: unknown, transfer?: Transferable[]) => void;
    addEventListener: (
      type: "message",
      listener: (event: MessageEvent<unknown>) => void,
    ) => void;
  };
  if (typeof scope.postMessage !== "function") {
    throw new NecRuntimeError("NEC worker entry must run inside a worker");
  }
  return {
    postMessage(value, transfer = []) {
      scope.postMessage(value, transfer as Transferable[]);
    },
    onMessage(listener) {
      scope.addEventListener("message", (event) => {
        listener(event.data);
      });
    },
  };
}

function isWorkerRequest(
  value: unknown,
): value is Exclude<WorkerRequest, { readonly kind: "cancel-field" }> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as { id?: unknown; kind?: unknown };
  return typeof record.id === "number"
    && (record.kind === "create" || record.kind === "invoke");
}

function isCancelFieldRequest(
  value: unknown,
): value is Extract<WorkerRequest, { readonly kind: "cancel-field" }> {
  return typeof value === "object" && value !== null
    && (value as { kind?: unknown }).kind === "cancel-field";
}

void startWorker();

async function startWorker(): Promise<void> {
  const parent = await connectParent();
  const session: WorkerSession = { model: undefined };
  let queue: Promise<void> = Promise.resolve();

  function post(response: WorkerResponse, transfer: readonly ArrayBuffer[] = []): void {
    parent.postMessage(response, transfer);
  }

  parent.onMessage((value) => {
    if (isCancelFieldRequest(value)) {
      cancelWorkerFarField(session);
      return;
    }
    queue = queue.then(async () => {
      if (!isWorkerRequest(value)) {
        post({
          kind: "crash",
          error: serializeError(
            new NecRuntimeError("The NEC worker received a malformed request"),
          ),
        });
        return;
      }
      try {
        const { response, transfer } = await handleWorkerRequest(
          session,
          value,
          {
            createModel: createNecModel,
            emitProgress(event) {
              post({
                kind: "progress",
                operation: event.operation,
                phase: event.phase,
              });
            },
          },
        );
        if (!isWorkerResponse(response)) {
          post({
            id: value.id,
            kind: "error",
            error: serializeError(
              new NecRuntimeError("The NEC worker produced an invalid response"),
            ),
          });
          return;
        }
        post(response, transfer);
      } catch (error) {
        post({
          id: value.id,
          kind: "error",
          error: serializeError(error),
        });
      }
    }, () => undefined);
  });
}
