import type { AdapterId, OfferingConfig, ProviderDraft } from './types';

export type TuziProviderPresetId = 'tuzi-default' | 'tuzi-microsoft' | 'tuzi-codex';

export interface TuziModelPreset extends OfferingConfig {
  catalogId: string;
}

export interface TuziProviderPreset {
  id: TuziProviderPresetId;
  label: string;
  displayName: string;
  tierName: string;
  baseUrl: string;
  adapterId: Exclude<AdapterId, 'agent-generation'>;
  concurrency: number;
  models: TuziModelPreset[];
}

const gptImageSizes = ['auto', '1024x1024', '1536x1024', '1024x1536', '2048x2048', '2048x1152', '3840x2160', '2160x3840'];

export const TUZI_PROVIDER_PRESETS: TuziProviderPreset[] = [
  {
    id: 'tuzi-default',
    label: '兔子 · default',
    displayName: '兔子',
    tierName: 'default',
    baseUrl: 'https://api.tu-zi.com',
    adapterId: 'tuzi-json-images',
    concurrency: 3,
    models: [
      model('gpt-image-2', 'gpt-image-2', 'gpt-image-2', 'GPT-Image 2', gptImageSizes),
      model('gpt-image-2-image', 'image2-v', 'gpt-image-2', 'image2-v', gptImageSizes),
      model('gemini-3-pro-image-preview-4k', 'gemini-3-pro-image-preview-4k', 'gemini-3-pro-image-preview-4k', 'gemini-3-pro-image-preview-4k'),
      model('nano-banana-2-1k', 'nano-banana-2', 'nano-banana-2', 'Nano Banana 2 · 1K'),
      model('nano-banana-2-2k', 'nano-banana-2', 'nano-banana-2-2k', 'Nano Banana 2 · 2K'),
      model('nano-banana-2-4k', 'nano-banana-2', 'nano-banana-2-4k', 'Nano Banana 2 · 4K'),
      model('seedream-4-5', 'seedream-4.5', 'doubao-seedream-4-5-251128', 'Seedream 4.5'),
    ],
  },
  {
    id: 'tuzi-microsoft',
    label: '兔子 · 微软',
    displayName: '兔子',
    tierName: '微软',
    baseUrl: 'https://api.tu-zi.com',
    adapterId: 'tuzi-json-images',
    concurrency: 3,
    models: [model('gpt-image-2', 'gpt-image-2', 'gpt-image-2', 'GPT-Image 2', gptImageSizes)],
  },
  {
    id: 'tuzi-codex',
    label: '兔子 · Codex',
    displayName: '兔子',
    tierName: 'Codex',
    baseUrl: 'https://api.tu-zi.com',
    adapterId: 'openai-images',
    concurrency: 3,
    models: [model('gpt-image-2', 'gpt-image-2', 'gpt-image-2', 'GPT-Image 2', gptImageSizes)],
  },
];

export function tuziProviderPresetForDraft(draft: ProviderDraft): TuziProviderPreset | undefined {
  const baseUrl = normalizeBaseUrl(draft.baseUrl);
  return TUZI_PROVIDER_PRESETS.find((preset) => (
    draft.displayName.trim() === preset.displayName
    && draft.tierName.trim().toLocaleLowerCase() === preset.tierName.toLocaleLowerCase()
    && baseUrl === normalizeBaseUrl(preset.baseUrl)
    && draft.adapterId === preset.adapterId
  ));
}

export function createTuziProviderDraft(id: TuziProviderPresetId): ProviderDraft {
  const preset = TUZI_PROVIDER_PRESETS.find((entry) => entry.id === id);
  if (!preset) throw new Error(`Unknown Tuzi Provider preset: ${id}`);
  const defaultModels = preset.id === 'tuzi-default' ? preset.models : preset.models.slice(0, 1);
  return {
    displayName: preset.displayName,
    tierName: preset.tierName,
    baseUrl: preset.baseUrl,
    adapterId: preset.adapterId,
    concurrency: preset.concurrency,
    apiKey: '',
    hasApiKey: false,
    offerings: defaultModels.map(offeringFromTuziModel),
  };
}

export function createCustomProviderDraft(): ProviderDraft {
  return {
    displayName: '',
    tierName: '',
    baseUrl: '',
    adapterId: 'openai-images',
    concurrency: 3,
    apiKey: '',
    hasApiKey: false,
    offerings: [blankOffering()],
  };
}

export function offeringFromTuziModel(modelPreset: TuziModelPreset): OfferingConfig {
  return {
    id: '',
    canonicalModelId: modelPreset.canonicalModelId,
    providerModelId: modelPreset.providerModelId,
    displayName: modelPreset.displayName,
    price: { ...modelPreset.price },
    supportsTextToImage: modelPreset.supportsTextToImage,
    supportsImageToImage: modelPreset.supportsImageToImage,
    sizes: [...modelPreset.sizes],
    qualities: [...modelPreset.qualities],
  };
}

export function blankOffering(): OfferingConfig {
  return { id: '', canonicalModelId: '', providerModelId: '', displayName: '', price: { mode: 'unknown', currency: 'CNY' }, supportsTextToImage: true, supportsImageToImage: true, sizes: [], qualities: [] };
}

function model(catalogId: string, canonicalModelId: string, providerModelId: string, displayName: string, sizes: string[] = []): TuziModelPreset {
  return {
    catalogId,
    id: '',
    canonicalModelId,
    providerModelId,
    displayName,
    price: { mode: 'unknown', currency: 'CNY' },
    supportsTextToImage: true,
    supportsImageToImage: true,
    sizes: [...sizes],
    qualities: [],
  };
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '').toLocaleLowerCase();
}
