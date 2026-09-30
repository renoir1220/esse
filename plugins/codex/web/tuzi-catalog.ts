import type { AdapterId, OfferingConfig, ProviderDraft } from "./types";

export type TuziProviderPresetId = "tuzi-default" | "tuzi-microsoft" | "tuzi-codex";

export interface TuziModelPreset extends OfferingConfig {
  catalogId: string;
}

export interface TuziProviderPreset {
  id: TuziProviderPresetId;
  label: string;
  displayName: string;
  tierName: string;
  baseUrl: string;
  adapterId: Exclude<AdapterId, "agent-generation">;
  concurrency: number;
  models: TuziModelPreset[];
}

const observedAt = "2026-07-19";
const gptImageSizes = ["auto", "1024x1024", "1536x1024", "1024x1536", "2048x2048", "2048x1152", "3840x2160", "2160x3840"];

const videoRatioSizes = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
const syncRatioSizes = videoRatioSizes.map((size) => size.replace(":", "x"));

export const TUZI_PROVIDER_PRESETS: TuziProviderPreset[] = [
  {
    id: "tuzi-default",
    label: "兔子 · default",
    displayName: "兔子",
    tierName: "default",
    baseUrl: "https://api.tu-zi.com",
    adapterId: "tuzi-json-images",
    concurrency: 3,
    models: [
      model("gemini-3.1-flash-image-preview", "gemini-3.1-flash-image-preview", "gemini-3.1-flash-image-preview", "gemini-3.1-flash-image-preview", undefined, "default", syncRatioSizes, ["1k", "2k", "4k"]),
      model("gemini-3-pro-image-preview", "gemini-3-pro-image-preview", "gemini-3-pro-image-preview", "gemini-3-pro-image-preview", undefined, "default", syncRatioSizes),
      model("gemini-3-pro-image-preview-2k", "gemini-3-pro-image-preview-2k", "gemini-3-pro-image-preview-2k", "gemini-3-pro-image-preview-2k", undefined, "default", syncRatioSizes),
      model("gemini-3-pro-image-preview-4k", "gemini-3-pro-image-preview-4k", "gemini-3-pro-image-preview-4k", "gemini-3-pro-image-preview-4k", undefined, "default", syncRatioSizes),
      model("gemini-3-pro-image-preview-async", "gemini-3-pro-image-preview-async", "gemini-3-pro-image-preview-async", "gemini-3-pro-image-preview-async", undefined, "default", videoRatioSizes),
      model("gemini-3-pro-image-preview-2k-async", "gemini-3-pro-image-preview-2k-async", "gemini-3-pro-image-preview-2k-async", "gemini-3-pro-image-preview-2k-async", undefined, "default", videoRatioSizes),
      model("gemini-3-pro-image-preview-4k-async", "gemini-3-pro-image-preview-4k-async", "gemini-3-pro-image-preview-4k-async", "gemini-3-pro-image-preview-4k-async", undefined, "default", videoRatioSizes),
      model("gpt-image-2", "gpt-image-2", "gpt-image-2", "GPT-Image 2", 0.035, "default", gptImageSizes),
      model("nano-banana-2-1k", "nano-banana-2", "nano-banana-2", "Nano Banana 2 · 1K", 0.1778, "default"),
      model("nano-banana-2-2k", "nano-banana-2", "nano-banana-2-2k", "Nano Banana 2 · 2K", 0.286, "default"),
      model("nano-banana-2-4k", "nano-banana-2", "nano-banana-2-4k", "Nano Banana 2 · 4K", 0.325, "default"),
      model("seedream-4-5", "seedream-4.5", "doubao-seedream-4-5-251128", "Seedream 4.5", 0.1204, "default"),
    ],
  },
  {
    id: "tuzi-microsoft",
    label: "兔子 · 微软",
    displayName: "兔子",
    tierName: "微软",
    baseUrl: "https://api.tu-zi.com",
    adapterId: "tuzi-json-images",
    concurrency: 3,
    models: [model("gpt-image-2", "gpt-image-2", "gpt-image-2", "GPT-Image 2", 0.07, "微软", gptImageSizes)],
  },
  {
    id: "tuzi-codex",
    label: "兔子 · Codex",
    displayName: "兔子",
    tierName: "Codex",
    baseUrl: "https://api.tu-zi.com",
    adapterId: "openai-images",
    concurrency: 3,
    models: [model("gpt-image-2", "gpt-image-2", "gpt-image-2", "GPT-Image 2", 0.09996, "Codex", gptImageSizes)],
  },
];

export function tuziProviderPresetById(id: string): TuziProviderPreset | undefined {
  return TUZI_PROVIDER_PRESETS.find((preset) => preset.id === id);
}

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
  const preset = tuziProviderPresetById(id);
  if (!preset) throw new Error(`Unknown Tuzi Provider preset: ${id}`);
  const defaultModels = preset.id === "tuzi-default" ? ["gpt-image-2", "nano-banana-2-1k", "nano-banana-2-2k"].map((id) => preset.models.find((entry) => entry.catalogId === id)!) : preset.models.slice(0, 1);
  return {
    displayName: preset.displayName,
    tierName: preset.tierName,
    baseUrl: preset.baseUrl,
    adapterId: preset.adapterId,
    concurrency: preset.concurrency,
    apiKey: "",
    hasApiKey: false,
    offerings: defaultModels.map(offeringFromTuziModel),
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

export function offeringFromTuziModel(modelPreset: TuziModelPreset): OfferingConfig {
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
  return { id: "", canonicalModelId: "", providerModelId: "", displayName: "", price: { mode: "unknown", currency: "CNY" }, supportsTextToImage: true, supportsImageToImage: true, sizes: [], qualities: [] };
}

function model(
  catalogId: string,
  canonicalModelId: string,
  providerModelId: string,
  displayName: string,
  amount: number | undefined,
  tierName: string,
  sizes: string[] = [],
  qualities: string[] = [],
): TuziModelPreset {
  return {
    catalogId,
    id: "",
    canonicalModelId,
    providerModelId,
    displayName,
    price: amount === undefined ? { mode: "unknown", currency: "CNY" } : {
      mode: "per_request",
      currency: "CNY",
      amount,
      observedAt,
      note: `兔子模型广场固定目录价，${tierName} 分组`,
    },
    supportsTextToImage: true,
    supportsImageToImage: true,
    sizes: sizes.length ? [...sizes] : providerModelId.startsWith("nano-banana-2") ? [...syncRatioSizes] : [],
    qualities: [...qualities],
  };
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "").toLocaleLowerCase();
}
