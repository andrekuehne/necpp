import { spawn, spawnSync } from "node:child_process";
import {
  createServer,
} from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const packageDirectory = resolve(import.meta.dirname, "../..");
export const VITE_VERSION = "6.3.5";

const sourceWasm = join(packageDirectory, "src", "nec2pp.wasm");
const sourceLoader = join(packageDirectory, "src", "nec2pp.generated.js");
const suppliedTarball = process.env.NECPP_WASM_TARBALL;

export const hasWasmArtifacts = (
  typeof suppliedTarball === "string"
  && suppliedTarball.length > 0
  && existsSync(resolve(suppliedTarball))
) || (existsSync(sourceWasm) && existsSync(sourceLoader));

function resolveSpawn(command, args) {
  if (command !== "npm") {
    return { command, args };
  }
  const configuredNpmCli = process.env.npm_execpath;
  const bundledNpmCli = resolve(
    dirname(process.execPath),
    "node_modules/npm/bin/npm-cli.js",
  );
  const npmCli = typeof configuredNpmCli === "string" && configuredNpmCli.length > 0
    ? configuredNpmCli
    : bundledNpmCli;
  if (!existsSync(npmCli)) {
    throw new Error(`Could not locate the npm CLI at ${npmCli}`);
  }
  return {
    command: process.execPath,
    args: [npmCli, ...args],
  };
}

