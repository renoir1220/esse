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
  assert(names.includes("ui_save_provider_profile"));
  const resources = await client.listResources();
  assert(resources.resources.some((resource) => resource.uri === "ui://esse/local-v1.html"));
  const opened = await client.callTool({ name: "open_esse", arguments: { tab: "settings" } });
  assert.equal(opened.isError, undefined);
  console.log(JSON.stringify({ transport: "stdio", runtime: compiledBinary ? "compiled" : "node", tools: names.length, widget: "ok", localState: "ok" }, null, 2));
} finally {
  await client.close().catch(() => undefined);
  await rm(dataDir, { recursive: true, force: true });
}
