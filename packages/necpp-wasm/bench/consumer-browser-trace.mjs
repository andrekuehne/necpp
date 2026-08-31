import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { chromium } from "playwright";

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument near ${name ?? "end of command"}`);
    }
    values.set(name.slice(2), value);
  }
  if (!values.has("consumer-web") || !values.has("output")) {
    throw new Error("--consumer-web and --output are required");
  }
  return {
    consumerWeb: resolve(values.get("consumer-web")),
    output: resolve(values.get("output")),
    quick: values.get("quick") === "true",
  };
}

async function waitForServer(url, preview) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (preview.exitCode !== null) throw new Error("Vite preview exited early");
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // The preview server is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("timed out waiting for the consumer benchmark preview");
}

async function readTraceStream(client, handle) {
  const chunks = [];
  for (;;) {
    const result = await client.send("IO.read", { handle });
    chunks.push(result.base64Encoded
      ? Buffer.from(result.data, "base64")
      : Buffer.from(result.data));
    if (result.eof) break;
  }
  await client.send("IO.close", { handle });
  return Buffer.concat(chunks);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const host = "127.0.0.1";
  const port = 4176;
  const origin = `http://${host}:${port}`;
  const vite = resolve(options.consumerWeb, "node_modules", "vite", "bin", "vite.js");
  const preview = spawn(process.execPath, [
    vite,
    "preview",
    "--outDir", "dist-nec-benchmark",
    "--host", host,
    "--port", String(port),
  ], {
    cwd: options.consumerWeb,
    stdio: "ignore",
    shell: false,
  });
  try {
    const benchmarkPath = "/benchmarks/nec-performance.html";
    await waitForServer(`${origin}${benchmarkPath}`, preview);
    const browser = await chromium.launch({
      headless: true,
      args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding"],
    });
    try {
      const page = await browser.newPage();
      const client = await page.context().newCDPSession(page);
      await client.send("Tracing.start", {
        categories: [
          "devtools.timeline",
          "disabled-by-default-devtools.timeline",
          "disabled-by-default-devtools.timeline.frame",
          "v8",
          "v8.execute",
          "blink.user_timing",
        ].join(","),
        options: "sampling-frequency=10000",
        transferMode: "ReturnAsStream",
      });
      const query = options.quick ? "?autorun=1&quick=1" : "?autorun=1";
      await page.goto(`${origin}${benchmarkPath}${query}`, {
        waitUntil: "domcontentloaded",
      });
      await page.waitForFunction(
        () => ["complete", "error"].includes(document.body.dataset.status ?? ""),
        null,
        { timeout: 20 * 60_000 },
      );
      if (await page.locator("body").getAttribute("data-status") !== "complete") {
        throw new Error(
          await page.locator("body").getAttribute("data-error")
            ?? "consumer browser benchmark failed",
        );
      }
      const complete = new Promise((resolveComplete) => {
        client.once("Tracing.tracingComplete", resolveComplete);
      });
      await client.send("Tracing.end");
      const { stream } = await complete;
      const trace = await readTraceStream(client, stream);
      writeFileSync(options.output, trace);
      process.stdout.write(`${JSON.stringify({
        ok: true,
        output: options.output,
        bytes: trace.byteLength,
        userAgent: await page.evaluate(() => navigator.userAgent),
      })}\n`);
    } finally {
      await browser.close();
    }
  } finally {
    preview.kill();
  }
}

if (process.argv[1] !== undefined
    && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
