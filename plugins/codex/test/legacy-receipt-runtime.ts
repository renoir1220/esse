import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { BatchRecord } from "../src/types.js";
import { coloredPng } from "./pixel-fixture.js";

export const RECEIPT_SOURCE_COMMITS = [
  "996ea8acdab576f8cec2f77605b27b61679b6473", // omitted referenceImagePaths
  "03fbd5fd3aa3ad0b48b375b518203900995e271f" // explicit empty referenceImagePaths
];
export type LegacyRequest = { batchId: string; imageIds?: string[]; jobIds?: string[]; instructions: string; requestKey: string };
export interface LegacyReceiptFixture {
  sourceCommit: string;
  selector: "imageIds" | "jobIds";
  request: LegacyRequest;
  record: BatchRecord;
  files: Array<{ path: string; base64: string }>;
}

// Runs the unmodified historical manager and MCP handler, not a hash emulator.
// The callback runs after the old server closes, before its data root is removed.
export async function withLegacyReceipt<T>(checkout: string, selector: LegacyReceiptFixture["selector"],
  afterClose: (root: string, fixture: LegacyReceiptFixture) => Promise<T>): Promise<T> {
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim();
  assert(RECEIPT_SOURCE_COMMITS.includes(sourceCommit));
  assert.equal(execFileSync("git", ["diff", "--name-only", "HEAD", "--", "plugins/codex/src"], { cwd: checkout, encoding: "utf8" }).trim(), "");
  const load = (relative: string) => import(pathToFileURL(path.join(checkout, "plugins/codex/src", relative)).href);
  const [pathsModule, settingsModule, secretsModule, storeModule, registryModule, managerModule, thumbnailModule, appModule, typesModule] = await Promise.all([
    load("paths.ts"), load("storage/settings-store.ts"), load("storage/secret-store.ts"), load("storage/batch-store.ts"),
    load("providers/registry.ts"), load("jobs/batch-manager.ts"), load("files/thumbnailer.ts"), load("mcp/app.ts"), load("types.ts")
  ]);
  const root = await mkdtemp(path.join(os.tmpdir(), "esse-legacy-receipt-"));
  const paths = pathsModule.resolveDataPaths({ ESSE_DATA_DIR: root }, process.platform);
  await pathsModule.ensureDataPaths(paths);
  const settings = new settingsModule.SettingsStore(paths.settingsFile, new secretsModule.MemorySecretStore());
  let providerCalls = 0;
  const registry = new registryModule.ProviderRegistry(settings, async () => { providerCalls += 1; throw new Error("Unexpected Provider call in historical fixture"); });
  const store = new storeModule.BatchStore(paths.batchesDir);
  const manager = new managerModule.BatchManager(store, registry, paths);
  await manager.initialize();
  const server = appModule.createLocalEsseServer({ version: sourceCommit, widgetHtml: "<html></html>", settings, registry, batches: manager, thumbnailer: new thumbnailModule.Thumbnailer(paths) });
  const client = new Client({ name: "historical-receipt-writer", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    return result;
  };
  let closed = false;
  try {
    const imagePath = path.join(root, "offline-image.png");
    await writeFile(imagePath, coloredPng(0, 255, 0));
    const created = await call("create_image_batch", { offeringId: typesModule.CODEX_GENERATION_OFFERING_ID, prompt: "legacy mother", requestKey: "legacy-mother-key" });
    const batch = (created.structuredContent as { batch: { id: string; jobs: Array<{ id: string }> } }).batch;
    const jobId = batch.jobs[0]!.id;
    await call("start_agent_image_job", { batchId: batch.id, jobId });
    await call("complete_agent_image_job", { batchId: batch.id, jobId, imagePath });
    const request: LegacyRequest = { batchId: batch.id, [selector]: [jobId], instructions: "legacy bounded rework", requestKey: "legacy-rework-key" };
    await call("modify_selected_images", request);
    await call("start_agent_image_job", { batchId: batch.id, jobId });
    await writeFile(imagePath, coloredPng(0, 0, 255));
    await call("complete_agent_image_job", { batchId: batch.id, jobId, imagePath });
    const before = manager.get(batch.id);
    await call("modify_selected_images", request);
    assert.deepEqual(manager.get(batch.id), before);
    await manager.waitForPersistence(batch.id);
    await client.close(); await server.close(); closed = true;
    const record = await store.get(batch.id) as BatchRecord;
    assert(record);
    const imagePaths = [...new Set(record.jobs.flatMap(job => [job.outputPath, ...(job.referenceImagePaths || []), ...(job.backups || []).map(backup => backup.outputPath)]).filter((value): value is string => Boolean(value)))];
    const files = await Promise.all(imagePaths.map(async file => ({ path: portablePath(file, root), base64: (await readFile(file)).toString("base64") })));
    const fixture = { sourceCommit, selector, request, record: mapPaths(record, value => portablePath(value, root)), files };
    assert.equal(providerCalls, 0);
    return await afterClose(root, fixture);
  } finally {
    if (!closed) { await client.close(); await server.close(); }
    await rm(root, { recursive: true, force: true });
  }
}

function portablePath(value: string, root: string): string {
  return value.startsWith(root + path.sep) ? "$FIXTURE_ROOT/" + path.relative(root, value).split(path.sep).join("/") : value;
}

export function restorePaths<T>(value: T, root: string): T {
  return mapPaths(value, entry => entry.startsWith("$FIXTURE_ROOT/") ? path.join(root, ...entry.slice("$FIXTURE_ROOT/".length).split("/")) : entry);
}

function mapPaths<T>(value: T, map: (entry: string) => string): T {
  if (typeof value === "string") return map(value) as T;
  if (Array.isArray(value)) return value.map(entry => mapPaths(entry, map)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, mapPaths(entry, map)])) as T;
  return value;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const checkouts = process.argv.slice(2);
  assert.equal(checkouts.length, 2, "Provide clean checkouts of both receipt source commits");
  const fixtures: LegacyReceiptFixture[] = [];
  for (const checkout of checkouts) for (const selector of ["imageIds", "jobIds"] as const) {
    fixtures.push(await withLegacyReceipt(checkout, selector, async (_root, fixture) => fixture));
  }
  const destination = new URL("./fixtures/legacy-modification-receipts.json", import.meta.url);
  await mkdir(path.dirname(fileURLToPath(destination)), { recursive: true });
  await writeFile(destination, JSON.stringify({ schemaVersion: 1, fixtures }, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ fixtures: fixtures.length, providerCalls: 0 }) + "\n");
}
