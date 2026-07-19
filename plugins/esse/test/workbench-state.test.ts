import assert from "node:assert/strict";
import test from "node:test";
import { batchPollDelay, keepSelectedBatchId, mergeBatchWithoutReordering } from "../web/workbench-state.js";
import type { BatchSnapshot, WorkbenchState } from "../web/types.js";

function batch(id: string, updatedAt = "2026-01-01T00:00:00.000Z", status: BatchSnapshot["status"] = "completed"): BatchSnapshot {
  return {
    id,
    title: id,
    prompt: id,
    outputDirectory: `C:\\output\\${id}`,
    offering: { id: "offer", providerProfileId: "provider", providerName: "provider", tierName: "default", adapterId: "openai-images", canonicalModelId: "model", providerModelId: "model", displayName: "model", concurrency: 1, price: { mode: "unknown", currency: "CNY" } },
    jobs: [],
    status,
    total: 0,
    queued: status === "queued" ? 1 : 0,
    running: status === "running" ? 1 : 0,
    succeeded: status === "completed" ? 1 : 0,
    failed: 0,
    canceled: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
  };
}

function state(batches: BatchSnapshot[], activeBatch?: BatchSnapshot): WorkbenchState {
  return { view: { tab: "batches", batchId: activeBatch?.id }, providers: [], offerings: [], batches, activeBatch, platform: "win32", secureStorage: "Windows DPAPI" };
}

test("full refresh preserves the batch explicitly selected by the user", () => {
  const first = batch("first");
  const second = batch("second");
  assert.equal(keepSelectedBatchId("second", state([first, second], first)), "second");
  assert.equal(keepSelectedBatchId("missing", state([first], first)), "first");
});

test("batch polling replaces in place without reordering or changing active batch", () => {
  const first = batch("first");
  const second = batch("second");
  const updatedSecond = batch("second", "2026-01-01T00:00:02.000Z", "running");
  const current = state([first, second], first);
  const merged = mergeBatchWithoutReordering(current, updatedSecond);
  assert.deepEqual(merged.batches.map((entry) => entry.id), ["first", "second"]);
  assert.equal(merged.batches[1], updatedSecond);
  assert.equal(merged.activeBatch?.id, "first");
  assert.equal(mergeBatchWithoutReordering(merged, updatedSecond), merged);
});

test("polling slows down after a batch reaches a terminal state", () => {
  assert.equal(batchPollDelay(batch("running", "now", "running")), 2_500);
  assert.equal(batchPollDelay(batch("done")), 15_000);
});
