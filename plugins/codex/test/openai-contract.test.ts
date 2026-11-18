import assert from "node:assert/strict";
import test from "node:test";
import { OpenAiImagesAdapter } from "../src/providers/openai-images.js";
import { createOpenAiProviderDraft, openAiProviderPresetForDraft } from "../web/openai-catalog.js";

test("Official OpenAI preset can be saved with its project key and both image models", () => {
  const draft = createOpenAiProviderDraft();
  assert.equal(draft.apiKey, "");
  assert.equal(draft.baseUrl, "https://api.openai.com");
  assert.equal(draft.adapterId, "openai-images");
  assert.equal(openAiProviderPresetForDraft({ ...draft, baseUrl: `${draft.baseUrl}/v1/` })?.id, "openai-official");
  assert.equal(openAiProviderPresetForDraft({ ...draft, baseUrl: "https://api.openai.com.example" }), undefined);
  assert.deepEqual(draft.offerings.map((offering) => offering.providerModelId), ["gpt-image-2.6-flare", "gpt-image-2.6-sunburst"]);
});

test("Official OpenAI omits legacy response formatting and sends the original reference bytes", async () => {
  const model = "gpt-image-2.6-flare";
  const refs = ["data:image/png;base64,Zmlyc3Q=", "data:image/png;base64,c2Vjb25k"];
  let calls = 0;
  const adapter = new OpenAiImagesAdapter({
    baseUrl: "https://api.openai.com/v1/",
    apiKey: "fixture-project-key",
    fetchImpl: async (url, init) => {
      calls += 1;
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-project-key");
      assert.equal(init?.redirect, "error");
      if (calls === 1) {
        assert.equal(url, "https://api.openai.com/v1/images/generations");
        assert.deepEqual(JSON.parse(String(init?.body)), { model, prompt: "test", n: 1, size: "1024x1024", quality: "low" });
      } else {
        assert.equal(url, "https://api.openai.com/v1/images/edits");
        assert(init?.body instanceof FormData);
        assert.equal(init.body.has("response_format"), false);
        assert.equal(init.body.get("quality"), "low");
        assert.deepEqual(await Promise.all(init.body.getAll("image[]").map((image) => (image as Blob).text())), ["first", "second"]);
      }
      return Response.json({ data: [{ b64_json: "aW1hZ2U=" }] }, { headers: { "x-request-id": "image-request" } });
    }
  });
  const request = { model, prompt: "test", size: "1024x1024", quality: "low", responseFormat: "b64_json" as const };
  for (const images of [[], refs]) {
    const result = await adapter.generate({ ...request, images });
    assert.equal(result.b64Json, "aW1hZ2U=");
    assert.equal(result.providerRequestId, "image-request");
  }
  await assert.rejects(adapter.generate({ ...request, images: Array<string>(17).fill(refs[0]!) }), /up to 16/);
  assert.equal(calls, 2);
});
