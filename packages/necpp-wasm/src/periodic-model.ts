import { NecStateError } from "./errors.js";
import { instantiateNecModule } from "./loader.js";
import { validFloquetRequest } from "./periodic-floquet.js";
import { validLayeredStacks } from "./periodic-stack.js";
import { ScanSweepPool, recordedCall, validSweep, type PeriodicCellCall } from "./periodic-sweep.js";
import { computeScanElementPattern, validPatternRequest } from "./scan-element-pattern.js";
import { copyAssetOptions, createNecPeriodicWorkerModel } from "./worker-client.js";
import {
  finitePair,
  scanPhasesForDirection,
  validLattice,
  validPeriodicGeometryOptions,
  validScanDirection,
} from "./periodic-lattice.js";
import {
  WasmNecModel,
  createModelFromModule,
  floquetAmplitudesEntry,
  inputError,
  periodicDiagnosticsEntry,
  positiveNumber,
  requireRecord,
  setLatticeEntry,
  setLayeredStacksEntry,
  setScanPhasesEntry,
} from "./model.js";
import type {
  LayeredStacks,
  LoadDefinition,
  NecModelState,
  NecPeriodicModel,
  PeriodicGeometryOptions,
  PeriodicGround,
  PeriodicLattice,
  PortDefinition,
  ScanElementPattern,
  ScanElementPatternOptions,
  ScanElementPatternRequest,
  ScanImpedanceRequest,
  ScanImpedanceResult,
  ScanPhasesRad,
  ScanSweepChunk,
  ScanSweepOptions,
  ScanSweepRequest,
  WasmAssetOptions,
  WireDefinition,
} from "./types.js";
import type { NecWasmModule } from "./wasm-internal.js";

/**
 * The unit cell of an infinite array. It owns a finite model whose interaction
 * matrix carries the periodic correction, and exposes only the operations that
 * make sense for one cell of an infinite array.
 */
export class WasmNecPeriodicModel implements NecPeriodicModel {
  readonly #cell: WasmNecModel;
  readonly #assets: WasmAssetOptions | undefined;
  #lattice: PeriodicLattice | undefined;
  // The configuration calls that succeeded, replayed by the sweep workers.
  readonly #calls: PeriodicCellCall[] = [];
  #sweepPool: ScanSweepPool | undefined;

  constructor(cell: WasmNecModel, assets?: WasmAssetOptions) {
    this.#cell = cell;
    this.#assets = assets;
  }

  get state(): NecModelState {
    return this.#cell.state;
  }

  addWire(wire: WireDefinition): void {
    this.#cell.addWire(wire);
    this.#calls.push(recordedCall({ method: "addWire", argument: wire }));
  }

  completeGeometry(options?: PeriodicGeometryOptions): void {
    const valid = validPeriodicGeometryOptions(options);
    this.#cell.completeGeometry(valid);
    this.#calls.push(recordedCall({ method: "completeGeometry", argument: valid }));
  }

  definePorts(ports: readonly PortDefinition[]): void {
    this.#cell.definePorts(ports);
    this.#calls.push(recordedCall({ method: "definePorts", argument: ports }));
  }

  addLoad(load: LoadDefinition): void {
    this.#cell.addLoad(load);
    this.#calls.push(recordedCall({ method: "addLoad", argument: load }));
  }

  clearLoads(): void {
    this.#cell.clearLoads();
    this.#calls.push({ method: "clearLoads" });
  }

  setGround(ground: PeriodicGround): void {
    this.#cell.setGround(ground);
    this.#calls.push(recordedCall({ method: "setGround", argument: ground }));
  }

  setLattice(lattice: PeriodicLattice): void {
    const valid = validLattice(lattice, "lattice");
    this.#cell[setLatticeEntry](valid.a1M, valid.a2M);
    this.#lattice = valid;
    this.#calls.push(recordedCall({ method: "setLattice", argument: valid }));
  }

  setLayeredStacks(stacks: LayeredStacks): void {
    const valid = validLayeredStacks(stacks, "stacks");
    this.#cell[setLayeredStacksEntry](valid);
    this.#calls.push(recordedCall({ method: "setLayeredStacks", argument: valid }));
  }

