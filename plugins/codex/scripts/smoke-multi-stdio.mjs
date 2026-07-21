import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = process.cwd();
const dataDir = await mkdtemp(path.join(os.tmpdir(), "esse-multi-stdio-"));
const compiledBinary = process.env.ESSE_BINARY;
const pluginRoot = compiledBinary ? path.dirname(path.dirname(path.resolve(compiledBinary))) : root;
const sharedEnv = {
  ...process.env,
  ESSE_DATA_DIR: dataDir,
  ESSE_CORE_IDLE_MS: "100",
  ESSE_PLUGIN_ROOT: pluginRoot
};

function createConnection(name) {
  const transport = new StdioClientTransport({
    command: compiledBinary || process.execPath,
    args: compiledBinary ? [] : [path.join(pluginRoot, "mcp", "server.cjs")],
    cwd: pluginRoot,
    env: sharedEnv
  });
  return {
    transport,
    client: new Client({ name, version: "0.1.0" })
  };
}

const first = createConnection("esse-multi-stdio-a");
const second = createConnection("esse-multi-stdio-b");

try {
  await Promise.all([
    first.client.connect(first.transport),
    second.client.connect(second.transport)
  ]);
  await first.client.callTool({
    name: "ui_set_default_offering",
    arguments: { offeringId: "esse-codex-generation" }
  });

  const arguments_ = {
    title: "multi-client regression",
    prompt: "one local agent-generation placeholder",
    count: 1,
    requestKey: "multi-client-create-once"
  };
  const [createdByFirst, createdBySecond] = await Promise.all([
    first.client.callTool({ name: "create_image_batch", arguments: arguments_ }),
    second.client.callTool({ name: "create_image_batch", arguments: arguments_ })
  ]);
  const firstBatch = createdByFirst.structuredContent?.batch;
  const secondBatch = createdBySecond.structuredContent?.batch;
  assert(firstBatch?.id, "first client did not receive a batch ID");
  assert.equal(secondBatch?.id, firstBatch.id, "the same requestKey created more than one batch");

  const observedBySecond = await second.client.callTool({
    name: "get_image_batch",
    arguments: { batchId: firstBatch.id }
  });
  assert.equal(observedBySecond.structuredContent?.batch?.id, firstBatch.id);
  assert.equal(observedBySecond.structuredContent?.batch?.total, 1);

  const conflictingKey = "multi-client-conflicting-create";
  const conflictingResults = await Promise.all([
    first.client.callTool({
      name: "create_image_batch",
      arguments: { title: "conflict a", prompt: "first prompt", count: 1, requestKey: conflictingKey }
    }),
    second.client.callTool({
      name: "create_image_batch",
      arguments: { title: "conflict b", prompt: "second prompt", count: 1, requestKey: conflictingKey }
    })
  ]);
  assert.equal(conflictingResults.filter((result) => result.isError).length, 1, "conflicting concurrent requests did not reject exactly one caller");
  const conflictError = conflictingResults.find((result) => result.isError);
  assert.match(conflictError?.content?.[0]?.text || "", /already used with different arguments/u);
  const batches = await first.client.callTool({ name: "list_image_batches", arguments: { limit: 10 } });
  assert.equal(batches.structuredContent?.batches?.filter((batch) => batch.requestKey === conflictingKey).length, 1);

  console.log(JSON.stringify({
    transport: "stdio",
    clients: 2,
    sharedCore: true,
    idempotentCreate: true,
    conflictingArgumentsRejected: true,
    batchId: firstBatch.id
  }, null, 2));
} finally {
  await Promise.all([
    first.client.close().catch(() => undefined),
    second.client.close().catch(() => undefined)
  ]);
  await delay(300);
  await rm(dataDir, { recursive: true, force: true });
}
