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
export { rotationalOrder } from "./symmetry.js";
export { analyzeArraySymmetry, createExplicitArrayBuildPlan } from "./array-symmetry.js";
export {
  applyArrayBuildPlan,
  createNecArraySolver,
  gatherComplexMatrix,
  gatherComplexVector,
  gatherEmbeddedBasis,
  rephaseFarField,
  scatterComplexVector,
} from "./array-solver.js";
export type { AppliedArrayBuildPlan } from "./array-solver.js";

export type { NecErrorCode, NecErrorOptions } from "./errors.js";

export type {
  AngleSweep,
  ArrayBuildPlan,
  ArrayElementId,
  ArrayElementMapping,
  ArraySolverDiagnostics,
  CartesianSignsTransform,
  CartesianPointM,
  CanonicalArrayElement,
  CompleteGeometryOptions,
  ComplexMatrix,
  ComplexVector,
  ConductivityLoad,
  CreateArraySolverOptions,
  CreateNecModelOptions,
  CreateNecWorkerModelOptions,
  DeckResult,
  DistributedParallelRlcLoad,
  DistributedSeriesRlcLoad,
  EmbeddedFarFieldResult,
  EmbeddedFieldNormalization,
  ElementWirePattern,
  FarFieldRequest,
  FarFieldResult,
  FiniteGround,
  FreeSpaceGround,
  FullArrayDescription,
  GeometryCompletionResult,
  GeometrySymmetry,
  GroundConnection,
  GroundModel,
  ImpedanceLoad,
  ImpedanceResult,
  LoadDefinition,
  NecArraySolver,
  NecModel,
  NecModelState,
  NecWorkerModel,
  NecWorkerOperation,
  NecWorkerProgressEvent,
  NecWorkerProgressListener,
  ParallelRlcLoad,
  PerfectGround,
  PortDefinition,
  PortSolution,
  PowerBudget,
  PositionCanonicalization,
  PositionedArrayElement,
  PrepareOptions,
  ReflectionPlane,
  ReflectionSymmetry,
  RelativeLoadDefinition,
  RelativePortDefinition,
  RelativeSegmentSelection,
  RelativeWireDefinition,
  RotationalOrder,
  RotationalSymmetry,
  RotateZTransform,
  RunDeckOptions,
  SegmentSelection,
  SeriesRlcLoad,
  SymmetryCopy,
  SymmetryCopyTransform,
  SymmetryExpansion,
  SymmetryFailureClassification,
  SymmetryFailureReason,
  SymmetrizationReason,
  SymmetrizationReasonCode,
  SymmetrizerDiagnostics,
  SymmetrizerOptions,
  SymmetryCandidateDiagnostics,
  WireDefinition,
} from "./types.js";

import { runDeckWithModule, validateDeckText } from "./deck.js";
import { NecInputError } from "./errors.js";
import { instantiateNecModule } from "./loader.js";
import { createModelFromModule } from "./model.js";
import type {
  CreateNecModelOptions,
  DeckResult,
  NecModel,
  RunDeckOptions,
} from "./types.js";

/** Create an isolated stateful NEC model backed by a new WASM module instance. */
export async function createNecModel(
  options?: CreateNecModelOptions,
): Promise<NecModel> {
  const module = await instantiateNecModule(options);
  return createModelFromModule(module);
}

/** Compatibility escape hatch for complete NEC text decks. */
export async function runDeck(
  deck: string,
  options?: RunDeckOptions,
): Promise<DeckResult> {
  validateDeckText(deck);
  if (options?.signal?.aborted === true) {
    throw new NecInputError("Deck execution was aborted before it started", {
      details: { operation: "runDeck", aborted: true },
    });
  }
  const module = await instantiateNecModule(options);
  return runDeckWithModule(module, deck, options);
}
