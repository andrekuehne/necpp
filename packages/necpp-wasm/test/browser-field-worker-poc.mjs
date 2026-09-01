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
      const worker = new Worker("/field-worker-poc-outer.js", { type: "module" });
      worker.addEventListener("message", (event) => {
        window.result = event.data;
        worker.terminate();
      });
      worker.postMessage({ kind: "run" });
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
  const page = await browser.newPage();
  page.on("console", (message) => process.stderr.write(`${message.text()}\n`));
  page.on("pageerror", (error) => process.stderr.write(`${error.stack ?? error}\n`));
  await page.goto(`http://127.0.0.1:${address.port}/`);
  await page.waitForFunction(() => window.result !== undefined);
  const result = await page.evaluate(() => window.result);
  if (result.isolated !== false || result.samples !== 1240
      || result.finite !== true || result.workers !== 2
      || result.modelGeneration !== 1 || result.solutionGeneration !== 1
      || result.capability !== "supported") {
    throw new Error(`Unexpected browser evaluator result ${JSON.stringify(result)}`);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
