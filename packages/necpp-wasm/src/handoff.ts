import { NecInputError } from "./errors.js";
import type {
  IsolatedElementCharacterization,
  IsolatedElementHandoff,
} from "./types.js";

export const ISOLATED_ELEMENT_HANDOFF_KIND =
  "isolated-element-characterization" as const;

export interface IsolatedElementHandoffMessage {
  readonly kind: typeof ISOLATED_ELEMENT_HANDOFF_KIND;
  readonly schemaVersion: 1;
  readonly impedance: IsolatedElementCharacterization["impedance"];
  readonly admittance: IsolatedElementCharacterization["admittance"];
  readonly quadrature: IsolatedElementCharacterization["quadrature"];
  readonly embeddedField: IsolatedElementCharacterization["embeddedField"];
}

function isMessagePort(value: unknown): value is MessagePort {
  return typeof value === "object"
    && value !== null
    && typeof (value as MessagePort).postMessage === "function";
}

function requireHandle(
  handle: IsolatedElementCharacterization["quadrature"],
  name: string,
): ArrayBuffer {
  if (
    handle === undefined
    || handle.schemaVersion !== 1
    || !Number.isInteger(handle.byteLength)
    || handle.byteLength < 0
    || !(handle.buffer instanceof ArrayBuffer)
    || handle.buffer.byteLength !== handle.byteLength
  ) {
    throw new NecInputError(`${name} is not a transferable packed handle`);
  }
  return handle.buffer;
}

/** Move large characterization buffers onto `destination`. Caller keeps Z/Y. */
export function transferIsolatedElementCharacterization(
  characterization: IsolatedElementCharacterization,
  destination: MessagePort,
): IsolatedElementHandoff {
  if (!isMessagePort(destination)) {
    throw new NecInputError("destination must be a MessagePort");
  }
  const quadratureBuffer = requireHandle(characterization.quadrature, "quadrature");
  const embeddedBuffer = requireHandle(
    characterization.embeddedField,
    "embeddedField",
  );
  const message: IsolatedElementHandoffMessage = {
    kind: ISOLATED_ELEMENT_HANDOFF_KIND,
    schemaVersion: 1,
    impedance: characterization.impedance,
    admittance: characterization.admittance,
    quadrature: characterization.quadrature,
    embeddedField: characterization.embeddedField,
  };
  destination.postMessage(message, [quadratureBuffer, embeddedBuffer]);
  return {
    impedance: characterization.impedance,
    admittance: characterization.admittance,
    quadratureByteLength: characterization.quadrature.byteLength,
    embeddedFieldByteLength: characterization.embeddedField.byteLength,
  };
}
