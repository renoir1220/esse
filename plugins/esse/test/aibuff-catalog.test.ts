import assert from "node:assert/strict";
import test from "node:test";
import {
  AIBUFF_PROVIDER_PRESETS,
  aibuffProviderPresetForDraft,
  createAibuffProviderDraft,
  createCustomProviderDraft,
  offeringFromAibuffModel,
} from "../web/aibuff-catalog";

test("AIBuff preset uses the verified OpenAI-compatible image contract", () => {
  assert.deepEqual(AIBUFF_PROVIDER_PRESETS.map((preset) => preset.label), ["AIBuff · gpt-image-2"]);
  assert.equal(AIBUFF_PROVIDER_PRESETS[0]?.baseUrl, "https://aibuff.cc");
  assert.equal(AIBUFF_PROVIDER_PRESETS[0]?.adapterId, "openai-images");
  assert.equal(AIBUFF_PROVIDER_PRESETS[0]?.models[0]?.price.amount, 0.5);

  const draft = createAibuffProviderDraft("aibuff-default");
  assert.equal(draft.tierName, "gpt-image-2");
  assert.deepEqual(draft.offerings.map((offering) => offering.providerModelId), ["gpt-image-2"]);
  assert.equal(aibuffProviderPresetForDraft(draft)?.id, "aibuff-default");
});

test("catalog offerings are cloned before entering editable Provider state", () => {
  const presetModel = AIBUFF_PROVIDER_PRESETS[0]!.models[0]!;
  const first = offeringFromAibuffModel(presetModel);
  const second = offeringFromAibuffModel(presetModel);
  first.price.amount = 999;
  first.sizes.push("changed");
  assert.equal(first.id, "");
  assert.equal(second.price.amount, 0.5);
  assert.deepEqual(second.sizes, ["auto", "1024x1024", "1536x1024", "1024x1536"]);
});

test("custom Provider keeps the manual OpenAI Images path", () => {
  const draft = createCustomProviderDraft();
  assert.equal(draft.displayName, "");
  assert.equal(draft.adapterId, "openai-images");
  assert.equal(draft.offerings.length, 1);
  assert.equal(draft.offerings[0]?.providerModelId, "");
  assert.equal(aibuffProviderPresetForDraft(draft), undefined);
});