  #requireLattice(
    operation: "computeScanImpedance" | "sweepScanImpedance" | "computeScanElementPattern",
  ): PeriodicLattice {
    const lattice = this.#lattice;
    if (this.state === "disposed" || lattice === undefined) {
      throw new NecStateError(
        operation,
        this.state,
        this.state === "disposed"
          ? undefined
          : `${operation} requires a lattice; call setLattice first`,
      );
    }
    return lattice;
  }

  computeScanImpedance(request: ScanImpedanceRequest): ScanImpedanceResult {
    const lattice = this.#requireLattice("computeScanImpedance");
    const record = requireRecord(request, "request");
    const frequencyMHz = positiveNumber(record.frequencyMHz, "request.frequencyMHz");
    const scanPhasesRad = requestedScanPhases(record, lattice, frequencyMHz);
    const floquetRequest = validFloquetRequest(record, "request");

    this.#cell[setScanPhasesEntry](scanPhasesRad);
    this.#cell.prepare({ frequencyMHz });
    const result = this.#cell.computeImpedanceMatrix();
    return {
      impedance: result.impedance,
      admittance: result.admittance,
      frequencyMHz: result.frequencyMHz,
      scanPhasesRad,
      diagnostics: this.#cell[periodicDiagnosticsEntry](),
      floquet: this.#cell[floquetAmplitudesEntry](floquetRequest),
    };
  }

  sweepScanImpedance(
    request: ScanSweepRequest,
    options?: ScanSweepOptions,
  ): AsyncIterable<ScanSweepChunk> {
    this.#requireLattice("sweepScanImpedance");
    const sweep = validSweep(request, options);
    const assets = this.#assets;
    this.#sweepPool ??= new ScanSweepPool(() => createNecPeriodicWorkerModel(assets));
    return this.#sweepPool.sweep(this.#calls.slice(), sweep);
  }

  async computeScanElementPattern(
    request: ScanElementPatternRequest,
    options?: ScanElementPatternOptions,
  ): Promise<ScanElementPattern> {
    const lattice = this.#requireLattice("computeScanElementPattern");
    const valid = validPatternRequest(request, options);
    // Every round sweeps the cell as of this call, whatever changes meanwhile.
    const calls = this.#calls.slice();
    const assets = this.#assets;
    this.#sweepPool ??= new ScanSweepPool(() => createNecPeriodicWorkerModel(assets));
    const pool = this.#sweepPool;
    return computeScanElementPattern(
      lattice,
      (sweepRequest, sweepOptions) => pool.sweep(calls, validSweep(sweepRequest, sweepOptions)),
      valid,
      options,
    );
  }

  dispose(): void {
    this.#sweepPool?.dispose();
    this.#sweepPool = undefined;
    this.#cell.dispose();
  }
}

/** Scan phases from exactly one of `scanPhasesRad` and `scanDirection`. */
function requestedScanPhases(
  request: Readonly<Record<string, unknown>>,
  lattice: PeriodicLattice,
  frequencyMHz: number,
): ScanPhasesRad {
  const hasPhases = request.scanPhasesRad !== undefined;
  const hasDirection = request.scanDirection !== undefined;
  if (hasPhases === hasDirection) {
    inputError("request needs exactly one of scanPhasesRad and scanDirection", {
      name: "request",
    });
  }
  if (hasPhases) {
    return finitePair(request.scanPhasesRad, "request.scanPhasesRad");
  }
  const direction = validScanDirection(request.scanDirection, "request.scanDirection");
  return scanPhasesForDirection({ lattice, frequencyMHz, ...direction });
}

export function createPeriodicModelFromModule(
  module: NecWasmModule,
  assets?: WasmAssetOptions,
): NecPeriodicModel {
  return new WasmNecPeriodicModel(createModelFromModule(module) as WasmNecModel, assets);
}

/** Create the unit cell of an infinite periodic array, backed by a new WASM module instance. */
export async function createNecPeriodicModel(
  options?: WasmAssetOptions,
): Promise<NecPeriodicModel> {
  const module = await instantiateNecModule(options);
  return createPeriodicModelFromModule(module, copyAssetOptions(options));
}
