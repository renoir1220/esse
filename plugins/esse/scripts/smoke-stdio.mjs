import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = process.cwd();
const dataDir = await mkdtemp(path.join(os.tmpdir(), "esse-stdio-"));
const compiledBinary = process.env.ESSE_BINARY;
const transport = new StdioClientTransport({
  command: compiledBinary || process.execPath,
  args: compiledBinary ? [] : [path.join(root, "mcp", "server.cjs")],
  cwd: root,
  env: { ...process.env, ESSE_DATA_DIR: dataDir }
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
  assert(!names.includes("get_local_media_status"));
  const openTool = tools.tools.find((tool) => tool.name === "open_esse");
  const widgetUri = openTool?._meta?.ui?.resourceUri;
  assert.match(widgetUri || "", /^ui:\/\/esse\/local-v2-[0-9a-f]{16}\.html$/);
  const resources = await client.listResources();
  assert(resources.resources.some((resource) => resource.uri === widgetUri));
  const opened = await client.callTool({ name: "open_esse", arguments: { tab: "settings" } });
  assert.equal(opened.isError, undefined);
  console.log(JSON.stringify({ transport: "stdio", runtime: compiledBinary ? "compiled" : "node", tools: names.length, widget: "ok", localState: "ok" }, null, 2));
} finally {
  await client.close().catch(() => undefined);
  await rm(dataDir, { recursive: true, force: true });
}
