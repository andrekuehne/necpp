export {
  NecConditioningError,
  NecError,
  NecGeometryError,
  NecInputError,
  NecPortError,
  NecRuntimeError,
  NecSolverError,
  NecStateError,
} from "./errors.ts";

export type { NecErrorCode, NecErrorOptions } from "./errors.ts";

export type {
  AngleSweep,
  CartesianPointM,
  CompleteGeometryOptions,
  ComplexMatrix,
  ComplexVector,
  ConductivityLoad,
  CreateNecModelOptions,
  DeckResult,
  DistributedParallelRlcLoad,
  DistributedSeriesRlcLoad,
  EmbeddedFarFieldResult,
  EmbeddedFieldNormalization,
  FarFieldRequest,
  FarFieldResult,
  FiniteGround,
  FreeSpaceGround,
  GroundConnection,
  GroundModel,
  ImpedanceLoad,
  ImpedanceResult,
  LoadDefinition,
  NecModel,
  NecModelState,
  ParallelRlcLoad,
  PerfectGround,
  PortDefinition,
  PortSolution,
  PrepareOptions,
  RunDeckOptions,
  SegmentSelection,
  SeriesRlcLoad,
  WireDefinition,
} from "./types.ts";

import type {
  CreateNecModelOptions,
  DeckResult,
  NecModel,
  RunDeckOptions,
} from "./types.ts";

/** WP0 contract declaration. The runtime factory is implemented in WP5. */
export declare function createNecModel(options?: CreateNecModelOptions): Promise<NecModel>;

/** Compatibility escape hatch for complete NEC text decks. */
export declare function runDeck(deck: string, options?: RunDeckOptions): Promise<DeckResult>;
