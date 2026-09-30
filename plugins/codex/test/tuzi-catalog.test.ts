import assert from "node:assert/strict";
import test from "node:test";
import {
  createCustomProviderDraft,
  createTuziProviderDraft,
  offeringFromTuziModel,
  TUZI_PROVIDER_PRESETS,
  tuziProviderPresetForDraft,
} from "../web/tuzi-catalog";

test("Tuzi presets keep each credential group and model catalog independent", () => {
  assert.deepEqual(TUZI_PROVIDER_PRESETS.map((preset) => preset.label), ["兔子 · default", "兔子 · 微软", "兔子 · Codex"]);
  assert.equal(TUZI_PROVIDER_PRESETS[0]?.models.length, 12);
  assert.equal(TUZI_PROVIDER_PRESETS[1]?.models[0]?.price.amount, 0.07);
  assert.equal(TUZI_PROVIDER_PRESETS[2]?.adapterId, "openai-images");

  const draft = createTuziProviderDraft("tuzi-default");
  assert.equal(draft.tierName, "default");
  assert.deepEqual(draft.offerings.map((offering) => offering.providerModelId), ["gpt-image-2", "nano-banana-2", "nano-banana-2-2k"]);
  assert.equal(tuziProviderPresetForDraft(draft)?.id, "tuzi-default");

  const groupedDraft = createTuziProviderDraft("tuzi-microsoft");
  assert.deepEqual(groupedDraft.offerings.map((offering) => offering.providerModelId), ["gpt-image-2"]);
});

test("catalog offerings are cloned before entering editable Provider state", () => {
  const presetModel = TUZI_PROVIDER_PRESETS[0]!.models.find((model) => model.catalogId === "nano-banana-2-1k")!;
  const first = offeringFromTuziModel(presetModel);
  const second = offeringFromTuziModel(presetModel);
  first.price.amount = 999;
  first.sizes.push("changed");
  assert.equal(first.id, "");
  assert.equal(second.price.amount, 0.1778);
  assert(second.sizes.includes("9x16"));
  assert(!second.sizes.includes("changed"));
});

test("custom Provider keeps the original manual configuration path", () => {
  const draft = createCustomProviderDraft();
  assert.equal(draft.displayName, "");
  assert.equal(draft.adapterId, "openai-images");
  assert.equal(draft.offerings.length, 1);
  assert.equal(draft.offerings[0]?.providerModelId, "");
  assert.equal(tuziProviderPresetForDraft(draft), undefined);
});

test("documented Flash and Pro async presets use distinct resolution and size contracts", () => {
  const models = TUZI_PROVIDER_PRESETS[0]!.models;
  const flash = models.find((entry) => entry.providerModelId === "gemini-3.1-flash-image-preview")!;
  assert(flash.sizes.includes("9x16"));
  assert.deepEqual(flash.qualities, ["1k", "2k", "4k"]);
  assert.equal(flash.price.mode, "unknown");
  for (const id of ["gemini-3-pro-image-preview-async", "gemini-3-pro-image-preview-2k-async", "gemini-3-pro-image-preview-4k-async"]) {
    const model = models.find((entry) => entry.providerModelId === id)!;
    assert(model.sizes.includes("9:16"));
    assert.deepEqual(model.qualities, []);
    assert.equal(model.price.mode, "unknown");
  }
});
