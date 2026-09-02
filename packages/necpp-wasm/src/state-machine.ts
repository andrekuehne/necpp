import { NecStateError } from "./errors.js";
import type { NecModelState } from "./types.js";

export type ModelOperation =
  | "addWire"
  | "completeGeometry"
  | "definePorts"
  | "addLoad"
  | "clearLoads"
  | "setGround"
  | "prepare"
  | "computeImpedanceMatrix"
  | "solveVoltages"
  | "solveCurrents"
  | "computeFarField"
  | "computeEmbeddedFarFields"
  | "getCurrentDistribution"
  | "prepareCurrentQuadrature"
  | "characterizeIsolatedElement"
  | "dispose";

export interface ConditionalTransition {
  readonly configurationChanged: NecModelState;
  readonly configurationUnchanged: NecModelState;
}

type TransitionTarget = NecModelState | ConditionalTransition;
type TransitionRow = Readonly<Partial<Record<NecModelState, TransitionTarget>>>;

export interface TransitionOptions {
  /** Relevant only to `prepare`; defaults to true for conservative invalidation. */
  readonly configurationChanged?: boolean;
}

/** Executable form of the normative lifecycle table in docs/wasm-api.md. */
export const MODEL_TRANSITIONS: Readonly<Record<ModelOperation, TransitionRow>> = {
  addWire: {
    empty: "geometry-building",
    "geometry-building": "geometry-building",
  },
  completeGeometry: {
    "geometry-building": "geometry-complete",
  },
  definePorts: {
    "geometry-complete": "geometry-complete",
  },
  addLoad: {
    "geometry-complete": "geometry-complete",
    prepared: "geometry-complete",
    solved: "geometry-complete",
  },
  clearLoads: {
    "geometry-complete": "geometry-complete",
    prepared: "geometry-complete",
    solved: "geometry-complete",
  },
  setGround: {
    "geometry-complete": "geometry-complete",
    prepared: "geometry-complete",
    solved: "geometry-complete",
  },
  prepare: {
    "geometry-complete": "prepared",
    prepared: "prepared",
    solved: {
      configurationChanged: "prepared",
      configurationUnchanged: "solved",
    },
  },
  computeImpedanceMatrix: {
    prepared: "prepared",
    solved: "solved",
  },
  solveVoltages: {
    prepared: "solved",
    solved: "solved",
  },
  solveCurrents: {
    prepared: "solved",
    solved: "solved",
  },
  computeFarField: {
    solved: "solved",
  },
  computeEmbeddedFarFields: {
    prepared: "prepared",
    solved: "solved",
  },
  getCurrentDistribution: {
    prepared: "prepared",
    solved: "solved",
  },
  prepareCurrentQuadrature: {
    prepared: "prepared",
    solved: "solved",
  },
  characterizeIsolatedElement: {
    prepared: "prepared",
    solved: "solved",
  },
  dispose: {
    empty: "disposed",
    "geometry-building": "disposed",
    "geometry-complete": "disposed",
    prepared: "disposed",
    solved: "disposed",
    disposed: "disposed",
  },
};

export function transitionModelState(
  state: NecModelState,
  operation: ModelOperation,
  options: TransitionOptions = {},
): NecModelState {
  const target = MODEL_TRANSITIONS[operation][state];
  if (target === undefined) {
    throw new NecStateError(operation, state);
  }
  if (typeof target === "string") {
    return target;
  }
  return options.configurationChanged === false
    ? target.configurationUnchanged
    : target.configurationChanged;
}
