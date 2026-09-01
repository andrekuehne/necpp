import { readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { chromium } from "playwright";

const root = resolve(import.meta.dirname, "../.test-build/src");
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/") {
    response.setHeader("content-type", "text/html");
    response.end(`<!doctype html><script type="module">
      import { createNecArraySolver } from "/index.js";
      const description = {
        elements: [{ id: "e0", positionM: [0, 0], patternId: "dipole" }],
        patterns: [{
          id: "dipole", kind: "straight-wire-pattern",
          wires: [{ id: "wire", segments: 11,
            startM: [-0.235, 0, 0.25], endM: [0.235, 0, 0.25], radiusM: 0.001 }],
          ports: [{ wireId: "wire", segment: 6 }],
        }],
        ground: { kind: "perfect" },
      };
      const solver = await createNecArraySolver(
        description,
        { symmetry: "off", fieldWorkers: 2 },
      );
      try {
        await solver.prepare({ frequencyMHz: 300 });
        await solver.solveVoltages({ real: Float64Array.of(1), imag: Float64Array.of(0) });
        const field = await solver.computeFarField({
          radiusM: 1,
          theta: { startDeg: 0, count: 31, stepDeg: 3 },
          phi: { startDeg: 0, count: 40, stepDeg: 9 },
        });
        window.result = {
          isolated: globalThis.crossOriginIsolated,
          samples: field.eThetaReal.length,
          finite: field.eThetaReal.every(Number.isFinite),
          backend: field.fieldBackend.backend,
          workers: field.fieldBackend.activeWorkerCount,
          tileSize: field.fieldBackend.tileSize,
          snapshotBytes: field.fieldBackend.snapshotBytesPerWorker,
        };
      } catch (error) {
        window.result = { error: error?.stack ?? String(error) };
      } finally {
        await solver.dispose();
        window.disposed = true;
      }

      window.startTeardownProbe = async () => {
        const active = await createNecArraySolver(
          description,
          { symmetry: "off", fieldWorkers: 2 },
        );
        await active.prepare({ frequencyMHz: 300 });
        await active.solveVoltages({ real: Float64Array.of(1), imag: Float64Array.of(0) });
        void active.computeFarField({
          radiusM: 1,
          theta: { startDeg: 0, count: 181, stepDeg: 0.5 },
          phi: { startDeg: 0, count: 360, stepDeg: 1 },
        }).catch(() => undefined);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
        return true;
      };
    </script>`);
    return;
  }
  const path = resolve(root, `.${url.pathname}`);
  try {
    if (!path.startsWith(root) || !statSync(path).isFile()) throw new Error("missing");
    response.setHeader("content-type", extname(path) === ".js"
      ? "text/javascript" : extname(path) === ".wasm"
        ? "application/wasm" : "application/octet-stream");
    response.end(readFileSync(path));
  } catch {
    response.statusCode = 404;
    response.end("not found");
  }
});
await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const address = server.address();
const browser = await chromium.launch({ headless: true });
try {
  const cdp = await browser.newBrowserCDPSession();
  await cdp.send("Target.setDiscoverTargets", { discover: true });
  const page = await browser.newPage();
  page.on("console", (message) => process.stderr.write(`${message.text()}\n`));
  page.on("pageerror", (error) => process.stderr.write(`${error.stack ?? error}\n`));
  await page.goto(`http://127.0.0.1:${address.port}/`);
  await page.waitForFunction(() => window.result !== undefined);
  await page.waitForFunction(() => window.disposed === true);
  const result = await page.evaluate(() => window.result);
  if (result.isolated !== false || result.samples !== 1240
      || result.finite !== true || result.backend !== "worker-pool"
      || result.workers !== 2 || result.tileSize !== 512
      || result.snapshotBytes !== 11 * 13 * 8) {
    throw new Error(`Unexpected production browser result ${JSON.stringify(result)}`);
  }
  await page.evaluate(() => window.startTeardownProbe());
  const workerTargets = async () => (await cdp.send("Target.getTargets"))
    .targetInfos.filter((target) => target.type === "worker"
      && target.url.startsWith(`http://127.0.0.1:${address.port}/`));
  const beforeClose = await workerTargets();
  if (beforeClose.length < 1) {
    throw new Error("Teardown probe did not create a discoverable worker target");
  }
  await page.close();
  const teardownDeadline = Date.now() + 5_000;
  while ((await workerTargets()).length !== 0 && Date.now() < teardownDeadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  const afterClose = await workerTargets();
  if (afterClose.length !== 0) {
    throw new Error(`Page teardown left ${afterClose.length} worker targets alive`);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
