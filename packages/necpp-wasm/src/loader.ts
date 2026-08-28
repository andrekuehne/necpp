import { NecInputError, NecRuntimeError } from "./errors.js";
import type { CreateNecModelOptions } from "./types.js";
import type {
  EmscriptenModuleOptions,
  NecWasmModule,
  NecWasmModuleFactory,
} from "./wasm-internal.js";

const EXPECTED_ABI_VERSION = 1;

function copyWasmBinary(binary: ArrayBuffer | Uint8Array): Uint8Array {
  try {
    if (binary instanceof Uint8Array) {
      return new Uint8Array(binary);
    }
    if (binary instanceof ArrayBuffer) {
      return new Uint8Array(binary.slice(0));
    }
  } catch (cause) {
    throw new NecInputError("wasmBinary must reference readable WASM bytes", {
      cause,
    });
  }
  throw new NecInputError("wasmBinary must be an ArrayBuffer or Uint8Array");
}

function resolveWasmUrl(value: string | URL | undefined): string {
  if (value === undefined) {
    return new URL("./nec2pp.wasm", import.meta.url).href;
  }
  if (value instanceof URL) {
    return value.href;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new NecInputError("wasmUrl must be a nonempty string or URL");
  }
  try {
    return new URL(value, import.meta.url).href;
  } catch (cause) {
    throw new NecInputError("wasmUrl is not a valid URL", { cause });
  }
}

function moduleOptions(
  options: CreateNecModelOptions | undefined,
): EmscriptenModuleOptions {
  if (options !== undefined && (typeof options !== "object" || options === null)) {
    throw new NecInputError("WASM loading options must be an object");
  }
  if (options?.wasmUrl !== undefined && options.wasmBinary !== undefined) {
    throw new NecInputError("wasmUrl and wasmBinary cannot both be supplied");
  }

  if (options?.wasmBinary !== undefined) {
    return { wasmBinary: copyWasmBinary(options.wasmBinary) };
  }

  const wasmUrl = resolveWasmUrl(options?.wasmUrl);
  return {
    locateFile(path, prefix) {
      return path.endsWith(".wasm") ? wasmUrl : `${prefix}${path}`;
    },
  };
}

function validateModule(module: NecWasmModule): void {
  if (
    typeof module !== "object"
    || module === null
    || typeof module._necpp_wasm_v1_abi_version !== "function"
    || typeof module._necpp_wasm_v1_model_create !== "function"
    || typeof module._necpp_wasm_v1_deck_create !== "function"
    || typeof module._malloc !== "function"
    || typeof module._free !== "function"
    || !(module.HEAPU8 instanceof Uint8Array)
    || !(module.HEAP32 instanceof Int32Array)
    || !(module.HEAPF64 instanceof Float64Array)
  ) {
    throw new NecRuntimeError("The loaded Emscripten module has an invalid surface");
  }

  const abiVersion = module._necpp_wasm_v1_abi_version();
  if (abiVersion !== EXPECTED_ABI_VERSION) {
    throw new NecRuntimeError(
      `Unsupported NEC WASM ABI version ${abiVersion}; expected ${EXPECTED_ABI_VERSION}`,
      { details: { actualAbiVersion: abiVersion, expectedAbiVersion: EXPECTED_ABI_VERSION } },
    );
  }
}

export async function instantiateNecModule(
  options: CreateNecModelOptions | undefined,
  factory?: NecWasmModuleFactory,
): Promise<NecWasmModule> {
  try {
    const selectedOptions = moduleOptions(options);
    const selectedFactory = factory
      ?? (await import("./nec2pp.generated.js")).default;
    if (typeof selectedFactory !== "function") {
      throw new NecRuntimeError(
        "The generated Emscripten module does not export a default factory",
      );
    }
    const module = await selectedFactory(selectedOptions);
    validateModule(module);
    return module;
  } catch (error) {
    if (error instanceof NecInputError || error instanceof NecRuntimeError) {
      throw error;
    }
    throw new NecRuntimeError("Failed to load or instantiate NEC WebAssembly", {
      cause: error,
    });
  }
}
