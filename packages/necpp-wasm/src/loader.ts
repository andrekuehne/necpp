import { NecInputError, NecRuntimeError } from "./errors.js";
import type { CreateNecModelOptions } from "./types.js";
import { abiVersion, engineVersion } from "./versions.js";
import generatedFactory from "./nec2pp.generated.js";
import type {
  EmscriptenModuleOptions,
  NecWasmModule,
  NecWasmModuleFactory,
} from "./wasm-internal.js";

const textDecoder = new TextDecoder();

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

function isHttpUrl(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}

async function downloadWasmBinary(wasmUrl: string): Promise<Uint8Array> {
  try {
    const response = await fetch(wasmUrl);
    if (!response.ok) {
      throw new NecRuntimeError(`Failed to download WASM from ${wasmUrl}`, {
        details: { status: response.status, wasmUrl },
      });
    }
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof NecRuntimeError) {
      throw error;
    }
    throw new NecRuntimeError("Failed to download WASM", {
      cause: error,
      details: { wasmUrl },
    });
  }
}

async function moduleOptions(
  options: CreateNecModelOptions | undefined,
): Promise<EmscriptenModuleOptions> {
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
  if (isHttpUrl(wasmUrl)) {
    return { wasmBinary: await downloadWasmBinary(wasmUrl) };
  }
  return {
    locateFile(path, prefix) {
      return path.endsWith(".wasm") ? wasmUrl : `${prefix}${path}`;
    },
  };
}

function decodeCString(module: NecWasmModule, pointer: number): string {
  if (
    !Number.isSafeInteger(pointer)
    || pointer <= 0
    || pointer >= module.HEAPU8.length
  ) {
    throw new NecRuntimeError("The native module returned an invalid version string");
  }
  const end = module.HEAPU8.indexOf(0, pointer);
  if (end < 0) {
    throw new NecRuntimeError("The native module returned an unterminated version string");
  }
  return textDecoder.decode(module.HEAPU8.slice(pointer, end));
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

  const nativeAbiVersion = module._necpp_wasm_v1_abi_version();
  if (nativeAbiVersion !== abiVersion) {
    throw new NecRuntimeError(
      `Unsupported NEC WASM ABI version ${nativeAbiVersion}; expected ${abiVersion}`,
      {
        details: {
          actualAbiVersion: nativeAbiVersion,
          expectedAbiVersion: abiVersion,
        },
      },
    );
  }

  const nativeEngineVersion = decodeCString(
    module,
    module._necpp_wasm_v1_engine_version(),
  );
  if (nativeEngineVersion !== engineVersion) {
    throw new NecRuntimeError(
      `NEC engine version ${nativeEngineVersion} does not match package engine ${engineVersion}`,
      {
        details: {
          actualEngineVersion: nativeEngineVersion,
          expectedEngineVersion: engineVersion,
        },
      },
    );
  }
}

export async function instantiateNecModule(
  options: CreateNecModelOptions | undefined,
  factory?: NecWasmModuleFactory,
): Promise<NecWasmModule> {
  try {
    const selectedOptions = await moduleOptions(options);
    const selectedFactory = factory ?? generatedFactory;
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
