import type { OfferingConfig, ProviderDraft } from './types';

const ratios = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
const wideRatios = [...ratios, '1:4', '4:1', '1:8', '8:1'];

export const GEMINI_PROVIDER_PRESET = {
  id: 'google-gemini',
  label: 'Google Gemini · 官方',
  displayName: 'Google Gemini',
  tierName: '官方',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  adapterId: 'gemini-native-images' as const,
  concurrency: 1,
  models: [
    model('gemini-nano-banana-2.1', 'Nano Banana 2.1', wideRatios, ['1K', '2K', '4K']),
    model('gemini-3.1-flash-image', 'Nano Banana 2', wideRatios, ['512', '1K', '2K', '4K']),
    model('gemini-3-pro-image', 'Nano Banana Pro', ratios, ['1K', '2K', '4K']),
    model('gemini-2.5-flash-image', 'Nano Banana', ratios, []),
  ],
};

export function createGeminiProviderDraft(): ProviderDraft {
  const preset = GEMINI_PROVIDER_PRESET;
  const defaultModel = preset.models[0];
  if (!defaultModel) throw new Error('Google Gemini 预设缺少默认模型。');
  return { displayName: preset.displayName, tierName: preset.tierName, baseUrl: preset.baseUrl, adapterId: preset.adapterId, concurrency: preset.concurrency, apiKey: '', hasApiKey: false, offerings: [structuredClone(defaultModel)] };
}

export function geminiProviderPresetForDraft(draft: ProviderDraft): typeof GEMINI_PROVIDER_PRESET | undefined {
  return draft.adapterId === GEMINI_PROVIDER_PRESET.adapterId && draft.baseUrl.trim().replace(/\/+$/, '') === GEMINI_PROVIDER_PRESET.baseUrl && draft.displayName.trim() === GEMINI_PROVIDER_PRESET.displayName && draft.tierName.trim() === GEMINI_PROVIDER_PRESET.tierName ? GEMINI_PROVIDER_PRESET : undefined;
}

function model(id: string, displayName: string, sizes: string[], qualities: string[]): OfferingConfig & { catalogId: string } {
  return { id: '', catalogId: id, canonicalModelId: id, providerModelId: id, displayName, price: { mode: 'unknown', currency: 'USD' }, supportsTextToImage: true, supportsImageToImage: true, sizes: [...sizes], qualities: [...qualities] };
}
