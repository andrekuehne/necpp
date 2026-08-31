import assert from "node:assert/strict";
import test from "node:test";

import { analyzeArraySymmetry } from "../.test-build/src/index.js";
import { timingStats } from "../bench/far-field-benchmark.mjs";
import {
  PRIMARY_FIELD_GRID,
  SPEED_OF_LIGHT_M_PER_S,
  STEERING_POINTS,
  complexVectorChecksum,
  createFarFieldFixture,
  fixtureManifest,
  sourceGridForDisplay,
  steeringCurrents,
} from "../bench/far-field-fixture-v1.mjs";

test("far-field WP0 fixture freezes the production horizontal 8 x 8 model", () => {
  const fixture = createFarFieldFixture();
  assert.equal(fixture.id, "pav-ng-8x8-x-dipole-v1");
  assert.equal(fixture.speedOfLightMPerS, SPEED_OF_LIGHT_M_PER_S);
  assert.equal(fixture.frequencyMHz, 10_000);
  assert.equal(fixture.elementCount, 64);
  assert.equal(fixture.segmentsPerElement, 11);
  assert.equal(fixture.segmentCount, 704);
  assert.equal(fixture.feedSegment, 6);
  assert.equal(fixture.spacingM / fixture.wavelengthM, 0.5);
  assert.equal(fixture.lengthM / fixture.wavelengthM, 0.47);
  assert.equal(fixture.radiusM / fixture.wavelengthM, 0.001);
  assert.equal(fixture.heightM / fixture.wavelengthM, 0.25);
  assert.deepEqual(fixture.ground, { kind: "perfect" });
  assert.equal(fixture.groundConnection, "none");

  for (const [index, wire] of fixture.wires.entries()) {
    assert.equal(wire.start[1], wire.end[1], `wire ${index} y`);
    assert.equal(wire.start[2], fixture.heightM, `wire ${index} start height`);
    assert.equal(wire.end[2], fixture.heightM, `wire ${index} end height`);
    assert.ok(wire.end[0] > wire.start[0], `wire ${index} is x-directed`);
  }
});

test("far-field WP0 fixture asserts the production explicit fallback", () => {
  const fixture = createFarFieldFixture();
  const plan = analyzeArraySymmetry(fixture.description, { positionEpsilonM: 0 });
  assert.equal(plan.kind, "explicit");
  assert.ok(plan.reasons.some(({ code }) =>
    code === "UNSUPPORTED_ELEMENT_PATTERN_TRANSFORM"));
});

test("far-field WP0 grids match primary and consumer-derived secondary policy", () => {
  const fixture = createFarFieldFixture();
  const secondary = sourceGridForDisplay(fixture, 32, 32);
  assert.deepEqual(PRIMARY_FIELD_GRID.theta, { startDeg: 0, count: 181, stepDeg: 0.5 });
  assert.deepEqual(PRIMARY_FIELD_GRID.phi, { startDeg: 0, count: 360, stepDeg: 1 });
  assert.equal(secondary.theta.count, 69);
  assert.equal(secondary.phi.count, 272);
  assert.equal(secondary.theta.stepDeg, 90 / 68);
  assert.equal(secondary.phi.stepDeg, 360 / 272);
  assert.equal(secondary.derivation.display.n1, 32);
  assert.equal(secondary.derivation.display.n2, 32);
});

test("far-field WP0 steering is valid, deterministic, and checksum locked", () => {
  const fixture = createFarFieldFixture();
  assert.equal(STEERING_POINTS.length, 10);
  assert.deepEqual(STEERING_POINTS[0], { id: "broadside", u: 0, v: 0 });
  assert.ok(STEERING_POINTS.every(({ u, v }) => u ** 2 + v ** 2 <= 1));
  const checksums = STEERING_POINTS.map((point) =>
    complexVectorChecksum(steeringCurrents(fixture, point)).sha256);
  assert.deepEqual(checksums, [
    "ca38cc89646b9cd9290a769f54e81852a1d9aa70f2286792f741dc4937f59925",
    "0350938ee155954c87bdb12cebfebc2584d2d8f126d174a4bfbb865004e93bde",
    "dc4761c06459325fe0d767b919ab48fd4188159c8250a477423713d1d187019b",
    "548a90579c2debd93c149335a50ddafee5b6c5709be47dac71de74f2f4372a9b",
    "0a4860216b64f9ea5e0ae4cc536d7974b23f434be26202d1c2db4e999b038fcd",
    "4c15a06a16d52b87943cff35ac91f42bc5e2376bc80f9a0c616fcdc53189758a",
    "dae86a165706198ccbbfbfa588021ef84b57d54b8eba8e4f2338a136e96ff9d4",
    "0eb276cb1ff560fec88abaa043cd094ecc4a042d233489e5be1374ea48c60a6d",
    "c328737b01c99d826f4a341dda5bd8bf88781580af27a7c2d214cbf46a86dbf0",
    "602906112f63c81e6b4c7f9459a03c7f8fa60ffdde6d779b12b805190d1ceb0d",
  ]);
  assert.deepEqual(
    fixtureManifest().steering.map(({ requestedChecksum }) => requestedChecksum.sha256),
    checksums,
  );
});

test("far-field WP0 timing summaries retain dispersion", () => {
  assert.deepEqual(timingStats([8, 1, 4, 2, 16]), {
    count: 5,
    minimum: 1,
    median: 4,
    maximum: 16,
    p90: 16,
  });
  assert.equal(timingStats([Number.NaN]), null);
});
