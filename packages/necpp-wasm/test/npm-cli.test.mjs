import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { resolveNpmInvocation } from "../scripts/npm-cli.mjs";

test("npm resolves when node is invoked directly without npm_execpath", () => {
  const env = { ...process.env };
  delete env.npm_execpath;
  const invocation = resolveNpmInvocation(["--version"], { env });
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: "utf8",
    env,
    shell: invocation.shell,
    windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
});
