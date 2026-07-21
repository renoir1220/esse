import { describe, expect, it } from 'vitest';
import { createTuziProviderDraft, TUZI_PROVIDER_PRESETS } from './provider-catalog';

describe('Tuzi Provider catalog', () => {
  it('keeps the Plugin-compatible credential groups and model presets independent', () => {
    expect(TUZI_PROVIDER_PRESETS.map((preset) => preset.id)).toEqual(['tuzi-default', 'tuzi-microsoft', 'tuzi-codex']);
    expect(TUZI_PROVIDER_PRESETS[0].models.map((model) => [model.catalogId, model.providerModelId, model.price.amount])).toEqual([
      ['gpt-image-2', 'gpt-image-2', 0.035],
      ['nano-banana-2-1k', 'nano-banana-2', 0.1778],
      ['nano-banana-2-2k', 'nano-banana-2-2k', 0.286],
      ['nano-banana-2-4k', 'nano-banana-2-4k', 0.325],
      ['seedream-4-5', 'doubao-seedream-4-5-251128', 0.1204],
    ]);
    const draft = createTuziProviderDraft('tuzi-default');
    draft.offerings[0].displayName = 'changed';
    expect(TUZI_PROVIDER_PRESETS[0].models[0].displayName).toBe('GPT-Image 2');
    expect(draft.apiKey).toBe('');
  });
});
