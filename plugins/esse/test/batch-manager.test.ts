import assert from "node:assert/strict";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveDataPaths, ensureDataPaths } from "../src/paths.js";
import { SettingsStore } from "../src/storage/settings-store.js";
import { MemorySecretStore } from "../src/storage/secret-store.js";
import { BatchStore } from "../src/storage/batch-store.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { BatchManager } from "../src/jobs/batch-manager.js";

const onePixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=";

test("persistent local batch respects profile concurrency and writes unique output files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "esse-batch-"));
  try {
    const paths = resolveDataPaths({ ESSE_DATA_DIR: root }, process.platform);
    await ensureDataPaths(paths);
    const settings = new SettingsStore(paths.settingsFile, new MemorySecretStore());
    await settings.saveProvider({
      id: "profile-default",
      displayName: "兔子",
      tierName: "default",
      baseUrl: "https://provider.invalid",
      adapterId: "tuzi-json-images",
      concurrency: 2,
      apiKey: "test-key",
      offerings: [{
        id: "offer-default",
        canonicalModelId: "gpt-image-2",
        providerModelId: "gpt-image-2",
        displayName: "GPT-Image 2",
        price: { mode: "per_request", currency: "CNY", amount: 0.035 },
        supportsTextToImage: true,
        supportsImageToImage: true,
        sizes: [],
        qualities: []
      }]
    });
    let active = 0;
    let peak = 0;
    const fetchImpl: typeof fetch = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active -= 1;
      return new Response(JSON.stringify({ data: [{ b64_json: onePixelPng }] }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const registry = new ProviderRegistry(settings, fetchImpl);
    const manager = new BatchManager(new BatchStore(paths.batchesDir), registry, paths);
    await manager.initialize();
    const perImagePrompts = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [String(index + 1), `prompt-${index + 1}`]));
    const created = await manager.create({ offeringId: "offer-default", prompt: "fallback", count: 5, perImagePrompts, requestKey: "batch-once" });
    const duplicate = await manager.create({ offeringId: "offer-default", prompt: "fallback", count: 5, perImagePrompts, requestKey: "batch-once" });
    assert.equal(duplicate.id, created.id);
    const completed = await waitForBatch(manager, created.id);
    assert.equal(completed.succeeded, 5);
    assert.equal(peak, 2);
    assert.deepEqual(completed.jobs.map((job) => job.prompt), Object.values(perImagePrompts));
    assert.equal(new Set(completed.jobs.map((job) => job.outputPath)).size, 5);
    assert.equal((await readdir(completed.outputDirectory)).length, 5);
    assert.equal(completed.estimatedCost, 0.175);
    const reloaded = new BatchManager(new BatchStore(paths.batchesDir), registry, paths);
    await reloaded.initialize();
    assert.equal(reloaded.get(created.id).succeeded, 5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("in-place modification keeps the batch, refreshes the main image, and creates Chinese backups", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "esse-edit-"));
  try {
    const { manager } = await createManager(root, async () => new Response(JSON.stringify({ data: [{ b64_json: onePixelPng }] }), { status: 200, headers: { "content-type": "application/json" } }));
    const created = await manager.create({ offeringId: "offer-default", prompt: "original", count: 1, requestKey: "edit-source" });
    const original = await waitForBatch(manager, created.id);
    const originalJob = onlyJob(original);
    const originalPath = originalJob.outputPath!;
    assert.equal(originalJob.name, "图1");

    const editing = await manager.modifyInPlace({ batchId: created.id, jobIds: [originalJob.id], instructions: "只保留一支向日葵", requestKey: "edit-once" });
    assert.equal(editing.id, created.id);
    const editingJob = onlyJob(editing);
    assert.equal(editingJob.backups?.[0]?.name, "图1-1");
    const backupPath = editingJob.backups![0]!.outputPath;
    await access(backupPath);

    const modified = await waitForBatch(manager, created.id);
    const modifiedJob = onlyJob(modified);
    assert.equal(modifiedJob.status, "succeeded");
    assert.notEqual(modifiedJob.outputPath, originalPath);
    await access(modifiedJob.outputPath!);
    await assert.rejects(access(originalPath));
    const duplicate = await manager.modifyInPlace({ batchId: created.id, jobIds: [modifiedJob.id], instructions: "不会重复提交", requestKey: "edit-once" });
    assert.equal(onlyJob(duplicate).backups?.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("definitely uncharged failures auto retry three times, while unknown-charge failures do not", async () => {
  const retryRoot = await mkdtemp(path.join(os.tmpdir(), "esse-retry-"));
  const unknownRoot = await mkdtemp(path.join(os.tmpdir(), "esse-unknown-"));
  try {
    let retryCalls = 0;
    const { manager: retryManager } = await createManager(retryRoot, async () => {
      retryCalls += 1;
      if (retryCalls <= 3) return new Response(JSON.stringify({ error: { message: "busy" } }), { status: 429, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ data: [{ b64_json: onePixelPng }] }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const retried = await retryManager.create({ offeringId: "offer-default", prompt: "retry", count: 1 });
    const completed = await waitForBatch(retryManager, retried.id);
    const completedJob = onlyJob(completed);
    assert.equal(completedJob.status, "succeeded");
    assert.equal(completedJob.attempt, 4);
    assert.equal(retryCalls, 4);

    let unknownCalls = 0;
    const { manager: unknownManager } = await createManager(unknownRoot, async () => {
      unknownCalls += 1;
      throw new Error("connection dropped");
    });
    const unknown = await unknownManager.create({ offeringId: "offer-default", prompt: "unknown", count: 1 });
    const failed = await waitForBatch(unknownManager, unknown.id);
    const failedJob = onlyJob(failed);
    assert.equal(failedJob.status, "failed");
    assert.equal(failedJob.chargeState, "unknown");
    assert.equal(failedJob.retryable, true);
    assert.equal(unknownCalls, 1);
  } finally {
    await Promise.all([rm(retryRoot, { recursive: true, force: true }), rm(unknownRoot, { recursive: true, force: true })]);
  }
});

test("deleting a terminal batch removes its managed images and record", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "esse-delete-"));
  try {
    const { manager, store } = await createManager(root, async () => new Response(JSON.stringify({ data: [{ b64_json: onePixelPng }] }), { status: 200, headers: { "content-type": "application/json" } }));
    const created = await manager.create({ offeringId: "offer-default", prompt: "delete", count: 1 });
    const completed = await waitForBatch(manager, created.id);
    const outputPath = onlyJob(completed).outputPath!;
    await manager.delete(created.id);
    assert.throws(() => manager.get(created.id), /Unknown image batch/);
    assert.equal(await store.get(created.id), undefined);
    await assert.rejects(access(outputPath));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function createManager(root: string, fetchImpl: typeof fetch) {
  const paths = resolveDataPaths({ ESSE_DATA_DIR: root }, process.platform);
  await ensureDataPaths(paths);
  const settings = new SettingsStore(paths.settingsFile, new MemorySecretStore());
  await settings.saveProvider({
    id: "profile-default",
    displayName: "兔子",
    tierName: "default",
    baseUrl: "https://provider.invalid",
    adapterId: "tuzi-json-images",
    concurrency: 2,
    apiKey: "test-key",
    offerings: [{
      id: "offer-default",
      canonicalModelId: "gpt-image-2",
      providerModelId: "gpt-image-2",
      displayName: "GPT-Image 2",
      price: { mode: "per_request", currency: "USD", amount: 0.05 },
      supportsTextToImage: true,
      supportsImageToImage: true,
      sizes: [],
      qualities: []
    }]
  });
  const store = new BatchStore(paths.batchesDir);
  const manager = new BatchManager(store, new ProviderRegistry(settings, fetchImpl), paths);
  await manager.initialize();
  return { manager, store };
}

async function waitForBatch(manager: BatchManager, id: string) {
  for (let index = 0; index < 200; index += 1) {
    const batch = manager.get(id);
    if (!["queued", "running"].includes(batch.status)) return batch;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("Timed out waiting for local batch.");
}

function onlyJob(batch: Awaited<ReturnType<typeof waitForBatch>>) {
  assert.equal(batch.jobs.length, 1);
  return batch.jobs[0]!;
}
