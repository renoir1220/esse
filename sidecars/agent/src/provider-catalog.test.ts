import { describe, expect, it } from 'vitest';
import { createTuziProviderDraft, TUZI_PROVIDER_PRESETS } from './provider-catalog';

describe('Tuzi Provider catalog', () => {
  it('keeps the Plugin-compatible credential groups and model presets independent', () => {
    expect(TUZI_PROVIDER_PRESETS.map((preset) => preset.id)).toEqual(['tuzi-default', 'tuzi-microsoft', 'tuzi-codex']);
    expect(TUZI_PROVIDER_PRESETS[0].models.map((model) => [model.catalogId, model.canonicalModelId, model.providerModelId, model.displayName])).toEqual([
      ['gpt-image-2', 'gpt-image-2', 'gpt-image-2', 'GPT-Image 2'],
      ['gpt-image-2-image', 'image2-v', 'gpt-image-2', 'image2-v'],
      ['gemini-3-pro-image-preview-4k', 'gemini-3-pro-image-preview-4k', 'gemini-3-pro-image-preview-4k', 'gemini-3-pro-image-preview-4k'],
      ['nano-banana-2-1k', 'nano-banana-2', 'nano-banana-2', 'Nano Banana 2 · 1K'],
      ['nano-banana-2-2k', 'nano-banana-2', 'nano-banana-2-2k', 'Nano Banana 2 · 2K'],
      ['nano-banana-2-4k', 'nano-banana-2', 'nano-banana-2-4k', 'Nano Banana 2 · 4K'],
      ['seedream-4-5', 'seedream-4.5', 'doubao-seedream-4-5-251128', 'Seedream 4.5'],
    ]);
    expect(TUZI_PROVIDER_PRESETS.flatMap((preset) => preset.models).every((model) => model.price.mode === 'unknown' && model.price.amount === undefined)).toBe(true);
    const draft = createTuziProviderDraft('tuzi-default');
    expect(draft.offerings).toHaveLength(7);
    draft.offerings[0].displayName = 'changed';
    expect(TUZI_PROVIDER_PRESETS[0].models[0].displayName).toBe('GPT-Image 2');
    expect(draft.apiKey).toBe('');
  });
});
