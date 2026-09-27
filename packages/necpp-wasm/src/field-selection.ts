import { NecInputError, NecRuntimeError } from "./errors.js";
import type { FarFieldEvaluator, FieldEvaluationDiagnostics } from "./types.js";

export function selectEvaluator(
  value: unknown,
  fallback: FarFieldEvaluator = "exact",
): FarFieldEvaluator {
  if (value === undefined) return fallback;
  if (value !== "exact" && value !== "ring") {
    throw new NecInputError('evaluator must be "exact" or "ring"');
  }
  return value;
}

export function evaluationMetadata(
  directions: number,
  rings: number,
  direct: number,
  bound: number,
  reason?: string,
): FieldEvaluationDiagnostics {
  return Object.freeze({
    evaluator: "ring-bandlimited-v1",
    execution: rings === 0 ? "exact" : direct > 0 ? "mixed" : "ring",
    interpolatedRings: rings,
    directRings: direct,
    evaluatedDirections: directions,
    truncationBound: bound,
    ...(reason === undefined ? {} : { fallbackReason: reason }),
  });
}

// Matches the reason codes in nec_ring::Stats. These describe evaluator
// fallback, independently of fieldBackend's worker scheduling fallback.
export const ringReasons = [
  undefined,
  "nonperiodic-grid",
  "unsupported-model",
  "unusable-error-budget",
  "no-sample-reduction",
  "estimated-direct-cheaper",
] as const;

export function reviveEvaluation(
  value: unknown,
): { fieldEvaluation?: FieldEvaluationDiagnostics } {
  if (value === undefined) return {};
  const record = value as FieldEvaluationDiagnostics;
  if (
    record === null
    || record.evaluator !== "ring-bandlimited-v1"
    || !["exact", "mixed", "ring"].includes(record.execution)
    || ![record.interpolatedRings, record.directRings, record.evaluatedDirections]
      .every((number) => Number.isSafeInteger(number) && number >= 0)
    || !Number.isFinite(record.truncationBound)
    || record.truncationBound < 0
    || (record.fallbackReason !== undefined && typeof record.fallbackReason !== "string")
  ) {
    throw new NecRuntimeError("Invalid field evaluator metadata");
  }
  const result = evaluationMetadata(
    record.evaluatedDirections, record.interpolatedRings, record.directRings,
    record.truncationBound, record.fallbackReason,
  );
  if (result.execution !== record.execution) {
    throw new NecRuntimeError("Inconsistent field evaluator metadata");
  }
  return { fieldEvaluation: result };
}
