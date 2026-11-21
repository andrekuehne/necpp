import { NecCancellationError, NecInputError } from "./errors.js";
import { validFloquetRequest } from "./periodic-floquet.js";
import { finitePair, validScanDirection } from "./periodic-lattice.js";
import { embeddedNormalization, inputError, positiveNumber, requireRecord } from "./model.js";
import type {
  FloquetRequestOptions,
  LoadDefinition,
  NecPeriodicWorkerModel,
  PeriodicGround,
  PeriodicLattice,
  PortDefinition,
  ScanSweepChunk,
  ScanSweepOptions,
  ScanSweepPoint,
  ScanSweepRequest,
  ScanState,
  WireDefinition,
} from "./types.js";

/**
 * One configuration call on a unit cell. A sweep worker gets its copy of the
 * cell by replaying the calls that succeeded on the cell, in order.
 */
export type PeriodicCellCall =
  | { readonly method: "addWire"; readonly argument: WireDefinition }
  | { readonly method: "completeGeometry" }
  | { readonly method: "definePorts"; readonly argument: readonly PortDefinition[] }
  | { readonly method: "addLoad"; readonly argument: LoadDefinition }
  | { readonly method: "clearLoads" }
  | { readonly method: "setGround"; readonly argument: PeriodicGround }
  | { readonly method: "setLattice"; readonly argument: PeriodicLattice };

/**
 * A deep copy of a configuration call, so that a caller who reuses and
 * changes the objects passed in does not change what the workers replay.
 */
export function recordedCall(call: PeriodicCellCall): PeriodicCellCall {
  return structuredClone(call);
}

function replay(worker: NecPeriodicWorkerModel, call: PeriodicCellCall): Promise<void> {
  switch (call.method) {
  case "addWire":
    return worker.addWire(call.argument);
  case "completeGeometry":
    return worker.completeGeometry();
  case "definePorts":
    return worker.definePorts(call.argument);
  case "addLoad":
    return worker.addLoad(call.argument);
  case "clearLoads":
    return worker.clearLoads();
  case "setGround":
    return worker.setGround(call.argument);
  case "setLattice":
    return worker.setLattice(call.argument);
  default: {
    const unexpected: never = call;
    throw new NecInputError(`Unknown unit-cell call ${String(unexpected)}`);
  }
  }
}

export interface ValidSweep {
  readonly frequencyMHz: number;
  readonly scanStates: readonly ScanState[];
  /** The Floquet options of every scan state, validated. */
  readonly floquet: FloquetRequestOptions;
  readonly workers: "auto" | number;
  readonly signal: AbortSignal | undefined;
}

function validScanState(value: unknown, name: string): ScanState {
  const record = requireRecord(value, name);
  const hasPhases = record.scanPhasesRad !== undefined;
  if (hasPhases === (record.scanDirection !== undefined)) {
    inputError(`${name} needs exactly one of scanPhasesRad and scanDirection`, { name });
  }
  return hasPhases
    ? { scanPhasesRad: finitePair(record.scanPhasesRad, `${name}.scanPhasesRad`) }
    : { scanDirection: validScanDirection(record.scanDirection, `${name}.scanDirection`) };
}

/** @internal Validate a sweep request and its options before anything starts. */
export function validSweep(request: ScanSweepRequest, options: ScanSweepOptions | undefined): ValidSweep {
  const record = requireRecord(request, "request");
  const frequencyMHz = positiveNumber(record.frequencyMHz, "request.frequencyMHz");
  if (!Array.isArray(record.scanStates)) {
    inputError("request.scanStates must be an array of scan states", { name: "request.scanStates" });
  }
  const scanStates = Object.freeze(
    (record.scanStates as readonly unknown[]).map((state, index) =>
      validScanState(state, `request.scanStates[${index}]`)),
  );
  const floquetRequest = validFloquetRequest(record, "request");
  const floquet: FloquetRequestOptions = Object.freeze({
    normalization: embeddedNormalization(floquetRequest.normalization),
    evanescentModes: floquetRequest.evanescentModes,
  });
  const workers = options?.workers ?? "auto";
  if (workers !== "auto" && (!Number.isInteger(workers) || workers < 1 || workers > 8)) {
    inputError("options.workers must be \"auto\" or an integer from 1 through 8", {
      name: "options.workers",
      value: workers,
    });
  }
  const signal = options?.signal;
  if (signal !== undefined
      && (typeof signal !== "object" || signal === null
        || typeof signal.aborted !== "boolean"
        || typeof signal.addEventListener !== "function"
        || typeof signal.removeEventListener !== "function")) {
    inputError("options.signal must be an AbortSignal", { name: "options.signal" });
  }
  return { frequencyMHz, scanStates, floquet, workers, signal };
}

function logicalCores(): number {
  const value = globalThis.navigator?.hardwareConcurrency;
  return Number.isInteger(value) && value > 0 ? value : 1;
}

