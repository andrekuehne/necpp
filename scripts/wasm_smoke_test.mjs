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

const context = module._nec_create_context();
if (!context) {
  throw new Error("nec_create_context returned null");
}

const processInput = (deck) => module.ccall(
  "nec_process_input",
  "number",
  ["number", "string"],
  [context, deck],
);
const getOutput = () => {
  const length = module._nec_get_output_length(context);
  const pointer = module._nec_get_output(context);
  return { length, text: module.UTF8ToString(pointer, length) };
};

const validDeck = `CM WASM STRING INPUT SMOKE TEST
CE
GW 0 9 0.0 0.0 -0.25 0.0 0.0 0.25 0.001
GE 0
FR 0 1 0 0 300.0
EX 0 0 5 0 1.0 0.0
XQ
EN
`;

try {
  const validStatus = processInput(validDeck);
  if (validStatus !== 0) {
    throw new Error(`valid deck returned ${validStatus}: ${getOutput().text}`);
  }

  const validOutput = getOutput();
  if (validOutput.length <= 0 || validOutput.text.length <= 0) {
    throw new Error("valid deck produced empty output");
  }
  if (!validOutput.text.includes("WASM STRING INPUT SMOKE TEST")) {
    throw new Error("supplied string marker was not consumed");
  }
  if (!validOutput.text.includes("ANTENNA INPUT PARAMETERS")) {
    throw new Error("valid deck did not produce the expected NEC result marker");
  }

  let invalidStatus;
  try {
    invalidStatus = processInput("CE INVALID INPUT\nBOGUS\nEN\n");
  } catch (error) {
    throw new Error(`invalid input caused a WASM trap: ${error}`);
  }

  const invalidOutput = getOutput();
  if (invalidStatus >= 0) {
    throw new Error(`invalid deck unexpectedly returned ${invalidStatus}`);
  }
  if (!invalidOutput.text.startsWith("Error:")) {
    throw new Error(`invalid deck did not return a controlled error: ${invalidOutput.text}`);
  }
} finally {
  module._nec_delete_context(context);
}

console.log("WASM API smoke test passed");
