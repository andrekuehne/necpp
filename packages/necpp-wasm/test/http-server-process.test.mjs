import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

import { stopChild, waitForHttpServer } from "./http-server-process.mjs";

test("HTTP readiness does not depend on colorized server output", async (context) => {
  const serverScript = `
    const { createServer } = require("node:http");
    let ready = false;
    setTimeout(() => { ready = true; }, 100);
    const server = createServer((_request, response) => {
      response.writeHead(ready ? 200 : 503);
      response.end(ready ? "ready" : "starting");
    });
    server.listen(0, "127.0.0.1", () => {
      process.stdout.write("\\u001b[36mLocal: http://\\u001b[1m127.0.0.1\\u001b[22m\\u001b[36m\\u001b[39m\\n");
      process.send(server.address().port);
    });
  `;
  const child = spawn(process.execPath, ["-e", serverScript], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  context.after(() => stopChild(child));

  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  const [port] = await once(child, "message");
  const origin = `http://127.0.0.1:${port}`;

  assert.equal(output.includes(origin), false);
  await waitForHttpServer(child, origin, () => output, { timeoutMs: 5_000 });
  assert.equal((await fetch(origin)).status, 200);

  await stopChild(child);
  assert.equal(child.exitCode !== null || child.signalCode !== null, true);
});
