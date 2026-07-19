import assert from "node:assert/strict";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MAX_ORIGINAL_IMAGE_BYTES, OriginalImageRegistry } from "../src/files/original-image-registry.js";
import { originalImageDataUrl } from "../web/original-image-resource.js";

const onePixelPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=", "base64");

test("original image resources preserve exact bytes and reject changed files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "esse-original-resource-"));
  const filePath = path.join(root, "原图.png");
  try {
    await writeFile(filePath, onePixelPng);
    const registry = new OriginalImageRegistry();
    const uri = await registry.register(filePath);
    const token = new URL(uri).pathname.slice(1);
    const resource = await registry.read(token);
    assert.equal(resource.mimeType, "image/png");
    assert.equal(resource.sizeBytes, onePixelPng.length);
    assert.deepEqual(Buffer.from(resource.blob, "base64"), onePixelPng);

    await writeFile(filePath, Buffer.concat([onePixelPng, Buffer.from([0])]));
    await assert.rejects(() => registry.read(token), /发生变化/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("original image resources enforce the 60 MB limit before reading", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "esse-original-limit-"));
  const filePath = path.join(root, "large.png");
  try {
    await writeFile(filePath, onePixelPng);
    await truncate(filePath, MAX_ORIGINAL_IMAGE_BYTES + 1);
    await assert.rejects(() => new OriginalImageRegistry().register(filePath), /超过 60 MB/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("widget converts an MCP blob to an exact data URL without decoding or transcoding", () => {
  const image = originalImageDataUrl({
    contents: [{ uri: "esse-image://original/test", mimeType: "image/png", blob: onePixelPng.toString("base64") }]
  });
  assert.equal(image, `data:image/png;base64,${onePixelPng.toString("base64")}`);
});

test("the lightbox uses MCP resources as its only exact-original path", async () => {
  const workbench = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../web/main.tsx", import.meta.url), "utf8"));
  assert.match(workbench, /ui_get_original_image_resource/);
  assert.match(workbench, /bridge\.readResource/);
  assert.match(workbench, /originalImageDataUrl/);
  assert.doesNotMatch(workbench, /createObjectURL|blob:/);
  assert.doesNotMatch(workbench, /ui_get_direct_image_url|127\.0\.0\.1|loadFallbackPreview/);
  assert.doesNotMatch(workbench, /ui_get_image_preview[\s\S]{0,160}full:\s*true/);
});
