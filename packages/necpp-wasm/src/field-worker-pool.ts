import type { FarFieldEvaluationSnapshot } from "./model.js";
import { tileRequest, validateFarFieldSnapshot, type FarFieldTileResult } from "./field-evaluator.js";
import type { FarFieldRequest, FarFieldResult } from "./types.js";

interface WorkerHost {
  post(message: unknown, transfer?: ArrayBuffer[]): void;
  onMessage(handler: (message: unknown) => void): () => void;
  onFailure(handler: (error: Error) => void): () => void;
  terminate(): void;
}

export type FieldEvaluatorArtifactShape = "dedicated" | "full-nec";

async function openEvaluatorWorker(
  artifactShape: FieldEvaluatorArtifactShape,
  assetBaseUrl?: string,
): Promise<WorkerHost> {
  const workerUrl = assetBaseUrl === undefined
    ? new URL("./field-evaluator-worker.js", import.meta.url)
    : new URL("field-evaluator-worker.js", assetBaseUrl);
  workerUrl.searchParams.set("artifact", artifactShape);
  const runtime = globalThis as typeof globalThis & {
    process?: { versions?: { node?: string } };
  };
  if (typeof runtime.process?.versions?.node === "string") {
    const { Worker: NodeWorker } = await import("node:worker_threads");
    const worker = new NodeWorker(workerUrl);
    const earlyFailures: Error[] = [];
    const captureEarlyFailure = (error: Error) => { earlyFailures.push(error); };
    worker.on("error", captureEarlyFailure);
    return {
      post: (message, transfer = []) => worker.postMessage(message, transfer),
      onMessage(handler) {
        worker.on("message", handler);
        return () => worker.off("message", handler);
      },
      onFailure(handler) {
        const error = (value: Error) => handler(value);
        const exit = (code: number) => {
          if (code !== 0) handler(new Error(`Evaluator worker exited with code ${code}`));
        };
        worker.on("error", error);
        worker.on("exit", exit);
        worker.off("error", captureEarlyFailure);
        for (const failure of earlyFailures.splice(0)) handler(failure);
        return () => { worker.off("error", error); worker.off("exit", exit); };
      },
      terminate: () => {
        // A sibling startup failure may terminate this worker before its own
        // module-resolution error arrives. Keep that late error contained.
        worker.on("error", () => undefined);
        void worker.terminate();
      },
    };
  }
  // Keep the default constructor in Vite's statically analyzable form so the
  // nested worker, generated loader, and evaluator WASM are all emitted.
  const worker = assetBaseUrl === undefined
    ? new Worker(new URL("./field-evaluator-worker.js", import.meta.url), {
      type: "module",
    })
    : new Worker(workerUrl, { type: "module" });
  return {
    post: (message, transfer = []) => worker.postMessage(message, transfer),
    onMessage(handler) {
      const listener = (event: MessageEvent<unknown>) => handler(event.data);
      worker.addEventListener("message", listener);
      return () => worker.removeEventListener("message", listener);
    },
    onFailure(handler) {
      const listener = (event: ErrorEvent) => handler(event.error instanceof Error
        ? event.error : new Error(event.message));
      const messageListener = () => handler(new Error(
        "Evaluator worker could not deserialize a message",
      ));
      worker.addEventListener("error", listener);
      worker.addEventListener("messageerror", messageListener);
      return () => {
        worker.removeEventListener("error", listener);
        worker.removeEventListener("messageerror", messageListener);
      };
    },
    terminate: () => worker.terminate(),
  };
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

class EvaluatorSlot {
  readonly index: number;
  #host: WorkerHost | undefined;
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #removeMessage: (() => void) | undefined;
  #removeFailure: (() => void) | undefined;
  readonly artifactShape: FieldEvaluatorArtifactShape;
  readonly assetBaseUrl: string | undefined;

  constructor(
    index: number,
    artifactShape: FieldEvaluatorArtifactShape,
    assetBaseUrl?: string,
  ) {
    this.index = index;
    this.artifactShape = artifactShape;
    this.assetBaseUrl = assetBaseUrl;
  }

  async start(): Promise<void> {
    this.#host = await openEvaluatorWorker(this.artifactShape, this.assetBaseUrl);
    this.#removeMessage = this.#host.onMessage((message) => {
      const response = message as { id?: number; kind?: string; result?: unknown; message?: string };
      if (typeof response.id !== "number") return;
      const pending = this.#pending.get(response.id);
      if (pending === undefined) return;
      this.#pending.delete(response.id);
      if (response.kind === "error") pending.reject(new Error(response.message ?? "Evaluator failed"));
      else pending.resolve(response.result);
    });
    this.#removeFailure = this.#host.onFailure((error) => this.#fail(error));
  }

  #fail(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  request(message: Readonly<Record<string, unknown>>, transfer: ArrayBuffer[] = []): Promise<unknown> {
    if (this.#host === undefined) return Promise.reject(new Error("Evaluator is stopped"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try { this.#host?.post({ ...message, id }, transfer); }
      catch (error) {
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  terminate(): void {
    this.#removeMessage?.();
    this.#removeFailure?.();
    this.#fail(new Error("Evaluator was terminated"));
    this.#host?.terminate();
    this.#host = undefined;
  }
}

function cloneSnapshot(snapshot: FarFieldEvaluationSnapshot): FarFieldEvaluationSnapshot {
  return {
    ...snapshot,
    x: snapshot.x.slice(), y: snapshot.y.slice(), z: snapshot.z.slice(),
    cab: snapshot.cab.slice(), sab: snapshot.sab.slice(), salp: snapshot.salp.slice(),
    segmentHalfLengths: snapshot.segmentHalfLengths.slice(),
    air: snapshot.air.slice(), aii: snapshot.aii.slice(),
    bir: snapshot.bir.slice(), bii: snapshot.bii.slice(),
    cir: snapshot.cir.slice(), cii: snapshot.cii.slice(),
  };
}

function snapshotTransfers(snapshot: FarFieldEvaluationSnapshot): ArrayBuffer[] {
  return [snapshot.x, snapshot.y, snapshot.z, snapshot.cab, snapshot.sab,
    snapshot.salp, snapshot.segmentHalfLengths, snapshot.air, snapshot.aii,
    snapshot.bir, snapshot.bii, snapshot.cir, snapshot.cii]
    .map((value) => value.buffer as ArrayBuffer);
}

function currentUpdate(snapshot: FarFieldEvaluationSnapshot) {
  const air = snapshot.air.slice(); const aii = snapshot.aii.slice();
  const bir = snapshot.bir.slice(); const bii = snapshot.bii.slice();
  const cir = snapshot.cir.slice(); const cii = snapshot.cii.slice();
  return {
    message: { kind: "update-currents", solutionGeneration: snapshot.solutionGeneration,
      air, aii, bir, bii, cir, cii },
    transfer: [air, aii, bir, bii, cir, cii].map((value) => value.buffer as ArrayBuffer),
  };
}

export interface FarFieldPoolDiagnostics {
  readonly workers: number;
  readonly tileSize: number;
  readonly tiles: number;
  readonly snapshotBroadcastMs: number;
  readonly dispatchComputeTransferMs: number;
  readonly mergeMs: number;
  readonly totalMs: number;
  readonly workerComputeMs: number;
  readonly kernelMs: number;
  readonly completedTiles: number;
  readonly cancelledTiles: number;
  readonly cancelledJobs: number;
  readonly restartedWorkers: number;
  readonly snapshotBytesPerWorker: number;
  readonly geometryBytesPerWorker: number;
  readonly currentBytesPerWorker: number;
  readonly lastBroadcastBytesPerWorker: number;
  readonly geometryReused: boolean;
}

export interface PooledFarFieldResult extends FarFieldResult {
  readonly poolDiagnostics: FarFieldPoolDiagnostics;
}

export class StaleFarFieldJobError extends Error {
  constructor() { super("Far-field job was superseded by a newer generation"); }
}

/** Internal prewarmed evaluator pool owned by the array facade's outer worker. */
export class FarFieldWorkerPool {
  readonly workerCount: number;
  readonly tileSize: number;
  readonly artifactShape: FieldEvaluatorArtifactShape;
  readonly assetBaseUrl: string | undefined;
  #slots: EvaluatorSlot[] = [];
  #snapshot: FarFieldEvaluationSnapshot | undefined;
  #activeGeneration = 0;
  #snapshotBroadcastMs = 0;
  #lastBroadcastBytesPerWorker = 0;
  #geometryReused = false;
  #disposed = false;
  #restartedWorkers = 0;
  #warmupMs = 0;
  #cancelledTiles = 0;
  #cancelledJobs = 0;
  #activeJob: {
    readonly generation: number;
    readonly totalTiles: number;
    completedTiles: number;
    dispatchedTiles: number;
  } | undefined;

  constructor(
    workerCount: number,
    tileSize = 512,
    artifactShape: FieldEvaluatorArtifactShape = "dedicated",
    assetBaseUrl?: string,
  ) {
    if (!Number.isInteger(workerCount) || workerCount < 1 || workerCount > 8)
      throw new Error("Evaluator worker count must be from 1 through 8");
    if (!Number.isInteger(tileSize) || tileSize < 1) throw new Error("Tile size must be positive");
    this.workerCount = workerCount;
    this.tileSize = tileSize;
    this.artifactShape = artifactShape;
    this.assetBaseUrl = assetBaseUrl;
  }

  async prewarm(): Promise<void> {
    if (this.#disposed) throw new Error("Evaluator pool is disposed");
    if (this.#slots.length !== 0) return;
    const started = performance.now();
    this.#slots = Array.from(
      { length: this.workerCount },
      (_, index) => new EvaluatorSlot(
        index,
        this.artifactShape,
        this.assetBaseUrl,
      ),
    );
    try {
      await Promise.all(this.#slots.map((slot) => slot.start()));
      await Promise.all(this.#slots.map((slot) => slot.request({ kind: "ping" })));
      this.#warmupMs = performance.now() - started;
    } catch (error) {
      for (const slot of this.#slots) slot.terminate();
      this.#slots = [];
      throw error;
    }
  }

  async setSnapshot(snapshot: FarFieldEvaluationSnapshot): Promise<void> {
    validateFarFieldSnapshot(snapshot);
    await this.prewarm();
    this.cancelActive();
    if (this.#snapshot?.modelGeneration === snapshot.modelGeneration
        && this.#snapshot.solutionGeneration === snapshot.solutionGeneration) {
      this.#snapshot = snapshot;
      this.#snapshotBroadcastMs = 0;
      this.#geometryReused = true;
      this.#lastBroadcastBytesPerWorker = 0;
      return;
    }
    const started = performance.now();
    const reuseGeometry = this.#snapshot?.modelGeneration === snapshot.modelGeneration;
    await Promise.all(this.#slots.map(async (slot) => {
      if (reuseGeometry) {
        const update = currentUpdate(snapshot);
        await slot.request(update.message, update.transfer);
      } else {
        const copy = cloneSnapshot(snapshot);
        await slot.request({ kind: "configure", snapshot: copy }, snapshotTransfers(copy));
      }
    }));
    this.#snapshot = snapshot;
    this.#snapshotBroadcastMs = performance.now() - started;
    this.#geometryReused = reuseGeometry;
    this.#lastBroadcastBytesPerWorker = snapshot.segmentCount * (reuseGeometry ? 6 : 13) * 8;
  }

  async #restart(slotIndex: number): Promise<EvaluatorSlot> {
    this.#slots[slotIndex]?.terminate();
    const replacement = new EvaluatorSlot(
      slotIndex,
      this.artifactShape,
      this.assetBaseUrl,
    );
    await replacement.start();
    const snapshot = this.#snapshot;
    if (snapshot === undefined) throw new Error("No evaluator snapshot is available");
    const copy = cloneSnapshot(snapshot);
    await replacement.request({ kind: "configure", snapshot: copy }, snapshotTransfers(copy));
    this.#slots[slotIndex] = replacement;
    this.#restartedWorkers += 1;
    return replacement;
  }

  async computeFarField(request: FarFieldRequest): Promise<PooledFarFieldResult> {
    const snapshot = this.#snapshot;
    if (snapshot === undefined) throw new Error("Evaluator pool has no snapshot");
    const totalStarted = performance.now();
    const generation = ++this.#activeGeneration;
    const totalSamples = request.theta.count * request.phi.count;
    const tiles = [] as Array<{ start: number; count: number }>;
    for (let start = 0; start < totalSamples; start += this.tileSize) {
      tiles.push({ start, count: Math.min(this.tileSize, totalSamples - start) });
    }
    const eThetaReal = new Float64Array(totalSamples);
    const eThetaImag = new Float64Array(totalSamples);
    const ePhiReal = new Float64Array(totalSamples);
    const ePhiImag = new Float64Array(totalSamples);
    let nextTile = 0;
    let workerComputeMs = 0;
    const computeByWorker = new Float64Array(this.workerCount);
    const activeJob = {
      generation,
      totalTiles: tiles.length,
      completedTiles: 0,
      dispatchedTiles: 0,
    };
    this.#activeJob = activeJob;
    const dispatchStarted = performance.now();
    const run = async (initialSlot: EvaluatorSlot): Promise<void> => {
      let slot = initialSlot;
      while (generation === this.#activeGeneration) {
        const tileIndex = nextTile++;
        const tile = tiles[tileIndex];
        if (tile === undefined) return;
        activeJob.dispatchedTiles += 1;
        const message = { kind: "evaluate", tile: tileRequest(
          request, tile.start, tile.count, generation, snapshot.solutionGeneration,
        ) };
        let result: FarFieldTileResult;
        try { result = await slot.request(message) as FarFieldTileResult; }
        catch {
          if (generation !== this.#activeGeneration) throw new StaleFarFieldJobError();
          slot = await this.#restart(slot.index);
          result = await slot.request(message) as FarFieldTileResult;
        }
        if (!(result.eThetaReal instanceof Float64Array)
            || !(result.eThetaImag instanceof Float64Array)
            || !(result.ePhiReal instanceof Float64Array)
            || !(result.ePhiImag instanceof Float64Array)
            || result.count !== tile.count || result.start !== tile.start
            || result.eThetaReal.length !== tile.count
            || result.eThetaImag.length !== tile.count
            || result.ePhiReal.length !== tile.count
            || result.ePhiImag.length !== tile.count
            || !Number.isFinite(result.computeMs) || result.computeMs < 0) {
          throw new Error("Evaluator returned an invalid field tile");
        }
        if (generation !== this.#activeGeneration
            || result.jobGeneration !== generation
            || result.solutionGeneration !== snapshot.solutionGeneration) {
          throw new StaleFarFieldJobError();
        }
        workerComputeMs += result.computeMs;
        computeByWorker[slot.index] = (computeByWorker[slot.index] ?? 0)
          + result.computeMs;
        eThetaReal.set(result.eThetaReal, result.start);
        eThetaImag.set(result.eThetaImag, result.start);
        ePhiReal.set(result.ePhiReal, result.start);
        ePhiImag.set(result.ePhiImag, result.start);
        activeJob.completedTiles += 1;
      }
      throw new StaleFarFieldJobError();
    };
    try {
      await Promise.all(this.#slots.map(run));
      if (generation !== this.#activeGeneration) throw new StaleFarFieldJobError();
    } finally {
      if (this.#activeJob?.generation === generation) this.#activeJob = undefined;
    }
    for (const values of [eThetaReal, eThetaImag, ePhiReal, ePhiImag]) {
      if (!values.every(Number.isFinite)) {
        throw new Error("Evaluator returned a nonfinite field result");
      }
    }
    const dispatchComputeTransferMs = performance.now() - dispatchStarted;
    const mergeStarted = performance.now();
    const thetaDeg = Float64Array.from({ length: request.theta.count }, (_, index) =>
      request.theta.startDeg + index * request.theta.stepDeg);
    const phiDeg = Float64Array.from({ length: request.phi.count }, (_, index) =>
      request.phi.startDeg + index * request.phi.stepDeg);
    const mergeMs = performance.now() - mergeStarted;
    const snapshotBytesPerWorker = snapshot.segmentCount * 13 * 8;
    const geometryBytesPerWorker = snapshot.segmentCount * 7 * 8;
    const currentBytesPerWorker = snapshot.segmentCount * 6 * 8;
    return {
      radiusM: request.radiusM ?? 1,
      frequencyMHz: snapshot.frequencyMHz,
      thetaDeg, phiDeg, eThetaReal, eThetaImag, ePhiReal, ePhiImag,
      poolDiagnostics: {
        workers: this.workerCount, tileSize: this.tileSize, tiles: tiles.length,
        snapshotBroadcastMs: this.#snapshotBroadcastMs,
        dispatchComputeTransferMs, mergeMs,
        totalMs: performance.now() - totalStarted,
        workerComputeMs,
        kernelMs: Math.max(...computeByWorker),
        completedTiles: activeJob.completedTiles,
        cancelledTiles: this.#cancelledTiles,
        cancelledJobs: this.#cancelledJobs,
        restartedWorkers: this.#restartedWorkers,
        snapshotBytesPerWorker, geometryBytesPerWorker, currentBytesPerWorker,
        lastBroadcastBytesPerWorker: this.#lastBroadcastBytesPerWorker,
        geometryReused: this.#geometryReused,
      },
    };
  }

  /** Test hook used to prove recovery without exposing failure injection publicly. */
  terminateEvaluatorForTest(index: number): void { this.#slots[index]?.terminate(); }

  get warmupMs(): number { return this.#warmupMs; }

  /** Stop assigning tiles to the active generation. In-flight tiles are bounded by worker count. */
  cancelActive(): void {
    const active = this.#activeJob;
    if (active !== undefined && active.generation === this.#activeGeneration) {
      this.#cancelledJobs += 1;
      this.#cancelledTiles += active.totalTiles - active.completedTiles;
    }
    this.#activeGeneration += 1;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.cancelActive();
    for (const slot of this.#slots) slot.terminate();
    this.#slots = [];
    this.#snapshot = undefined;
  }
}
