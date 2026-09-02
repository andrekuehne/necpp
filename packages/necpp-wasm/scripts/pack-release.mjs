import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

import { resolveNpmInvocation } from "./npm-cli.mjs";

const packageDirectory = resolve(import.meta.dirname, "..");
const outputDirectory = resolve(process.argv[2] ?? join(packageDirectory, ".pack-work"));
const packageJson = JSON.parse(
  readFileSync(join(packageDirectory, "package.json"), "utf8"),
);

if (packageJson.private === true) {
  throw new Error("Refusing to create a release tarball while package.json is private");
}
if (
  packageJson.publishConfig?.access !== "public"
  || packageJson.publishConfig?.registry !== "https://registry.npmjs.org/"
) {
  throw new Error("Release package must target the public npm registry with public access");
}

mkdirSync(outputDirectory, { recursive: true });

const invocation = resolveNpmInvocation([
  "pack",
  "--pack-destination",
  outputDirectory,
  "--json",
]);
const packed = spawnSync(invocation.command, invocation.args, {
  cwd: packageDirectory,
  encoding: "utf8",
  shell: invocation.shell,
  stdio: ["ignore", "pipe", "inherit"],
});
if (packed.error) {
  throw packed.error;
}
if (packed.status !== 0) {
  throw new Error(`npm pack failed with status ${packed.status}`);
}

const jsonStart = packed.stdout.indexOf("[");
if (jsonStart < 0) {
  throw new Error(`npm pack did not return a JSON report:\n${packed.stdout}`);
}
const reports = JSON.parse(packed.stdout.slice(jsonStart));
const report = reports[0];
if (report?.version !== packageJson.version) {
  throw new Error(
    `Packed version ${report?.version ?? "<missing>"} does not match ${packageJson.version}`,
  );
}

const requiredFiles = new Set([
  "package.json",
  "README.md",
  "COPYING",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/worker.js",
  "dist/worker.d.ts",
  "dist/worker-entry.js",
  "dist/field-evaluator-worker.js",
  "dist/field-evaluator.js",
  "dist/field-worker-pool.js",
  "dist/nec2pp.generated.js",
  "dist/nec2pp.wasm",
  "dist/necpp-field-evaluator.generated.js",
  "dist/necpp-field-evaluator.wasm",
  "fixtures/current-quadrature-v1/manifest.json",
  "fixtures/current-quadrature-v1/dipole.necq",
  "fixtures/current-quadrature-v1/dipole.necf",
]);
const packedFiles = new Set(
  (report.files ?? []).map(({ path }) => path.replaceAll("\\", "/")),
);
for (const path of requiredFiles) {
  if (!packedFiles.has(path)) {
    throw new Error(`Release tarball is missing ${path}`);
  }
}
for (const path of packedFiles) {
  const allowed = path === "package.json"
    || path === "README.md"
    || path === "COPYING"
    || path.startsWith("dist/")
    || path.startsWith("fixtures/");
  if (!allowed) {
    throw new Error(`Release tarball contains unexpected path ${path}`);
  }
  if (/\.map$|\.tsbuildinfo$|(^|\/)src\/|(^|\/)test\//.test(path)) {
    throw new Error(`Release tarball contains a source or debug artifact: ${path}`);
  }
}

const tarball = join(outputDirectory, report.filename);
if (!existsSync(tarball)) {
  throw new Error(`npm pack did not create ${tarball}`);
}
const digest = createHash("sha256").update(readFileSync(tarball)).digest("hex");
const normalizedReport = {
  ...report,
  files: report.files ?? [],
  sha256: digest,
  tarballBytes: statSync(tarball).size,
};
writeFileSync(
  join(outputDirectory, "package-report.json"),
  `${JSON.stringify(normalizedReport, null, 2)}\n`,
);
writeFileSync(
  join(outputDirectory, "SHA256SUMS"),
  `${digest}  ${basename(tarball)}\n`,
);

process.stdout.write(
  `Packed ${report.filename} (${normalizedReport.tarballBytes} bytes, sha256 ${digest})\n`,
);
