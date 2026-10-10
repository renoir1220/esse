import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ensureDataPaths, resolveDataPaths } from "../src/paths.js";
import { SettingsStore } from "../src/storage/settings-store.js";
import { MemorySecretStore } from "../src/storage/secret-store.js";
import { BatchStore } from "../src/storage/batch-store.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { BatchManager } from "../src/jobs/batch-manager.js";
import { Thumbnailer } from "../src/files/thumbnailer.js";
import { createLocalEsseServer } from "../src/mcp/app.js";
import { coloredPng } from "./pixel-fixture.js";
import { RECEIPT_SOURCE_COMMITS, restorePaths, withLegacyReceipt, type LegacyReceiptFixture } from "./legacy-receipt-runtime.js";

const saved = JSON.parse(await readFile(new URL("./fixtures/legacy-modification-receipts.json", import.meta.url), "utf8")) as { schemaVersion: number; fixtures: LegacyReceiptFixture[] };
assert.equal(saved.schemaVersion, 1);
assert.equal(saved.fixtures.length, 4);

// CI uses records written by the actual historical runtimes. Local upgrade
// acceptance can run those runtimes anew, then open their same data directory.
const legacyCheckouts: string[] | undefined = process.env.ESSE_LEGACY_PLUGIN_CHECKOUTS
  ? JSON.parse(process.env.ESSE_LEGACY_PLUGIN_CHECKOUTS) : undefined;
if (legacyCheckouts) assert.equal(legacyCheckouts.length, RECEIPT_SOURCE_COMMITS.length);

for (const sourceCommit of RECEIPT_SOURCE_COMMITS) for (const selector of ["imageIds", "jobIds"] as const) {
  test(`Plugin upgrade replays ${sourceCommit.slice(0, 7)} ${selector} receipt without another generation`, async () => {
    if (legacyCheckouts) {
      const checkout = legacyCheckouts[RECEIPT_SOURCE_COMMITS.indexOf(sourceCommit)]!;
      await withLegacyReceipt(checkout, selector, async (root, fixture) => {
        assert.equal(fixture.sourceCommit, sourceCommit);
        await verifyReplay(root, fixture);
      });
      return;
    }
    const fixture = saved.fixtures.find(entry => entry.sourceCommit === sourceCommit && entry.selector === selector);
    assert(fixture);
    const root = await mkdtemp(path.join(os.tmpdir(), "esse-upgrade-receipt-"));
    try {
      const paths = resolveDataPaths({ ESSE_DATA_DIR: root }, process.platform);
      await ensureDataPaths(paths);
      // Only relocate filesystem paths. Never compute or alter old fingerprints.
      const record = restorePaths(fixture.record, root);
      await writeFile(path.join(paths.batchesDir, `${record.id}.json`), JSON.stringify(record));
      for (const file of fixture.files) {
        const destination = restorePaths(file.path, root);
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, Buffer.from(file.base64, "base64"));
      }
      await verifyReplay(root, fixture);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

async function verifyReplay(root: string, fixture: LegacyReceiptFixture): Promise<void> {
  const paths = resolveDataPaths({ ESSE_DATA_DIR: root }, process.platform);
  const settings = new SettingsStore(paths.settingsFile, new MemorySecretStore());
  let providerCalls = 0;
  const registry = new ProviderRegistry(settings, async () => { providerCalls += 1; throw new Error("Unexpected generation during receipt replay"); });
  const store = new BatchStore(paths.batchesDir);
  let writes = 0;
  const save = store.save.bind(store);
  store.save = async batch => { writes += 1; await save(batch); };
  const manager = new BatchManager(store, registry, paths);
  await manager.initialize();
  const before = manager.get(fixture.request.batchId);
  const diskBefore = await store.get(before.id);
  const allBefore = manager.list();
  const initialWrites = writes;
  const imagesBefore = await Promise.all(fixture.files.map(file => readFile(restorePaths(file.path, root))));
  const server = createLocalEsseServer({ version: "upgrade-test", widgetHtml: "<html></html>", settings, registry, batches: manager, thumbnailer: new Thumbnailer(paths) });
  const client = new Client({ name: "upgrade-receipt-reader", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  try {
    for (const empty of [{}, { referenceImagePaths: [] }, { referenceImages: [] }, { referenceImagePaths: [], referenceImages: [] }]) {
      const result = await client.callTool({ name: "modify_selected_images", arguments: { ...fixture.request, ...empty } });
      assert.notEqual(result.isError, true, JSON.stringify(result.content));
      assert.deepEqual((result.structuredContent as { batch: unknown }).batch, before);
    }
    const listed = await client.callTool({ name: "list_image_batches", arguments: { requestKey: fixture.request.requestKey, limit: 1 } });
    assert.notEqual(listed.isError, true);
    assert.deepEqual((listed.structuredContent as { batches: Array<{ id: string }> }).batches.map(batch => batch.id), [before.id]);
    const extraPath = path.join(root, "changed-reference.png");
    await writeFile(extraPath, coloredPng(255, 0, 0));
    const changed = [
      { instructions: fixture.request.instructions + " changed" },
      { offeringId: "a-different-model" },
      { [fixture.selector]: ["a-different-target"] },
      { referenceImagePaths: [extraPath] },
      { referenceImages: [{ batchId: before.id, image: "图1" }] }
    ];
    for (const change of changed) {
      const result = await client.callTool({ name: "modify_selected_images", arguments: { ...fixture.request, ...change } });
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result.content), /already used with different arguments/u);
    }
    await manager.waitForPersistence(before.id);
    assert.deepEqual(manager.get(before.id), before);
    assert.deepEqual(manager.list(), allBefore);
    assert.deepEqual(await store.get(before.id), diskBefore);
    assert.deepEqual(await Promise.all(fixture.files.map(file => readFile(restorePaths(file.path, root)))), imagesBefore);
    assert.equal(writes, initialWrites, "Replay/conflicts must not create another receipt or backup");
    assert.equal(providerCalls, 0);
  } finally { await client.close(); await server.close(); }
}
