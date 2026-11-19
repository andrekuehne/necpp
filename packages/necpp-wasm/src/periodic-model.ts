import { NecStateError } from "./errors.js";
import { instantiateNecModule } from "./loader.js";
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
  PeriodicLattice,
  PortDefinition,
  ScanImpedanceRequest,
  ScanImpedanceResult,
  ScanPhasesRad,
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
  #lattice: PeriodicLattice | undefined;

  constructor(cell: WasmNecModel) {
    this.#cell = cell;
  }

  get state(): NecModelState {
    return this.#cell.state;
  }

  addWire(wire: WireDefinition): void {
    this.#cell.addWire(wire);
  }

  completeGeometry(): void {
    this.#cell.completeGeometry();
  }

  definePorts(ports: readonly PortDefinition[]): void {
    this.#cell.definePorts(ports);
  }

  addLoad(load: LoadDefinition): void {
    this.#cell.addLoad(load);
  }

  clearLoads(): void {
    this.#cell.clearLoads();
  }

  setLattice(lattice: PeriodicLattice): void {
    const valid = validLattice(lattice, "lattice");
    this.#cell[setLatticeEntry](valid.a1M, valid.a2M);
    this.#lattice = valid;
  }

  computeScanImpedance(request: ScanImpedanceRequest): ScanImpedanceResult {
    const lattice = this.#lattice;
    if (this.state === "disposed" || lattice === undefined) {
      throw new NecStateError(
        "computeScanImpedance",
        this.state,
        this.state === "disposed"
          ? undefined
          : "computeScanImpedance requires a lattice; call setLattice first",
      );
    }
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

  dispose(): void {
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

export function createPeriodicModelFromModule(module: NecWasmModule): NecPeriodicModel {
  return new WasmNecPeriodicModel(createModelFromModule(module) as WasmNecModel);
}

/** Create the unit cell of an infinite periodic array, backed by a new WASM module instance. */
export async function createNecPeriodicModel(
  options?: WasmAssetOptions,
): Promise<NecPeriodicModel> {
  const module = await instantiateNecModule(options);
  return createPeriodicModelFromModule(module);
}
