import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { imageDimensions, readImageFileMetadata } from "../src/files/image-metadata.js";
import { formatImageFileSize, formatImageResolution } from "../web/image-metadata.js";

const onePixelPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=", "base64");

test("reads dimensions and exact byte size from the original local image", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "esse-image-metadata-"));
  const imagePath = path.join(root, "original.png");
  try {
    await writeFile(imagePath, onePixelPng);
    assert.deepEqual(await readImageFileMetadata(imagePath), { width: 1, height: 1, sizeBytes: onePixelPng.length });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parses WebP extended canvas dimensions without platform image APIs", () => {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(22, 4);
  bytes.write("WEBP", 8, "ascii");
  bytes.write("VP8X", 12, "ascii");
  bytes.writeUInt32LE(10, 16);
  bytes.writeUIntLE(639, 24, 3);
  bytes.writeUIntLE(359, 27, 3);
  assert.deepEqual(imageDimensions(bytes), { width: 640, height: 360 });
});

test("formats image information with friendly loading and unknown fallbacks", () => {
  assert.equal(formatImageResolution(undefined), "读取中…");
  assert.equal(formatImageResolution({ available: true, width: 2048, height: 1536 }), "2048 × 1536 px");
  assert.equal(formatImageResolution({ available: false }), "未知");
  assert.equal(formatImageFileSize({ available: true, sizeBytes: 1536 }), "1.5 KB");
  assert.equal(formatImageFileSize({ available: true, sizeBytes: 2.5 * 1024 * 1024 }), "2.5 MB");
  assert.equal(formatImageFileSize({ available: false }), "未知");
});
