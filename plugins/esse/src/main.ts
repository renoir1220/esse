import { readFile } from "node:fs/promises";
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ensureDataPaths, resolveDataPaths } from "./paths.js";
import { createSecretStore } from "./storage/secret-store.js";
import { SettingsStore } from "./storage/settings-store.js";
import { BatchStore } from "./storage/batch-store.js";
import { ProviderRegistry } from "./providers/registry.js";
import { BatchManager } from "./jobs/batch-manager.js";
import { Thumbnailer } from "./files/thumbnailer.js";
import { createLocalEsseServer } from "./mcp/app.js";

async function main(): Promise<void> {
  const paths = resolveDataPaths();
  await ensureDataPaths(paths);
  const secrets = createSecretStore(paths.secretsDir);
  const settings = new SettingsStore(paths.settingsFile, secrets);
  const registry = new ProviderRegistry(settings);
  const batchStore = new BatchStore(paths.batchesDir);
  const batches = new BatchManager(batchStore, registry, paths);
  await batches.initialize();
  const thumbnailer = new Thumbnailer(paths);
  const widgetHtml = await readFile(path.join(process.cwd(), "mcp", "widget.html"), "utf8");
  const server = createLocalEsseServer({ widgetHtml, settings, registry, batches, thumbnailer });
  await server.connect(new StdioServerTransport());
  process.stderr.write(`esse local MCP ready. Data: ${paths.root}\n`);
}

main().catch((error) => {
  process.stderr.write(`esse failed to start: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
