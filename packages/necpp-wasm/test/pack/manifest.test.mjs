import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  hasWasmArtifacts,
  packPackage,
} from "./helpers.mjs";

const skip = !hasWasmArtifacts && "WASM artifacts have not been built";
const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
);

test("npm pack contains only the documented publish files", { skip }, () => {
  const packed = packPackage();
  assert.equal(packed.version, packageJson.version);
  const filenamePrefix = packageJson.name.slice(1).replace("/", "-");
  assert.equal(packed.filename, `${filenamePrefix}-${packageJson.version}.tgz`);
  assert.equal(packageJson.version, "0.2.0");
  assert.equal(packageJson.engines.node, ">=24");
  assert.deepEqual(packageJson.publishConfig, {
    access: "public",
    registry: "https://registry.npmjs.org/",
  });
  assert.equal(packageJson.repository.url, "git+https://github.com/andrekuehne/necpp.git");
  assert.equal(packageJson.bugs.url, "https://github.com/andrekuehne/necpp/issues");
  assert.ok(packageJson.keywords.includes("nec2"));
  assert.ok(packageJson.keywords.includes("wasm"));

  const files = new Set(packed.files);
  const required = [
    "package.json",
    "README.md",
    "COPYING",
    "dist/index.js",
    "dist/index.d.ts",
    "dist/worker.js",
    "dist/worker.d.ts",
    "dist/worker-entry.js",
    "dist/nec2pp.generated.js",
    "dist/nec2pp.wasm",
  ];
  for (const path of required) {
    assert.ok(files.has(path), `missing ${path} in packed tarball`);
  }

  for (const path of files) {
    const allowed = path === "package.json"
      || path === "README.md"
      || path === "COPYING"
      || path.startsWith("dist/");
    assert.ok(allowed, `packed unexpected path ${path}`);
    assert.equal(path.includes(".."), false);
    assert.doesNotMatch(path, /\.map$/);
    assert.doesNotMatch(path, /(^|\/)src\//);
    assert.doesNotMatch(path, /(^|\/)test\//);
  }
});
