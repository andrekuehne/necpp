import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  necfSchemaVersion,
  necqFlags,
  necqSchemaVersion,
} from "../.test-build/src/index.js";
import * as workerEntry from "../.test-build/src/worker.js";

const repoRoot = new URL("../../../", import.meta.url);
const fixtureDirectory = new URL("../fixtures/current-quadrature-v1/", import.meta.url);

function source(path) {
  return readFileSync(new URL(path, repoRoot), "utf8");
}

function constant(text, pattern) {
  const match = text.match(pattern);
  assert.ok(match, `missing ${pattern}`);
  return Number(match[1]);
}

test("NECQ and NECF schema exports match the engine", () => {
  assert.equal(necqSchemaVersion, 1);
  assert.equal(necfSchemaVersion, 1);
  assert.deepEqual({ ...necqFlags }, { images: 1, weights: 2 });
  assert.ok(Object.isFrozen(necqFlags));

  const header = source("src/nec_prepared_current_quadrature.h");
  assert.equal(
    constant(header, /nec_prepared_quadrature_schema_version = (\d+);/),
    necqSchemaVersion,
  );
  assert.equal(
    constant(header, /nec_prepared_quadrature_flag_images = (\d+)u;/),
    necqFlags.images,
  );
  assert.equal(
    constant(header, /nec_prepared_quadrature_flag_weights = (\d+)u;/),
    necqFlags.weights,
  );
  assert.equal(
    constant(source("src/necpp_wasm_v1.cpp"), /kNecfSchemaVersion = (\d+);/),
    necfSchemaVersion,
  );

  const necqRust = source("packages/necpp-wasm/rust/necq_view.rs");
  assert.equal(constant(necqRust, /NECQ_SCHEMA_VERSION: u32 = (\d+);/), necqSchemaVersion);
  assert.equal(constant(necqRust, /NECQ_FLAG_IMAGES: u32 = (\d+);/), necqFlags.images);
  assert.equal(constant(necqRust, /NECQ_FLAG_WEIGHTS: u32 = (\d+);/), necqFlags.weights);
  assert.equal(
    constant(source("packages/necpp-wasm/rust/necf_view.rs"), /NECF_SCHEMA_VERSION: u32 = (\d+);/),
    necfSchemaVersion,
  );
});

test("the worker entry exports the same schema constants", () => {
  assert.equal(workerEntry.necqSchemaVersion, necqSchemaVersion);
  assert.equal(workerEntry.necfSchemaVersion, necfSchemaVersion);
  assert.equal(workerEntry.necqFlags, necqFlags);
});

test("published fixtures carry the exported schema versions and flag bits", () => {
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", fixtureDirectory), "utf8"));
  const definedFlags = necqFlags.images | necqFlags.weights;
  let necqCount = 0;
  let necfCount = 0;
  for (const fixture of manifest.cases) {
    for (const packed of [fixture.quadraturePacked, fixture.embeddedPacked]) {
      if (!packed) {
        continue;
      }
      const bytes = readFileSync(new URL(packed.file, fixtureDirectory));
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      assert.equal(bytes.subarray(0, 4).toString("latin1"), packed.magic);
      if (packed.magic === "NECQ") {
        necqCount += 1;
        assert.equal(view.getUint32(4, true), necqSchemaVersion, packed.file);
        assert.equal(view.getUint32(8, true) & ~definedFlags, 0, packed.file);
      } else {
        necfCount += 1;
        assert.equal(view.getUint32(4, true), necfSchemaVersion, packed.file);
      }
    }
  }
  assert.ok(necqCount > 0);
  assert.ok(necfCount > 0);
});
