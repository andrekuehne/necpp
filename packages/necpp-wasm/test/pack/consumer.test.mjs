import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer as createNetServer } from "node:net";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  VITE_VERSION,
  cdnDipoleScript,
  createCleanFixture,
  dipoleScript,
  hasWasmArtifacts,
  installFixture,
  packPackage,
  readPackedWasm,
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
  let settled = false;
  let timeout;

  const ready = new Promise((resolve, reject) => {
    const fail = (reason) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(reason instanceof Error ? reason : new Error(String(reason)));
    };
    const succeed = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    const onChunk = (chunk) => {
      output += chunk.toString();
      if (output.includes(`http://127.0.0.1:${port}`)) {
        succeed();
      }
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    child.on("error", fail);
    child.on("exit", (code) => {
      fail(new Error(`vite preview exited ${code}: ${output}`));
    });
    timeout = setTimeout(() => {
      fail(new Error(`vite preview did not start:\n${output}`));
    }, 30_000);
  });

  await ready;
  return {
    origin: `http://127.0.0.1:${port}`,
    async close() {
      if (child.exitCode !== null) {
        return;
      }
      const exited = once(child, "exit");
      child.kill();
      await exited;
    },
  };
}

test("a clean Node fixture imports the tarball by name and solves a dipole", {
  skip,
}, () => {
  const fixture = createCleanFixture("node");
  installFixture(fixture.root);
  writeFixtureFile(fixture.root, "dipole.mjs", dipoleScript);
  writeFixtureFile(fixture.root, "worker-dipole.mjs", workerDipoleScript);

  const direct = parseJsonLine(run("node", ["dipole.mjs"], {
    cwd: fixture.root,
    stdio: ["ignore", "pipe", "inherit"],
  }).stdout);
  assert.equal(direct.packageVersion, packageJson.version);
  assert.equal(direct.engineVersion, "2.3.4");
  assert.equal(direct.abiVersion, 1);
  assert.ok(direct.resistanceOhm > 0);
  assert.match(direct.resolved.replaceAll("\\", "/"), /node_modules\/@necpp-engine\/wasm/);
  assert.doesNotMatch(direct.resolved, /packages[/\\]necpp-wasm[/\\]src[/\\]/);

  const worker = parseJsonLine(
    run("node", ["worker-dipole.mjs"], {
      cwd: fixture.root,
      stdio: ["ignore", "pipe", "inherit"],
    }).stdout,
  );
  assert.equal(worker.packageVersion, packageJson.version);
  assert.ok(Math.abs(worker.resistanceOhm - direct.resistanceOhm) < 1e-9);
});

test("custom wasmUrl loads the binary from an HTTP CDN-style origin", {
  skip,
}, async () => {
  const fixture = createCleanFixture("cdn");
  installFixture(fixture.root);
  writeFixtureFile(fixture.root, "cdn-dipole.mjs", cdnDipoleScript);
  packPackage();
  const server = await serveWasm(readPackedWasm());
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
