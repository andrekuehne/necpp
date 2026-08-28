import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

const isRunning = (child) => child.exitCode === null && child.signalCode === null;

/**
 * Wait for a spawned HTTP server to answer instead of parsing its human-facing
 * console output. Tools such as Vite add ANSI styling when CI enables colors,
 * which can split an otherwise visible URL with escape sequences.
 */
export async function waitForHttpServer(
  child,
  url,
  getOutput,
  { timeoutMs = 30_000, pollIntervalMs = 50 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let processFailure;
  const onError = (error) => {
    processFailure = error;
  };
  const onExit = (code, signal) => {
    processFailure = new Error(
      `HTTP server exited ${code ?? `from signal ${signal}`} before becoming ready`,
    );
  };
  child.on("error", onError);
  child.on("exit", onExit);

  try {
    while (Date.now() < deadline) {
      if (processFailure !== undefined) {
        throw new Error(`${processFailure.message}:\n${getOutput()}`, {
          cause: processFailure,
        });
      }

      try {
        const remainingMs = deadline - Date.now();
        const response = await fetch(url, {
          signal: AbortSignal.timeout(Math.max(1, Math.min(1_000, remainingMs))),
        });
        await response.body?.cancel();
        if (response.ok) {
          return;
        }
      } catch (error) {
        if (processFailure !== undefined) {
          throw new Error(`${processFailure.message}:\n${getOutput()}`, {
            cause: processFailure,
          });
        }
        if (Date.now() >= deadline) {
          break;
        }
      }

      await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
    }
  } finally {
    child.off("error", onError);
    child.off("exit", onExit);
  }

  throw new Error(`HTTP server did not start at ${url}:\n${getOutput()}`);
}

export async function stopChild(child) {
  if (!isRunning(child)) {
    return;
  }

  const exited = once(child, "exit");
  child.kill();
  let forceKillTimer;
  const forceKillDelay = new Promise((resolveDelay) => {
    forceKillTimer = setTimeout(resolveDelay, 5_000);
    forceKillTimer.unref();
  });
  await Promise.race([
    exited,
    forceKillDelay,
  ]);
  clearTimeout(forceKillTimer);
  if (isRunning(child)) {
    child.kill("SIGKILL");
    await exited;
  }
}
