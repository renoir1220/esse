import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { resolveDataPaths, ensureDataPaths } from "../src/paths.js";
import { SettingsStore } from "../src/storage/settings-store.js";
import { MemorySecretStore } from "../src/storage/secret-store.js";
import { BatchStore } from "../src/storage/batch-store.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { BatchManager } from "../src/jobs/batch-manager.js";
import { Thumbnailer } from "../src/files/thumbnailer.js";
import { createLocalEsseServer, WIDGET_URI } from "../src/mcp/app.js";
import { AUTHORIZED_WORKFLOW_POLICY, WORKFLOW_POLLING, WORKFLOW_TOOL_GUIDANCE } from "../src/mcp/workflow-policy.js";
import { ORIGINAL_IMAGE_RESOURCE_TEMPLATE } from "../src/files/original-image-registry.js";
import { CODEX_GENERATION_OFFERING_ID } from "../src/types.js";
import { coloredPng } from "./pixel-fixture.js";

const onePixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=";

test("Agent rework retains original reference bytes and attaches explicit local and Esse references", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "esse-reference-review-"));
  const fixture = await reviewMcpFixture(root);
  try {
    const buffers = [coloredPng(255, 0, 0), coloredPng(0, 0, 255), coloredPng(0, 255, 0), coloredPng(255, 255, 0), coloredPng(0, 255, 255)];
    const files = buffers.map((_, index) => path.join(root, `input-${index}.png`));
    await Promise.all(files.map((file, index) => writeFile(file, buffers[index]!)));
    const create = async (prompt: string, key: string, references: string[] = []) => {
      const result = await fixture.client.callTool({ name: "create_image_batch", arguments: { offeringId: CODEX_GENERATION_OFFERING_ID, prompt, referenceImagePaths: references, requestKey: key } });
      assert.notEqual(result.isError, true);
      return (result.structuredContent as { batch: { id: string; jobs: Array<{ id: string }> } }).batch;
    };
    const mother = await create("mother with original A/B", "reference-mother", files.slice(0, 2));
    const start = await fixture.client.callTool({ name: "start_agent_image_job", arguments: { batchId: mother.id, jobId: mother.jobs[0]!.id } });
    const initialPaths = (start.structuredContent as { job: { referenceImagePaths: string[] } }).job.referenceImagePaths;
    assert.deepEqual(await Promise.all(initialPaths.map(file => readFile(file))), buffers.slice(0, 2));
    const completed = await fixture.client.callTool({ name: "complete_agent_image_job", arguments: { batchId: mother.id, jobId: mother.jobs[0]!.id, imagePath: files[2] } });
    assert.notEqual(completed.isError, true);
    const carrier = await create("structural reference carrier", "reference-carrier");
    await fixture.client.callTool({ name: "start_agent_image_job", arguments: { batchId: carrier.id, jobId: carrier.jobs[0]!.id } });
    const carrierCompleted = await fixture.client.callTool({ name: "complete_agent_image_job", arguments: { batchId: carrier.id, jobId: carrier.jobs[0]!.id, imagePath: files[4] } });
    assert.notEqual(carrierCompleted.isError, true);
    const modification = {
      batchId: mother.id, imageIds: [mother.jobs[0]!.id], instructions: "bounded rework", requestKey: "reference-rework",
      referenceImagePaths: [files[0], files[1], files[3]], referenceImages: [{ batchId: carrier.id, image: "图1" }]
    };
    const modified = await fixture.client.callTool({ name: "modify_selected_images", arguments: modification });
    assert.notEqual(modified.isError, true);
    const rework = await fixture.client.callTool({ name: "start_agent_image_job", arguments: { batchId: mother.id, jobId: mother.jobs[0]!.id } });
    const reworkPaths = (rework.structuredContent as { job: { referenceImagePaths: string[] } }).job.referenceImagePaths;
    assert.deepEqual(await Promise.all(reworkPaths.map(file => readFile(file))), [buffers[2], buffers[0], buffers[1], buffers[3], buffers[4]]);
    assert.deepEqual(await readFile(files[0]!), buffers[0]);
    assert.deepEqual(await readFile(files[1]!), buffers[1]);
    assert.deepEqual(await readFile(fixture.batches.get(carrier.id).jobs[0]!.outputPath!), buffers[4]);
    await fixture.client.callTool({ name: "fail_agent_image_job", arguments: { batchId: mother.id, jobId: mother.jobs[0]!.id, error: "offline fixture: no generation" } });
    const beforeReplay = fixture.batches.get(mother.id);
    const replayed = await fixture.client.callTool({ name: "modify_selected_images", arguments: modification });
    assert.notEqual(replayed.isError, true);
    for (const references of [[], [files[0], files[1], files[2]]]) {
      const conflict = await fixture.client.callTool({ name: "modify_selected_images", arguments: { ...modification, referenceImagePaths: references } });
      assert.equal(conflict.isError, true);
      assert.match(JSON.stringify(conflict.content), /already used with different arguments/u);
    }
    assert.deepEqual(fixture.batches.get(mother.id), beforeReplay);
  } finally { await fixture.client.close(); await fixture.server.close(); await rm(root, { recursive: true, force: true }); }
});

