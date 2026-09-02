import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { chromium } from "playwright";

const root = resolve(import.meta.dirname, "../.test-build/src");
const fixturesRoot = resolve(
  import.meta.dirname,
  "../fixtures/current-quadrature-v1",
);
const wasmPath = resolve(root, "nec2pp.wasm");
const generatedPath = resolve(root, "nec2pp.generated.js");
const dipoleNecq = resolve(fixturesRoot, "dipole.necq");
const dipoleNecf = resolve(fixturesRoot, "dipole.necf");
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
if (!existsSync(dipoleNecq) || !existsSync(dipoleNecf)) {
  process.stdout.write("skip: current-quadrature-v1 fixtures have not been generated\n");
  process.exit(0);
}

function contentType(path) {
  const extension = extname(path);
  if (extension === ".js") return "text/javascript";
  if (extension === ".wasm") return "application/wasm";
  if (extension === ".json") return "application/json";
  return "application/octet-stream";
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
        "  const data = event.data;",
        "  if (data && data.port) {",
        "    data.port.onmessage = (handoffEvent) => {",
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
        "  if (data && data.kind === 'isolated-element-characterization') {",
        "    bound = {",
        "      necq: new Uint8Array(data.quadrature.buffer, 0, 4).join(','),",
        "      necf: new Uint8Array(data.embeddedField.buffer, 0, 4).join(','),",
        "      quadratureBytes: data.quadrature.byteLength,",
        "      embeddedBytes: data.embeddedField.byteLength,",
        "    };",
        "    self.postMessage({ kind: 'bound', ...bound });",
        "    return;",
        "  }",
        "  if (data && data.kind === 'steer') {",
        "    self.postMessage({ kind: 'steer', rebound: bound !== null });",
        "  }",
        "};",
      ].join("\\n");

      function createConsumer() {
        return new Worker(
          URL.createObjectURL(new Blob([consumerSource], { type: "text/javascript" })),
        );
      }

      const liveConsumer = createConsumer();
      const fixtureConsumer = createConsumer();
      const channel = new MessageChannel();
      const liveBound = new Promise((resolve) => {
        liveConsumer.onmessage = (event) => {
          if (event.data?.kind === "bound") resolve(event.data);
        };
      });
      liveConsumer.postMessage({ port: channel.port2 }, [channel.port2]);

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
        const received = await liveBound;
        liveConsumer.postMessage({ kind: "steer" });
        const steered = await new Promise((resolve) => {
          liveConsumer.onmessage = (event) => {
            if (event.data?.kind === "steer") resolve(event.data);
          };
        });

        const necq = await (await fetch("/fixtures/current-quadrature-v1/dipole.necq")).arrayBuffer();
        const necf = await (await fetch("/fixtures/current-quadrature-v1/dipole.necf")).arrayBuffer();
        const fixtureBound = new Promise((resolve) => {
          fixtureConsumer.onmessage = (event) => {
            if (event.data?.kind === "bound") resolve(event.data);
          };
        });
        fixtureConsumer.postMessage({
          kind: "isolated-element-characterization",
          quadrature: { schemaVersion: 1, byteLength: necq.byteLength, buffer: necq },
          embeddedField: { schemaVersion: 1, byteLength: necf.byteLength, buffer: necf },
        }, [necq, necf]);
        const fixtureReceived = await fixtureBound;
        fixtureConsumer.postMessage({ kind: "steer" });
        const fixtureSteered = await new Promise((resolve) => {
          fixtureConsumer.onmessage = (event) => {
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
          fixtureNceq: fixtureReceived.necq,
          fixtureNecf: fixtureReceived.necf,
          fixtureQuadratureBytes: fixtureReceived.quadratureBytes,
          fixtureEmbeddedBytes: fixtureReceived.embeddedBytes,
          fixtureRebound: fixtureSteered.rebound,
          mainHoldsFixtureBuffers: necq.byteLength > 0 || necf.byteLength > 0,
        };
      } catch (error) {
        window.result = { error: error?.stack ?? String(error) };
      } finally {
        await model.dispose();
        liveConsumer.terminate();
        fixtureConsumer.terminate();
        window.disposed = true;
      }
    </script>`);
    return;
  }
  if (url.pathname.startsWith("/fixtures/current-quadrature-v1/")) {
    const name = url.pathname.slice("/fixtures/current-quadrature-v1/".length);
    const path = resolve(fixturesRoot, name);
    try {
      if (!path.startsWith(fixturesRoot) || !statSync(path).isFile()) {
        throw new Error("missing");
      }
      response.setHeader("content-type", contentType(path));
      response.end(readFileSync(path));
    } catch {
      response.statusCode = 404;
      response.end("not found");
    }
    return;
  }
  const path = resolve(root, `.${url.pathname}`);
  try {
    if (!path.startsWith(root) || !statSync(path).isFile()) throw new Error("missing");
    response.setHeader("content-type", contentType(path));
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
    || result.fixtureNceq !== "78,69,67,81"
    || result.fixtureNecf !== "78,69,67,70"
    || result.fixtureRebound !== true
    || result.fixtureQuadratureBytes !== 4072
    || result.fixtureEmbeddedBytes !== 608
    || result.mainHoldsFixtureBuffers !== false
  ) {
    throw new Error(`Unexpected characterization handoff result ${JSON.stringify(result)}`);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
