import assert from "node:assert/strict";
import test from "node:test";
import { shouldSubmitComposerKey } from "../web/composer-keyboard";

test("modification composer submits with Enter only", () => {
  assert.equal(shouldSubmitComposerKey({ key: "Enter" }), true);
  assert.equal(shouldSubmitComposerKey({ key: "Enter", shiftKey: true }), false);
  assert.equal(shouldSubmitComposerKey({ key: "Enter", isComposing: true }), false);
  assert.equal(shouldSubmitComposerKey({ key: "Enter", repeat: true }), false);
  assert.equal(shouldSubmitComposerKey({ key: "a" }), false);
});
