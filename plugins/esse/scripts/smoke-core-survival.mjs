import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

if (process.platform !== "win32") {
  console.log(JSON.stringify({ skipped: true, reason: "native secure-provider survival smoke currently runs on Windows" }));
  process.exit(0);
}

const root = process.cwd();
const dataDir = await mkdtemp(path.join(os.tmpdir(), "esse-core-survival-"));
const compiledBinary = process.env.ESSE_BINARY;
const pluginRoot = compiledBinary ? path.dirname(path.dirname(path.resolve(compiledBinary))) : root;
let providerCalls = 0;
let finishProvider;
const providerFinished = new Promise((resolve) => { finishProvider = resolve; });
const onePixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=";
const provider = http.createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/images/generations") {
    response.writeHead(404).end();
    return;
  }
  providerCalls += 1;
  for await (const _chunk of request) {
    // Drain the request before simulating a slow Provider response.
  }
  await delay(350);
  response.writeHead(200, { "content-type": "application/json", "x-request-id": "fake-survival-request" });
  response.end(JSON.stringify({ data: [{ b64_json: onePixelPng }] }));
  finishProvider();
});
await new Promise((resolve, reject) => {
  provider.once("error", reject);
  provider.listen(0, "127.0.0.1", resolve);
});
const address = provider.address();
assert(address && typeof address === "object");

function createConnection(name) {
  const transport = new StdioClientTransport({
    command: compiledBinary || process.execPath,
    args: compiledBinary ? [] : [path.join(pluginRoot, "mcp", "server.cjs")],
    cwd: pluginRoot,
    env: {
      ...process.env,
      ESSE_DATA_DIR: dataDir,
      ESSE_CORE_IDLE_MS: "1000",
      ESSE_PLUGIN_ROOT: pluginRoot
    }
  });
  return { transport, client: new Client({ name, version: "0.1.0" }) };
}

let first;
let second;
try {
  first = createConnection("esse-core-survival-a");
  await first.client.connect(first.transport);
  const saved = await first.client.callTool({
    name: "ui_save_provider_profile",
    arguments: {
      displayName: "Local fake Provider",
      tierName: "test",
      baseUrl: `http://127.0.0.1:${address.port}`,
      adapterId: "openai-images",
      concurrency: 1,
      apiKey: "local-test-key",
      offerings: [{
        canonicalModelId: "fake-image-model",
        providerModelId: "fake-image-model",
        displayName: "Fake Image Model",
        price: { mode: "unknown", currency: "TEST" },
        supportsTextToImage: true,
        supportsImageToImage: false,
        sizes: [],
        qualities: []
      }]
    }
  });
  assert.equal(saved.isError, undefined);
  const created = await first.client.callTool({
    name: "create_image_batch",
    arguments: { prompt: "survive adapter disconnect", count: 1, requestKey: "core-survival-once" }
  });
  const batchId = created.structuredContent?.batch?.id;
  assert(batchId);

  await first.client.close();
  first = undefined;
  await providerFinished;

  second = createConnection("esse-core-survival-b");
  await second.client.connect(second.transport);
  let terminal;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const current = await second.client.callTool({ name: "get_image_batch", arguments: { batchId } });
    terminal = current.structuredContent?.batch;
    if (terminal?.status === "completed") break;
    await delay(20);
  }
  assert.equal(terminal?.status, "completed");
  assert.equal(terminal?.succeeded, 1);
  assert.equal(providerCalls, 1);
  console.log(JSON.stringify({ adapterDisconnected: true, providerCalls, status: terminal.status, batchId }, null, 2));
} finally {
  await first?.client.close().catch(() => undefined);
  await second?.client.close().catch(() => undefined);
  await new Promise((resolve) => provider.close(resolve));
  await delay(1200);
  await rm(dataDir, { recursive: true, force: true });
}
