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
    const server = createLocalEsseServer({
      widgetHtml: "<html><body><div id=\"root\"></div></body></html>",
      settings,
      registry,
      batches,
      thumbnailer: new Thumbnailer(paths),
      saveFileAs: async (sourcePath) => { nativeSaveSource = sourcePath; return path.join(root, "saved.png"); }
    });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    for (const required of ["open_esse", "inspect_image_folder", "list_image_batches", "create_image_batch", "start_agent_image_job", "complete_agent_image_job", "fail_agent_image_job", "modify_selected_images", "ui_get_batch_state", "ui_list_image_batches", "ui_save_provider_profile", "ui_save_image_as", "ui_delete_image_batch"]) {
      assert(names.includes(required), `Missing local MCP tool ${required}`);
    }
    const settingsTool = tools.tools.find((tool) => tool.name === "ui_save_provider_profile");
    assert.deepEqual((settingsTool?._meta as { ui?: { visibility?: string[] } })?.ui?.visibility, ["app"]);
    const openTool = tools.tools.find((tool) => tool.name === "open_esse");
    assert.equal((openTool?._meta as { ui?: { resourceUri?: string } })?.ui?.resourceUri, WIDGET_URI);
    const createTool = tools.tools.find((tool) => tool.name === "create_image_batch");
    assert(!((createTool?.inputSchema as { required?: string[] })?.required || []).includes("offeringId"), "create_image_batch must use the configured default when offeringId is omitted");
    assert((createTool?.inputSchema as { properties?: Record<string, unknown> })?.properties?.referenceImages, "create_image_batch must accept existing Esse image references");
    for (const headlessName of ["create_image_batch", "start_agent_image_job", "complete_agent_image_job", "fail_agent_image_job", "list_image_batches", "get_image_batch", "render_image_batch", "modify_selected_images"]) {
      const headless = tools.tools.find((tool) => tool.name === headlessName);
      assert.equal((headless?._meta as { ui?: { resourceUri?: string } })?.ui?.resourceUri, undefined, `${headlessName} must not reopen an inline widget`);
    }
    const resources = await client.listResources();
    assert(resources.resources.some((resource) => resource.uri === WIDGET_URI));
    const open = await client.callTool({ name: "open_esse", arguments: { tab: "settings" } });
    assert.equal((open.structuredContent as { state?: { providers?: unknown[] } }).state?.providers?.length, 0);
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
