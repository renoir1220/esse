import type { AdapterId, OfferingConfig, OfferingSnapshot, ProviderAdapter, ProviderProfile } from "../types.js";
import type { SettingsStore } from "../storage/settings-store.js";
import { OpenAiImagesAdapter } from "./openai-images.js";
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
    return profiles.flatMap((profile) => profile.offerings.map((offering) => ({
      ...snapshotFor(profile, offering),
      supportsTextToImage: offering.supportsTextToImage,
      supportsImageToImage: offering.supportsImageToImage,
      sizes: [...offering.sizes],
      qualities: [...offering.qualities],
      configured: profile.hasApiKey
    })));
  }

  async resolveOffering(id: string): Promise<ResolvedOffering> {
    const profiles = await this.settings.listProfiles();
    for (const profile of profiles) {
      const offering = profile.offerings.find((entry) => entry.id === id);
      if (offering) return { profile, offering, snapshot: snapshotFor(profile, offering) };
    }
    throw new Error(`Unknown image offering: ${id}. Open esse settings to configure it.`);
  }

  async adapterFor(profile: ProviderProfile): Promise<ProviderAdapter> {
    const apiKey = await this.settings.getApiKey(profile.id);
    const options = { baseUrl: profile.baseUrl, apiKey, fetchImpl: this.fetchImpl };
    if (profile.adapterId === "tuzi-json-images") return new TuziJsonImagesAdapter(options);
    if (profile.adapterId === "openai-images") return new OpenAiImagesAdapter(options);
    return assertNever(profile.adapterId);
  }

  async testProfile(input: { baseUrl: string; profileId?: string; apiKey?: string }): Promise<{ models: string[]; requestId?: string }> {
    const apiKey = input.apiKey?.trim() || (input.profileId ? await this.settings.getApiKey(input.profileId) : undefined);
    if (!apiKey) throw new Error("Enter an API key before testing the provider.");
    const response = await this.fetchImpl(`${input.baseUrl.replace(/\/$/, "")}/v1/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(30_000)
    });
    const body = await parseResponse(response);
    if (!response.ok) throw providerError(response, body);
    const data = Array.isArray((body as { data?: unknown[] }).data) ? (body as { data: unknown[] }).data : [];
    const models = data
      .map((entry) => entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string" ? (entry as { id: string }).id : undefined)
      .filter((value): value is string => Boolean(value))
      .sort();
    return { models, requestId: response.headers.get("x-request-id") || undefined };
  }
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

function assertNever(value: never): never {
  throw new Error(`Unsupported provider adapter: ${String(value)}`);
}

export function isAdapterId(value: string): value is AdapterId {
  return value === "tuzi-json-images" || value === "openai-images";
}
