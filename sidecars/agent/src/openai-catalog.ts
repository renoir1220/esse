import type { OfferingConfig, ProviderDraft } from './types';

const baseUrl = 'https://api.openai.com';
const sizes = ['auto', '1024x1024', '1536x1024', '1024x1536'];
const qualities = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'];

export const OPENAI_PROVIDER_PRESET = {
  id: 'openai-official',
  label: 'OpenAI · 官方',
  displayName: 'OpenAI',
  tierName: '官方',
  baseUrl,
  adapterId: 'openai-images' as const,
  concurrency: 1,
  models: [
    model('gpt-image-2.6-flare', 'GPT Image 2.6 Flare'),
    model('gpt-image-2.6-sunburst', 'GPT Image 2.6 Sunburst'),
  ],
};

export const OPENAI_PROVIDER_HINT = '填写已绑定 API 组织的 OpenAI 项目 API Key。该组织内有效的赠送 API 额度可抵扣生图和改图用量。';

export function createOpenAiProviderDraft(): ProviderDraft {
  const { displayName, tierName, adapterId, concurrency, models } = OPENAI_PROVIDER_PRESET;
  return { displayName, tierName, baseUrl, adapterId, concurrency, apiKey: '', hasApiKey: false, offerings: structuredClone(models) };
}

export function openAiProviderPresetForDraft(draft: ProviderDraft): typeof OPENAI_PROVIDER_PRESET | undefined {
  const { displayName, tierName, adapterId } = OPENAI_PROVIDER_PRESET;
  const root = draft.baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/i, '').toLowerCase();
  return draft.adapterId === adapterId && root === baseUrl && draft.displayName.trim() === displayName && draft.tierName.trim() === tierName
    ? OPENAI_PROVIDER_PRESET : undefined;
}

function model(id: string, displayName: string): OfferingConfig & { catalogId: string } {
  return {
    id: '',
    catalogId: id,
    canonicalModelId: id,
    providerModelId: id,
    displayName,
    price: { mode: 'unknown', currency: 'USD' },
    supportsTextToImage: true,
    supportsImageToImage: true,
    sizes: [...sizes],
    qualities: [...qualities],
  };
}
