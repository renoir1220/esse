import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { saveGeneratedImage } from "../src/files/output-files.js";

const onePixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=";

test("generated output trusts image signatures instead of MIME or generic RIFF/ftyp containers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "esse-output-signature-"));
  try {
    const fakeMp4 = Buffer.alloc(32);
    fakeMp4.writeUInt32BE(24, 0);
    fakeMp4.write("ftypisom", 4, "ascii");
    await assert.rejects(saveGeneratedImage({
      result: { b64Json: fakeMp4.toString("base64"), mimeType: "image/png" },
      outputDirectory: root,
      sourceName: "video.png"
    }), /not a recognized image/);

    const fakeRiff = Buffer.from("RIFF\u0018\0\0\0AVI LIST", "binary");
    await assert.rejects(saveGeneratedImage({
      result: { b64Json: fakeRiff.toString("base64"), mimeType: "image/webp" },
      outputDirectory: root,
      sourceName: "video.webp"
    }), /not a recognized image/);

    const output = await saveGeneratedImage({
      result: { b64Json: onePixelPng, mimeType: "video/mp4" },
      outputDirectory: root,
      sourceName: "actual-image.mp4"
    });
    assert.equal(path.extname(output), ".png");
    assert.deepEqual(await readFile(output), Buffer.from(onePixelPng, "base64"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generated downloads enforce pre-decode and streaming limits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "esse-output-limit-"));
  try {
    await assert.rejects(saveGeneratedImage({
      result: { b64Json: Buffer.alloc(13).toString("base64") },
      outputDirectory: root,
      sourceName: "too-large.png",
      maxBytes: 12
    }), /exceeds the 60 MB image limit/);

    await assert.rejects(saveGeneratedImage({
      result: { outputUrl: "https://images.example/result.png" },
      outputDirectory: root,
      sourceName: "too-large.png",
      maxBytes: 12,
      trustedBaseUrl: "https://images.example/v1",
      fetchImpl: async () => new Response(Buffer.from(onePixelPng, "base64"), { status: 200 })
    }), /exceeds the 60 MB download limit/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generated image URLs reject local addresses unless they match the configured Provider", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "esse-output-url-"));
  try {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response(Buffer.from(onePixelPng, "base64"), { status: 200 });
    };
    await assert.rejects(saveGeneratedImage({
      result: { outputUrl: "http://127.0.0.1/private.png" },
      outputDirectory: root,
      sourceName: "private.png",
      fetchImpl
    }), /local or private network/);
    assert.equal(calls, 0);

    const output = await saveGeneratedImage({
      result: { outputUrl: "http://127.0.0.1/generated.png" },
      outputDirectory: root,
      sourceName: "trusted.png",
      trustedBaseUrl: "http://127.0.0.1/v1",
      fetchImpl
    });
    assert.equal(calls, 1);
    assert.equal(path.extname(output), ".png");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