export function run(command, args, options = {}) {
  const invocation = resolveSpawn(command, args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: options.cwd ?? packageDirectory,
    encoding: "utf8",
    env: options.env ?? process.env,
    shell: options.shell ?? false,
    stdio: options.stdio ?? "inherit",
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with status ${result.status}\n`
        + `${result.stdout}\n${result.stderr}`,
    );
  }
  return result;
}

export function runAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? packageDirectory,
      env: options.env ?? process.env,
      shell: options.shell ?? command === "npm",
      stdio: options.stdio ?? "inherit",
      windowsHide: true,
    });
    let stdout = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (status) => {
      if (status !== 0) {
        reject(new Error(
          `${command} ${args.join(" ")} failed with status ${status}\n${stdout}`,
        ));
        return;
      }
      resolve({ status, stdout });
    });
  });
}

export function parseNpmJson(stdout) {
  const arrayIndex = stdout.indexOf("[");
  const objectIndex = stdout.indexOf("{");
  const start = arrayIndex >= 0 && (objectIndex < 0 || arrayIndex <= objectIndex)
    ? arrayIndex
    : objectIndex;
  if (start < 0) {
    throw new Error(`npm output did not contain JSON:\n${stdout}`);
  }
  return JSON.parse(stdout.slice(start));
}

let packedCache;

export function packPackage() {
  if (packedCache !== undefined) {
    return packedCache;
  }
  if (typeof suppliedTarball === "string" && suppliedTarball.length > 0) {
    const tarball = resolve(suppliedTarball);
    if (!existsSync(tarball)) {
      throw new Error(`NECPP_WASM_TARBALL does not exist: ${tarball}`);
    }
    const packageJson = JSON.parse(
      readFileSync(join(packageDirectory, "package.json"), "utf8"),
    );
    packedCache = {
      files: [],
      filename: tarball.slice(Math.max(tarball.lastIndexOf("/"), tarball.lastIndexOf("\\")) + 1),
      tarball,
      version: packageJson.version,
      workDirectory: dirname(tarball),
    };
    return packedCache;
  }
  const workDirectory = mkdtempSync(join(tmpdir(), "necpp-wasm-pack-"));
  const result = run("npm", ["pack", "--pack-destination", workDirectory, "--json"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const reports = parseNpmJson(result.stdout);
  const report = Array.isArray(reports) ? reports[0] : reports;
  const filename = report?.filename;
  if (typeof filename !== "string" || filename.length === 0) {
    throw new Error(`npm pack did not report a filename:\n${result.stdout}`);
  }
  const tarball = join(workDirectory, filename);
  if (!existsSync(tarball)) {
    throw new Error(`npm pack did not write ${tarball}`);
  }
  packedCache = {
    files: (report.files ?? []).map((file) => file.path.replaceAll("\\", "/")),
    filename,
    tarball,
    version: report.version,
    workDirectory,
  };
  return packedCache;
}

export function writeFixtureFile(root, relativePath, contents) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

export function createCleanFixture(name) {
  const root = mkdtempSync(join(tmpdir(), `necpp-wasm-${name}-`));
  const packed = packPackage();
  const tarballPosix = packed.tarball.replaceAll("\\", "/");
  writeFixtureFile(root, "package.json", `${JSON.stringify({
    name: `necpp-wasm-${name}-fixture`,
    private: true,
    type: "module",
    dependencies: {
      "@necpp/wasm": `file:${tarballPosix}`,
    },
  }, null, 2)}\n`);
  return { packed, root, tarballPosix };
}

export function installFixture(root, extraPackages = []) {
  const args = ["install", "--ignore-scripts", "--no-fund", "--no-audit"];
  if (extraPackages.length > 0) {
    args.push("--save-dev", ...extraPackages);
  }
  run("npm", args, { cwd: root });
}

export const dipoleScript = `import {
  abiVersion,
  createNecModel,
  engineVersion,
  packageVersion,
} from "@necpp/wasm";

const resolved = import.meta.resolve("@necpp/wasm");
if (!resolved.includes("node_modules")) {
  throw new Error(\`Package did not resolve from node_modules: \${resolved}\`);
}
if (
  resolved.includes("/packages/necpp-wasm/src/")
  || resolved.includes("\\\\packages\\\\necpp-wasm\\\\src\\\\")
) {
  throw new Error(\`Package resolved to workspace source: \${resolved}\`);
}

const model = await createNecModel();
try {
  model.addWire({
    tag: 1,
    segments: 11,
    start: [0, 0, -0.25],
    end: [0, 0, 0.25],
    radiusM: 0.001,
  });
  model.completeGeometry();
  model.definePorts([{ tag: 1, segment: 6 }]);
  model.prepare({ frequencyMHz: 300 });
  const matrices = model.computeImpedanceMatrix();
  if (!(matrices.impedance.real[0] > 0)) {
    throw new Error("expected a positive feed resistance");
  }
  process.stdout.write(JSON.stringify({
    abiVersion,
    engineVersion,
    packageVersion,
    resistanceOhm: matrices.impedance.real[0],
    resolved,
  }));
} finally {
  model.dispose();
}
`;

export const workerDipoleScript = `import {
  abiVersion,
  createNecWorkerModel,
  engineVersion,
  packageVersion,
} from "@necpp/wasm/worker";

const resolved = import.meta.resolve("@necpp/wasm/worker");
if (!resolved.includes("node_modules")) {
  throw new Error(\`Worker entry did not resolve from node_modules: \${resolved}\`);
}

const model = await createNecWorkerModel();
try {
  await model.addWire({
    tag: 1,
    segments: 11,
    start: [0, 0, -0.25],
    end: [0, 0, 0.25],
    radiusM: 0.001,
  });
  await model.completeGeometry();
  await model.definePorts([{ tag: 1, segment: 6 }]);
  await model.prepare({ frequencyMHz: 300 });
  const matrices = await model.computeImpedanceMatrix();
  if (!(matrices.impedance.real[0] > 0)) {
    throw new Error("expected a positive feed resistance");
  }
  process.stdout.write(JSON.stringify({
    abiVersion,
    engineVersion,
    packageVersion,
    resistanceOhm: matrices.impedance.real[0],
    resolved,
  }));
} finally {
  await model.dispose();
}
`;

export const cdnDipoleScript = `import { createNecModel } from "@necpp/wasm";

const wasmUrl = process.env.NEC_WASM_URL;
if (typeof wasmUrl !== "string" || wasmUrl.length === 0) {
  throw new Error("NEC_WASM_URL is required");
}

const model = await createNecModel({ wasmUrl });
try {
  model.addWire({
    tag: 1,
    segments: 11,
    start: [0, 0, -0.25],
    end: [0, 0, 0.25],
    radiusM: 0.001,
  });
  model.completeGeometry();
  model.definePorts([{ tag: 1, segment: 6 }]);
  model.prepare({ frequencyMHz: 300 });
  const matrices = model.computeImpedanceMatrix();
  if (!(matrices.impedance.real[0] > 0)) {
    throw new Error("expected a positive feed resistance");
  }
  process.stdout.write(JSON.stringify({
    resistanceOhm: matrices.impedance.real[0],
    wasmUrl,
  }));
} finally {
  model.dispose();
}
`;

export function serveWasm(bytes) {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      if (request.url !== "/nec2pp.wasm") {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/wasm",
        "Content-Length": bytes.length,
      });
      response.end(bytes);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("failed to bind WASM fixture server"));
        return;
      }
      resolve({
        close() {
          return new Promise((closeResolve, closeReject) => {
            server.close((error) => {
              if (error) {
                closeReject(error);
                return;
              }
              closeResolve();
            });
          });
        },
        url: `http://127.0.0.1:${address.port}/nec2pp.wasm`,
      });
    });
    server.on("error", reject);
  });
}

export function readPackedWasm() {
  return readFileSync(join(packageDirectory, "dist", "nec2pp.wasm"));
}
