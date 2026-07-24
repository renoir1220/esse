import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EsseApiClient, EsseApiError, sanitizeProviderError } from './api-client';
import type { ProviderSettingsStore } from './provider-settings';
import type { OfferingConfig, OfferingSummary, ProviderProfile } from './types';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('Esse Provider client', () => {
  it('sends the locally stored Provider key and requests original image data', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://provider.example/v1/images/generations');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer local-provider-key');
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'gpt-image-2', response_format: 'b64_json' });
      return new Response(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] }), { status: 200, headers: { 'x-request-id': 'request-1' } });
    }) as unknown as typeof fetch;
    const client = new EsseApiClient(fakeSettings('tuzi-json-images'), fetchMock);
    const result = await client.generate({ prompt: 'test', model: 'provider-1:gpt-image-2' });
    expect(result).toMatchObject({ requestId: 'request-1', items: [{ b64_json: 'aW1hZ2U=' }] });
  });

  it('returns locally configured offerings without contacting another Esse service', async () => {
    const client = new EsseApiClient(fakeSettings('tuzi-json-images'));
    await expect(client.offerings()).resolves.toEqual([expect.objectContaining({
      id: 'provider-1:gpt-image-2',
      providerName: 'Tuzi',
      priceMicros: 100_000,
      configured: true,
    })]);
  });

  it('uploads exact local references to an OpenAI-compatible edit endpoint', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'esse-api-edit-test-'));
    temporaryDirectories.push(directory);
    const sourcePath = path.join(directory, 'source.png');
    await writeFile(sourcePath, 'reference-image');
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://provider.example/v1/images/edits');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer local-provider-key');
      const form = init?.body as FormData;
      expect(form.get('prompt')).toBe('add a scarf');
      expect(form.getAll('image')).toHaveLength(1);
      return new Response(JSON.stringify({ data: [{ b64_json: 'ZWRpdGVk' }] }), { status: 200, headers: { 'x-request-id': 'edit-request-1' } });
    }) as unknown as typeof fetch;
    const client = new EsseApiClient(fakeSettings('openai-images'), fetchMock);
    await expect(client.edit({ prompt: 'add a scarf', model: 'provider-1:gpt-image-2' }, [sourcePath], 'stable-edit-key')).resolves.toMatchObject({ requestId: 'edit-request-1' });
  });

  it('accepts up to twenty references and rejects a twenty-first before contacting the Provider', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'esse-api-reference-limit-'));
    temporaryDirectories.push(directory);
    const sourcePath = path.join(directory, 'source.png');
    await writeFile(sourcePath, 'reference-image');
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.body as FormData).getAll('image')).toHaveLength(20);
      return new Response(JSON.stringify({ data: [{ b64_json: 'ZWRpdGVk' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new EsseApiClient(fakeSettings('openai-images'), fetchMock);
    await client.edit({ prompt: 'twenty references', model: 'provider-1:gpt-image-2' }, Array(20).fill(sourcePath));
    await expect(client.edit({ prompt: 'too many references', model: 'provider-1:gpt-image-2' }, Array(21).fill(sourcePath))).rejects.toThrow(/between 1 and 20/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('preserves an ambiguous Provider request ID and does not auto-retry it', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      error: { message: 'Provider result is unknown.', code: 'provider_result_unknown' },
      request_id: 'review-request-1',
    }), { status: 503 })) as unknown as typeof fetch;
    const client = new EsseApiClient(fakeSettings('tuzi-json-images'), fetchMock);
    const error = await client.generate({ prompt: 'ambiguous', model: 'provider-1:gpt-image-2' }, 'stable-request-key').catch((cause) => cause);
    expect(error).toBeInstanceOf(EsseApiError);
    expect((error as EsseApiError).details).toMatchObject({ requestId: 'review-request-1', chargeState: 'unknown', origin: 'upstream' });
    expect((error as EsseApiError).message).toBe('Provider result is unknown.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('can hide configured Provider identity without replacing it with the Esse brand', () => {
    expect(sanitizeProviderError(
      'Tuzi at https://api.tu-zi.com rejected sk-example-secret',
      { displayName: 'Tuzi', baseUrl: 'https://api.tu-zi.com' },
      { showProviderIdentity: false, redactProviderTerms: ['兔子'] },
    )).toBe('上游服务 at 上游服务 rejected [redacted]');
  });

  it('shows a safe nested network diagnostic without retrying the request', async () => {
    const failure = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connection timed out for a private endpoint'), { code: 'ETIMEDOUT' }),
    });
    const fetchMock = vi.fn(async () => { throw failure; }) as unknown as typeof fetch;
    const client = new EsseApiClient(fakeSettings('tuzi-json-images'), fetchMock);

    const error = await client.generate({ prompt: 'diagnose', model: 'provider-1:gpt-image-2' }).catch((cause) => cause);
    expect(error).toBeInstanceOf(EsseApiError);
    expect((error as EsseApiError).details.origin).toBe('esse');
    expect((error as EsseApiError).message).toContain('诊断码：ETIMEDOUT');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

function fakeSettings(adapterId: 'tuzi-json-images' | 'openai-images'): ProviderSettingsStore {
  const offering: OfferingConfig = {
    id: 'provider-1:gpt-image-2',
    canonicalModelId: 'gpt-image-2',
    providerModelId: 'gpt-image-2',
    displayName: 'gpt-image-2',
    price: { mode: 'per_request', currency: 'CNY', amount: 0.1 },
    supportsTextToImage: true,
    supportsImageToImage: true,
    sizes: ['1024x1024'],
    qualities: [],
  };
  const profile: ProviderProfile = {
    id: 'provider-1', displayName: 'Tuzi', tierName: '默认', baseUrl: 'https://provider.example',
    adapterId, concurrency: 3, hasApiKey: true, offerings: [offering], createdAt: '', updatedAt: '',
  };
  const summary: OfferingSummary = {
    ...offering,
    providerName: profile.displayName,
    providerType: adapterId,
    tierName: profile.tierName,
    concurrency: profile.concurrency,
    priceMicros: 100_000,
    currency: 'CNY',
    configured: true,
  };
  return {
    listOfferings: async () => [summary],
    resolveOffering: async () => ({ profile, offering }),
    getApiKey: async () => 'local-provider-key',
  } as unknown as ProviderSettingsStore;
}
