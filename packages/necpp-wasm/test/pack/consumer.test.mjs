import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { stopChild, waitForHttpServer } from "../http-server-process.mjs";

import {
  VITE_VERSION,
  cdnDipoleScript,
  createCleanFixture,
  dipoleScript,
  hasWasmArtifacts,
  installFixture,
  packPackage,
  readInstalledWasm,
  readInstalledLoader,
  run,
  runAsync,
  serveWasm,
  workerDipoleScript,
  writeFixtureFile,
} from "./helpers.mjs";

const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
);

const skip = !hasWasmArtifacts && "WASM artifacts have not been built";

function parseJsonLine(stdout) {
  return JSON.parse(stdout.trim());
}

function collectFiles(root) {
  const files = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      files.push(path);
    }
  }
  walk(root);
  return files;
}

function listenPort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("failed to allocate a preview port"));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.on("error", reject);
  });
}

async function startVitePreview(root) {
  const port = await listenPort();
  const viteBin = join(root, "node_modules", "vite", "bin", "vite.js");
  const child = spawn(
    process.execPath,
    [viteBin, "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );

  let output = "";
  const onChunk = (chunk) => {
    output += chunk.toString();
  };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);
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

test("a clean Node fixture imports the tarball by name and solves a dipole", {
  skip,
}, () => {
  const fixture = createCleanFixture("node");
  installFixture(fixture.root);
  writeFixtureFile(fixture.root, "dipole.mjs", dipoleScript);
  writeFixtureFile(fixture.root, "worker-dipole.mjs", workerDipoleScript);
  for (const name of ["manual-direct.mjs", "manual-worker.mjs"]) {
    writeFixtureFile(
      fixture.root,
      name,
      readFileSync(new URL(`../../../../examples/wasm-symmetry/${name}`, import.meta.url), "utf8"),
    );
  }

  const direct = parseJsonLine(run("node", ["dipole.mjs"], {
    cwd: fixture.root,
    stdio: ["ignore", "pipe", "inherit"],
  }).stdout);
  assert.equal(direct.packageVersion, packageJson.version);
  assert.equal(direct.engineVersion, "2.5.0");
  assert.equal(direct.abiVersion, 1);
  assert.equal(direct.sectionCount, 4);
  assert.ok(direct.resistanceOhm > 0);
  assert.ok(direct.powerBudget.inputPowerW > 0);
  assert.equal(direct.combinedFieldSamples, 1);
  assert.ok(direct.rootedInputPowers.interpolate > 0);
  assert.ok(direct.rootedInputPowers["zero-current"] > 0);
  assert.notEqual(
    direct.rootedInputPowers.interpolate,
    direct.rootedInputPowers["zero-current"],
  );
  assert.match(direct.resolved.replaceAll("\\", "/"), /node_modules\/@necpp-engine\/wasm/);
  assert.doesNotMatch(direct.resolved, /packages[/\\]necpp-wasm[/\\]src[/\\]/);

  const packedLoader = readInstalledLoader(fixture.root);
  for (const symbol of [
    "_necpp_wasm_v1_complete_geometry_symmetric",
    "_necpp_wasm_v1_geometry_symmetry_kind",
    "_necpp_wasm_v1_geometry_section_count",
    "_necpp_wasm_v1_geometry_fundamental_segment_count",
    "_necpp_wasm_v1_geometry_full_segment_count",
    "_necpp_wasm_v1_solution_input_power_w",
    "_necpp_wasm_v1_solution_radiated_power_w",
    "_necpp_wasm_v1_solution_structure_loss_w",
    "_necpp_wasm_v1_solution_network_loss_w",
  ]) {
    assert.ok(packedLoader.includes(symbol), `packed loader is missing ${symbol}`);
  }

  const worker = parseJsonLine(
    run("node", ["worker-dipole.mjs"], {
      cwd: fixture.root,
      stdio: ["ignore", "pipe", "inherit"],
    }).stdout,
  );
  assert.equal(worker.packageVersion, packageJson.version);
  assert.equal(worker.sectionCount, 4);
  assert.ok(Math.abs(worker.resistanceOhm - direct.resistanceOhm) < 1e-9);
  assert.deepEqual(worker.powerBudget, direct.powerBudget);
  assert.equal(worker.combinedFieldSamples, 1);

  for (const [name, mode] of [
    ["manual-direct.mjs", "direct"],
    ["manual-worker.mjs", "worker"],
  ]) {
    const example = parseJsonLine(run("node", [name], {
      cwd: fixture.root,
      stdio: ["ignore", "pipe", "inherit"],
    }).stdout);
    assert.equal(example.mode, mode);
    assert.equal(example.sectionCount, 4);
    assert.equal(example.portCount, 4);
    assert.equal(example.finite, true);
  }
});

test("every package README TypeScript example compiles and the quick start executes", {
  skip,
}, () => {
  const fixture = createCleanFixture("readme");
  installFixture(fixture.root, [
    `@types/node@${packageJson.devDependencies["@types/node"]}`,
    `typescript@${packageJson.devDependencies.typescript}`,
    `vite@${VITE_VERSION}`,
  ]);

  const readme = readFileSync(join(
    fixture.root,
    "node_modules",
    "@necpp-engine",
    "wasm",
    "README.md",
  ), "utf8");
  for (const requiredText of [
    "Symmetric arrays and automatic optimization",
    "Full NxN input with automatic selection",
    'symmetry: "auto"',
    'symmetry: "off"',
    'symmetry: "require"',
    "maxPositionAdjustmentM",
    "UNSUPPORTED_ELEMENT_PATTERN_TRANSFORM",
    "11.55x",
    "https://github.com/andrekuehne/necpp/blob/master/docs/wasm-api.md",
  ]) {
    assert.ok(readme.includes(requiredText), `packed README is missing ${requiredText}`);
  }
  const examples = [...readme.matchAll(/```ts\r?\n([\s\S]*?)```/g)]
    .map((match) => match[1]);
  assert.ok(examples.length >= 10, "expected all documented TypeScript examples");

  const paths = examples.map((source, index) => {
    const path = `readme-example-${index + 1}.ts`;
    writeFixtureFile(fixture.root, path, source);
    return path;
  });
  const tsc = join(fixture.root, "node_modules", "typescript", "bin", "tsc");
  run(process.execPath, [
    tsc,
    "--noEmit",
    "--strict",
    "--noUncheckedIndexedAccess",
    "--exactOptionalPropertyTypes",
    "--skipLibCheck",
    "--target", "ES2024",
    "--module", "NodeNext",
    "--moduleResolution", "NodeNext",
    "--lib", "ES2024,DOM",
    ...paths,
  ], { cwd: fixture.root });

  writeFixtureFile(fixture.root, "readme-quick-start.mjs", examples[0]);
  run("node", ["readme-quick-start.mjs"], { cwd: fixture.root });
});

test("custom wasmUrl loads the binary from an HTTP CDN-style origin", {
  skip,
}, async () => {
  const fixture = createCleanFixture("cdn");
  installFixture(fixture.root);
  writeFixtureFile(fixture.root, "cdn-dipole.mjs", cdnDipoleScript);
  const server = await serveWasm(readInstalledWasm(fixture.root));
  try {
    const result = parseJsonLine((await runAsync("node", ["cdn-dipole.mjs"], {
      cwd: fixture.root,
      env: {
        ...process.env,
        NEC_WASM_URL: server.url,
      },
      stdio: ["ignore", "pipe", "inherit"],
    })).stdout);
    assert.equal(result.wasmUrl, server.url);
    assert.ok(result.resistanceOhm > 0);
  } finally {
    await server.close();
  }
});

test("a clean Vite fixture builds, serves WASM with the correct MIME type, and bundles the worker", {
  skip,
}, async () => {
  const fixture = createCleanFixture("vite");
  writeFixtureFile(fixture.root, "vite.config.js", `export default {
  build: {
    target: "es2024",
  },
  worker: {
    format: "es",
  },
};
`);
  writeFixtureFile(fixture.root, "index.html", `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>NEC WASM Vite fixture</title>
  </head>
  <body>
    <pre id="out">loading</pre>
    <script type="module" src="/main.js"></script>
  </body>
</html>
`);
  writeFixtureFile(fixture.root, "main.js", `import {
  abiVersion,
  createNecModel,
  engineVersion,
  packageVersion,
} from "@necpp-engine/wasm";
import { createNecWorkerModel } from "@necpp-engine/wasm/worker";

const out = document.getElementById("out");

async function runDirect() {
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
    return {
      abiVersion,
      engineVersion,
      packageVersion,
      resistanceOhm: matrices.impedance.real[0],
    };
  } finally {
    model.dispose();
  }
}

async function runWorker() {
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
    return matrices.impedance.real[0];
  } finally {
    await model.dispose();
  }
}

try {
  const direct = await runDirect();
  const workerResistanceOhm = await runWorker();
  const payload = {
    ...direct,
    workerResistanceOhm,
    workerOk: Number.isFinite(workerResistanceOhm),
  };
  out.textContent = JSON.stringify(payload);
  window.__NEC_RESULT__ = payload;
} catch (error) {
  const payload = { error: String(error) };
  out.textContent = JSON.stringify(payload);
  window.__NEC_RESULT__ = payload;
}
`);

  installFixture(fixture.root, [`vite@${VITE_VERSION}`]);
  const viteBin = join(fixture.root, "node_modules", "vite", "bin", "vite.js");
  run(process.execPath, [viteBin, "build"], { cwd: fixture.root });

  const builtRoot = join(fixture.root, "dist");
  const builtFiles = collectFiles(builtRoot);
  const wasmFiles = builtFiles.filter((path) => path.endsWith(".wasm"));
  assert.ok(wasmFiles.length >= 1, "Vite build must emit the WASM binary");
  const builtJs = builtFiles
    .filter((path) => path.endsWith(".js"))
    .map((path) => readFileSync(path, "utf8"));
  assert.ok(
    builtJs.some((source) => source.includes("Worker")),
    "Vite build must retain the worker constructor",
  );
  assert.ok(
    builtJs.every((source) => {
      return !source.includes("packages/necpp-wasm/src/")
        && !source.includes("packages\\\\necpp-wasm\\\\src\\\\");
    }),
    "bundled output must not reference the original repository source tree",
  );

  const preview = await startVitePreview(fixture.root);
  try {
    const htmlResponse = await fetch(`${preview.origin}/`);
    assert.equal(htmlResponse.ok, true);
    assert.match(await htmlResponse.text(), /NEC WASM Vite fixture/);

    const wasmPath = wasmFiles[0].slice(builtRoot.length).replaceAll("\\", "/");
    const wasmResponse = await fetch(preview.origin + wasmPath);
    assert.equal(wasmResponse.ok, true, `WASM asset ${wasmPath} must be served`);
    const mime = wasmResponse.headers.get("content-type") ?? "";
    assert.match(mime, /application\/wasm/);
    assert.ok((await wasmResponse.arrayBuffer()).byteLength > 0);
  } finally {
    await preview.close();
  }
});
