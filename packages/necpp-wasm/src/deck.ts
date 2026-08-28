import {
  NecConditioningError,
  NecGeometryError,
  NecInputError,
  NecPortError,
  NecRuntimeError,
  NecSolverError,
} from "./errors.js";
import type { DeckResult, RunDeckOptions } from "./types.js";
import type { NecWasmModule } from "./wasm-internal.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function decodeBytes(
  module: NecWasmModule,
  pointer: number,
  length: number,
): string {
  if (
    !Number.isSafeInteger(pointer)
    || pointer < 0
    || !Number.isSafeInteger(length)
    || length < 0
    || pointer + length > module.HEAPU8.length
  ) {
    throw new NecRuntimeError("The native deck runner returned an invalid buffer");
  }
  return textDecoder.decode(module.HEAPU8.slice(pointer, pointer + length));
}

function decodeCString(module: NecWasmModule, pointer: number): string {
  if (
    !Number.isSafeInteger(pointer)
    || pointer <= 0
    || pointer >= module.HEAPU8.length
  ) {
    throw new NecRuntimeError("The native module returned an invalid string");
  }
  const end = module.HEAPU8.indexOf(0, pointer);
  if (end < 0) {
    throw new NecRuntimeError("The native module returned an unterminated string");
  }
  return decodeBytes(module, pointer, end - pointer);
}

function deckError(module: NecWasmModule, deck: number, status: number): never {
  let message = `Deck execution failed with native status ${status}`;
  try {
    const nativeMessage = decodeCString(
      module,
      module._necpp_wasm_v1_deck_last_error(deck),
    );
    if (nativeMessage.length > 0) {
      message = nativeMessage;
    }
  } catch {
    // Keep the stable fallback message.
  }
  const details = { operation: "runDeck", nativeStatus: status };
  switch (status) {
  case 2:
    throw new NecInputError(message, { details });
  case 3:
    throw new NecGeometryError(message, { details });
  case 4:
    throw new NecPortError(message, { details });
  case 5:
    throw new NecConditioningError(message, { details });
  case 6:
    throw new NecSolverError(message, { details });
  default:
    throw new NecRuntimeError(message, { details });
  }
}

function assertNotAborted(options: RunDeckOptions | undefined): void {
  if (options?.signal?.aborted === true) {
    throw new NecInputError("Deck execution was aborted before it started", {
      details: { operation: "runDeck", aborted: true },
    });
  }
}

export function validateDeckText(deckText: unknown): asserts deckText is string {
  if (typeof deckText !== "string" || deckText.length === 0) {
    throw new NecInputError("deck must be a nonempty string");
  }
  if (deckText.includes("\0")) {
    throw new NecInputError("deck cannot contain embedded NUL characters");
  }
}

export function runDeckWithModule(
  module: NecWasmModule,
  deckText: string,
  options?: RunDeckOptions,
): DeckResult {
  assertNotAborted(options);
  validateDeckText(deckText);
  const bytes = textEncoder.encode(deckText);
  if (bytes.length === 0) {
    throw new NecInputError("deck must contain UTF-8 input");
  }

  let deck = 0;
  let inputPointer = 0;
  try {
    deck = module._necpp_wasm_v1_deck_create();
    if (!Number.isSafeInteger(deck) || deck <= 0) {
      throw new NecRuntimeError("Failed to create the native deck runner");
    }
    inputPointer = module._malloc(bytes.length);
    if (!Number.isSafeInteger(inputPointer) || inputPointer <= 0) {
      throw new NecRuntimeError("WASM memory allocation failed");
    }
    module.HEAPU8.set(bytes, inputPointer);
    assertNotAborted(options);
    const status = module._necpp_wasm_v1_deck_process(
      deck,
      inputPointer,
      bytes.length,
    );
    if (status !== 0) {
      deckError(module, deck, status);
    }
    const reportLength = module._necpp_wasm_v1_deck_output_length(deck);
    const report = decodeBytes(
      module,
      module._necpp_wasm_v1_deck_output(deck),
      reportLength,
    );
    const engineVersion = decodeCString(
      module,
      module._necpp_wasm_v1_engine_version(),
    );
    return { report, engineVersion };
  } catch (error) {
    if (
      error instanceof NecInputError
      || error instanceof NecGeometryError
      || error instanceof NecPortError
      || error instanceof NecConditioningError
      || error instanceof NecSolverError
      || error instanceof NecRuntimeError
    ) {
      throw error;
    }
    throw new NecRuntimeError("runDeck failed at the WASM boundary", {
      cause: error,
      details: { operation: "runDeck" },
    });
  } finally {
    if (inputPointer !== 0) {
      try {
        module._free(inputPointer);
      } catch {
        // Preserve the operation's result.
      }
    }
    if (deck !== 0) {
      try {
        module._necpp_wasm_v1_deck_delete(deck);
      } catch {
        // Cleanup is contained at the ABI.
      }
    }
  }
}
