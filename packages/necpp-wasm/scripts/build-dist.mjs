import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";

const packageDirectory = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const sourceDirectory = join(packageDirectory, "src");
const distDirectory = join(packageDirectory, "dist");
const localCompiler = join(packageDirectory, "node_modules", "typescript", "bin", "tsc");

const packageJson = JSON.parse(
  readFileSync(join(packageDirectory, "package.json"), "utf8"),
);
const versionsSource = readFileSync(join(sourceDirectory, "versions.ts"), "utf8");
const expectedPackageVersion = `packageVersion = "${packageJson.version}"`;
if (!versionsSource.includes(expectedPackageVersion)) {
  throw new Error(
    `src/versions.ts must export ${expectedPackageVersion} to match package.json`,
  );
}

const cmakeLists = readFileSync(join(repositoryRoot, "CMakeLists.txt"), "utf8");
const cmakeVersion = cmakeLists.match(/project\(\s*necpp\s+VERSION\s+([0-9.]+)/);
if (cmakeVersion === null) {
  throw new Error("Could not read the CMake project version");
}
if (!versionsSource.includes(`engineVersion = "${cmakeVersion[1]}"`)) {
  throw new Error(
    `src/versions.ts engineVersion must match CMake project VERSION ${cmakeVersion[1]}`,
  );
}

const requiredArtifacts = [
  "nec2pp.generated.js", "nec2pp.wasm",
  "necpp-field-evaluator.generated.js", "necpp-field-evaluator.wasm",
];
const missingArtifacts = requiredArtifacts.filter(
  (name) => !existsSync(join(sourceDirectory, name)),
);
if (missingArtifacts.length > 0) {
  throw new Error(
    `Cannot assemble dist without WASM artifacts: ${missingArtifacts.join(", ")}`,
  );
}

const licenseSource = join(repositoryRoot, "COPYING");
if (!existsSync(licenseSource)) {
  throw new Error(`Missing license file at ${licenseSource}`);
}

rmSync(distDirectory, { force: true, recursive: true });

if (!existsSync(localCompiler)) {
  throw new Error("The pinned TypeScript compiler is missing; run npm install first");
}
const result = spawnSync(process.execPath, [
  localCompiler,
  "--project",
  "tsconfig.dist.json",
], {
  cwd: packageDirectory,
  stdio: "inherit",
});
if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

for (const name of requiredArtifacts) {
  copyFileSync(join(sourceDirectory, name), join(distDirectory, name));
}
copyFileSync(licenseSource, join(packageDirectory, "COPYING"));

const requiredDistFiles = [
  "index.js",
  "index.d.ts",
  "worker.js",
  "worker.d.ts",
  "worker-entry.js",
  "field-evaluator-worker.js",
  "field-evaluator.js",
  "field-worker-pool.js",
  "nec2pp.generated.js",
  "nec2pp.wasm",
  "necpp-field-evaluator.generated.js",
  "necpp-field-evaluator.wasm",
];
const missingDistFiles = requiredDistFiles.filter(
  (name) => !existsSync(join(distDirectory, name)),
);
if (missingDistFiles.length > 0) {
  throw new Error(`dist is missing ${missingDistFiles.join(", ")}`);
}

const disallowed = [];
function walk(directory) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      walk(path);
      continue;
    }
    if (entry.endsWith(".map") || entry.endsWith(".tsbuildinfo")) {
      disallowed.push(relative(distDirectory, path));
    }
  }
}
walk(distDirectory);
if (disallowed.length > 0) {
  throw new Error(`dist contains disallowed debug artifacts: ${disallowed.join(", ")}`);
}

const wasmBytes = statSync(join(distDirectory, "nec2pp.wasm")).size;
const loaderBytes = statSync(join(distDirectory, "nec2pp.generated.js")).size;
const evaluatorWasmBytes = statSync(
  join(distDirectory, "necpp-field-evaluator.wasm"),
).size;
const evaluatorLoaderBytes = statSync(
  join(distDirectory, "necpp-field-evaluator.generated.js"),
).size;
if (wasmBytes >= 1024 * 1024) {
  throw new Error(`nec2pp.wasm is ${wasmBytes} bytes; expected under 1 MiB`);
}
if (loaderBytes >= 200 * 1024) {
  throw new Error(
    `nec2pp.generated.js is ${loaderBytes} bytes; expected under 200 KiB`,
  );
}
if (evaluatorWasmBytes >= 64 * 1024) {
  throw new Error(
    `necpp-field-evaluator.wasm is ${evaluatorWasmBytes} bytes; expected under 64 KiB`,
  );
}
if (evaluatorLoaderBytes >= 64 * 1024) {
  throw new Error(
    `necpp-field-evaluator.generated.js is ${evaluatorLoaderBytes} bytes; expected under 64 KiB`,
  );
}

process.stdout.write(
  `Assembled ${relative(dirname(packageDirectory), distDirectory)} `
    + `(wasm ${wasmBytes} bytes, loader ${loaderBytes} bytes; evaluator wasm `
    + `${evaluatorWasmBytes} bytes, loader ${evaluatorLoaderBytes} bytes)\n`,
);
