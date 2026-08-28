import {
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = fileURLToPath(new URL("../", import.meta.url));
const outputDirectory = fileURLToPath(
  new URL("../.test-build/", import.meta.url),
);
const localCompiler = fileURLToPath(
  new URL("../node_modules/typescript/bin/tsc", import.meta.url),
);

rmSync(outputDirectory, { force: true, recursive: true });

const compiler = existsSync(localCompiler) ? process.execPath : "tsc";
const compilerArguments = existsSync(localCompiler)
  ? [localCompiler, "--project", "tsconfig.build.json"]
  : ["--project", "tsconfig.build.json"];
const result = spawnSync(
  compiler,
  compilerArguments,
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

const sourceDirectory = fileURLToPath(new URL("../src/", import.meta.url));
const builtSourceDirectory = fileURLToPath(
  new URL("../.test-build/src/", import.meta.url),
);
mkdirSync(builtSourceDirectory, { recursive: true });

for (const name of ["nec2pp.generated.js", "nec2pp.wasm"]) {
  const source = join(sourceDirectory, name);
  if (existsSync(source)) {
    copyFileSync(source, join(builtSourceDirectory, name));
  }
}
