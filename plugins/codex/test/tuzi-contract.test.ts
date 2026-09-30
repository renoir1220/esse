import assert from "node:assert/strict";
import test from "node:test";
import { TuziJsonImagesAdapter } from "../src/providers/tuzi-json-images.js";
import type { ProviderTaskState } from "../src/types.js";

// Contracts from Tuzi's current images/videos docs; no network requests.
const reference = "data:image/png;base64,aW1hZ2U=";
test("saved Flash resolution suffix normalizes to the documented base model and quality", async () => {
  const adapter = new TuziJsonImagesAdapter({ baseUrl: "https://provider.example", apiKey: "dummy-key", fetchImpl: async (url, init) => {
    assert.equal(String(url), "https://provider.example/v1/images/generations");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "gemini-3.1-flash-image-preview");
    assert.equal(body.quality, "4k");
    return Response.json({ data: [{ url: "https://cdn.example/image.png" }] });
  } });
  await adapter.generate({ model: "gemini-3.1-flash-image-preview-4k", prompt: "legacy config", images: [], responseFormat: "url" });
});
for (const model of ["gemini-3.1-flash-image-preview", "gemini-3-pro-image-preview", "gemini-3-pro-image-preview-2k", "gemini-3-pro-image-preview-4k", "nano-banana-2", "nano-banana-2-2k", "nano-banana-2-4k"]) {
  for (const count of [0, 1, 2]) test(`${model}: synchronous JSON with ${count} references`, async () => {
    let submissions = 0;
    const images = [reference, "https://cdn.example/reference.png"].slice(0, count);
    const updates: ProviderTaskState[] = [];
    const adapter = new TuziJsonImagesAdapter({ baseUrl: "https://provider.example/v1/", apiKey: "dummy-key", fetchImpl: async (url, init) => {
      submissions += 1;
      assert.equal(String(url), "https://provider.example/v1/images/generations");
      assert.equal(new Headers(init?.headers).get("content-type"), "application/json");
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body, { model, prompt: "contract", n: 1, size: "9x16", quality: "2k", response_format: "url", ...(count ? { image: count === 1 ? images[0] : images } : {}) });
      return new Response(JSON.stringify({ data: [{ url: "https://cdn.example/output.png" }] }), { headers: { "x-request-id": "sync-request" } });
    } });
    const result = await adapter.generate({ model, prompt: "contract", size: "9:16", quality: "2K", images, responseFormat: "b64_json", onProviderTask: (task) => { updates.push(task); } });
    assert.equal(result.outputUrl, "https://cdn.example/output.png");
    assert.equal(result.providerRequestId, "sync-request");
    assert.equal(submissions, 1);
    assert.deepEqual(updates, []);
  });
}

for (const model of ["gemini-3-pro-image-preview-async", "gemini-3-pro-image-preview-2k-async", "gemini-3-pro-image-preview-4k-async", "gpt-image-2"]) test(`${model}: multipart video image task`, async () => {
  const urls: string[] = [];
  const adapter = new TuziJsonImagesAdapter({ baseUrl: "https://provider.example/v1", apiKey: "dummy-key", fetchImpl: async (url, init) => {
    urls.push(String(url));
    if (init?.method === "POST") {
      assert.equal(String(url), "https://provider.example/v1/videos");
      assert.equal(new Headers(init.headers).has("content-type"), false);
      assert(init.body instanceof FormData);
      assert.equal(init.body.get("model"), model);
      assert.equal(init.body.get("size"), model === "gpt-image-2" ? "1024x1536" : "9:16");
      assert.equal(init.body.has("image"), false);
      assert.equal(init.body.has("response_format"), false);
      if (model !== "gpt-image-2") assert.equal(init.body.has("quality"), false);
      const references = init.body.getAll("input_reference");
      assert.equal(references.length, 2);
      assert.equal(await (references[0] as Blob).text(), "image");
      assert.equal(references[1], "https://cdn.example/reference.png");
      return Response.json({ id: "accepted", status: "submitted" });
    }
    return Response.json({ status: "completed", video_url: "https://cdn.example/image.png" });
  } });
  const result = await adapter.generate({ model, prompt: "contract", size: model === "gpt-image-2" ? "1024x1536" : "9x16", quality: "4K", images: [reference, "https://cdn.example/reference.png"], responseFormat: "b64_json" });
  assert.equal(result.outputUrl, "https://cdn.example/image.png");
  assert.deepEqual(urls, ["https://provider.example/v1/videos", "https://provider.example/v1/videos/accepted"]);
});

for (const protocol of ["tuzi-video", "tuzi-images"] as const) test(`persisted ${protocol} wins over today's model routing`, async () => {
  const urls: string[] = [];
  const now = new Date().toISOString();
  const adapter = new TuziJsonImagesAdapter({ baseUrl: "https://provider.example/v1/", apiKey: "dummy-key", fetchImpl: async (url, init) => {
    urls.push(String(url)); assert.notEqual(init?.method, "POST");
    return Response.json(protocol === "tuzi-video" ? { status: "completed", video_url: "https://cdn.example/image.png" } : { status: "completed", result: JSON.stringify({ data: [{ url: "https://cdn.example/image.png" }] }) });
  } });
  await adapter.generate({ model: "gemini-3.1-flash-image-preview", prompt: "resume", images: [], responseFormat: "url", providerTask: { id: "old/id", protocol, status: "in_progress", submittedAt: now, updatedAt: now } });
  assert.deepEqual(urls, [protocol === "tuzi-video" ? "https://provider.example/v1/videos/old%2Fid" : "https://provider.example/get-async?id=old%2Fid"]);
});

test("processing maps to in_progress without resubmission", async () => {
  const updates: ProviderTaskState[] = [];
  const now = new Date().toISOString();
  let queries = 0;
  const adapter = new TuziJsonImagesAdapter({ baseUrl: "https://provider.example", apiKey: "dummy-key", fetchImpl: async (_url, init) => {
    assert.notEqual(init?.method, "POST");
    return Response.json(++queries === 1 ? { status: "processing", progress: "25" } : { status: "completed", video_url: "https://cdn.example/image.png" });
  } });
  await adapter.generate({ model: "gpt-image-2", prompt: "resume", images: [], responseFormat: "url", providerTask: { id: "accepted", protocol: "tuzi-video", status: "in_progress", submittedAt: now, updatedAt: now }, onProviderTask: (task) => { updates.push(task); } });
  assert.equal(queries, 2);
  assert.equal(updates[0]?.status, "in_progress");
  assert.equal(updates[0]?.progress, 25);
});

for (const status of ["failed", "expired", "unexpected"]) test(`${status} remains charge-unknown and never resubmits`, async () => {
  let queries = 0;
  const now = new Date().toISOString();
  const adapter = new TuziJsonImagesAdapter({ baseUrl: "https://provider.example", apiKey: "dummy-key", fetchImpl: async (_url, init) => { queries += 1; assert.notEqual(init?.method, "POST"); return Response.json({ status }); } });
  await assert.rejects(adapter.generate({ model: "gpt-image-2", prompt: "resume", images: [], responseFormat: "url", providerTask: { id: "accepted", protocol: "tuzi-video", status: "in_progress", submittedAt: now, updatedAt: now } }), (error: unknown) => (error as { details?: { chargeState?: string } }).details?.chargeState === "unknown");
  assert.equal(queries, 1);
});
