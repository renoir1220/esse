import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { describeLocalMediaStartupError, LocalMediaServer } from "../src/files/local-media-server.js";

const onePixelPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=", "base64");

test("local media server exposes only registered files without retaining deleted images", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "esse-media-"));
  const filePath = path.join(root, "原图.png");
  const server = await LocalMediaServer.start();
  try {
    await writeFile(filePath, onePixelPng);
    const mediaUrl = await server.urlFor(filePath);
    assert(mediaUrl.startsWith(`${server.origin}/media/`));
    assert(!mediaUrl.includes(encodeURIComponent(root)));

    const full = await fetch(mediaUrl);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("content-type"), "image/png");
    assert.equal(full.headers.get("cross-origin-resource-policy"), "cross-origin");
    assert.equal(full.headers.get("cache-control"), "private, no-store");
    assert.equal(full.headers.get("pragma"), "no-cache");
    assert.equal(full.headers.get("etag"), null);
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), onePixelPng);

    const range = await fetch(mediaUrl, { headers: { Range: "bytes=0-7" } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get("content-range"), `bytes 0-7/${onePixelPng.length}`);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), onePixelPng.subarray(0, 8));

    const preflight = await fetch(mediaUrl, { method: "OPTIONS", headers: { "Access-Control-Request-Private-Network": "true" } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-private-network"), "true");

    const unknown = new URL(mediaUrl);
    unknown.pathname = unknown.pathname.replace(/\/media\/[^/]+\//, "/media/not-the-secret/");
    assert.equal((await fetch(unknown)).status, 404);

    await rm(filePath);
    const deleted = await fetch(mediaUrl);
    assert.equal(deleted.status, 410);
    assert.equal(deleted.headers.get("cache-control"), "private, no-store");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("local media startup errors are actionable and do not promise a fallback", () => {
  const source = Object.assign(new Error("permission denied"), { code: "EACCES" });
  const described = describeLocalMediaStartupError(source, "darwin");
  assert.match(described.message, /已停止启动/);
  assert.match(described.message, /不会回退/);
  assert.match(described.message, /localhost/);
  assert.match(described.message, /darwin/);
  assert.match(described.message, /EACCES/);
});
