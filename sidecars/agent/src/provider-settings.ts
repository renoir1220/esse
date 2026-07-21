import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CredentialStore } from './credential-store';
import type { OfferingConfig, OfferingSummary, ProviderProfile, SaveProviderInput } from './types';

type StoredProviderProfile = Omit<ProviderProfile, 'hasApiKey'>;

interface ProviderSettingsDocument {
  version: 1;
  providers: StoredProviderProfile[];
  updatedAt: string;
}

export class ProviderSettingsStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string, private readonly credentials: CredentialStore) {}

  async listProfiles(): Promise<ProviderProfile[]> {
    const settings = await this.read();
    return Promise.all(settings.providers.map(async (profile) => ({ ...structuredClone(profile), hasApiKey: await this.credentials.has(profile.id) })));
  }

  async listOfferings(): Promise<OfferingSummary[]> {
    const profiles = await this.listProfiles();
    return profiles.flatMap((profile) => profile.offerings.map((offering) => offeringSummary(profile, offering)));
  }

  async getProfile(id: string): Promise<ProviderProfile> {
    const profile = (await this.listProfiles()).find((entry) => entry.id === id);
    if (!profile) throw new Error(`Unknown Provider profile: ${id}`);
    return profile;
  }

  async getApiKey(id: string): Promise<string> {
    const apiKey = await this.credentials.get(id);
    if (!apiKey) throw new Error(`Provider ${id} 还没有 API Key，请在 Esse 设置中填写。`);
    return apiKey;
  }

  async resolveOffering(id: string): Promise<{ profile: ProviderProfile; offering: OfferingConfig }> {
    for (const profile of await this.listProfiles()) {
      const offering = profile.offerings.find((entry) => entry.id === id);
      if (offering) return { profile, offering };
    }
    throw new Error(`Unknown image offering: ${id}`);
  }

  async saveProvider(input: SaveProviderInput): Promise<ProviderProfile> {
    const displayName = input.displayName.trim();
    const tierName = input.tierName.trim();
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    if (!displayName || !tierName) throw new Error('请填写服务商名称和档位名称。');
    if (!input.offerings.length) throw new Error('请至少配置一个模型。');
    const settings = await this.read();
    const now = new Date().toISOString();
    const id = input.id?.trim() || randomUUID();
    const existing = settings.providers.find((entry) => entry.id === id);
    const offerings = input.offerings.map((offering) => normalizeOffering(offering, id));
    const stored: StoredProviderProfile = {
      id,
      displayName,
      tierName,
      baseUrl,
      adapterId: input.adapterId,
      concurrency: Math.max(1, Math.min(12, Math.trunc(input.concurrency || 1))),
      offerings,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    if (input.apiKey?.trim()) await this.credentials.set(id, input.apiKey);
    const index = settings.providers.findIndex((entry) => entry.id === id);
    if (index >= 0) settings.providers[index] = stored;
    else settings.providers.push(stored);
    settings.updatedAt = now;
    await this.write(settings);
    return { ...structuredClone(stored), hasApiKey: await this.credentials.has(id) };
  }

  async deleteProvider(id: string): Promise<void> {
    const settings = await this.read();
    settings.providers = settings.providers.filter((entry) => entry.id !== id);
    settings.updatedAt = new Date().toISOString();
    await this.credentials.delete(id);
    await this.write(settings);
  }

  async testProvider(input: { baseUrl: string; profileId?: string; apiKey?: string }, fetchImpl: typeof fetch = fetch): Promise<{ models: string[]; requestId?: string }> {
    const apiKey = input.apiKey?.trim() || (input.profileId ? await this.credentials.get(input.profileId) : undefined);
    if (!apiKey) throw new Error('请输入 API Key 后再测试连接。');
    const response = await fetchImpl(`${normalizeBaseUrl(input.baseUrl)}/v1/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(30_000),
    });
    const body = await parseJsonResponse(response);
    if (!response.ok) throw new Error(providerMessage(response.status, body));
    const data = Array.isArray((body as { data?: unknown[] }).data) ? (body as { data: unknown[] }).data : [];
    const models = data.flatMap((entry) => entry && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string' ? [(entry as { id: string }).id] : []).sort();
    return { models, requestId: response.headers.get('x-request-id') || undefined };
  }

  private async read(): Promise<ProviderSettingsDocument> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as ProviderSettingsDocument;
      if (parsed.version === 1 && Array.isArray(parsed.providers)) return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return { version: 1, providers: [], updatedAt: new Date(0).toISOString() };
  }

  private async write(document: ProviderSettingsDocument): Promise<void> {
    const task = this.writeQueue.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.filePath);
    });
    this.writeQueue = task.then(() => undefined, () => undefined);
    await task;
  }
}

function normalizeOffering(value: OfferingConfig, profileId: string): OfferingConfig {
  const canonicalModelId = value.canonicalModelId.trim();
  const providerModelId = value.providerModelId.trim();
  const displayName = value.displayName.trim();
  if (!canonicalModelId || !providerModelId || !displayName) throw new Error('每个模型都需要显示名称、服务商模型 ID 和标准模型 ID。');
  return {
    ...structuredClone(value),
    id: value.id.trim() || `${profileId}:${providerModelId}:${randomUUID().slice(0, 8)}`,
    canonicalModelId,
    providerModelId,
    displayName,
    price: { ...value.price, currency: value.price.currency.trim() || 'CNY' },
    sizes: value.sizes.filter(Boolean),
    qualities: value.qualities.filter(Boolean),
  };
}

function offeringSummary(profile: ProviderProfile, offering: OfferingConfig): OfferingSummary {
  const amount = offering.price.mode === 'per_request' && Number.isFinite(offering.price.amount) ? offering.price.amount! : 0;
  return {
    id: offering.id,
    canonicalModelId: offering.canonicalModelId,
    providerModelId: offering.providerModelId,
    displayName: offering.displayName,
    providerName: profile.displayName,
    providerType: profile.adapterId,
    tierName: profile.tierName,
    concurrency: profile.concurrency,
    priceMicros: Math.max(0, Math.round(amount * 1_000_000)),
    currency: offering.price.currency,
    price: { ...offering.price },
    configured: profile.hasApiKey,
    sizes: [...offering.sizes],
    supportsTextToImage: offering.supportsTextToImage,
    supportsImageToImage: offering.supportsImageToImage,
  };
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value.trim());
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('Provider API 地址必须使用 HTTPS；本机 localhost 可使用 HTTP。');
  return url.toString().replace(/\/+$/, '');
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { message: text.slice(0, 1000) }; }
}

function providerMessage(status: number, body: unknown): string {
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const error = record.error && typeof record.error === 'object' ? record.error as Record<string, unknown> : {};
  const message = typeof error.message === 'string' ? error.message : typeof record.message === 'string' ? record.message : `HTTP ${status}`;
  return `Provider 连接失败：${message.replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted]').slice(0, 800)}`;
}
