import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { ORIGINAL_IMAGE_RESOURCE_TEMPLATE } from "../src/files/original-image-registry.js";
import { CODEX_GENERATION_OFFERING_ID } from "../src/types.js";

const onePixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=";

test("local MCP exposes the installable plugin tools and widget over stdio-compatible transport", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "esse-mcp-"));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "esse-test", version: "0.1.0" });
  try {
    const paths = resolveDataPaths({ ESSE_DATA_DIR: root }, process.platform);
    await ensureDataPaths(paths);
    const settings = new SettingsStore(paths.settingsFile, new MemorySecretStore());
    const registry = new ProviderRegistry(settings, async () => new Response(JSON.stringify({ data: [{ b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=" }] }), { status: 200, headers: { "content-type": "application/json" } }));
    const batches = new BatchManager(new BatchStore(paths.batchesDir), registry, paths);
    await batches.initialize();
    let nativeSaveSource: string | undefined;
    let nativeClipboardSource: string | undefined;
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
      openFolder: async (folderPath) => { openedFolder = folderPath; },
      updateChecker: { check: async (currentVersion) => ({ currentVersion, latestVersion: "0.2.1", updateAvailable: true, checked: true, checkedAt: "2026-07-19T10:00:00.000Z", releaseUrl: "https://github.com/renoir1220/esse/releases/tag/v0.2.1" }) }
    });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    for (const required of ["open_esse", "inspect_image_folder", "list_image_batches", "create_image_batch", "append_image_batch_jobs", "start_agent_image_job", "complete_agent_image_job", "fail_agent_image_job", "modify_selected_images", "delete_esse_images", "merge_image_batches", "ui_get_batch_state", "ui_check_for_updates", "ui_list_image_batches", "ui_open_batch_folder", "ui_save_provider_profile", "ui_get_image_previews", "ui_get_original_image_resource", "ui_get_image_metadata", "ui_save_image_as", "ui_copy_image_to_clipboard", "ui_delete_esse_images", "ui_delete_image_batch"]) {
      assert(names.includes(required), `Missing local MCP tool ${required}`);
    }
    assert(!names.includes("get_local_media_status"), "PoC-only media diagnostics must not be published");
    const settingsTool = tools.tools.find((tool) => tool.name === "ui_save_provider_profile");
    assert.deepEqual((settingsTool?._meta as { ui?: { visibility?: string[] } })?.ui?.visibility, ["app"]);
    const openTool = tools.tools.find((tool) => tool.name === "open_esse");
    assert.equal((openTool?._meta as { ui?: { resourceUri?: string } })?.ui?.resourceUri, WIDGET_URI);
    const createTool = tools.tools.find((tool) => tool.name === "create_image_batch");
    assert(!((createTool?.inputSchema as { required?: string[] })?.required || []).includes("offeringId"), "create_image_batch must use the configured default when offeringId is omitted");
    assert((createTool?.inputSchema as { properties?: Record<string, unknown> })?.properties?.referenceImages, "create_image_batch must accept existing Esse image references");
    const appendTool = tools.tools.find((tool) => tool.name === "append_image_batch_jobs");
    assert((appendTool?.inputSchema as { properties?: Record<string, unknown> })?.properties?.batchId, "append_image_batch_jobs must target one existing batch");
    assert(!((appendTool?.inputSchema as { required?: string[] })?.required || []).includes("offeringId"), "append_image_batch_jobs must reuse the batch model when offeringId is omitted");
    const listTool = tools.tools.find((tool) => tool.name === "list_image_batches");
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
    const created = await client.callTool({ name: "create_image_batch", arguments: { prompt: "use my default", count: 1 } });
    const createdBatch = (created.structuredContent as { batch?: { id?: string; offering?: { id?: string } } }).batch;
    assert.equal(createdBatch?.offering?.id, defaultOfferingId);
    assert.equal((created.structuredContent as { activateBatchId?: string }).activateBatchId, createdBatch?.id);
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
    const appended = await client.callTool({
      name: "append_image_batch_jobs",
      arguments: {
        batchId: createdBatch?.id,
        offeringId: defaultOfferingId,
        jobs: [{ prompt: "append directly to this batch" }],
        requestKey: "mcp-append-once"
      }
    });
    const appendedContent = appended.structuredContent as { batch?: { id?: string; total?: number; jobs?: Array<{ id?: string; name?: string }> }; appendedJobIds?: string[] };
    assert.equal(appendedContent.batch?.id, createdBatch?.id);
    assert.equal(appendedContent.batch?.total, 2);
    assert.equal(appendedContent.batch?.jobs?.[1]?.name, "图2");
    assert.deepEqual(appendedContent.appendedJobIds, [appendedContent.batch?.jobs?.[1]?.id]);
    const duplicateAppend = await client.callTool({
      name: "append_image_batch_jobs",
      arguments: { batchId: createdBatch?.id, prompt: "must not duplicate", requestKey: "mcp-append-once" }
    });
    assert.equal((duplicateAppend.structuredContent as { batch?: { total?: number } }).batch?.total, 2);
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
        jobs: [{ prompt: "match the exact color palette", referenceImages: [{ batchId: createdBatch?.id, image: "图1" }] }]
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
    const opened = await client.callTool({ name: "ui_open_batch_folder", arguments: { batchId: createdBatch?.id } });
    assert.equal((opened.structuredContent as { opened?: boolean }).opened, true);
    assert.equal(openedFolder, path.dirname(completedOutputPath!));

    await client.callTool({ name: "ui_set_default_offering", arguments: { offeringId: CODEX_GENERATION_OFFERING_ID } });
    const delegated = await client.callTool({
      name: "create_image_batch",
      arguments: {
        title: "Agent delegated",
        jobs: [{ prompt: "Agent prompt", referenceImages: [{ batchId: createdBatch?.id, image: "图1" }] }]
      }
    });
    const delegatedBatch = (delegated.structuredContent as { batch?: { id?: string; status?: string; offering?: { adapterId?: string }; jobs?: Array<{ id?: string; referenceImagePaths?: string[] }> } }).batch;
    assert.equal(delegatedBatch?.status, "queued");
    assert.equal(delegatedBatch?.offering?.adapterId, "agent-generation");
    assert.deepEqual(delegatedBatch?.jobs?.[0]?.referenceImagePaths, [completedOutputPath]);
    const delegatedJobId = delegatedBatch?.jobs?.[0]?.id;
    const started = await client.callTool({ name: "start_agent_image_job", arguments: { batchId: delegatedBatch?.id, jobId: delegatedJobId } });
    assert.equal((started.structuredContent as { job?: { prompt?: string; status?: string } }).job?.prompt, "Agent prompt");
    assert.equal((started.structuredContent as { job?: { status?: string } }).job?.status, "running");
    const agentOutput = path.join(root, "agent-output.png");
    await writeFile(agentOutput, Buffer.from(onePixelPng, "base64"));
    const imported = await client.callTool({ name: "complete_agent_image_job", arguments: { batchId: delegatedBatch?.id, jobId: delegatedJobId, imagePath: agentOutput } });
    assert.equal((imported.structuredContent as { job?: { status?: string } }).job?.status, "succeeded");
    const importedHistory = (imported.structuredContent as { batch?: { jobs?: Array<{ id?: string; callHistory?: Array<{ status?: string; source?: string }> }> } }).batch?.jobs?.find((job) => job.id === delegatedJobId)?.callHistory;
    assert.deepEqual(importedHistory?.map((call) => [call.status, call.source]), [["succeeded", "agent"]]);

    await client.callTool({ name: "modify_selected_images", arguments: { batchId: createdBatch?.id, jobIds: [completedJobId], instructions: "create one backup for metadata verification", offeringId: defaultOfferingId } });
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
