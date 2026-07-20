import type { AdapterId, OfferingConfig, ProviderDraft } from "./types";

export type AibuffProviderPresetId = "aibuff-default";

export interface AibuffModelPreset extends OfferingConfig {
  catalogId: string;
}

export interface AibuffProviderPreset {
  id: AibuffProviderPresetId;
  label: string;
  displayName: string;
  tierName: string;
  baseUrl: string;
  adapterId: Exclude<AdapterId, "agent-generation">;
  concurrency: number;
  models: AibuffModelPreset[];
}

const observedAt = "2026-07-20";
const gptImageSizes = ["auto", "1024x1024", "1536x1024", "1024x1536"];

export const AIBUFF_PROVIDER_PRESETS: AibuffProviderPreset[] = [
  {
    id: "aibuff-default",
    label: "AIBuff · gpt-image-2",
    displayName: "AIBuff",
    tierName: "gpt-image-2",
    baseUrl: "https://aibuff.cc",
    adapterId: "openai-images",
    concurrency: 3,
    models: [
      model("gpt-image-2", "gpt-image-2", "gpt-image-2", "GPT-Image 2", 0.5, gptImageSizes),
    ],
  },
];

export function aibuffProviderPresetById(id: string): AibuffProviderPreset | undefined {
  return AIBUFF_PROVIDER_PRESETS.find((preset) => preset.id === id);
}

export function aibuffProviderPresetForDraft(draft: ProviderDraft): AibuffProviderPreset | undefined {
  const baseUrl = normalizeBaseUrl(draft.baseUrl);
  return AIBUFF_PROVIDER_PRESETS.find((preset) => (
    draft.displayName.trim() === preset.displayName
    && draft.tierName.trim().toLocaleLowerCase() === preset.tierName.toLocaleLowerCase()
    && baseUrl === normalizeBaseUrl(preset.baseUrl)
    && draft.adapterId === preset.adapterId
  ));
}

export function createAibuffProviderDraft(id: AibuffProviderPresetId): ProviderDraft {
  const preset = aibuffProviderPresetById(id);
  if (!preset) throw new Error(`Unknown AIBuff Provider preset: ${id}`);
  return {
    displayName: preset.displayName,
    tierName: preset.tierName,
    baseUrl: preset.baseUrl,
    adapterId: preset.adapterId,
    concurrency: preset.concurrency,
    apiKey: "",
    hasApiKey: false,
    offerings: preset.models.map(offeringFromAibuffModel),
  };
}

export function createCustomProviderDraft(): ProviderDraft {
  return {
    displayName: "",
    tierName: "",
    baseUrl: "",
    adapterId: "openai-images",
    concurrency: 3,
    apiKey: "",
    hasApiKey: false,
    offerings: [blankOffering()],
  };
}

export function offeringFromAibuffModel(modelPreset: AibuffModelPreset): OfferingConfig {
  return {
    id: "",
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
  return { id: "", canonicalModelId: "", providerModelId: "", displayName: "", price: { mode: "unknown", currency: "USD" }, supportsTextToImage: true, supportsImageToImage: true, sizes: [], qualities: [] };
}

function model(
  catalogId: string,
  canonicalModelId: string,
  providerModelId: string,
  displayName: string,
  amount: number,
  sizes: string[] = [],
): AibuffModelPreset {
  return {
    catalogId,
    id: "",
    canonicalModelId,
    providerModelId,
    displayName,
    price: {
      mode: "per_request",
      currency: "USD",
      amount,
      observedAt,
      note: "AIBuff 控制台 gpt-image-2 当前显示模型价格；实际费用以 AIBuff 为准",
    },
    supportsTextToImage: true,
    supportsImageToImage: true,
    sizes: [...sizes],
    qualities: ["auto", "low", "medium", "high"],
  };
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "").toLocaleLowerCase();
}
