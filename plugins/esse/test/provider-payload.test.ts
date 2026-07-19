import assert from "node:assert/strict";
import test from "node:test";
import { providerSavePayload } from "../web/provider-payload.js";
import { compactToolArgs } from "../web/tool-args.js";
import type { ProviderDraft } from "../web/types.js";

test("provider save payload contains only schema-valid defined fields", () => {
  const draft: ProviderDraft = {
    displayName: " 兔子 ",
    tierName: " default ",
    baseUrl: "https://api.tu-zi.com ",
    adapterId: "tuzi-json-images",
    concurrency: 3,
    apiKey: "",
    hasApiKey: true,
    offerings: [{
      id: "",
      canonicalModelId: "gpt-image-2",
      providerModelId: "gpt-image-2",
      displayName: "GPT-Image 2",
      price: { mode: "per_request", amount: 0.035, currency: "CNY", observedAt: "2026-07-18", note: undefined },
      supportsTextToImage: true,
      supportsImageToImage: true,
      sizes: ["auto"],
      qualities: ["high"],
    }],
  };
  const payload = providerSavePayload(draft);
  assert.equal(payload.displayName, "兔子");
  assert(!("apiKey" in payload));
  const offering = (payload.offerings as Array<Record<string, unknown>>)[0];
  assert(offering);
  assert(!("id" in offering));
  assert.deepEqual(offering.price, { mode: "per_request", currency: "CNY", amount: 0.035 });
  assert.deepEqual(compactToolArgs({ keep: true, omit: undefined, nested: { bad: Number.NaN, good: "ok" } }), { keep: true, nested: { good: "ok" } });
});
