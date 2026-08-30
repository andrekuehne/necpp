import { NecInputError } from "./errors.js";
import type { RotationalOrder } from "./types.js";

const INT32_MAX = 2_147_483_647;

/**
 * Validate and brand an N-fold rotational section count for geometry symmetry.
 * The native ABI represents the value as a signed 32-bit integer.
 */
export function rotationalOrder(order: number): RotationalOrder {
  if (!Number.isSafeInteger(order) || order < 2 || order > INT32_MAX) {
    throw new NecInputError(
      "Rotational symmetry order must be an integer from 2 through 2147483647",
      { details: { symmetryFailure: "INVALID_SYMMETRY", order } },
    );
  }
  return order as RotationalOrder;
}
