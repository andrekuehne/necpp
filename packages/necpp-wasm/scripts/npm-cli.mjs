import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Resolve npm without assuming one Node distribution layout.
 *
 * `npm_execpath` exists under `npm run`, but not when CI invokes a test with
 * `node` directly. setup-node installs npm under ../lib/node_modules on
 * POSIX, while common Windows distributions place it beside node.exe.
 */
export function resolveNpmInvocation(
  args,
  {
    env = process.env,
    execPath = process.execPath,
    platform = process.platform,
  } = {},
) {
  const nodeDirectory = dirname(execPath);
  const candidates = [
    env.npm_execpath,
    resolve(nodeDirectory, "node_modules/npm/bin/npm-cli.js"),
    resolve(nodeDirectory, "../lib/node_modules/npm/bin/npm-cli.js"),
  ];
  const npmCli = candidates.find((candidate) => (
    typeof candidate === "string"
    && candidate.length > 0
    && existsSync(candidate)
  ));

  if (npmCli !== undefined) {
    return {
      command: execPath,
      args: [npmCli, ...args],
      shell: false,
    };
  }

  // Last resort for nonstandard installations. A shell is needed for
  // npm.cmd on Windows; POSIX can execute npm's shebang launcher directly.
  return {
    command: "npm",
    args,
    shell: platform === "win32",
  };
}
