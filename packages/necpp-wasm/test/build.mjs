import {
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const packageDirectory = resolve(import.meta.dirname, "..");
const outputDirectory = resolve(packageDirectory, ".test-build");
const localCompiler = resolve(
  packageDirectory,
  "node_modules/typescript/bin/tsc",
);

rmSync(outputDirectory, { force: true, recursive: true });

if (!existsSync(localCompiler)) {
  throw new Error("The pinned TypeScript compiler is missing; run npm install first");
}
const result = spawnSync(
  process.execPath,
  [localCompiler, "--project", "tsconfig.build.json"],
  {
    cwd: packageDirectory,
    stdio: "inherit",
  },
);
if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const sourceDirectory = resolve(packageDirectory, "src");
const builtSourceDirectory = resolve(outputDirectory, "src");
mkdirSync(builtSourceDirectory, { recursive: true });

for (const name of [
  "nec2pp.generated.js", "nec2pp.wasm",
  "necpp-field-evaluator.generated.js", "necpp-field-evaluator.wasm",
]) {
  const source = join(sourceDirectory, name);
  if (existsSync(source)) {
    copyFileSync(source, join(builtSourceDirectory, name));
  }
}
