import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pruneThumbnailCache } from "../src/files/thumbnail-cache.js";
import { progressivePreviewChunks } from "../web/preview-batching.js";

test("thumbnail disk cache removes expired entries then evicts oldest files to its byte budget", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "esse-thumbnail-prune-"));
  try {
    const now = Date.parse("2026-07-20T00:00:00.000Z");
    const expired = path.join(root, "expired.jpg");
    const oldest = path.join(root, "oldest.jpg");
    const newest = path.join(root, "newest.jpg");
    await Promise.all([writeFile(expired, Buffer.alloc(5)), writeFile(oldest, Buffer.alloc(7)), writeFile(newest, Buffer.alloc(7))]);
    await Promise.all([
      utimes(expired, new Date(now - 31 * 24 * 60 * 60 * 1000), new Date(now - 31 * 24 * 60 * 60 * 1000)),
      utimes(oldest, new Date(now - 2_000), new Date(now - 2_000)),
      utimes(newest, new Date(now - 1_000), new Date(now - 1_000))
    ]);
    const result = await pruneThumbnailCache(root, { maxBytes: 8, maxAgeMs: 30 * 24 * 60 * 60 * 1000, now });
    assert.deepEqual(result, { scanned: 3, removed: 2, remainingBytes: 7 });
    assert.deepEqual(await readdir(root), ["newest.jpg"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cold previews render progressively before reaching the bounded batch size", () => {
  assert.deepEqual(progressivePreviewChunks([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), [[1], [2, 3], [4, 5, 6, 7], [8, 9, 10]]);
});