function workerCount(requested: "auto" | number, scanStates: number): number {
  const wanted = requested === "auto" ? Math.min(8, Math.max(1, logicalCores() - 1)) : requested;
  return Math.max(1, Math.min(wanted, scanStates));
}

interface SweepWorker {
  readonly model: NecPeriodicWorkerModel;
  /** Calls of the cell replayed on this worker so far. */
  replayed: number;
  /** Settles once the worker is up to date with the calls given so far. */
  ready: Promise<void>;
}

/**
 * @internal Workers that each hold a copy of one unit cell, for scan sweeps.
 * They start on demand and stay until `dispose()`, so that each keeps the
 * scan-independent part of its fill from one sweep to the next.
 */
export class ScanSweepPool {
  readonly #createWorker: () => Promise<NecPeriodicWorkerModel>;
  #workers: SweepWorker[] = [];
  #starting: Promise<SweepWorker>[] = [];
  #disposed = false;

  constructor(createWorker: () => Promise<NecPeriodicWorkerModel>) {
    this.#createWorker = createWorker;
  }

  /** At least `count` workers, each up to date with `calls`. */
  async #acquire(count: number, calls: readonly PeriodicCellCall[]): Promise<SweepWorker[]> {
    // A worker that crashed or was terminated cannot be reused.
    this.#workers = this.#workers.filter((worker) => worker.model.state !== "disposed");
    while (this.#workers.length + this.#starting.length < count) {
      const starting = this.#createWorker().then((model) => {
        const worker: SweepWorker = { model, replayed: 0, ready: Promise.resolve() };
        if (this.#disposed) {
          model.terminate();
        } else {
          this.#workers.push(worker);
        }
        return worker;
      });
      this.#starting.push(starting);
      void starting.then(
        () => { this.#starting = this.#starting.filter((entry) => entry !== starting); },
        () => { this.#starting = this.#starting.filter((entry) => entry !== starting); },
      );
    }
    await Promise.all(this.#starting);
    if (this.#disposed) {
      throw new NecCancellationError("terminated");
    }
    const workers = this.#workers.slice(0, count);
    for (const worker of workers) {
      const pending = calls.slice(worker.replayed);
      worker.replayed = calls.length;
      worker.ready = worker.ready.then(async () => {
        for (const call of pending) await replay(worker.model, call);
      }).catch((error: unknown) => {
        this.#workers = this.#workers.filter((entry) => entry !== worker);
        worker.model.terminate();
        throw error;
      });
    }
    await Promise.all(workers.map((worker) => worker.ready));
    return workers;
  }

  /** Solve the scan states of a valid sweep on cells configured by `calls`. */
  async *sweep(calls: readonly PeriodicCellCall[], sweep: ValidSweep): AsyncGenerator<ScanSweepChunk> {
    const { frequencyMHz, scanStates, floquet, signal } = sweep;
    const total = scanStates.length;
    const cancelled = (): NecCancellationError =>
      new NecCancellationError("aborted", "The scan sweep was aborted");
    // A function, so that the check is not narrowed away after the first one.
    const isAborted = (): boolean => signal?.aborted === true;
    if (isAborted()) throw cancelled();
    if (total === 0) return;

    let stopped = false;
    let failure: { readonly error: unknown } | undefined;
    const finished: ScanSweepPoint[] = [];
    let wake: (() => void) | undefined;
    const notify = (): void => {
      wake?.();
      wake = undefined;
    };
    let rejectAborted: ((error: unknown) => void) | undefined;
    const aborted = new Promise<never>((_, reject) => { rejectAborted = reject; });
    aborted.catch(() => undefined);
    // Stops dispatch even if the consumer never pulls again.
    const abort = (): void => {
      stopped = true;
      rejectAborted?.(cancelled());
      notify();
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      // Abort also stops the wait for workers to start; they stay in the pool.
      const workers = await Promise.race([
        this.#acquire(workerCount(sweep.workers, total), calls),
        aborted,
      ]);

      let next = 0;
      const run = async (worker: SweepWorker): Promise<void> => {
        while (!stopped && next < total) {
          const index = next;
          next += 1;
          try {
            const result = await worker.model.computeScanImpedance({
              frequencyMHz,
              ...scanStates[index]!,
              ...floquet,
            });
            if (stopped) return;
            finished.push({ index, result });
          } catch (error) {
            if (!stopped && failure === undefined) failure = { error };
            stopped = true;
          }
          notify();
        }
      };
      for (const worker of workers) void run(worker);

      let completed = 0;
      while (completed < total) {
        if (isAborted()) throw cancelled();
        if (failure !== undefined) throw failure.error;
        if (finished.length === 0) {
          await new Promise<void>((resolve) => { wake = resolve; });
          continue;
        }
        const points = finished.splice(0);
        completed += points.length;
        yield Object.freeze({ points: Object.freeze(points), completed, total });
      }
    } finally {
      stopped = true;
      signal?.removeEventListener("abort", abort);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const worker of this.#workers) worker.model.terminate();
    this.#workers = [];
  }
}
