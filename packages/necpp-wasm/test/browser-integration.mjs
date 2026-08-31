import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { chromium } from "playwright";

import { resolveNpmInvocation } from "../scripts/npm-cli.mjs";
import { stopChild, waitForHttpServer } from "./http-server-process.mjs";

const mode = process.argv[2];
if (mode !== "direct" && mode !== "worker" && mode !== "example") {
  throw new Error("usage: npm run test:browser -- direct|worker|example");
}

const tarballValue = process.env.NECPP_WASM_TARBALL;
if (typeof tarballValue !== "string" || tarballValue.length === 0) {
  throw new Error("NECPP_WASM_TARBALL must identify the already-tested release tarball");
}
const tarball = resolve(tarballValue);
if (!existsSync(tarball)) {
  throw new Error(`Release tarball does not exist: ${tarball}`);
}

const packageDirectory = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(
  readFileSync(join(packageDirectory, "package.json"), "utf8"),
);
const fixture = mkdtempSync(join(tmpdir(), `necpp-wasm-browser-${mode}-`));
const repositoryRoot = resolve(packageDirectory, "../..");

function writeFixture(relativePath, contents) {
  const path = join(fixture, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function run(command, args) {
  const invocation = command === "npm"
    ? resolveNpmInvocation(args)
    : { command, args, shell: false };
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: fixture,
    encoding: "utf8",
    shell: invocation.shell,
    stdio: ["ignore", "pipe", "pipe"],
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
}

function allocatePort() {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("failed to allocate a Vite preview port"));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePort(address.port);
      });
    });
    server.on("error", reject);
  });
}

