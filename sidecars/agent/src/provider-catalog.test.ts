import { describe, expect, it } from 'vitest';
import { createTuziProviderDraft, TUZI_PROVIDER_PRESETS } from './provider-catalog';

describe('Tuzi Provider catalog', () => {
  it('advertises documented Flash resolutions and Pro async ratio sizes without guessed prices', () => {
    const models = TUZI_PROVIDER_PRESETS[0].models;
    const flash = models.find((entry) => entry.providerModelId === 'gemini-3.1-flash-image-preview')!;
    expect(flash.sizes).toContain('9x16');
    expect(flash.qualities).toEqual(['1k', '2k', '4k']);
    for (const id of ['gemini-3-pro-image-preview-async', 'gemini-3-pro-image-preview-2k-async', 'gemini-3-pro-image-preview-4k-async']) {
      const model = models.find((entry) => entry.providerModelId === id)!;
      expect(model.sizes).toContain('9:16');
      expect(model.qualities).toEqual([]);
      expect(model.price.mode).toBe('unknown');
    }
  });
  it('keeps the Plugin-compatible credential groups and model presets independent', () => {
    expect(TUZI_PROVIDER_PRESETS.map((preset) => preset.id)).toEqual(['tuzi-default', 'tuzi-microsoft', 'tuzi-codex']);
    expect(TUZI_PROVIDER_PRESETS[0].models.slice(6).map((model) => [model.catalogId, model.canonicalModelId, model.providerModelId, model.displayName])).toEqual([
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
    expect(draft.offerings).toHaveLength(13);
    draft.offerings[0].displayName = 'changed';
    expect(TUZI_PROVIDER_PRESETS[0].models[0].displayName).toBe('gemini-3.1-flash-image-preview');
    expect(draft.apiKey).toBe('');
  });
});
