import { randomUUID } from "node:crypto";
import { CODEX_GENERATION_OFFERING_ID, type AdapterId, type OfferingConfig, type ProviderProfile, type SettingsDocument, type StoredProviderProfile } from "../types.js";
import { readJsonFile, writeJsonFile } from "./atomic-json.js";
import type { SecretStore } from "./secret-store.js";

export interface SaveProviderInput {
  id?: string;
  displayName: string;
  tierName: string;
  baseUrl: string;
  adapterId: AdapterId;
  concurrency: number;
  apiKey?: string;
  offerings: OfferingConfig[];
  makeDefault?: boolean;
}

export class SettingsStore {
  constructor(private readonly settingsFile: string, private readonly secrets: SecretStore) {}

  async load(): Promise<SettingsDocument> {
    return (await readJsonFile<SettingsDocument>(this.settingsFile)) || emptySettings();
  }

  async listProfiles(): Promise<ProviderProfile[]> {
    const settings = await this.load();
    return Promise.all(settings.providers.map(async (profile) => ({ ...profile, hasApiKey: Boolean(await this.secrets.get(profile.id)) })));
  }

  async getProfile(id: string): Promise<ProviderProfile> {
    const profile = (await this.listProfiles()).find((entry) => entry.id === id);
    if (!profile) throw new Error(`Unknown provider profile: ${id}`);
    return profile;
  }

  async getApiKey(id: string): Promise<string> {
    const key = await this.secrets.get(id);
    if (!key) throw new Error(`Provider profile ${id} has no API key.`);
    return key;
  }

  async saveProvider(input: SaveProviderInput): Promise<ProviderProfile> {
    const settings = await this.load();
    const now = new Date().toISOString();
    const id = input.id || randomUUID();
    const existing = settings.providers.find((entry) => entry.id === id);
    const stored: StoredProviderProfile = {
      id,
      displayName: input.displayName.trim(),
      tierName: input.tierName.trim(),
      baseUrl: input.baseUrl.trim().replace(/\/$/, ""),
      adapterId: input.adapterId,
      concurrency: Math.max(1, Math.min(12, Math.trunc(input.concurrency))),
      offerings: input.offerings,
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };
    if (input.apiKey?.trim()) await this.secrets.set(id, input.apiKey.trim());
    const index = settings.providers.findIndex((entry) => entry.id === id);
    if (index >= 0) settings.providers[index] = stored;
    else settings.providers.push(stored);
    if (input.makeDefault || !settings.defaultOfferingId) settings.defaultOfferingId = stored.offerings[0]?.id;
    settings.updatedAt = now;
    await writeJsonFile(this.settingsFile, settings);
    return { ...stored, hasApiKey: Boolean(await this.secrets.get(id)) };
  }

  async deleteProvider(id: string): Promise<void> {
    const settings = await this.load();
    const removedOfferingIds = new Set(settings.providers.find((entry) => entry.id === id)?.offerings.map((entry) => entry.id) || []);
    settings.providers = settings.providers.filter((entry) => entry.id !== id);
    if (settings.defaultOfferingId && removedOfferingIds.has(settings.defaultOfferingId)) {
      settings.defaultOfferingId = settings.providers[0]?.offerings[0]?.id || CODEX_GENERATION_OFFERING_ID;
    }
    settings.updatedAt = new Date().toISOString();
    await this.secrets.delete(id);
    await writeJsonFile(this.settingsFile, settings);
  }

  async setDefaultOffering(id: string): Promise<void> {
    const settings = await this.load();
    const exists = id === CODEX_GENERATION_OFFERING_ID || settings.providers.some((profile) => profile.offerings.some((offering) => offering.id === id));
    if (!exists) throw new Error(`Unknown offering: ${id}`);
    settings.defaultOfferingId = id;
    settings.updatedAt = new Date().toISOString();
    await writeJsonFile(this.settingsFile, settings);
  }
}

function emptySettings(): SettingsDocument {
  return { version: 1, providers: [], updatedAt: new Date(0).toISOString() };
}
