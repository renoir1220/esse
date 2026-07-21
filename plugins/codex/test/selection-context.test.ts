import assert from "node:assert/strict";
import test from "node:test";
import { imagesMentionedInRequest, selectableImages, selectionModelContext } from "../web/selection-context.js";
import type { BatchSnapshot } from "../web/types.js";

test("selected Esse images are identified by display name, stable image ID, and path", () => {
  const context = selectionModelContext(batch(), new Set(["job-2"]));
  assert.match(context, /图2 \(image ID: job-2, local path: C:\\output\\job-2\.png\)/);
  assert.match(context, /必须把这些准确 image ID 传给 modify_selected_images/);
});

test("multiple unselected images require clarification and explain both selection methods", () => {
  const context = selectionModelContext(batch(), new Set());
  assert.match(context, /不得猜测/);
  assert.match(context, /例如“图1”/);
  assert.match(context, /双击选择图片/);
});

test("backups and failed-job source images are independently selectable", () => {
  const images = selectableImages(batch());
  assert.deepEqual(images.map((image) => [image.name, image.kind]), [
    ["图1", "result"],
    ["图2", "result"],
    ["图2-1", "backup"],
    ["图3", "failed-source"]
  ]);
  assert.deepEqual(imagesMentionedInRequest(batch(), "把图2-1变暖，但图1保持原样").map((image) => image.name), ["图1", "图2-1"]);
  assert.deepEqual(imagesMentionedInRequest(batch(), "把图2-1变成冷色调").map((image) => image.name), ["图2-1"]);
  const backupContext = selectionModelContext(batch(), new Set(["backup-2-1"]));
  assert.match(backupContext, /图2-1 \(image ID: backup-2-1, local path: C:\\output\\job-2-1\.png\)/);
  assert.match(backupContext, /历史备份或失败任务的原始参考图/);
});

function batch(): BatchSnapshot {
  const offering = { id: "offer", providerProfileId: "provider", providerName: "provider", tierName: "default", adapterId: "openai-images" as const, canonicalModelId: "model", providerModelId: "model", displayName: "model", concurrency: 1, price: { mode: "unknown" as const, currency: "CNY" } };
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: "batch-1", title: "测试批次", prompt: "prompt", outputDirectory: "C:\\output", offering,
    jobs: [
      { id: "job-1", index: 0, name: "图1", outputPath: "C:\\output\\job-1.png", offering, prompt: "prompt", status: "succeeded" as const, progress: 100, attempt: 1, retryable: false, chargeState: "charged" as const, createdAt: now },
      { id: "job-2", index: 1, name: "图2", outputPath: "C:\\output\\job-2.png", backups: [{ id: "backup-2-1", name: "图2-1", outputPath: "C:\\output\\job-2-1.png", prompt: "old prompt", createdAt: now }], offering, prompt: "prompt", status: "succeeded" as const, progress: 100, attempt: 1, retryable: false, chargeState: "charged" as const, createdAt: now },
      { id: "job-3", index: 2, name: "图3", referenceImagePaths: ["C:\\input\\failed-original.png"], offering, prompt: "prompt", status: "failed" as const, progress: 0, attempt: 1, retryable: true, chargeState: "unknown" as const, error: "timeout", createdAt: now }
    ],
    status: "partial", total: 3, queued: 0, running: 0, succeeded: 2, failed: 1, canceled: 0, createdAt: now, updatedAt: now
  };
}
