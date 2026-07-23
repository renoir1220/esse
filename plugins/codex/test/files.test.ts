import assert from "node:assert/strict";
import { copyFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureDataPaths, resolveDataPaths } from "../src/paths.js";
import { imageFilesToDataUrls, scanImageFolder } from "../src/files/image-files.js";
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

test("thumbnailer deduplicates concurrent work and reuses encoded previews from memory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "esse-thumbnail-cache-"));
  try {
    const input = path.join(root, "flower.png");
    await writeFile(input, Buffer.from(onePixelPng, "base64"));
    const paths = resolveDataPaths({ ESSE_DATA_DIR: path.join(root, "data") }, process.platform);
    await ensureDataPaths(paths);
    let creates = 0;
    const thumbnailer = new Thumbnailer(paths, process.platform, {
      createThumbnail: async (source, target) => {
        creates += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        await copyFile(source, target);
      }
    });
    const previews = await Promise.all(Array.from({ length: 6 }, () => thumbnailer.dataUrl(input, 320)));
    assert.equal(creates, 1);
    assert(previews.every((preview) => preview === previews[0]));
    const [diskThumbnail] = await readdir(paths.thumbnailsDir);
    assert(diskThumbnail);
    await rm(path.join(paths.thumbnailsDir, diskThumbnail), { force: true });
    assert.equal(await thumbnailer.dataUrl(input, 320), previews[0]);
    assert.equal(creates, 1, "memory cache should avoid reading or regenerating an existing encoded preview");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("thumbnailer bounds concurrent native image processes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "esse-thumbnail-pool-"));
  try {
    const paths = resolveDataPaths({ ESSE_DATA_DIR: path.join(root, "data") }, process.platform);
    await ensureDataPaths(paths);
    const inputs = await Promise.all(Array.from({ length: 7 }, async (_, index) => {
      const input = path.join(root, `flower-${index}.png`);
      await writeFile(input, Buffer.from(onePixelPng, "base64"));
      return input;
    }));
    let active = 0;
    let peak = 0;
    const thumbnailer = new Thumbnailer(paths, process.platform, {
      maxConcurrentGenerations: 3,
      createThumbnail: async (source, target) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 15));
        await copyFile(source, target);
        active -= 1;
      }
    });
    await Promise.all(inputs.map((input) => thumbnailer.dataUrl(input, 320)));
    assert.equal(peak, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reference image encoding applies count and byte limits independently to each job request", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "esse-reference-limits-"));
  try {
    const first = path.join(root, "first.png");
    const second = path.join(root, "second.png");
    await Promise.all([writeFile(first, Buffer.alloc(8)), writeFile(second, Buffer.alloc(8))]);
    await assert.rejects(imageFilesToDataUrls([first, second], { maxImages: 1 }), /at most 1 reference images/);
    await assert.rejects(imageFilesToDataUrls([first, second], { maxBytesPerImage: 10, maxTotalBytes: 15 }), /per-request input limit/);
    const independentJobs = await Promise.all([
      imageFilesToDataUrls([first], { maxBytesPerImage: 10, maxTotalBytes: 8 }),
      imageFilesToDataUrls([second], { maxBytesPerImage: 10, maxTotalBytes: 8 })
    ]);
    assert.deepEqual(independentJobs.map((images) => images.length), [1, 1]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
