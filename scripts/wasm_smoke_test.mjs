import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const modulePath = process.argv[2];
if (!modulePath) {
  throw new Error("usage: node wasm_smoke_test.mjs <nec2pp.js>");
}

const { default: createNecModule } = await import(
  pathToFileURL(path.resolve(modulePath)).href
);
const module = await createNecModule();

const OK = 0;
const STATE_ERROR = 1;
const INPUT_ERROR = 2;

const IMPEDANCE_REAL = 0;
const IMPEDANCE_IMAG = 1;
const SOLUTION_CURRENTS_REAL = 8;
const SOLUTION_CURRENTS_IMAG = 9;
const FAR_FIELD_E_THETA_REAL = 15;
const FAR_FIELD_E_THETA_IMAG = 16;
const FAR_FIELD_E_PHI_REAL = 17;
const FAR_FIELD_E_PHI_IMAG = 18;
const EMBEDDED_E_THETA_REAL = 21;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const check = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const decodeBytes = (pointer, length) => decoder.decode(
  module.HEAPU8.subarray(pointer, pointer + length),
);
const decodeCString = (pointer) => {
  let end = pointer;
  while (module.HEAPU8[end] !== 0) {
    end += 1;
  }
  return decodeBytes(pointer, end - pointer);
};
const allocateFloat64 = (values) => {
  const pointer = module._malloc(values.length * Float64Array.BYTES_PER_ELEMENT);
  check(pointer !== 0, "WASM allocation failed");
  module.HEAPF64.set(values, pointer / Float64Array.BYTES_PER_ELEMENT);
  return pointer;
};
const allocateInt32 = (values) => {
  const pointer = module._malloc(values.length * Int32Array.BYTES_PER_ELEMENT);
  check(pointer !== 0, "WASM allocation failed");
  module.HEAP32.set(values, pointer / Int32Array.BYTES_PER_ELEMENT);
  return pointer;
};
const allocateBytes = (values) => {
  const pointer = module._malloc(values.length);
  check(pointer !== 0, "WASM allocation failed");
  module.HEAPU8.set(values, pointer);
  return pointer;
};
const copyResult = (model, kind) => {
  const length = module._necpp_wasm_v1_result_buffer_length(model, kind);
  const pointer = module._necpp_wasm_v1_result_buffer(model, kind);
  check(length === 0 || pointer !== 0, `result buffer ${kind} is null`);
  return new Float64Array(
    module.HEAPF64.buffer,
    pointer,
    length,
  ).slice();
};
const modelError = (model) => decodeCString(
  module._necpp_wasm_v1_last_error(model),
);

const validDeck = `CM WASM STRING INPUT SMOKE TEST
CE
GW 1 11 0.0 0.0 -0.25 0.0 0.0 0.25 0.001
GE 0
FR 0 1 0 0 300.0
EX 0 1 6 0 1.0 0.0
XQ
EN
`;

check(module._necpp_wasm_v1_abi_version() === 1, "unexpected ABI version");
check(
  decodeCString(module._necpp_wasm_v1_engine_version()).length > 0,
  "empty engine version",
);
check(typeof module._malloc === "function", "_malloc was not exported");
check(typeof module._free === "function", "_free was not exported");
check(module._nec_create_context === undefined, "legacy ABI leaked into module");

