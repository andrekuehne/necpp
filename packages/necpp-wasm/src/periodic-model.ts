import { NecStateError } from "./errors.js";
import { instantiateNecModule } from "./loader.js";
import { ScanSweepPool, recordedCall, validSweep, type PeriodicCellCall } from "./periodic-sweep.js";
import { copyAssetOptions, createNecPeriodicWorkerModel } from "./worker-client.js";
import {
  finitePair,
  scanPhasesForDirection,
  validLattice,
  validScanDirection,
} from "./periodic-lattice.js";
import {
  WasmNecModel,
  createModelFromModule,
  inputError,
  periodicDiagnosticsEntry,
  positiveNumber,
  requireRecord,
  setLatticeEntry,
  setScanPhasesEntry,
} from "./model.js";
import type {
  LoadDefinition,
  NecModelState,
  NecPeriodicModel,
  PeriodicGround,
  PeriodicLattice,
  PortDefinition,
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

  completeGeometry(): void {
    this.#cell.completeGeometry();
    this.#calls.push({ method: "completeGeometry" });
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

  #requireLattice(operation: "computeScanImpedance" | "sweepScanImpedance"): PeriodicLattice {
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

    this.#cell[setScanPhasesEntry](scanPhasesRad);
    this.#cell.prepare({ frequencyMHz });
    const result = this.#cell.computeImpedanceMatrix();
    return {
      impedance: result.impedance,
      admittance: result.admittance,
      frequencyMHz: result.frequencyMHz,
      scanPhasesRad,
      diagnostics: this.#cell[periodicDiagnosticsEntry](),
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
