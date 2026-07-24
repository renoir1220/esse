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
    const responseFormats: unknown[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      responseFormats.push((JSON.parse(String(init?.body || "{}")) as { response_format?: unknown }).response_format);
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
    assert.deepEqual(responseFormats, Array(5).fill("b64_json"));
    for (const job of completed.jobs) {
      assert.equal(job.callHistory?.length, 1);
      assert.equal(job.callHistory?.[0]?.source, "provider");
      assert.equal(job.callHistory?.[0]?.status, "succeeded");
      assert.equal(typeof job.callHistory?.[0]?.durationMs, "number");
    }
    const reloaded = new BatchManager(new BatchStore(paths.batchesDir), registry, paths);
    await reloaded.initialize();
    assert.equal(reloaded.get(created.id).succeeded, 5);
    assert.equal(reloaded.get(created.id).jobs[0]?.callHistory?.[0]?.status, "succeeded");
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

test("new jobs append directly to an active batch with their own model and idempotency key", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "esse-append-generate-"));
  try {
    const requests: Array<{ model?: string; prompt?: string; size?: string }> = [];
    const { manager, store, registry, paths } = await createManager(root, async (_input, init) => {
      requests.push(JSON.parse(String(init?.body || "{}")) as { model?: string; prompt?: string; size?: string });
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response(JSON.stringify({ data: [{ b64_json: onePixelPng }] }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const created = await manager.create({
      offeringId: "offer-default",
      prompt: "original turtle",
      count: 1,
      size: "1024x1024"
    });
    const appendInput = {
      batchId: created.id,
      offeringId: "offer-alternate",
      prompt: "fallback",
      jobs: [{ prompt: "new turtle one" }, { prompt: "new turtle two" }],
      requestKey: "append-once"
    };
    const appended = await manager.append(appendInput);
    assert.equal(appended.batch.id, created.id);
    assert.equal(appended.batch.total, 3);
    assert.deepEqual(appended.batch.jobs.map((job) => job.name), ["图1", "图2", "图3"]);
    assert.deepEqual(appended.batch.jobs.slice(1).map((job) => job.offering?.id), ["offer-alternate", "offer-alternate"]);
    assert.deepEqual(appended.batch.jobs.slice(1).map((job) => job.prompt), ["new turtle one", "new turtle two"]);
    assert.deepEqual(appended.appendedJobIds, appended.batch.jobs.slice(1).map((job) => job.id));

    const duplicate = await manager.append(appendInput);
    assert.deepEqual(duplicate.appendedJobIds, appended.appendedJobIds);
    assert.equal(duplicate.batch.total, 3);
    await assert.rejects(
      manager.append({ batchId: created.id, prompt: "different operation", count: 2, requestKey: "append-once" }),
      /already used with different arguments/u
    );

    const completed = await waitForBatch(manager, created.id);
    assert.equal(completed.succeeded, 3);
    assert.equal(manager.list(10).length, 1);
    assert.equal(completed.estimatedCost, 0.21);
    assert.deepEqual(requests.map((request) => request.model).sort(), ["alternate-image-model", "alternate-image-model", "gpt-image-2"]);
    assert.equal(requests.find((request) => request.model === "gpt-image-2")?.size, "1024x1024");
    assert(requests.filter((request) => request.model === "alternate-image-model").every((request) => request.size === undefined));

    const reloaded = new BatchManager(store, registry, paths);
    await reloaded.initialize();
    const persistedDuplicate = await reloaded.append(appendInput);
    assert.deepEqual(persistedDuplicate.appendedJobIds, appended.appendedJobIds);
    assert.equal(persistedDuplicate.batch.total, 3);
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
    assert.deepEqual(completed.jobs[0]?.callHistory?.map((call) => [call.source, call.status]), [["agent", "succeeded"]]);
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
    assert.deepEqual(failed.jobs[1]?.callHistory?.map((call) => [call.source, call.status, call.error]), [["agent", "failed", "当前 Agent 不支持第二项生成"]]);
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
    assert.deepEqual(modifiedJob.callHistory?.map((call) => [call.offering.id, call.status]), [["offer-default", "succeeded"], ["offer-alternate", "succeeded"]]);
    assert.notEqual(modifiedJob.outputPath, originalPath);
    assert.deepEqual(modifiedJob.referenceImagePaths, [backupPath]);
    await access(modifiedJob.outputPath!);
    await assert.rejects(access(originalPath));
    const duplicate = await manager.modifyInPlace({ batchId: created.id, jobIds: [originalJob.id], instructions: "只保留一支向日葵", offeringId: "offer-alternate", requestKey: "edit-once" });
    assert.equal(onlyJob(duplicate).backups?.length, 1);
    await assert.rejects(
      manager.modifyInPlace({ batchId: created.id, jobIds: [modifiedJob.id], instructions: "不同修改", requestKey: "edit-once" }),
      /already used with different arguments/u
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("backup and failed-source modifications append jobs to the same batch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "esse-append-edit-"));
  try {
    const { manager } = await createManager(root, async () => new Response(JSON.stringify({ data: [{ b64_json: onePixelPng }] }), { status: 200, headers: { "content-type": "application/json" } }));
    const created = await manager.create({ offeringId: "offer-default", prompt: "original", count: 1 });
    const completed = await waitForBatch(manager, created.id);
    const edited = await manager.modifyInPlace({ batchId: created.id, imageIds: [completed.jobs[0]!.id], instructions: "first edit" });
    const editedComplete = await waitForBatch(manager, edited.id);
    const backup = editedComplete.jobs[0]!.backups![0]!;

    const fromBackup = await manager.modifyInPlace({ batchId: created.id, imageIds: [backup.id], instructions: "edit the preserved version", requestKey: "append-backup" });
    assert.equal(fromBackup.id, created.id);
    assert.equal(fromBackup.total, 2);
    assert.equal(fromBackup.jobs[1]?.name, "图2");
    assert.deepEqual(fromBackup.jobs[1]?.referenceImagePaths, [backup.outputPath]);
    const backupComplete = await waitForBatch(manager, created.id);
    assert.equal(backupComplete.jobs[1]?.status, "succeeded");
    await access(backup.outputPath);

    const failedSource = path.join(root, "failed-source.png");
    await writeFile(failedSource, Buffer.from(onePixelPng, "base64"));
    const delegated = await manager.create({
      offeringId: CODEX_GENERATION_OFFERING_ID,
      prompt: "delegated",
      jobs: [{ prompt: "will fail", referenceImagePaths: [failedSource] }]
    });
    const failed = await manager.failAgentJob(delegated.id, delegated.jobs[0]!.id, "generation unavailable");
    const fromFailed = await manager.modifyInPlace({
      batchId: delegated.id,
      imageIds: [failed.jobs[0]!.id],
      instructions: "recover from the exact source",
      offeringId: "offer-default"
    });
    assert.equal(fromFailed.id, delegated.id);
    assert.equal(fromFailed.total, 2);
    assert.equal(fromFailed.jobs[1]?.name, "图2");
    assert.deepEqual(fromFailed.jobs[1]?.referenceImagePaths, [failedSource]);
    const recovered = await waitForBatch(manager, delegated.id);
    assert.equal(recovered.jobs[1]?.status, "succeeded");
    await access(failedSource);
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
    assert.deepEqual(completedJob.callHistory?.map((call) => call.status), ["failed", "failed", "failed", "succeeded"]);
    assert(completedJob.callHistory?.slice(0, 3).every((call) => Boolean(call.error)));
    assert(completedJob.callHistory?.every((call) => typeof call.durationMs === "number"));

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
    assert.deepEqual(failedJob.callHistory?.map((call) => [call.status, call.chargeState]), [["failed", "unknown"]]);
    assert.match(failedJob.callHistory?.[0]?.error || "", /connection dropped/);
    const manualRetry = await unknownManager.retry(unknown.id, [failedJob.id], true);
    assert.equal(onlyJob(manualRetry).attempt, 2);
    const failedAgain = await waitForBatch(unknownManager, unknown.id);
    assert.equal(unknownCalls, 2);
    assert.deepEqual(onlyJob(failedAgain).callHistory?.map((call) => call.status), ["failed", "failed"]);
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

test("deleting a terminal batch waits for pending persistence and cannot resurrect its record", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "esse-delete-race-"));
  try {
    const { manager, store } = await createManager(root, async () => { throw new Error("Agent generation must not call a Provider."); });
    const created = await manager.create({ offeringId: CODEX_GENERATION_OFFERING_ID, prompt: "delete race", count: 1 });
    const job = created.jobs[0]!;
    await manager.startAgentJob(created.id, job.id);

    const originalSave = store.save.bind(store);
    let releaseSave!: () => void;
    let markSaveEntered!: () => void;
    const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
    const saveEntered = new Promise<void>((resolve) => { markSaveEntered = resolve; });
    let delayNextSave = true;
    store.save = async (batch) => {
      if (delayNextSave) {
        delayNextSave = false;
        markSaveEntered();
        await saveGate;
      }
      await originalSave(batch);
    };

    const failing = manager.failAgentJob(created.id, job.id, "terminal failure");
    await saveEntered;
    let deletionSettled = false;
    const deleting = manager.delete(created.id).then(() => { deletionSettled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(deletionSettled, false, "delete must wait for the pending record write");
    assert.throws(() => manager.get(created.id), /Unknown image batch/);
    releaseSave();
    await Promise.all([failing, deleting]);
    assert.equal(await store.get(created.id), undefined);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(await store.get(created.id), undefined, "a delayed save must not recreate the deleted record");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generation size and quality survive restart and are reused by manual retry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "esse-generation-options-"));
  try {
    let failTransport = true;
    const payloads: Array<Record<string, unknown>> = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (failTransport) throw new Error("connection dropped");
      payloads.push(JSON.parse(String(init?.body || "{}")) as Record<string, unknown>);
      return new Response(JSON.stringify({ data: [{ b64_json: onePixelPng }] }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const { manager, store, registry, paths } = await createManager(root, fetchImpl);
    const created = await manager.create({ offeringId: "offer-default", prompt: "persistent options", count: 1, size: "1536x1024", quality: "high" });
    const failed = await waitForBatch(manager, created.id);
    assert.deepEqual(failed.generationOptions, { size: "1536x1024", quality: "high" });

    failTransport = false;
    const restored = new BatchManager(store, registry, paths);
    await restored.initialize();
    const retrying = await restored.retry(created.id, [failed.jobs[0]!.id], true);
    const completed = await waitForBatch(restored, retrying.id);
    assert.equal(completed.status, "completed");
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0]?.size, "1536x1024");
    assert.equal(payloads[0]?.quality, "high");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deleting exact images removes managed files without renumbering survivors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "esse-delete-images-"));
  try {
    const { manager } = await createManager(root, async () => new Response(JSON.stringify({ data: [{ b64_json: onePixelPng }] }), { status: 200, headers: { "content-type": "application/json" } }));
    const created = await manager.create({ offeringId: "offer-default", prompt: "delete selected", count: 2 });
    const completed = await waitForBatch(manager, created.id);
    const edited = await manager.modifyInPlace({ batchId: created.id, imageIds: [completed.jobs[0]!.id], instructions: "create a backup" });
    const editedComplete = await waitForBatch(manager, edited.id);
    const backup = editedComplete.jobs[0]!.backups![0]!;
    const second = editedComplete.jobs[1]!;
    const firstOutput = editedComplete.jobs[0]!.outputPath!;

    const withoutBackup = await manager.deleteImages(created.id, [backup.id]);
    assert.equal(withoutBackup.jobs[0]?.backups?.length || 0, 0);
    assert.equal(withoutBackup.jobs[0]?.referenceImagePaths, undefined);
    await assert.rejects(access(backup.outputPath));

    const withoutSecond = await manager.deleteImages(created.id, [second.id]);
    assert.deepEqual(withoutSecond.jobs.map((job) => job.name), ["图1"]);
    await assert.rejects(access(second.outputPath!));
    await access(firstOutput);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("merging batches copies managed images and preserves or deletes sources explicitly", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "esse-merge-"));
  try {
    const { manager } = await createManager(root, async () => new Response(JSON.stringify({ data: [{ b64_json: onePixelPng }] }), { status: 200, headers: { "content-type": "application/json" } }));
    const target = await waitForBatch(manager, (await manager.create({ offeringId: "offer-default", title: "target", prompt: "target", count: 1 })).id);
    const source = await waitForBatch(manager, (await manager.create({ offeringId: "offer-default", title: "source", prompt: "source", count: 1 })).id);
    const sourceOutput = source.jobs[0]!.outputPath!;

    const merged = await manager.mergeBatches({ targetBatchId: target.id, sourceBatchIds: [source.id], requestKey: "merge-once" });
    assert.deepEqual(merged.jobs.map((job) => job.name), ["图1", "图2"]);
    assert.notEqual(merged.jobs[1]?.id, source.jobs[0]?.id);
    assert.notEqual(merged.jobs[1]?.outputPath, sourceOutput);
    assert(merged.jobs[1]?.outputPath?.startsWith(target.outputDirectory));
    await access(sourceOutput);
    await access(merged.jobs[1]!.outputPath!);
    assert.equal(manager.get(source.id).id, source.id);
    const duplicate = await manager.mergeBatches({ targetBatchId: target.id, sourceBatchIds: [source.id], requestKey: "merge-once" });
    assert.equal(duplicate.total, 2);

    const disposable = await waitForBatch(manager, (await manager.create({ offeringId: "offer-default", title: "disposable", prompt: "disposable", count: 1 })).id);
    const mergedAndDeleted = await manager.mergeBatches({ targetBatchId: target.id, sourceBatchIds: [disposable.id], deleteSourceBatches: true });
    assert.deepEqual(mergedAndDeleted.jobs.map((job) => job.name), ["图1", "图2", "图3"]);
    assert.throws(() => manager.get(disposable.id), /Unknown image batch/);
    await access(mergedAndDeleted.jobs[2]!.outputPath!);
    assert.equal(manager.activation()?.batchId, target.id);
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
  return { manager, store, registry, settings, paths };
}

async function waitForBatch(manager: BatchManager, id: string) {
  for (let index = 0; index < 200; index += 1) {
    const batch = manager.get(id);
    if (!["queued", "running"].includes(batch.status)) {
      await manager.waitForPersistence(id);
      return manager.get(id);
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("Timed out waiting for local batch.");
}

function onlyJob(batch: Awaited<ReturnType<typeof waitForBatch>>) {
  assert.equal(batch.jobs.length, 1);
  return batch.jobs[0]!;
}