test("Plugin MCP reports shared append receipts as ambiguous at limit 1 and 50", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "esse-ambiguity-review-"));
  const fixture = await reviewMcpFixture(root);
  try {
    for (const title of ["A", "B"]) {
      const created = await fixture.client.callTool({ name: "create_image_batch", arguments: { offeringId: CODEX_GENERATION_OFFERING_ID, prompt: title, requestKey: `create-${title}` } });
      const batchId = (created.structuredContent as { batch: { id: string } }).batch.id;
      await fixture.client.callTool({ name: "append_image_batch_jobs", arguments: { batchId, prompt: "append", requestKey: "shared-append-key" } });
    }
    for (const limit of [1, 50]) {
      const result = await fixture.client.callTool({ name: "list_image_batches", arguments: { requestKey: "shared-append-key", limit } });
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result.content), /Ambiguous requestKey: 2 batches match/u);
      assert.equal(result.structuredContent, undefined);
    }
    for (const batch of fixture.batches.list()) {
      const exact = await fixture.client.callTool({ name: "get_image_batch", arguments: { batchId: batch.id } });
      assert.equal((exact.structuredContent as { batch: { id: string } }).batch.id, batch.id);
      for (const job of batch.jobs) await fixture.client.callTool({ name: "fail_agent_image_job", arguments: { batchId: batch.id, jobId: job.id, error: "offline ambiguity fixture" } });
    }
    const restarted = new BatchManager(new BatchStore(fixture.paths.batchesDir), fixture.registry, fixture.paths);
    await restarted.initialize();
    assert.throws(() => restarted.list(1, "shared-append-key"), /Ambiguous requestKey: 2 batches match/u);
  } finally { await fixture.client.close(); await fixture.server.close(); await rm(root, { recursive: true, force: true }); }
});

