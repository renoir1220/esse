import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureDataPaths, resolveDataPaths } from "../src/paths.js";
import { scanImageFolder } from "../src/files/image-files.js";
import { Thumbnailer } from "../src/files/thumbnailer.js";

const onePixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=";

test("local folder scan finds images and native thumbnailer creates a widget preview", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "esse-files-"));
  try {
    const input = path.join(root, "flower.png");
    await writeFile(input, Buffer.from(onePixelPng, "base64"));
    await writeFile(path.join(root, "notes.txt"), "not an image", "utf8");
    const scanned = await scanImageFolder({ folderPath: root, recursive: false });
    assert.deepEqual(scanned.files.map((file) => file.name), ["flower.png"]);
    const paths = resolveDataPaths({ ESSE_DATA_DIR: path.join(root, "data") }, process.platform);
    await ensureDataPaths(paths);
    const dataUrl = await new Thumbnailer(paths).dataUrl(input, 128);
    assert(dataUrl?.startsWith("data:image/"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
