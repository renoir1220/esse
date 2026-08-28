import assert from "node:assert/strict";
import test from "node:test";
import { TuziJsonImagesAdapter } from "../src/providers/tuzi-json-images.js";
import type { ProviderTaskState } from "../src/types.js";

const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=";

test("Tuzi adapter submits one async image task and unwraps its completed result", async () => {
  const urls: string[] = [];
  const updates: ProviderTaskState[] = [];
  let queries = 0;
  const adapter = new TuziJsonImagesAdapter({
    baseUrl: "https://provider.example",
    apiKey: "local-key",
    fetchImpl: async (input, init) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/async/v1/images/edits")) {
        const form = init?.body as FormData;
        assert.equal(form.get("model"), "gpt-image-2");
        assert.equal(form.getAll("image").length, 1);
        return new Response(JSON.stringify({ id: "task-1", status: "submitted" }), { status: 202, headers: { "x-oneapi-request-id": "request-1" } });
      }
      queries += 1;
      if (queries === 1) return new Response(JSON.stringify({ error: { message: "system cpu overloaded" } }), { status: 503 });
      return new Response(JSON.stringify({ id: "task-1", status: "completed", result: { data: [{ b64_json: image }] } }), { status: 200 });
    }
  });

  const result = await adapter.generate({
    model: "gpt-image-2", prompt: "test", images: ["data:image/png;base64,reference"], responseFormat: "b64_json",
    onProviderTask: (task) => { updates.push(structuredClone(task)); }
  });

  assert.deepEqual(urls, [
    "https://provider.example/async/v1/images/edits",
    "https://provider.example/get-async?id=task-1",
    "https://provider.example/get-async?id=task-1"
  ]);
  assert.deepEqual(updates.map((task) => task.status), ["submitted", "completed"]);
  assert.equal(result.providerRequestId, "request-1");
  assert.equal(result.b64Json, image);
});

test("Tuzi adapter resumes a persisted task without submitting another generation", async () => {
  const urls: string[] = [];
  const now = new Date().toISOString();
  const adapter = new TuziJsonImagesAdapter({
    baseUrl: "https://provider.example",
    apiKey: "local-key",
    fetchImpl: async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ id: "task-resume", status: "completed", result: { data: [{ b64_json: image }] } }), { status: 200 });
    }
  });

  await adapter.generate({
    model: "gpt-image-2", prompt: "resume", images: [], responseFormat: "b64_json",
    providerTask: { id: "task-resume", status: "in_progress", progress: 10, submittedAt: now, startedAt: now, updatedAt: now }
  });

  assert.deepEqual(urls, ["https://provider.example/get-async?id=task-resume"]);
});
