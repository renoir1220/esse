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
import { pruneThumbnailCache } from "./files/thumbnail-cache.js";
import { createLocalEsseServer } from "./mcp/app.js";

declare const __ESSE_VERSION__: string;

async function runSelfTest(): Promise<void> {
  const pluginRoot = resolvePluginRoot();
  const paths = resolveDataPaths();
  await ensureDataPaths(paths);
  const [widgetHtml, manifestText] = await Promise.all([
    readFile(path.join(pluginRoot, "mcp", "widget.html"), "utf8"),
    readFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8")
  ]);
  const manifest = JSON.parse(manifestText) as { name?: string; version?: string };
  if (manifest.name !== "esse") throw new Error("Plugin manifest name is not esse.");
  if (manifest.version !== __ESSE_VERSION__) throw new Error(`Runtime version ${__ESSE_VERSION__} does not match manifest ${manifest.version}.`);
  if (widgetHtml.length < 10_000) throw new Error("Compiled Esse widget is missing or incomplete.");
  process.stdout.write(JSON.stringify({
    status: "ok",
    version: __ESSE_VERSION__,
    platform: process.platform,
    architecture: process.arch,
    widget: "ok",
    dataRoot: paths.root
  }));
}

async function main(): Promise<void> {
  if (process.argv.includes("--version")) {
    process.stdout.write(`${__ESSE_VERSION__}\n`);
    return;
  }
  if (process.argv.includes("--self-test")) {
    await runSelfTest();
    return;
  }

  const paths = resolveDataPaths();
  await ensureDataPaths(paths);
  const cachePrune = await pruneThumbnailCache(paths.thumbnailsDir).catch((error) => {
    process.stderr.write(`esse could not prune its thumbnail cache: ${error instanceof Error ? error.message : String(error)}\n`);
    return undefined;
  });
  if (cachePrune?.removed) process.stderr.write(`esse removed ${cachePrune.removed} stale thumbnail cache file(s).\n`);
  const secrets = createSecretStore(paths.secretsDir);
  const settings = new SettingsStore(paths.settingsFile, secrets);
  const registry = new ProviderRegistry(settings);
  const batchStore = new BatchStore(paths.batchesDir);
  const batches = new BatchManager(batchStore, registry, paths);
  await batches.initialize();
  const thumbnailer = new Thumbnailer(paths);
  const widgetHtml = await readFile(path.join(resolvePluginRoot(), "mcp", "widget.html"), "utf8");
  const server = createLocalEsseServer({ version: __ESSE_VERSION__, widgetHtml, settings, registry, batches, thumbnailer });
  await server.connect(new StdioServerTransport());
  process.stderr.write(`esse local MCP ${__ESSE_VERSION__} ready. Data: ${paths.root}.\n`);
}

function resolvePluginRoot(): string {
  return path.resolve(process.env.ESSE_PLUGIN_ROOT || process.cwd());
}

main().catch((error) => {
  process.stderr.write(`esse failed to start: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
