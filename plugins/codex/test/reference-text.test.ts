import assert from "node:assert/strict";
import test from "node:test";
import { batchReferenceText, imageIdReferenceText } from "../src/reference-text.js";

test("batch reference text names the batch and preserves its exact ID", () => {
  assert.equal(batchReferenceText("春季海报", "batch-123"), "批次名称：春季海报\nbatchId: batch-123");
});

test("image reference text preserves the exact image ID", () => {
  assert.equal(imageIdReferenceText("image-456"), "imageId: image-456");
});