const model = module._necpp_wasm_v1_model_create();
check(model !== 0, "model_create returned null");
let tagsPointer = 0;
let segmentsPointer = 0;
let realPointer = 0;
let imagPointer = 0;
try {
  check(
    module._necpp_wasm_v1_prepare(model, 300) === STATE_ERROR,
    "illegal lifecycle call did not return a state error",
  );
  check(modelError(model).length > 0, "state error message is empty");
  check(
    module._necpp_wasm_v1_add_wire(
      model, 1, 11,
      0, 0, 0,
      0, 0, 0,
      0.001,
    ) === INPUT_ERROR,
    "invalid geometry did not return a controlled input error",
  );
  check(
    module._necpp_wasm_v1_add_wire(
      model, 1, 11,
      0, 0, -0.25,
      0, 0, 0.25,
      0.001,
    ) === OK,
    `addWire failed: ${modelError(model)}`,
  );
  check(
    module._necpp_wasm_v1_complete_geometry(model, 0) === OK,
    `completeGeometry failed: ${modelError(model)}`,
  );

  tagsPointer = allocateInt32(new Int32Array([1]));
  segmentsPointer = allocateInt32(new Int32Array([6]));
  check(
    module._necpp_wasm_v1_define_ports(
      model, tagsPointer, segmentsPointer, 1,
    ) === OK,
    `definePorts failed: ${modelError(model)}`,
  );
  check(
    module._necpp_wasm_v1_prepare(model, 300) === OK,
    `prepare failed: ${modelError(model)}`,
  );
  check(
    module._necpp_wasm_v1_compute_impedance(model) === OK,
    `computeImpedance failed: ${modelError(model)}`,
  );
  check(module._necpp_wasm_v1_impedance_order(model) === 1, "wrong matrix order");
  const impedanceReal = copyResult(model, IMPEDANCE_REAL);
  const impedanceImag = copyResult(model, IMPEDANCE_IMAG);
  check(
    impedanceReal.length === 1 &&
      Number.isFinite(impedanceReal[0]) &&
      Number.isFinite(impedanceImag[0]) &&
      impedanceReal[0] > 0,
    "invalid one-port impedance",
  );

  realPointer = allocateFloat64(new Float64Array([1]));
  imagPointer = allocateFloat64(new Float64Array([0]));
  check(
    module._necpp_wasm_v1_solve_voltages(
      model, realPointer, imagPointer, 1,
    ) === OK,
    `solveVoltages failed: ${modelError(model)}`,
  );
  check(module._necpp_wasm_v1_solution_count(model) === 1, "wrong solution size");
  const currentReal = copyResult(model, SOLUTION_CURRENTS_REAL);
  const currentImag = copyResult(model, SOLUTION_CURRENTS_IMAG);
  check(
    Number.isFinite(currentReal[0]) && Number.isFinite(currentImag[0]),
    "nonfinite port current",
  );

  check(
    module._necpp_wasm_v1_compute_far_field(
      model,
      1,
      0, 3, 45,
      0, 2, 90,
    ) === OK,
    `computeFarField failed: ${modelError(model)}`,
  );
  check(
    module._necpp_wasm_v1_far_field_theta_count(model) === 3 &&
      module._necpp_wasm_v1_far_field_phi_count(model) === 2,
    "wrong far-field dimensions",
  );
  const copiedFields = [
    copyResult(model, FAR_FIELD_E_THETA_REAL),
    copyResult(model, FAR_FIELD_E_THETA_IMAG),
    copyResult(model, FAR_FIELD_E_PHI_REAL),
    copyResult(model, FAR_FIELD_E_PHI_IMAG),
  ];
  check(
    copiedFields.every(
      (field) => field.length === 6 && field.every(Number.isFinite),
    ),
    "invalid far-field buffers",
  );

  const oldHeap = module.HEAPU8.buffer;
  const growthPointer = module._malloc(oldHeap.byteLength + 65536);
  check(growthPointer !== 0, "memory-growth allocation failed");
  check(module.HEAPU8.buffer !== oldHeap, "WASM memory did not grow");
  module._free(growthPointer);
  check(
    copiedFields.every((field) => field.every(Number.isFinite)),
    "JavaScript result copies changed after WASM memory growth",
  );

  check(
    module._necpp_wasm_v1_compute_embedded_far_fields(
      model,
      1,
      90, 1, 0,
      0, 1, 0,
      0,
    ) === OK,
    `computeEmbeddedFarFields failed: ${modelError(model)}`,
  );
  check(
    module._necpp_wasm_v1_embedded_samples_per_port(model) === 1,
    "wrong embedded-field dimensions",
  );
  check(
    copyResult(model, EMBEDDED_E_THETA_REAL).every(Number.isFinite),
    "invalid embedded field",
  );
} finally {
  if (tagsPointer) module._free(tagsPointer);
  if (segmentsPointer) module._free(segmentsPointer);
  if (realPointer) module._free(realPointer);
  if (imagPointer) module._free(imagPointer);
  module._necpp_wasm_v1_model_delete(model);
}

const deck = module._necpp_wasm_v1_deck_create();
check(deck !== 0, "deck_create returned null");
let deckPointer = 0;
try {
  const encodedDeck = encoder.encode(validDeck);
  deckPointer = allocateBytes(encodedDeck);
  const validStatus = module._necpp_wasm_v1_deck_process(
    deck, deckPointer, encodedDeck.length,
  );
  check(
    validStatus === OK,
    `valid deck returned ${validStatus}: ` +
      decodeCString(module._necpp_wasm_v1_deck_last_error(deck)),
  );
  const outputLength = module._necpp_wasm_v1_deck_output_length(deck);
  const output = decodeBytes(
    module._necpp_wasm_v1_deck_output(deck),
    outputLength,
  );
  check(output.includes("WASM STRING INPUT SMOKE TEST"), "deck marker missing");
  check(output.includes("ANTENNA INPUT PARAMETERS"), "deck result marker missing");

  const invalidBytes = encoder.encode("CE INVALID INPUT\nBOGUS\nEN\n");
  const invalidPointer = allocateBytes(invalidBytes);
  try {
    const invalidStatus = module._necpp_wasm_v1_deck_process(
      deck, invalidPointer, invalidBytes.length,
    );
    check(invalidStatus === INPUT_ERROR, "invalid deck returned wrong status");
    check(
      decodeCString(module._necpp_wasm_v1_deck_last_error(deck)).length > 0,
      "invalid deck did not retain an error",
    );
  } catch (error) {
    throw new Error(`invalid input caused a WASM trap: ${error}`);
  } finally {
    module._free(invalidPointer);
  }
} finally {
  if (deckPointer) module._free(deckPointer);
  module._necpp_wasm_v1_deck_delete(deck);
}

console.log("WP4 WASM ABI smoke test passed");