async function reviewMcpFixture(root: string) {
  const paths = resolveDataPaths({ ESSE_DATA_DIR: root }, process.platform);
  await ensureDataPaths(paths);
  const settings = new SettingsStore(paths.settingsFile, new MemorySecretStore());
  const registry = new ProviderRegistry(settings, async () => { throw new Error("Unexpected Provider call in offline Agent fixture"); });
  const batches = new BatchManager(new BatchStore(paths.batchesDir), registry, paths);
  await batches.initialize();
  const server = createLocalEsseServer({ version: "review", widgetHtml: "<html></html>", settings, registry, batches, thumbnailer: new Thumbnailer(paths) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "parent-review-fixture", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { paths, registry, batches, server, client };
}

function asyncTaskFetch(result: unknown): typeof fetch {
  let sequence = 0;
  const results = new Map<string, unknown>();
  return async (input) => {
    const url = String(input);
    if (url.includes('/v1/videos/')) {
      const id = url.slice(url.lastIndexOf('/') + 1);
      return Response.json({ id, status: 'completed', video_url: `data:image/png;base64,${onePixelPng}` });
    }
    if (url.includes("/get-async?id=")) {
      const id = new URL(url).searchParams.get("id") || "";
      return new Response(JSON.stringify({ id, status: "completed", result: results.get(id) }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const id = `task-${++sequence}`;
    results.set(id, result);
    return new Response(JSON.stringify({ id, status: "submitted" }), { status: 202, headers: { "content-type": "application/json", "x-oneapi-request-id": `request-${sequence}` } });
  };
}

test("local MCP exposes the installable plugin tools and widget over stdio-compatible transport", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "esse-mcp-"));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "esse-test", version: "0.1.0" });
  try {
    const paths = resolveDataPaths({ ESSE_DATA_DIR: root }, process.platform);
    await ensureDataPaths(paths);
    const settings = new SettingsStore(paths.settingsFile, new MemorySecretStore());
    const registry = new ProviderRegistry(settings, asyncTaskFetch({ data: [{ b64_json: onePixelPng }] }));
    const batches = new BatchManager(new BatchStore(paths.batchesDir), registry, paths);
    await batches.initialize();
    let nativeSaveSource: string | undefined;
    let nativeClipboardSource: string | undefined;
    let nativeClipboardText: string | undefined;
    let openedFolder: string | undefined;
    const server = createLocalEsseServer({
      version: "0.2.0",
      widgetHtml: "<html><body><div id=\"root\"></div></body></html>",
      settings,
      registry,
      batches,
      thumbnailer: new Thumbnailer(paths),
      saveFileAs: async (sourcePath) => { nativeSaveSource = sourcePath; return path.join(root, "saved.png"); },
      copyImageToClipboard: async (sourcePath) => { nativeClipboardSource = sourcePath; },
      copyTextToClipboard: async (text) => { nativeClipboardText = text; },
      openFolder: async (folderPath) => { openedFolder = folderPath; },
      updateChecker: { check: async (currentVersion) => ({ currentVersion, latestVersion: "0.2.1", updateAvailable: true, checked: true, checkedAt: "2026-07-19T10:00:00.000Z", releaseUrl: "https://github.com/renoir1220/esse/releases/tag/v0.2.1" }) }
    });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    assert(client.getInstructions()?.includes(AUTHORIZED_WORKFLOW_POLICY));
    for (const name of ["create_image_batch", "append_image_batch_jobs", "modify_selected_images", "list_image_batches", "get_image_batch", "render_image_batch"]) {
      assert(tools.tools.find(tool => tool.name === name)?.description?.includes(WORKFLOW_TOOL_GUIDANCE));
    }
    const names = tools.tools.map((tool) => tool.name);
    for (const required of ["open_esse", "inspect_image_folder", "list_image_batches", "create_image_batch", "append_image_batch_jobs", "start_agent_image_job", "complete_agent_image_job", "fail_agent_image_job", "modify_selected_images", "delete_esse_images", "merge_image_batches", "ui_get_batch_state", "ui_check_for_updates", "ui_list_image_batches", "ui_open_batch_folder", "ui_save_provider_profile", "ui_get_image_previews", "ui_get_original_image_resource", "ui_get_image_metadata", "ui_save_image_as", "ui_copy_image_to_clipboard", "ui_copy_batch_reference_to_clipboard", "ui_copy_image_id_to_clipboard", "ui_delete_esse_images", "ui_delete_image_batch"]) {
      assert(names.includes(required), `Missing local MCP tool ${required}`);
    }
    for (const tool of tools.tools) assert(tool.outputSchema, `${tool.name} must publish an output schema`);
    assert(!names.includes("get_local_media_status"), "PoC-only media diagnostics must not be published");
    const settingsTool = tools.tools.find((tool) => tool.name === "ui_save_provider_profile");
    assert.deepEqual((settingsTool?._meta as { ui?: { visibility?: string[] } })?.ui?.visibility, ["app"]);
    const openTool = tools.tools.find((tool) => tool.name === "open_esse");
    assert.equal((openTool?._meta as { ui?: { resourceUri?: string } })?.ui?.resourceUri, WIDGET_URI);
    const createTool = tools.tools.find((tool) => tool.name === "create_image_batch");
    assert(!((createTool?.inputSchema as { required?: string[] })?.required || []).includes("offeringId"), "create_image_batch must use the configured default when offeringId is omitted");
    assert(((createTool?.inputSchema as { required?: string[] })?.required || []).includes("requestKey"), "create_image_batch must require an idempotency key");
    assert((createTool?.inputSchema as { properties?: Record<string, unknown> })?.properties?.referenceImages, "create_image_batch must accept existing Esse image references");
    const appendTool = tools.tools.find((tool) => tool.name === "append_image_batch_jobs");
    assert((appendTool?.inputSchema as { properties?: Record<string, unknown> })?.properties?.batchId, "append_image_batch_jobs must target one existing batch");
    assert(!((appendTool?.inputSchema as { required?: string[] })?.required || []).includes("offeringId"), "append_image_batch_jobs must reuse the batch model when offeringId is omitted");
    const listTool = tools.tools.find((tool) => tool.name === "list_image_batches");
    assert((listTool?.inputSchema as { properties?: Record<string, unknown> })?.properties?.requestKey);
    assert.equal((listTool?.inputSchema as { properties?: { limit?: { maximum?: number } } })?.properties?.limit?.maximum, 50);
    const modifyTool = tools.tools.find((tool) => tool.name === "modify_selected_images");
    assert((modifyTool?.inputSchema as { properties?: Record<string, unknown> })?.properties?.imageIds, "modify_selected_images must accept exact image IDs");
    for (const headlessName of ["create_image_batch", "append_image_batch_jobs", "start_agent_image_job", "complete_agent_image_job", "fail_agent_image_job", "list_image_batches", "get_image_batch", "render_image_batch", "modify_selected_images", "delete_esse_images", "merge_image_batches"]) {
      const headless = tools.tools.find((tool) => tool.name === headlessName);
      assert.equal((headless?._meta as { ui?: { resourceUri?: string } })?.ui?.resourceUri, undefined, `${headlessName} must not reopen an inline widget`);
    }
    const resources = await client.listResources();
    assert(resources.resources.some((resource) => resource.uri === WIDGET_URI));
    const templates = await client.listResourceTemplates();
    assert(templates.resourceTemplates.some((resource) => resource.uriTemplate === ORIGINAL_IMAGE_RESOURCE_TEMPLATE));
    const widget = await client.readResource({ uri: WIDGET_URI });
    assert.equal((widget.contents[0]?._meta as { ui?: { csp?: unknown } } | undefined)?.ui?.csp, undefined, "the widget must not request localhost CSP access");
    const legacyWidget = await client.readResource({ uri: "ui://esse/local-v1.html" });
    assert.equal(legacyWidget.contents[0]?.uri, "ui://esse/local-v1.html");
    const priorProcessWidgetUri = "ui://esse/local-v2-0123456789abcdef.html";
    const priorProcessWidget = await client.readResource({ uri: priorProcessWidgetUri });
    assert.equal(priorProcessWidget.contents[0]?.uri, priorProcessWidgetUri);
    const open = await client.callTool({ name: "open_esse", arguments: { tab: "settings" } });
    assert.equal((open.structuredContent as { state?: { providers?: unknown[] } }).state?.providers?.length, 0);
    const update = await client.callTool({ name: "ui_check_for_updates", arguments: {} });
    assert.deepEqual((update.structuredContent as { update?: unknown }).update, { currentVersion: "0.2.0", latestVersion: "0.2.1", updateAvailable: true, checked: true, checkedAt: "2026-07-19T10:00:00.000Z", releaseUrl: "https://github.com/renoir1220/esse/releases/tag/v0.2.1" });
    const builtInOffering = (open.structuredContent as { state?: { offerings?: Array<{ id?: string; adapterId?: string; price?: { mode?: string } }> } }).state?.offerings?.find((entry) => entry.id === CODEX_GENERATION_OFFERING_ID);
    assert.equal(builtInOffering?.adapterId, "agent-generation");
    assert.equal(builtInOffering?.price?.mode, "model_quota");
    const secret = "must-not-enter-tool-output";
    const saved = await client.callTool({
      name: "ui_save_provider_profile",
      arguments: {
        displayName: "兔子",
        tierName: "default",
        baseUrl: "https://api.tu-zi.com",
        adapterId: "tuzi-json-images",
        concurrency: 3,
        apiKey: secret,
        offerings: [{
          canonicalModelId: "gpt-image-2",
          providerModelId: "gpt-image-2",
          displayName: "GPT-Image 2",
          price: { mode: "per_request", currency: "CNY", amount: 0.035 },
          supportsTextToImage: true,
          supportsImageToImage: true,
          sizes: [],
          qualities: []
        }]
      }
    });
    assert(!JSON.stringify(saved).includes(secret));
    assert.equal((saved.structuredContent as { state?: { providers?: Array<{ hasApiKey?: boolean }> } }).state?.providers?.[0]?.hasApiKey, true);
    const publicOffering = (saved.structuredContent as { state?: { offerings?: Array<{ adapterId?: string; supportsTextToImage?: boolean; supportsImageToImage?: boolean; sizes?: string[]; qualities?: string[] }> } }).state?.offerings?.find((entry) => entry.adapterId === "tuzi-json-images");
    assert.equal(publicOffering?.supportsTextToImage, true);
    assert.equal(publicOffering?.supportsImageToImage, true);
    assert.deepEqual(publicOffering?.sizes, []);
    assert.deepEqual(publicOffering?.qualities, []);
    const defaultOfferingId = (saved.structuredContent as { state?: { defaultOfferingId?: string } }).state?.defaultOfferingId;
    const created = await client.callTool({ name: "create_image_batch", arguments: { prompt: "use my default", count: 1, requestKey: "mcp-create-default" } });
    const createdBatch = (created.structuredContent as { batch?: { id?: string; title?: string; offering?: { id?: string } } }).batch;
    assert.equal(createdBatch?.offering?.id, defaultOfferingId);
    assert.equal((created.structuredContent as { activateBatchId?: string }).activateBatchId, createdBatch?.id);
    assert.equal((created.structuredContent as { nextAction?: string }).nextAction, AUTHORIZED_WORKFLOW_POLICY);
    assert.deepEqual((created.structuredContent as { polling?: unknown }).polling, WORKFLOW_POLLING);
    const reconciled = await client.callTool({ name: "list_image_batches", arguments: { requestKey: "mcp-create-default", limit: 1 } });
    assert.deepEqual((reconciled.structuredContent as { batches: Array<{ id: string }> }).batches.map(batch => batch.id), [createdBatch?.id]);
    const refreshedState = await client.callTool({ name: "ui_get_local_state", arguments: { batchId: createdBatch?.id } });
    assert.equal((refreshedState.structuredContent as { state?: { activation?: { batchId?: string } } }).state?.activation?.batchId, createdBatch?.id);
    let completedJobId: string | undefined;
    let completedOutputPath: string | undefined;
    for (let index = 0; index < 100; index += 1) {
      const current = await client.callTool({ name: "get_image_batch", arguments: { batchId: createdBatch?.id } });
      const currentBatch = (current.structuredContent as { batch?: { status?: string; jobs?: Array<{ id?: string; outputPath?: string }> } }).batch;
      if (currentBatch?.status && !["queued", "running"].includes(currentBatch.status)) {
        completedJobId = currentBatch.jobs?.[0]?.id;
        completedOutputPath = currentBatch.jobs?.[0]?.outputPath;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert(completedJobId);
    assert(completedOutputPath);
    const appendArguments = {
      batchId: createdBatch?.id,
      offeringId: defaultOfferingId,
      jobs: [{ prompt: "append directly to this batch" }],
      requestKey: "mcp-append-once"
    };
    const appended = await client.callTool({
      name: "append_image_batch_jobs",
      arguments: appendArguments
    });
    const appendedContent = appended.structuredContent as { batch?: { id?: string; total?: number; jobs?: Array<{ id?: string; name?: string }> }; appendedJobIds?: string[] };
    assert.equal(appendedContent.batch?.id, createdBatch?.id);
    assert.equal(appendedContent.batch?.total, 2);
    assert.equal(appendedContent.batch?.jobs?.[1]?.name, "图2");
    assert.deepEqual(appendedContent.appendedJobIds, [appendedContent.batch?.jobs?.[1]?.id]);
    const duplicateAppend = await client.callTool({
      name: "append_image_batch_jobs",
      arguments: appendArguments
    });
    assert.equal((duplicateAppend.structuredContent as { batch?: { total?: number } }).batch?.total, 2);
    const appendedReceipt = await client.callTool({ name: "list_image_batches", arguments: { requestKey: "mcp-append-once", limit: 1 } });
    assert.deepEqual((appendedReceipt.structuredContent as { batches: Array<{ id: string }> }).batches.map(batch => batch.id), [createdBatch?.id]);
    const conflictingAppend = await client.callTool({
      name: "append_image_batch_jobs",
      arguments: { batchId: createdBatch?.id, prompt: "different operation", requestKey: "mcp-append-once" }
    });
    assert.equal(conflictingAppend.isError, true);
    const imagePreviews = await client.callTool({
      name: "ui_get_image_previews",
      arguments: {
        batchId: createdBatch?.id,
        items: [{ jobId: completedJobId, full: false }, { jobId: completedJobId, full: true }]
      }
    });
    const previewItems = (imagePreviews._meta as { previews?: Array<{ dataUrl?: string; full?: boolean }> } | undefined)?.previews || [];
    assert.equal(previewItems.length, 2);
    assert(previewItems.every((preview) => preview.dataUrl?.startsWith("data:image/")));
    assert.deepEqual(previewItems.map((preview) => preview.full), [false, true]);
    assert(!JSON.stringify(imagePreviews.structuredContent).includes("data:image/"), "preview bytes must remain hidden from model-visible structured content");
    const originalImage = await client.callTool({ name: "ui_get_original_image_resource", arguments: { batchId: createdBatch?.id, jobId: completedJobId } });
    const originalImageUri = (originalImage._meta as { resourceUri?: string } | undefined)?.resourceUri;
    assert(originalImageUri?.startsWith("esse-image://original/"));
    assert(!JSON.stringify(originalImage.structuredContent).includes("esse-image://"), "original image URI must remain hidden from model-visible structured content");
    const originalImageBytes = await client.readResource({ uri: originalImageUri! });
    const originalImageContent = originalImageBytes.contents[0];
    assert.equal(originalImageContent?.mimeType, "image/png");
    assert("blob" in originalImageContent!);
    assert.deepEqual(Buffer.from(originalImageContent.blob!, "base64"), Buffer.from(onePixelPng, "base64"));
    const imageMetadata = await client.callTool({ name: "ui_get_image_metadata", arguments: { batchId: createdBatch?.id, jobId: completedJobId } });
    assert.deepEqual(imageMetadata.structuredContent, { batchId: createdBatch?.id, jobId: completedJobId, available: true, width: 1, height: 1, sizeBytes: Buffer.from(onePixelPng, "base64").length });
    const listed = await client.callTool({ name: "list_image_batches", arguments: { limit: 5 } });
    const listedBatches = (listed.structuredContent as { batches?: Array<{ id?: string; jobs?: Array<{ name?: string }> }> }).batches;
    assert.equal(listedBatches?.[0]?.id, createdBatch?.id);
    assert.equal(listedBatches?.[0]?.jobs?.[0]?.name, "图1");
    const referenced = await client.callTool({
      name: "create_image_batch",
      arguments: {
        title: "reuse prior result",
        jobs: [{ prompt: "match the exact color palette", referenceImages: [{ batchId: createdBatch?.id, image: "图1" }] }],
        requestKey: "mcp-create-reference"
      }
    });
    const referencedBatch = (referenced.structuredContent as { batch?: { id?: string; jobs?: Array<{ inputPaths?: string[] }> } }).batch;
    assert.deepEqual(referencedBatch?.jobs?.[0]?.inputPaths, [completedOutputPath]);
    for (let index = 0; index < 100; index += 1) {
      const current = await client.callTool({ name: "get_image_batch", arguments: { batchId: referencedBatch?.id } });
      const status = (current.structuredContent as { batch?: { status?: string } }).batch?.status;
      if (status && !["queued", "running"].includes(status)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const libraryPage = await client.callTool({ name: "ui_list_image_batches", arguments: { page: 1, pageSize: 4 } });
    const library = libraryPage.structuredContent as { batches?: unknown[]; page?: number; total?: number; totalPages?: number };
    assert.equal(library.page, 1);
    assert((library.batches?.length || 0) >= 2);
    assert((library.total || 0) >= 2);
    assert((library.totalPages || 0) >= 1);
    const nativeSave = await client.callTool({ name: "ui_save_image_as", arguments: { batchId: createdBatch?.id, jobId: completedJobId } });
    assert.equal((nativeSave.structuredContent as { saved?: boolean }).saved, true);
    assert(nativeSaveSource);
    const nativeCopy = await client.callTool({ name: "ui_copy_image_to_clipboard", arguments: { batchId: createdBatch?.id, jobId: completedJobId } });
    assert.equal((nativeCopy.structuredContent as { copied?: boolean }).copied, true);
    assert.equal(nativeClipboardSource, completedOutputPath);
    const batchReferenceCopy = await client.callTool({ name: "ui_copy_batch_reference_to_clipboard", arguments: { batchId: createdBatch?.id } });
    assert.equal((batchReferenceCopy.structuredContent as { copied?: boolean }).copied, true);
    assert.equal(nativeClipboardText, `批次名称：${createdBatch?.title}\nbatchId: ${createdBatch?.id}`);
    const imageIdCopy = await client.callTool({ name: "ui_copy_image_id_to_clipboard", arguments: { batchId: createdBatch?.id, jobId: completedJobId } });
    assert.equal((imageIdCopy.structuredContent as { copied?: boolean }).copied, true);
    assert.equal(nativeClipboardText, `imageId: ${completedJobId}`);
    const opened = await client.callTool({ name: "ui_open_batch_folder", arguments: { batchId: createdBatch?.id } });
    assert.equal((opened.structuredContent as { opened?: boolean }).opened, true);
    assert.equal(openedFolder, path.dirname(completedOutputPath!));

    await client.callTool({ name: "ui_set_default_offering", arguments: { offeringId: CODEX_GENERATION_OFFERING_ID } });
    const secondAgentReference = path.join(root, "second-agent-reference.png");
    await writeFile(secondAgentReference, Buffer.from(onePixelPng, "base64"));
    const delegated = await client.callTool({
      name: "create_image_batch",
      arguments: {
        title: "Agent delegated",
        jobs: [
          { prompt: "Agent prompt one", referenceImages: [{ batchId: createdBatch?.id, image: "图1" }] },
          { prompt: "Agent prompt two", referenceImagePaths: [secondAgentReference] }
        ],
        requestKey: "mcp-create-agent"
      }
    });
    const delegatedBatch = (delegated.structuredContent as { batch?: { id?: string; status?: string; offering?: { adapterId?: string }; jobs?: Array<{ id?: string }> } }).batch;
    assert.equal(delegatedBatch?.status, "queued");
    assert.equal(delegatedBatch?.offering?.adapterId, "agent-generation");
    assert(!JSON.stringify(delegated.structuredContent).includes(completedOutputPath!), "Agent batch acceptance must not expose references from every child");
    assert(!JSON.stringify(delegated.structuredContent).includes(secondAgentReference), "Agent batch acceptance must defer references until one exact job starts");
    const firstDelegatedJobId = delegatedBatch?.jobs?.[0]?.id;
    const secondDelegatedJobId = delegatedBatch?.jobs?.[1]?.id;
    const started = await client.callTool({ name: "start_agent_image_job", arguments: { batchId: delegatedBatch?.id, jobId: firstDelegatedJobId } });
    const startedJob = (started.structuredContent as { job?: { prompt?: string; status?: string; referenceImagePaths?: string[] } }).job;
    assert.equal(startedJob?.prompt, "Agent prompt one");
    assert.equal(startedJob?.status, "running");
    assert.deepEqual(startedJob?.referenceImagePaths, [completedOutputPath]);
    assert(!JSON.stringify(started.structuredContent).includes(secondAgentReference), "Starting one job must not expose another job's references");
    const agentOutput = path.join(root, "agent-output.png");
    await writeFile(agentOutput, Buffer.from(onePixelPng, "base64"));
    const imported = await client.callTool({ name: "complete_agent_image_job", arguments: { batchId: delegatedBatch?.id, jobId: firstDelegatedJobId, imagePath: agentOutput } });
    assert.equal((imported.structuredContent as { job?: { status?: string } }).job?.status, "succeeded");
    const secondStarted = await client.callTool({ name: "start_agent_image_job", arguments: { batchId: delegatedBatch?.id, jobId: secondDelegatedJobId } });
    assert.deepEqual((secondStarted.structuredContent as { job?: { referenceImagePaths?: string[] } }).job?.referenceImagePaths, [secondAgentReference]);
    assert(!JSON.stringify(secondStarted.structuredContent).includes(completedOutputPath!), "The second job must not inherit the first job's references");
    const secondFailed = await client.callTool({ name: "fail_agent_image_job", arguments: { batchId: delegatedBatch?.id, jobId: secondDelegatedJobId, error: "Intentional isolation test" } });
    assert.equal((secondFailed.structuredContent as { job?: { status?: string } }).job?.status, "failed");

    await client.callTool({ name: "modify_selected_images", arguments: { batchId: createdBatch?.id, jobIds: [completedJobId], instructions: "create one backup for metadata verification", offeringId: defaultOfferingId, requestKey: "mcp-modify-metadata" } });
    let backupId: string | undefined;
    for (let index = 0; index < 100; index += 1) {
      const current = await client.callTool({ name: "get_image_batch", arguments: { batchId: createdBatch?.id } });
      const currentBatch = (current.structuredContent as { batch?: { status?: string; jobs?: Array<{ backups?: Array<{ id?: string; name?: string }> }> } }).batch;
      if (currentBatch?.status && !["queued", "running"].includes(currentBatch.status)) {
        const backup = currentBatch.jobs?.[0]?.backups?.[0];
        assert.equal(backup?.name, "图1-1");
        backupId = backup?.id;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert(backupId);
    const backupMetadata = await client.callTool({ name: "ui_get_image_metadata", arguments: { batchId: createdBatch?.id, jobId: backupId } });
    assert.deepEqual(backupMetadata.structuredContent, { batchId: createdBatch?.id, jobId: backupId, available: true, width: 1, height: 1, sizeBytes: Buffer.from(onePixelPng, "base64").length });

    const unsupported = await client.callTool({ name: "create_image_batch", arguments: { prompt: "unsupported Agent", count: 1, requestKey: "unsupported-agent" } });
    const unsupportedBatch = (unsupported.structuredContent as { batch?: { id?: string; jobs?: Array<{ id?: string }> } }).batch;
    const unsupportedResult = await client.callTool({
      name: "fail_agent_image_job",
      arguments: { batchId: unsupportedBatch?.id, jobId: unsupportedBatch?.jobs?.[0]?.id, error: "当前 Agent 不支持图像生成" }
    });
    assert.equal((unsupportedResult.structuredContent as { job?: { status?: string } }).job?.status, "failed");
  } finally {
    await client.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
