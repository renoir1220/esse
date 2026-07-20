import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("Esse skill uses native append and treats pricing as a quiet estimate", async () => {
  const skill = await readFile(path.resolve("skills/batch-generate-images/SKILL.md"), "utf8");
  assert.match(skill, /call `append_image_batch_jobs` with that exact `batchId`/);
  assert.match(skill, /Never create a temporary batch or use `merge_image_batches` to simulate append/);
  assert.match(skill, /Treat all price metadata as an estimate, not a bill or guaranteed charge/);
  assert.match(skill, /Do not volunteer or repeat price narration for routine generation/);
});
