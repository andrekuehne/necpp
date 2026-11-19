import { NecStateError } from "./errors.js";
import { instantiateNecModule } from "./loader.js";
import {
  WasmNecModel,
  createModelFromModule,
  inputError,
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
  WasmAssetOptions,
  WireDefinition,
} from "./types.js";
import type { NecWasmModule } from "./wasm-internal.js";

function finitePair(value: unknown, name: string): readonly [number, number] {
  if (
    !Array.isArray(value)
    || value.length !== 2
    || !value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  ) {
    inputError(`${name} must be a pair of finite numbers`, { name, value });
  }
  return Object.freeze([value[0] as number, value[1] as number]);
}

/**
 * The unit cell of an infinite array. It owns a finite model whose interaction
 * matrix carries the periodic correction, and exposes only the operations that
 * make sense for one cell of an infinite array.
 */
export class WasmNecPeriodicModel implements NecPeriodicModel {
  readonly #cell: WasmNecModel;
  #hasLattice = false;

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
    const record = requireRecord(lattice, "lattice");
    const a1M = finitePair(record.a1M, "lattice.a1M");
    const a2M = finitePair(record.a2M, "lattice.a2M");
    this.#cell[setLatticeEntry](a1M, a2M);
    this.#hasLattice = true;
  }

  computeScanImpedance(request: ScanImpedanceRequest): ScanImpedanceResult {
    if (this.state === "disposed" || !this.#hasLattice) {
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
    const scanPhasesRad = finitePair(record.scanPhasesRad, "request.scanPhasesRad");

    this.#cell[setScanPhasesEntry](scanPhasesRad);
    this.#cell.prepare({ frequencyMHz });
    const result = this.#cell.computeImpedanceMatrix();
    return {
      impedance: result.impedance,
      admittance: result.admittance,
      frequencyMHz: result.frequencyMHz,
      scanPhasesRad,
    };
  }

  dispose(): void {
    this.#cell.dispose();
  }
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
