import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BatchStore } from "../src/storage/batch-store.js";
import type { BatchRecord } from "../src/types.js";

test("batch store quarantines corrupt records and still loads healthy batches", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "esse-batch-store-"));
  try {
    const store = new BatchStore(root);
    const valid = sampleBatch("11111111-1111-4111-8111-111111111111");
    await store.save(valid);
    await writeFile(path.join(root, "broken.json"), "{ definitely not JSON", "utf8");
    await writeFile(path.join(root, "wrong-shape.json"), JSON.stringify({ id: "not-a-batch" }), "utf8");

    assert.deepEqual((await store.loadAll()).map((batch) => batch.id), [valid.id]);
    assert.deepEqual((await readdir(root)).filter((name) => name.endsWith(".json")), [`${valid.id}.json`]);
    const quarantined = await readdir(path.join(root, ".quarantine"));
    assert.equal(quarantined.length, 2);
    assert(quarantined.some((name) => name.endsWith("broken.json")));
    assert(quarantined.some((name) => name.endsWith("wrong-shape.json")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function sampleBatch(id: string): BatchRecord {
  const now = new Date().toISOString();
  const offering = {
    id: "offer-default",
    providerProfileId: "profile-default",
    providerName: "Provider",
    tierName: "default",
    adapterId: "openai-images" as const,
    canonicalModelId: "gpt-image-1",
    providerModelId: "gpt-image-1",
    displayName: "Image",
    concurrency: 1,
    price: { mode: "unknown" as const, currency: "USD" }
  };
  return {
    id,
    title: "healthy",
    prompt: "test",
    outputDirectory: path.join(os.tmpdir(), id),
    offering,
    jobs: [{
      id: "22222222-2222-4222-8222-222222222222",
      index: 0,
      name: "图1",
      prompt: "test",
      status: "succeeded",
      progress: 100,
      attempt: 1,
      retryable: false,
      chargeState: "charged",
      createdAt: now
    }],
    createdAt: now,
    updatedAt: now
  };
}
