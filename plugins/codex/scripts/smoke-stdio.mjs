import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = process.cwd();
const dataDir = await mkdtemp(path.join(os.tmpdir(), "esse-stdio-"));
const compiledBinary = process.env.ESSE_BINARY;
const pluginRoot = compiledBinary ? path.dirname(path.dirname(path.resolve(compiledBinary))) : root;
const transport = new StdioClientTransport({
  command: compiledBinary || process.execPath,
  args: compiledBinary ? [] : [path.join(pluginRoot, "mcp", "server.cjs")],
  cwd: pluginRoot,
  env: { ...process.env, ESSE_DATA_DIR: dataDir, ESSE_CORE_IDLE_MS: "100", ESSE_PLUGIN_ROOT: pluginRoot }
});
const client = new Client({ name: "esse-stdio-smoke", version: "0.1.0" });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name);
  assert(names.includes("open_esse"));
  assert(names.includes("create_image_batch"));
  assert(names.includes("list_image_batches"));
  assert(names.includes("modify_selected_images"));
  assert(names.includes("delete_esse_images"));
  assert(names.includes("merge_image_batches"));
  assert(names.includes("ui_get_batch_state"));
  assert(names.includes("ui_open_batch_folder"));
  assert(names.includes("ui_save_provider_profile"));
  assert(names.includes("ui_save_image_as"));
  assert(names.includes("ui_get_original_image_resource"));
  assert(!names.includes("get_local_media_status"));
  const openTool = tools.tools.find((tool) => tool.name === "open_esse");
  const widgetUri = openTool?._meta?.ui?.resourceUri;
  assert.equal(widgetUri, "ui://esse/local-v4.html");
  const resources = await client.listResources();
  assert(resources.resources.some((resource) => resource.uri === widgetUri));
  const templates = await client.listResourceTemplates();
  assert(templates.resourceTemplates.some((resource) => resource.uriTemplate === "esse-image://original/{token}"));
  for (const compatibleUri of [widgetUri, "ui://esse/local-v1.html", "ui://esse/local-v2-0000000000000000.html", "ui://esse/local-v3.html"]) {
    const widget = await client.readResource({ uri: compatibleUri });
    assert.equal(widget.contents[0]?.uri, compatibleUri);
    assert.equal(widget.contents[0]?._meta?.ui?.csp, undefined);
  }
  const opened = await client.callTool({ name: "open_esse", arguments: { tab: "settings" } });
  assert.equal(opened.isError, undefined);
  console.log(JSON.stringify({ transport: "stdio", runtime: compiledBinary ? "compiled" : "node", tools: names.length, widget: "ok", localState: "ok" }, null, 2));
} finally {
  await client.close().catch(() => undefined);
  await delay(300);
  await rm(dataDir, { recursive: true, force: true });
}
