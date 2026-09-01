import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { parse } from "yaml";

const packageDirectory = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(packageDirectory, "../..");
const workflowSource = readFileSync(
  resolve(repositoryRoot, ".github/workflows/build.yml"),
  "utf8",
);
const workflow = parse(workflowSource);
const innerBuildSource = readFileSync(
  resolve(repositoryRoot, "scripts/build_wasm_inner.sh"),
  "utf8",
);
const packageJson = JSON.parse(
  readFileSync(resolve(packageDirectory, "package.json"), "utf8"),
);

test("WP8 workflow parses and contains every required release gate", () => {
  const requiredJobs = [
    "native",
    "native-api",
    "wasm-build",
    "node-abi",
    "ts-facade",
    "package",
    "package-consumer",
    "browser-direct",
    "browser-worker",
    "browser-firefox",
    "artifact-report",
    "release",
  ];
  for (const job of requiredJobs) {
    assert.ok(workflow.jobs[job], `missing workflow job ${job}`);
  }

  assert.deepEqual(workflow.on.push.tags, ["wasm-v*"]);
  assert.equal(workflow.env.NODE_VERSION, "24");
  assert.equal(workflow.env.EMSCRIPTEN_IMAGE, "emscripten/emsdk:4.0.7");
  assert.equal(workflow.env.TYPESCRIPT_VERSION, packageJson.devDependencies.typescript);
  assert.equal(workflow.env.PLAYWRIGHT_VERSION, packageJson.devDependencies.playwright);
  assert.equal(packageJson.private, false);

  assert.equal(workflow.jobs["node-abi"].needs, "wasm-build");
  assert.equal(workflow.jobs["ts-facade"].needs, "wasm-build");
  assert.equal(workflow.jobs["package-consumer"].needs, "package");
  assert.equal(workflow.jobs["browser-direct"].needs, "package");
  assert.equal(workflow.jobs["browser-worker"].needs, "package");
  assert.equal(workflow.jobs["browser-firefox"].needs, "package");
  assert.equal(workflow.jobs.release.needs, "artifact-report");

  const finalGates = new Set(workflow.jobs["artifact-report"].needs);
  for (const job of [
    "native",
    "native-api",
    "node-abi",
    "ts-facade",
    "package-consumer",
    "browser-direct",
    "browser-worker",
    "browser-firefox",
  ]) {
    assert.ok(finalGates.has(job), `artifact report does not require ${job}`);
  }
});

test("WP8 workflow packs once and publishes the tested tarball", () => {
  assert.equal((workflowSource.match(/run pack:release/g) ?? []).length, 1);
  assert.equal((workflowSource.match(/npm publish/g) ?? []).length, 1);
  assert.ok(workflowSource.includes('NECPP_WASM_TARBALL="$tarball"'));
  assert.match(workflowSource, /sha256sum --check SHA256SUMS/);
  assert.match(
    workflowSource,
    /tarball="\$\(find "\$PWD\/release" -maxdepth 1 -name '\*\.tgz' -print -quit\)"/,
  );
  assert.match(workflowSource, /npm publish "\$tarball" --access public --provenance/);
  assert.match(workflowSource, /gh release create/);
  assert.match(workflowSource, /run test:browser -- example/);
  assert.match(workflowSource, /playwright install --with-deps firefox/);
  assert.match(workflowSource, /NECPP_TEST_BROWSER: firefox/);
  for (const artifact of [
    "necpp-field-evaluator.js",
    "necpp-field-evaluator.wasm",
  ]) {
    assert.ok(workflowSource.includes(artifact), `workflow omits ${artifact}`);
  }

  const wasmSteps = workflow.jobs["wasm-build"].steps;
  assert.equal(
    wasmSteps.some((step) => step.uses?.startsWith("actions/setup-node@")),
    false,
    "the Emscripten container job must compile only",
  );
  assert.doesNotMatch(innerBuildSource, /--emit-tsd/);
  assert.doesNotMatch(workflowSource, /nec2pp\.d\.ts/);

  const releaseSetupNode = workflow.jobs.release.steps.find(
    (step) => step.uses?.startsWith("actions/setup-node@"),
  );
  assert.equal(releaseSetupNode?.uses, "actions/setup-node@v6");
  assert.equal(releaseSetupNode?.with?.["package-manager-cache"], false);
});