async function startPreview() {
  const port = await allocatePort();
  const viteBin = join(fixture, "node_modules", "vite", "bin", "vite.js");
  const child = spawn(
    process.execPath,
    [viteBin, "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    {
      cwd: fixture,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let output = "";
  const consume = (chunk) => {
    output += chunk.toString();
  };
  child.stdout?.on("data", consume);
  child.stderr?.on("data", consume);
  const origin = `http://127.0.0.1:${port}`;
  try {
    await waitForHttpServer(child, origin, () => output);
  } catch (error) {
    await stopChild(child);
    throw error;
  }
  return {
    origin,
    close: () => stopChild(child),
  };
}

const modelImport = mode === "direct"
  ? `import { abiVersion, createNecModel, engineVersion, packageVersion } from "@necpp-engine/wasm";`
  : `import { abiVersion, engineVersion, packageVersion } from "@necpp-engine/wasm";\nimport { createNecWorkerModel } from "@necpp-engine/wasm/worker";`;
const factory = mode === "direct" ? "createNecModel" : "createNecWorkerModel";
const awaitPrefix = mode === "direct" ? "" : "await ";

if (mode === "example") {
  cpSync(resolve(repositoryRoot, "examples/wasm-array-vite"), fixture, {
    force: true,
    recursive: true,
  });
  const examplePackageJson = JSON.parse(readFileSync(join(fixture, "package.json"), "utf8"));
  examplePackageJson.dependencies = {
    "@necpp-engine/wasm": `file:${tarball.replaceAll("\\", "/")}`,
  };
  writeFixture("package.json", `${JSON.stringify(examplePackageJson, null, 2)}\n`);
} else {
  writeFixture("package.json", `${JSON.stringify({
    name: `necpp-browser-${mode}-fixture`,
    private: true,
    type: "module",
    dependencies: {
      "@necpp-engine/wasm": `file:${tarball.replaceAll("\\", "/")}`,
    },
    devDependencies: {
      vite: "6.3.5",
    },
  }, null, 2)}\n`);
  writeFixture("vite.config.js", `export default {
  build: { target: "es2024" },
  worker: { format: "es" },
};
`);
  writeFixture("index.html", `<!doctype html>
<html><body><pre id="out">loading</pre><script type="module" src="/main.js"></script></body></html>
`);
  writeFixture("main.js", `${modelImport}

const out = document.getElementById("out");
try {
  const model = await ${factory}();
  try {
    const side = 4;
    const segments = 11;
    const frequencyMHz = 300;
    const wavelengthM = 299792458 / (frequencyMHz * 1e6);
    const ports = [];
    const half = side / 2;
    for (let y = half; y < side; y += 1) {
      for (let x = half; x < side; x += 1) {
        const tag = (y - half) * half + (x - half) + 1;
        const xM = (x - (side - 1) / 2) * wavelengthM / 2;
        const yM = (y - (side - 1) / 2) * wavelengthM / 2;
        ${awaitPrefix}model.addWire({
          tag,
          segments,
          start: [xM, yM, -wavelengthM / 8],
          end: [xM, yM, wavelengthM / 8],
          radiusM: wavelengthM / 1000,
        });
      }
    }
    const completion = ${awaitPrefix}model.completeGeometry({
      symmetry: {
        kind: "reflection",
        planes: ["x=0", "y=0"],
        tagIncrement: half * half,
      },
    });
    for (let tag = 1; tag <= side * side; tag += 1) {
      ports.push({ tag, segment: (segments + 1) / 2 });
    }
    ${awaitPrefix}model.definePorts(ports);
    ${awaitPrefix}model.prepare({ frequencyMHz });
    const matrices = ${awaitPrefix}model.computeImpedanceMatrix();
    const solution = ${awaitPrefix}model.solveVoltages({
      real: new Float64Array(ports.length).fill(1),
      imag: new Float64Array(ports.length),
    });
    const field = ${awaitPrefix}model.computeFarField({
      radiusM: 1,
      theta: { startDeg: 0, count: 3, stepDeg: 90 },
      phi: { startDeg: 0, count: 1, stepDeg: 1 },
    });
    window.__NEC_RESULT__ = {
      abiVersion,
      engineVersion,
      packageVersion,
      resistanceOhm: matrices.impedance.real[0],
      fieldSamples: field.eThetaReal.length,
      fieldFinite: [...field.eThetaReal, ...field.eThetaImag,
        ...field.ePhiReal, ...field.ePhiImag].every(Number.isFinite),
      powerBudget: solution.powerBudget,
      sectionCount: completion.symmetry?.sectionCount,
      mode: ${JSON.stringify(mode)},
    };
  } finally {
    ${awaitPrefix}model.dispose();
  }
} catch (error) {
  window.__NEC_RESULT__ = { error: error?.stack ?? String(error) };
}
out.textContent = JSON.stringify(window.__NEC_RESULT__);
`);
}

let preview;
let browser;
try {
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"]);
  const viteBin = join(fixture, "node_modules", "vite", "bin", "vite.js");
  run(process.execPath, [viteBin, "build"]);
  preview = await startPreview();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const browserErrors = [];
  const wasmResponses = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      browserErrors.push(`console: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => browserErrors.push(`page: ${error.stack ?? error}`));
  page.on("response", (response) => {
    if (response.url().includes(".wasm")) {
      wasmResponses.push(response.headers()["content-type"] ?? "");
    }
  });
  await page.goto(preview.origin, { waitUntil: "domcontentloaded" });
  await page.waitForFunction((testMode) => testMode === "example"
    ? window.__NECPP_EXAMPLE_RESULT__ !== undefined
    : window.__NEC_RESULT__ !== undefined, mode, {
    timeout: 120_000,
  });
  const result = await page.evaluate((testMode) => testMode === "example"
    ? window.__NECPP_EXAMPLE_RESULT__
    : window.__NEC_RESULT__, mode);
  assert.deepEqual(browserErrors, []);
  assert.equal(result.error, undefined, result.error);
  assert.equal(result.packageVersion, packageJson.version);
  if (mode === "example") {
    assert.equal(result.ready, true);
    assert.equal(result.portCount, 4);
    assert.equal(result.fieldSamples, 361);
    assert.equal(result.finite, true);
    assert.equal(result.representation, "symmetric");
    assert.equal(result.maxPositionAdjustmentM, 0);
    assert.deepEqual(result.reasonCodes, []);
    assert.equal(await page.locator("#ports tbody tr").count(), 4);
    assert.equal(await page.locator("#matrix tbody tr").count(), 5);
    assert.equal(await page.locator("#plot .pattern").count(), 1);
  } else {
    assert.equal(result.mode, mode);
    assert.equal(result.abiVersion, 1);
    assert.equal(result.engineVersion, "2.5.0");
    assert.ok(result.resistanceOhm > 0);
    assert.equal(result.fieldSamples, 3);
    assert.equal(result.fieldFinite, true);
    assert.ok(result.powerBudget.inputPowerW > 0);
    assert.ok(Math.abs(
      result.powerBudget.inputPowerW - result.powerBudget.radiatedPowerW,
    ) < 1e-10);
    assert.equal(result.sectionCount, 4);
  }
  assert.ok(wasmResponses.length >= 1, "the browser must request the emitted WASM asset");
  assert.ok(
    wasmResponses.every((contentType) => /application\/wasm/.test(contentType)),
    `unexpected WASM MIME types: ${wasmResponses.join(", ")}`,
  );
  process.stdout.write(
    `Browser ${mode} integration passed\n`,
  );
} finally {
  await browser?.close();
  await preview?.close();
  rmSync(fixture, { force: true, recursive: true });
}
