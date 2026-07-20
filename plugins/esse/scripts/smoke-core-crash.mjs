import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

if (process.platform !== "win32") {
  console.log(JSON.stringify({ skipped: true, reason: "native secure-provider crash smoke currently runs on Windows" }));
  process.exit(0);
}

const root = process.cwd();
const dataDir = await mkdtemp(path.join(os.tmpdir(), "esse-core-crash-"));
const compiledBinary = process.env.ESSE_BINARY;
const pluginRoot = compiledBinary ? path.dirname(path.dirname(path.resolve(compiledBinary))) : root;
let providerCalls = 0;
let markStarted;
const providerStarted = new Promise((resolve) => { markStarted = resolve; });
const provider = http.createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/images/generations") {
    response.writeHead(404).end();
    return;
  }
  providerCalls += 1;
  markStarted();
  for await (const _chunk of request) {
    // Drain until the Core process is terminated.
  }
  await new Promise((resolve) => response.once("close", resolve));
  if (!response.writableEnded) response.destroy();
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
    env: { ...process.env, ESSE_DATA_DIR: dataDir, ESSE_CORE_IDLE_MS: "1000", ESSE_PLUGIN_ROOT: pluginRoot }
  });
  return { transport, client: new Client({ name, version: "0.1.0" }) };
}

let first;
let second;
try {
  first = createConnection("esse-core-crash-a");
  await first.client.connect(first.transport);
  await first.client.callTool({
    name: "ui_save_provider_profile",
    arguments: {
      displayName: "Hanging local Provider",
      tierName: "test",
      baseUrl: `http://127.0.0.1:${address.port}`,
      adapterId: "openai-images",
      concurrency: 1,
      apiKey: "local-test-key",
      offerings: [{
        canonicalModelId: "hanging-image-model",
        providerModelId: "hanging-image-model",
        displayName: "Hanging Image Model",
        price: { mode: "unknown", currency: "TEST" },
        supportsTextToImage: true,
        supportsImageToImage: false,
        sizes: [],
        qualities: []
      }]
    }
  });
  const created = await first.client.callTool({
    name: "create_image_batch",
    arguments: { prompt: "become unknown after Core crash", count: 1, requestKey: "core-crash-once" }
  });
  const batchId = created.structuredContent?.batch?.id;
  assert(batchId);
  await providerStarted;
  const lock = JSON.parse(await readFile(path.join(dataDir, "core.lock"), "utf8"));
  assert(Number.isInteger(lock.pid) && lock.pid > 0 && lock.pid !== process.pid);
  process.kill(lock.pid);
  await delay(200);
  await first.client.close().catch(() => undefined);
  first = undefined;

  second = createConnection("esse-core-crash-b");
  await second.client.connect(second.transport);
  const recovered = await second.client.callTool({ name: "get_image_batch", arguments: { batchId } });
  const batch = recovered.structuredContent?.batch;
  assert.equal(batch?.status, "failed");
  assert.equal(batch?.jobs?.[0]?.chargeState, "unknown");
  assert.match(batch?.jobs?.[0]?.error || "", /local plugin stopped/u);
  await delay(300);
  assert.equal(providerCalls, 1, "an unknown-charge request was submitted again after Core recovery");
  console.log(JSON.stringify({ coreCrashRecovered: true, providerCalls, status: batch.status, chargeState: batch.jobs[0].chargeState, batchId }, null, 2));
} finally {
  await first?.client.close().catch(() => undefined);
  await second?.client.close().catch(() => undefined);
  await new Promise((resolve) => provider.close(resolve));
  await delay(1200);
  await rm(dataDir, { recursive: true, force: true });
}
