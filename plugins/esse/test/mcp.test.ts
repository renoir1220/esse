import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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

test("local MCP exposes the installable plugin tools and widget over stdio-compatible transport", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "esse-mcp-"));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "esse-test", version: "0.1.0" });
  try {
    const paths = resolveDataPaths({ ESSE_DATA_DIR: root }, process.platform);
    await ensureDataPaths(paths);
    const settings = new SettingsStore(paths.settingsFile, new MemorySecretStore());
    const registry = new ProviderRegistry(settings);
    const batches = new BatchManager(new BatchStore(paths.batchesDir), registry, paths);
    await batches.initialize();
    const server = createLocalEsseServer({ widgetHtml: "<html><body><div id=\"root\"></div></body></html>", settings, registry, batches, thumbnailer: new Thumbnailer(paths) });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    for (const required of ["open_esse", "inspect_image_folder", "create_image_batch", "modify_selected_images", "ui_save_provider_profile", "ui_delete_image_batch"]) {
      assert(names.includes(required), `Missing local MCP tool ${required}`);
    }
    const settingsTool = tools.tools.find((tool) => tool.name === "ui_save_provider_profile");
    assert.deepEqual((settingsTool?._meta as { ui?: { visibility?: string[] } })?.ui?.visibility, ["app"]);
    const openTool = tools.tools.find((tool) => tool.name === "open_esse");
    assert.equal((openTool?._meta as { ui?: { resourceUri?: string } })?.ui?.resourceUri, WIDGET_URI);
    for (const headlessName of ["create_image_batch", "get_image_batch", "render_image_batch", "modify_selected_images"]) {
      const headless = tools.tools.find((tool) => tool.name === headlessName);
      assert.equal((headless?._meta as { ui?: { resourceUri?: string } })?.ui?.resourceUri, undefined, `${headlessName} must not reopen an inline widget`);
    }
    const resources = await client.listResources();
    assert(resources.resources.some((resource) => resource.uri === WIDGET_URI));
    const open = await client.callTool({ name: "open_esse", arguments: { tab: "settings" } });
    assert.equal((open.structuredContent as { state?: { providers?: unknown[] } }).state?.providers?.length, 0);
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
  } finally {
    await client.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
