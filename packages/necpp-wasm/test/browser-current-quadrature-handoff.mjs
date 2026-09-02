import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { chromium } from "playwright";

const root = resolve(import.meta.dirname, "../.test-build/src");
const wasmPath = resolve(root, "nec2pp.wasm");
const generatedPath = resolve(root, "nec2pp.generated.js");
if (
  !existsSync(wasmPath)
  || !existsSync(generatedPath)
  || !readFileSync(generatedPath, "utf8").includes(
    "_necpp_wasm_v1_get_current_distribution",
  )
) {
  process.stdout.write("skip: WASM artifacts have not been rebuilt with WP4 ABI exports\n");
  process.exit(0);
}

const server = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/") {
    response.setHeader("content-type", "text/html");
    response.end(`<!doctype html><script type="module">
      import { createNecWorkerModel } from "/worker.js";

      const fourNode = {
        nodes: Float64Array.of(-1, -1 / 3, 1 / 3, 1),
        images: "physical-only",
        modes: "unit-current",
      };
      const field = {
        radiusM: 1,
        theta: { startDeg: 0, count: 5, stepDeg: 45 },
        phi: { startDeg: 0, count: 3, stepDeg: 90 },
      };

      const consumerSource = [
        "let bound = null;",
        "self.onmessage = (event) => {",
        "  if (event.data && event.data.port) {",
        "    event.data.port.onmessage = (handoffEvent) => {",
        "      const message = handoffEvent.data;",
        "      if (message && message.kind === 'isolated-element-characterization') {",
        "        bound = {",
        "          necq: new Uint8Array(message.quadrature.buffer, 0, 4).join(','),",
        "          necf: new Uint8Array(message.embeddedField.buffer, 0, 4).join(','),",
        "          quadratureBytes: message.quadrature.byteLength,",
        "          embeddedBytes: message.embeddedField.byteLength,",
        "        };",
        "        self.postMessage({ kind: 'bound', ...bound });",
        "      }",
        "    };",
        "    return;",
        "  }",
        "  if (event.data && event.data.kind === 'steer') {",
        "    self.postMessage({ kind: 'steer', rebound: bound !== null });",
        "  }",
        "};",
      ].join("\\n");
      const consumer = new Worker(
        URL.createObjectURL(new Blob([consumerSource], { type: "text/javascript" })),
      );
      const channel = new MessageChannel();
      const bound = new Promise((resolve) => {
        consumer.onmessage = (event) => {
          if (event.data?.kind === "bound") resolve(event.data);
        };
      });
      consumer.postMessage({ port: channel.port2 }, [channel.port2]);

      const model = await createNecWorkerModel();
      try {
        await model.addWire({
          tag: 1, segments: 11,
          start: [0, 0, -0.25], end: [0, 0, 0.25], radiusM: 0.001,
        });
        await model.completeGeometry();
        await model.definePorts([{ tag: 1, segment: 6 }]);
        await model.prepare({ frequencyMHz: 300 });
        const handoff = await model.characterizeIsolatedElement(
          { quadrature: fourNode, field },
          { destination: channel.port1 },
        );
        const received = await bound;
        consumer.postMessage({ kind: "steer" });
        const steered = await new Promise((resolve) => {
          consumer.onmessage = (event) => {
            if (event.data?.kind === "steer") resolve(event.data);
          };
        });
        window.result = {
          clientHasQuadrature: "quadrature" in handoff,
          clientHasEmbedded: "embeddedField" in handoff,
          quadratureBytes: handoff.quadratureByteLength,
          embeddedBytes: handoff.embeddedFieldByteLength,
          necq: received.necq,
          necf: received.necf,
          rebound: steered.rebound,
        };
      } catch (error) {
        window.result = { error: error?.stack ?? String(error) };
      } finally {
        await model.dispose();
        consumer.terminate();
        window.disposed = true;
      }
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
  await page.waitForFunction(() => window.disposed === true);
  const result = await page.evaluate(() => window.result);
  if (result.error) {
    throw new Error(result.error);
  }
  if (
    result.clientHasQuadrature !== false
    || result.clientHasEmbedded !== false
    || result.necq !== "78,69,67,81"
    || result.necf !== "78,69,67,70"
    || result.rebound !== true
    || !(result.quadratureBytes > 0)
    || !(result.embeddedBytes > 0)
  ) {
    throw new Error(`Unexpected characterization handoff result ${JSON.stringify(result)}`);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
