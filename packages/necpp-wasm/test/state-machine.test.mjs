import assert from "node:assert/strict";
import test from "node:test";

import { NecStateError } from "../src/errors.ts";
import {
  MODEL_TRANSITIONS,
  transitionModelState,
} from "../src/state-machine.ts";

const states = [
  "empty",
  "geometry-building",
  "geometry-complete",
  "prepared",
  "solved",
  "disposed",
];

const operations = Object.keys(MODEL_TRANSITIONS);

test("the lifecycle table explicitly covers every operation/state pair", () => {
  assert.equal(operations.length, 13);
  assert.equal(states.length, 6);

  for (const operation of operations) {
    for (const state of states) {
      const expected = MODEL_TRANSITIONS[operation][state];
      if (expected === undefined) {
        assert.throws(
          () => transitionModelState(state, operation),
          (error) =>
            error instanceof NecStateError
            && error.code === "NEC_STATE"
            && error.operation === operation
            && error.state === state,
          `${operation} should be illegal in ${state}`,
        );
      } else {
        if (typeof expected === "string") {
          assert.equal(
            transitionModelState(state, operation),
            expected,
            `${operation} should transition ${state} to ${expected}`,
          );
        } else {
          assert.equal(
            transitionModelState(state, operation, { configurationChanged: true }),
            expected.configurationChanged,
          );
          assert.equal(
            transitionModelState(state, operation, { configurationChanged: false }),
            expected.configurationUnchanged,
          );
        }
      }
    }
  }
});

test("unchanged preparation is idempotent after a solve", () => {
  assert.equal(
    transitionModelState("solved", "prepare", { configurationChanged: false }),
    "solved",
  );
  assert.equal(
    transitionModelState("solved", "prepare", { configurationChanged: true }),
    "prepared",
  );
});

test("dispose is idempotent and disposed models reject every other operation", () => {
  assert.equal(transitionModelState("disposed", "dispose"), "disposed");

  for (const operation of operations) {
    if (operation !== "dispose") {
      assert.throws(
        () => transitionModelState("disposed", operation),
        NecStateError,
      );
    }
  }
});
