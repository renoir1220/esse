import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Thumbnailer } from "../src/files/thumbnailer.js";
import { ensureDataPaths, resolveDataPaths } from "../src/paths.js";

if (!["win32", "darwin"].includes(process.platform)) throw new Error("Thumbnail benchmark supports Windows and macOS desktop runners only.");

const root = await mkdtemp(path.join(os.tmpdir(), "esse-thumbnail-benchmark-"));
try {
  const sourceRoot = path.join(root, "sources");
  const paths = resolveDataPaths({ ESSE_DATA_DIR: path.join(root, "data") }, process.platform);
  await mkdir(sourceRoot, { recursive: true });
  await ensureDataPaths(paths);
  const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=", "base64");
  const inputs = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
    const filePath = path.join(sourceRoot, `image-${index + 1}.png`);
    await writeFile(filePath, imageBytes);
    return filePath;
  }));
  const thumbnailer = new Thumbnailer(paths);
  const coldStarted = performance.now();
  const cold = await Promise.all(inputs.map((filePath) => thumbnailer.dataUrl(filePath, 720)));
  const coldMs = performance.now() - coldStarted;
  const warmStarted = performance.now();
  const warm = await Promise.all(inputs.map((filePath) => thumbnailer.dataUrl(filePath, 720)));
  const warmMs = performance.now() - warmStarted;
  assert(cold.every((value) => value?.startsWith("data:image/")));
  assert.deepEqual(warm, cold);
  process.stdout.write(`${JSON.stringify({ status: "ok", platform: process.platform, architecture: process.arch, images: inputs.length, coldMs: Math.round(coldMs), warmMs: Math.round(warmMs) })}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
