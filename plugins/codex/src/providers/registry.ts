import {
  CODEX_GENERATION_OFFERING_ID,
  CODEX_GENERATION_PROFILE_ID,
  type AdapterId,
  type OfferingConfig,
  type OfferingSnapshot,
  type ProviderAdapter,
  type ProviderProfile
} from "../types.js";
import type { SettingsStore } from "../storage/settings-store.js";
import { OpenAiImagesAdapter } from "./openai-images.js";
import { GeminiImagesAdapter } from "./gemini-images.js";
import { geminiApiRoot } from "./gemini-protocol.js";
import { TuziJsonImagesAdapter } from "./tuzi-json-images.js";
import { parseResponse, providerError, type FetchLike } from "./http.js";

export interface ResolvedOffering {
  profile: ProviderProfile;
  offering: OfferingConfig;
  snapshot: OfferingSnapshot;
}

export class ProviderRegistry {
  constructor(private readonly settings: SettingsStore, private readonly fetchImpl: FetchLike = fetch) {}

  async listOfferings(): Promise<Array<OfferingSnapshot & Pick<OfferingConfig, "supportsTextToImage" | "supportsImageToImage" | "sizes" | "qualities"> & { configured: boolean }>> {
    const profiles = await this.settings.listProfiles();
    return [publicOffering(CODEX_GENERATION_PROFILE, CODEX_GENERATION_OFFERING, true), ...profiles.flatMap((profile) => profile.offerings.map((offering) => ({
      ...snapshotFor(profile, offering),
      supportsTextToImage: offering.supportsTextToImage,
      supportsImageToImage: offering.supportsImageToImage,
      sizes: [...offering.sizes],
      qualities: [...offering.qualities],
      configured: profile.hasApiKey
    })))];
  }

  async resolveOffering(id: string): Promise<ResolvedOffering> {
    if (id === CODEX_GENERATION_OFFERING_ID) {
      return {
        profile: CODEX_GENERATION_PROFILE,
        offering: CODEX_GENERATION_OFFERING,
        snapshot: snapshotFor(CODEX_GENERATION_PROFILE, CODEX_GENERATION_OFFERING)
      };
    }
    const profiles = await this.settings.listProfiles();
    for (const profile of profiles) {
      const offering = profile.offerings.find((entry) => entry.id === id);
      if (offering) return { profile, offering, snapshot: snapshotFor(profile, offering) };
    }
    throw new Error(`Unknown image offering: ${id}. Open esse settings to configure it.`);
  }

  async adapterFor(profile: ProviderProfile): Promise<ProviderAdapter> {
    if (profile.adapterId === "agent-generation") {
      throw new Error("Codex generation is performed by the current Agent and does not have a local Provider adapter.");
    }
    const apiKey = await this.settings.getApiKey(profile.id);
    const options = { baseUrl: profile.baseUrl, apiKey, fetchImpl: this.fetchImpl };
    if (profile.adapterId === "tuzi-json-images") return new TuziJsonImagesAdapter(options);
    if (profile.adapterId === "openai-images") return new OpenAiImagesAdapter(options);
    if (profile.adapterId === "gemini-native-images") return new GeminiImagesAdapter(options);
    return assertNever(profile.adapterId);
  }

  async testProfile(input: { baseUrl: string; profileId?: string; apiKey?: string; adapterId?: AdapterId }): Promise<{ models: string[]; requestId?: string }> {
    const apiKey = input.apiKey?.trim() || (input.profileId ? await this.settings.getApiKey(input.profileId) : undefined);
    if (!apiKey) throw new Error("Enter an API key before testing the provider.");
    const adapterId = input.adapterId || (input.profileId ? (await this.settings.listProfiles()).find((profile) => profile.id === input.profileId)?.adapterId : undefined);
    const gemini = adapterId === "gemini-native-images";
    const response = await this.fetchImpl(gemini ? `${geminiApiRoot(input.baseUrl)}/models?pageSize=100` : `${apiRoot(input.baseUrl)}/v1/models`, {
      headers: gemini ? { "x-goog-api-key": apiKey } : { authorization: `Bearer ${apiKey}` },
      ...(gemini ? { redirect: "error" as const } : {}),
      signal: AbortSignal.timeout(30_000)
    });
    const body = await parseResponse(response);
    if (!response.ok) throw providerError(response, body);
    if (gemini) {
      const records = Array.isArray((body as { models?: unknown[] }).models) ? (body as { models: unknown[] }).models : [];
      const models = records.flatMap((entry) => {
        const model = entry as { name?: unknown; supportedGenerationMethods?: unknown[] };
        return typeof model?.name === "string" && model.supportedGenerationMethods?.includes("generateContent") && /image|nano-banana/.test(model.name) ? [model.name.replace(/^models\//, "")] : [];
      }).sort();
      return { models, requestId: response.headers.get("x-request-id") || undefined };
    }
    const data = Array.isArray((body as { data?: unknown[] }).data) ? (body as { data: unknown[] }).data : [];
    const models = data
      .map((entry) => entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string" ? (entry as { id: string }).id : undefined)
      .filter((value): value is string => Boolean(value))
      .sort();
    return { models, requestId: response.headers.get("x-request-id") || undefined };
  }
}

function apiRoot(value: string): string {
  return value.trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
}

function snapshotFor(profile: ProviderProfile, offering: OfferingConfig): OfferingSnapshot {
  return {
    id: offering.id,
    providerProfileId: profile.id,
    providerName: profile.displayName,
    tierName: profile.tierName,
    adapterId: profile.adapterId,
    canonicalModelId: offering.canonicalModelId,
    providerModelId: offering.providerModelId,
    displayName: offering.displayName,
    concurrency: profile.concurrency,
    price: offering.price
  };
}

function publicOffering(profile: ProviderProfile, offering: OfferingConfig, configured: boolean) {
  return {
    ...snapshotFor(profile, offering),
    supportsTextToImage: offering.supportsTextToImage,
    supportsImageToImage: offering.supportsImageToImage,
    sizes: [...offering.sizes],
    qualities: [...offering.qualities],
    configured
  };
}

const CODEX_GENERATION_OFFERING: OfferingConfig = {
  id: CODEX_GENERATION_OFFERING_ID,
  canonicalModelId: "agent-image-generation",
  providerModelId: "agent-image-generation",
  displayName: "Codex 生成",
  price: { mode: "model_quota", currency: "MODEL" },
  supportsTextToImage: true,
  supportsImageToImage: true,
  sizes: [],
  qualities: []
};

const CODEX_GENERATION_PROFILE: ProviderProfile = {
  id: CODEX_GENERATION_PROFILE_ID,
  displayName: "Codex",
  tierName: "内置",
  baseUrl: "",
  adapterId: "agent-generation",
  concurrency: 1,
  hasApiKey: true,
  offerings: [CODEX_GENERATION_OFFERING],
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString()
};

function assertNever(value: never): never {
  throw new Error(`Unsupported provider adapter: ${String(value)}`);
}

export function isAdapterId(value: string): value is AdapterId {
  return value === "tuzi-json-images" || value === "openai-images" || value === "gemini-native-images" || value === "agent-generation";
}
