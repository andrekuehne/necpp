export {
  NecConditioningError,
  NecError,
  NecGeometryError,
  NecInputError,
  NecPortError,
  NecRuntimeError,
  NecSolverError,
  NecStateError,
} from "./errors.js";

export { abiVersion, engineVersion, packageVersion } from "./versions.js";

export type { NecErrorCode, NecErrorOptions } from "./errors.js";

export { createNecWorkerModel } from "./worker-client.js";

export type {
  AngleSweep,
  CartesianPointM,
  CompleteGeometryOptions,
  ComplexMatrix,
  ComplexVector,
  ConductivityLoad,
  CreateNecModelOptions,
  CreateNecWorkerModelOptions,
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
  NecModelState,
  NecWorkerModel,
  NecWorkerOperation,
  NecWorkerProgressEvent,
  NecWorkerProgressListener,
  ParallelRlcLoad,
  PerfectGround,
  PortDefinition,
  PortSolution,
  PrepareOptions,
  SegmentSelection,
  SeriesRlcLoad,
  WireDefinition,
} from "./types.js";
