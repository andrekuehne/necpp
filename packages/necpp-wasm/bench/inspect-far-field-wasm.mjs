import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument near ${name ?? "end of command"}`);
    }
    values.set(name.slice(2), value);
  }
  for (const required of ["generated-js", "wat", "output"]) {
    if (!values.has(required)) throw new Error(`--${required} is required`);
  }
  return {
    generatedJs: resolve(values.get("generated-js")),
    wat: resolve(values.get("wat")),
    output: resolve(values.get("output")),
  };
}

function publicExport(js, publicName) {
  const marker = `Module["${publicName}"]=wasmExports["`;
  const start = js.indexOf(marker);
  if (start < 0) throw new Error(`could not map ${publicName} in generated JS`);
  const valueStart = start + marker.length;
  const end = js.indexOf('"', valueStart);
  if (end < 0) throw new Error(`unterminated export mapping for ${publicName}`);
  return js.slice(valueStart, end);
}

function parseFunctions(wat) {
  const functions = new Map();
  let current;
  for (const line of wat.split(/\r?\n/)) {
    const start = line.match(/^ \(func \$(\d+)\b/);
    if (start !== null) {
      current = {
        id: Number(start[1]),
        calls: new Set(),
        simdInstructionLines: 0,
        simdOperations: new Set(),
      };
      functions.set(current.id, current);
    }
    if (current === undefined) continue;
    for (const match of line.matchAll(/\(call \$(\d+)/g)) {
      current.calls.add(Number(match[1]));
    }
    const operations = [...line.matchAll(/\((v128\.[\w.]+|[if]\d+x\d+\.[\w.]+)/g)];
    if (operations.length > 0) {
      current.simdInstructionLines += 1;
      for (const match of operations) current.simdOperations.add(match[1]);
    }
  }
  return functions;
}

function analyzeReachable(functions, root) {
  const reachable = new Set();
  const pending = [root];
  while (pending.length > 0) {
    const id = pending.pop();
    if (reachable.has(id)) continue;
    reachable.add(id);
    const functionInfo = functions.get(id);
    if (functionInfo === undefined) continue;
    for (const called of functionInfo.calls) pending.push(called);
  }
  const simdFunctions = [...reachable]
    .map((id) => functions.get(id))
    .filter((functionInfo) => functionInfo?.simdInstructionLines > 0);
  return {
    reachableFunctionCount: reachable.size,
    simdReachableFunctionCount: simdFunctions.length,
    simdInstructionLines: simdFunctions.reduce(
      (total, functionInfo) => total + functionInfo.simdInstructionLines,
      0,
    ),
    simdOperations: [...new Set(
      simdFunctions.flatMap((functionInfo) => [...functionInfo.simdOperations]),
    )].sort(),
    simdFunctionIds: simdFunctions.map(({ id }) => id).sort((left, right) => left - right),
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const js = readFileSync(options.generatedJs, "utf8");
  const wat = readFileSync(options.wat, "utf8");
  const minifiedExport = publicExport(js, "_necpp_wasm_v1_compute_far_field");
  const exportPattern = new RegExp(
    `\\(export "${minifiedExport.replace(/[$]/g, "\\$")}" \\(func \\$(\\d+)\\)\\)`,
  );
  const exportMatch = wat.match(exportPattern);
  if (exportMatch === null) {
    throw new Error(`could not map WASM export ${minifiedExport} to a function`);
  }
  const functions = parseFunctions(wat);
  const rootFunction = Number(exportMatch[1]);
  const allSimdFunctions = [...functions.values()].filter(
    ({ simdInstructionLines }) => simdInstructionLines > 0,
  );
  const report = {
    type: "far-field-wasm-simd-inspection",
    schemaVersion: 1,
    generatedJs: options.generatedJs,
    wat: options.wat,
    publicExport: "_necpp_wasm_v1_compute_far_field",
    minifiedExport,
    rootFunction,
    module: {
      functionCount: functions.size,
      simdFunctionCount: allSimdFunctions.length,
      simdInstructionLines: allSimdFunctions.reduce(
        (total, functionInfo) => total + functionInfo.simdInstructionLines,
        0,
      ),
    },
    farFieldCallGraph: analyzeReachable(functions, rootFunction),
  };
  writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (process.argv[1] !== undefined
    && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
