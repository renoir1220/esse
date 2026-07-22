import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTuziProviderDraft } from './provider-catalog';
import { ProviderSettingsStore } from './provider-settings';
import type { CredentialStore } from './credential-store';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('Provider settings', () => {
  it('keeps API keys out of provider JSON and exposes configured offerings', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'esse-provider-settings-'));
    temporaryDirectories.push(directory);
    const credentials = new MemoryCredentials();
    const filePath = path.join(directory, 'providers.json');
    const store = new ProviderSettingsStore(filePath, credentials as unknown as CredentialStore);
    const draft = createTuziProviderDraft('tuzi-default');
    const saved = await store.saveProvider({ ...draft, apiKey: 'private-provider-key' });

    expect(saved.hasApiKey).toBe(true);
    expect(await store.getApiKey(saved.id)).toBe('private-provider-key');
    expect(await readFile(filePath, 'utf8')).not.toContain('private-provider-key');
    expect(await store.listOfferings()).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerName: '兔子', tierName: 'default', configured: true, priceMicros: 0, price: { mode: 'unknown', currency: 'CNY' } }),
      expect.objectContaining({ canonicalModelId: 'image2-v', providerModelId: 'gpt-image-2', displayName: 'image2-v' }),
      expect.objectContaining({ canonicalModelId: 'gemini-3-pro-image-preview-4k', providerModelId: 'gemini-3-pro-image-preview-4k' }),
    ]));

    await store.deleteProvider(saved.id);
    expect(await store.listProfiles()).toEqual([]);
    await expect(store.getApiKey(saved.id)).rejects.toThrow(/没有 API Key/);
  });

  it('requires HTTPS except for an explicit loopback Provider', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'esse-provider-url-'));
    temporaryDirectories.push(directory);
    const store = new ProviderSettingsStore(path.join(directory, 'providers.json'), new MemoryCredentials() as unknown as CredentialStore);
    const draft = createTuziProviderDraft('tuzi-default');
    await expect(store.saveProvider({ ...draft, baseUrl: 'http://provider.example', apiKey: 'key' })).rejects.toThrow(/HTTPS/);
    await expect(store.saveProvider({ ...draft, baseUrl: 'http://127.0.0.1:9999', apiKey: 'key' })).resolves.toMatchObject({ baseUrl: 'http://127.0.0.1:9999' });
  });
});

class MemoryCredentials {
  private readonly values = new Map<string, string>();
  async get(id: string) { return this.values.get(id); }
  async has(id: string) { return this.values.has(id); }
  async set(id: string, value: string) { this.values.set(id, value); }
  async delete(id: string) { this.values.delete(id); }
}
