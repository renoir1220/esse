import assert from "node:assert/strict";
import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveDataPaths, ensureDataPaths } from "../src/paths.js";
import { SettingsStore } from "../src/storage/settings-store.js";
import { MemorySecretStore } from "../src/storage/secret-store.js";
import { BatchStore } from "../src/storage/batch-store.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { BatchManager } from "../src/jobs/batch-manager.js";
import { CODEX_GENERATION_OFFERING_ID } from "../src/types.js";

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

test("each child task keeps its own prompt and zero-to-many reference images", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "esse-references-"));
  try {
    const referencePaths = await Promise.all(Array.from({ length: 4 }, async (_, index) => {
      const filePath = path.join(root, `reference-${index + 1}.png`);
      await writeFile(filePath, Buffer.from(onePixelPng, "base64"));
      return filePath;
    }));
    const requests: Array<{ prompt?: string; image?: unknown[] }> = [];
    const { manager } = await createManager(root, async (_input, init) => {
      requests.push(JSON.parse(String(init?.body || "{}")) as { prompt?: string; image?: unknown[] });
      return new Response(JSON.stringify({ data: [{ b64_json: onePixelPng }] }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const created = await manager.create({
      offeringId: "offer-default",
      prompt: "batch fallback",
      jobs: [
        { prompt: "text-only child", referenceImagePaths: [] },
        { prompt: "four-reference child", referenceImagePaths: referencePaths }
      ]
    });
    const completed = await waitForBatch(manager, created.id);
    assert.deepEqual(completed.jobs.map((job) => job.prompt), ["text-only child", "four-reference child"]);
    assert.equal(completed.jobs[0]?.inputPaths?.length || 0, 0);
    assert.deepEqual(completed.jobs[1]?.inputPaths, referencePaths);
    assert.deepEqual(completed.jobs[1]?.referenceImagePaths, referencePaths);
    assert.equal(requests.find((request) => request.prompt === "text-only child")?.image, undefined);
    assert.equal(requests.find((request) => request.prompt === "four-reference child")?.image?.length, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex generation delegates to the current Agent and imports terminal results", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "esse-agent-generation-"));
  try {
    const referencePath = path.join(root, "reference.png");
    const generatedPath = path.join(root, "agent-result.png");
    await Promise.all([
      writeFile(referencePath, Buffer.from(onePixelPng, "base64")),
      writeFile(generatedPath, Buffer.from(onePixelPng, "base64"))
    ]);
    const { manager, registry, settings } = await createManager(root, async () => {
      throw new Error("Agent generation must not call a local Provider adapter.");
    });
    const offerings = await registry.listOfferings();
    const codex = offerings.find((entry) => entry.id === CODEX_GENERATION_OFFERING_ID);
    assert.equal(codex?.displayName, "Codex 生成");
    assert.equal(codex?.adapterId, "agent-generation");
    assert.equal(codex?.price.mode, "model_quota");
    assert.equal(codex?.configured, true);
    await settings.setDefaultOffering(CODEX_GENERATION_OFFERING_ID);

    const created = await manager.create({
      offeringId: CODEX_GENERATION_OFFERING_ID,
      prompt: "fallback",
      jobs: [
        { prompt: "use the reference", referenceImagePaths: [referencePath] },
        { prompt: "this Agent cannot finish", referenceImagePaths: [] }
      ],
      requestKey: "agent-batch"
    });
    assert.equal(created.status, "queued");
    assert.equal(created.estimatedCost, undefined);
    assert.equal(created.jobs[0]?.prompt, "use the reference");
    assert.deepEqual(created.jobs[0]?.referenceImagePaths, [referencePath]);

    const firstJob = created.jobs[0]!;
    const secondJob = created.jobs[1]!;
    assert.equal((await manager.startAgentJob(created.id, firstJob.id)).jobs[0]?.status, "running");
    const completed = await manager.completeAgentJob(created.id, firstJob.id, generatedPath);
    assert.equal(completed.jobs[0]?.status, "succeeded");
    assert(completed.jobs[0]?.outputPath?.startsWith(completed.outputDirectory));
    await access(generatedPath);
    await access(completed.jobs[0]!.outputPath!);
    const duplicate = await manager.completeAgentJob(created.id, firstJob.id, generatedPath);
    assert.equal(duplicate.jobs[0]?.outputPath, completed.jobs[0]?.outputPath);
    assert.equal((await readdir(completed.outputDirectory)).length, 1);

    await manager.startAgentJob(created.id, secondJob.id);
    const failed = await manager.failAgentJob(created.id, secondJob.id, "当前 Agent 不支持第二项生成");
    assert.equal(failed.status, "partial");
    assert.equal(failed.jobs[1]?.status, "failed");
    assert.equal(failed.jobs[1]?.retryable, false);
    assert.equal(failed.jobs[1]?.error, "当前 Agent 不支持第二项生成");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("in-place modification keeps the batch, refreshes the main image, and creates Chinese backups", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "esse-edit-"));
  try {
    const requestedModels: string[] = [];
    const { manager } = await createManager(root, async (_input, init) => {
      requestedModels.push(String((JSON.parse(String(init?.body || "{}")) as { model?: string }).model || ""));
      return new Response(JSON.stringify({ data: [{ b64_json: onePixelPng }] }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const created = await manager.create({ offeringId: "offer-default", prompt: "original", count: 1, requestKey: "edit-source" });
    const original = await waitForBatch(manager, created.id);
    const originalJob = onlyJob(original);
    const originalPath = originalJob.outputPath!;
    assert.equal(originalJob.name, "图1");
    assert.equal(originalJob.offering?.id, "offer-default");

    const editing = await manager.modifyInPlace({ batchId: created.id, jobIds: [originalJob.id], instructions: "只保留一支向日葵", offeringId: "offer-alternate", requestKey: "edit-once" });
    assert.equal(editing.id, created.id);
    const editingJob = onlyJob(editing);
    assert.equal(editingJob.backups?.[0]?.name, "图1-1");
    assert.equal(editingJob.backups?.[0]?.offering?.id, "offer-default");
    assert.equal(editingJob.offering?.id, "offer-alternate");
    const backupPath = editingJob.backups![0]!.outputPath;
    assert.deepEqual(editingJob.referenceImagePaths, [backupPath]);
    await access(backupPath);

    const modified = await waitForBatch(manager, created.id);
    const modifiedJob = onlyJob(modified);
    assert.equal(modifiedJob.status, "succeeded");
    assert.equal(modifiedJob.offering?.id, "offer-alternate");
    assert.deepEqual(requestedModels, ["gpt-image-2", "alternate-image-model"]);
    assert.notEqual(modifiedJob.outputPath, originalPath);
    assert.deepEqual(modifiedJob.referenceImagePaths, [backupPath]);
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

test("batch library pages all records by most recent activity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "esse-library-"));
  try {
    const { manager } = await createManager(root, async () => new Response(JSON.stringify({ data: [{ b64_json: onePixelPng }] }), { status: 200, headers: { "content-type": "application/json" } }));
    const created = [];
    for (let index = 0; index < 5; index += 1) {
      const batch = await manager.create({ offeringId: "offer-default", title: `batch-${index + 1}`, prompt: `prompt-${index + 1}`, count: 1 });
      created.push(await waitForBatch(manager, batch.id));
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    const oldest = created[0]!;
    const refreshed = await manager.modifyInPlace({ batchId: oldest.id, jobIds: [oldest.jobs[0]!.id], instructions: "recently modified" });
    await waitForBatch(manager, refreshed.id);

    assert.equal(manager.listRecent(1)[0]?.id, oldest.id);
    const firstPage = manager.listPage(1, 4);
    const secondPage = manager.listPage(2, 4);
    assert.equal(firstPage.total, 5);
    assert.equal(firstPage.totalPages, 2);
    assert.equal(firstPage.batches.length, 4);
    assert.equal(secondPage.batches.length, 1);
    assert.equal(new Set([...firstPage.batches, ...secondPage.batches].map((batch) => batch.id)).size, 5);
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
    }, {
      id: "offer-alternate",
      canonicalModelId: "alternate-image-model",
      providerModelId: "alternate-image-model",
      displayName: "Alternate Image",
      price: { mode: "per_request", currency: "USD", amount: 0.08 },
      supportsTextToImage: true,
      supportsImageToImage: true,
      sizes: [],
      qualities: []
    }]
  });
  const store = new BatchStore(paths.batchesDir);
  const registry = new ProviderRegistry(settings, fetchImpl);
  const manager = new BatchManager(store, registry, paths);
  await manager.initialize();
  return { manager, store, registry, settings };
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
