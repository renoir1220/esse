import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { EsseApiClient } from './api-client';
import { createGeminiProviderDraft, GEMINI_PROVIDER_PRESET } from './gemini-catalog';
import { GeminiInputError, geminiImages, geminiRequest } from './gemini-protocol';
import { ProviderSettingsStore } from './provider-settings';
import type { CredentialStore } from './credential-store';

const baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
const image = 'AAECAw==';
function fakeSettings(model = 'gemini-3.1-flash-image'): ProviderSettingsStore {
  return { resolveOffering: async () => ({ profile: { id: 'offline', baseUrl, adapterId: 'gemini-native-images', hasApiKey: true }, offering: { providerModelId: model } }), getApiKey: async () => 'offline-placeholder' } as unknown as ProviderSettingsStore;
}

describe('Gemini official REST contract (offline only)', () => {
  it('validates every preset ratio/resolution, reference MIME/count and the inline payload bound', () => {
    const request = { model: 'gemini-3.1-flash-image', prompt: 'Offline fixture', images: [] as string[] };
    for (const model of GEMINI_PROVIDER_PRESET.models) {
      for (const size of model.sizes) for (const quality of model.qualities.length ? model.qualities : ['1K']) {
        const body = JSON.parse(geminiRequest({ ...request, model: model.providerModelId, size, quality }).body);
        expect(body.generationConfig.imageConfig).toEqual({ aspectRatio: size, ...(model.providerModelId !== 'gemini-2.5-flash-image' ? { imageSize: quality } : {}) });
      }
    }
    expect(JSON.parse(geminiRequest({ ...request, size: '1024x1024' }).body).generationConfig.imageConfig.aspectRatio).toBe('1:1');
    expect(JSON.parse(geminiRequest({ ...request, size: '2520x1080' }).body).generationConfig.imageConfig.aspectRatio).toBe('21:9');
    expect(() => geminiRequest({ ...request, model: 'gemini-3-pro-image', size: '1:8' })).toThrow(GeminiInputError);
    for (const mime of ['image/png', 'image/jpeg', 'image/webp']) expect(() => geminiRequest({ ...request, images: Array(14).fill(`data:${mime};base64,${image}`) })).not.toThrow();
    expect(() => geminiRequest({ ...request, model: 'gemini-2.5-flash-image', images: Array(3).fill(`data:image/png;base64,${image}`) })).not.toThrow();
    expect(() => geminiRequest({ ...request, model: 'gemini-2.5-flash-image', images: Array(4).fill(`data:image/png;base64,${image}`) })).toThrow(GeminiInputError);
    for (const mime of ['image/gif', 'image/heic', 'image/heif']) expect(() => geminiRequest({ ...request, images: [`data:${mime};base64,${image}`] })).toThrow(GeminiInputError);
    expect(() => geminiRequest({ ...request, prompt: 'x'.repeat(20_000_000) })).toThrow(GeminiInputError);
  });

  it('transfers original local references with native headers, ratio and resolution in one POST', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'esse-gemini-reference-'));
    try {
      const reference = path.join(directory, 'reference.png');
      await writeFile(reference, Buffer.from(image, 'base64'));
      const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe(`${baseUrl}/models/gemini-3.1-flash-image:generateContent`);
        expect(new Headers(init?.headers).get('x-goog-api-key')).toBe('offline-placeholder');
        expect(new Headers(init?.headers).has('authorization')).toBe(false);
        expect(JSON.parse(String(init?.body))).toEqual({ contents: [{ role: 'user', parts: [{ text: 'Offline fixture' }, { inlineData: { mimeType: 'image/png', data: image } }] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '9:16', imageSize: '2K' } } });
        return Response.json({ responseId: 'google-fixture', candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, inlineData: { mimeType: 'image/png', data: 'dGhvdWdodA==' } }, { inlineData: { mimeType: 'image/png', data: image } }] } }] });
      });
      const result = await new EsseApiClient(fakeSettings(), fetchMock).edit({ model: 'offline', prompt: 'Offline fixture', size: '9:16', quality: '2k' }, [reference]);
      expect(result).toMatchObject({ requestId: 'google-fixture', items: [{ b64_json: image }] });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('rejects bad ratio, quality, count and model-specific reference limits before submission', async () => {
    const fetchMock = vi.fn();
    const client = new EsseApiClient(fakeSettings(), fetchMock);
    for (const extra of [{ size: '1920x1000' }, { quality: 'high' }, { n: 2 }]) await expect(client.generate({ model: 'offline', prompt: 'fixture', ...extra })).rejects.toMatchObject({ details: { chargeState: 'not_charged', origin: 'esse' } });
    await expect(new EsseApiClient(fakeSettings('gemini-2.5-flash-image'), fetchMock).generate({ model: 'offline', prompt: 'fixture', quality: '2K' })).rejects.toMatchObject({ details: { chargeState: 'not_charged' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves unknown-charge transport and success-without-image failures without any POST retry', async () => {
    for (const mode of ['transport', 'blocked', 'malformed', 'server']) {
      const fetchMock = vi.fn(async () => {
        if (mode === 'transport') throw new TypeError('Offline network failure');
        if (mode === 'server') return Response.json({ error: { message: 'Unavailable' } }, { status: 503 });
        return mode === 'blocked' ? Response.json({ responseId: 'blocked-fixture', promptFeedback: { blockReason: 'SAFETY' } }) : new Response('{');
      });
      await expect(new EsseApiClient(fakeSettings(), fetchMock).generate({ model: 'offline', prompt: 'fixture' })).rejects.toMatchObject({ details: { chargeState: 'unknown' } });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it('keeps the preset credential-free and independent from local edits', () => {
    const draft = createGeminiProviderDraft();
    expect(draft).toMatchObject({ baseUrl, adapterId: 'gemini-native-images', apiKey: '', hasApiKey: false });
    expect(GEMINI_PROVIDER_PRESET.models.every(model => model.price.mode === 'unknown' && model.price.amount === undefined)).toBe(true);
    draft.offerings[0].displayName = 'Changed';
    expect(GEMINI_PROVIDER_PRESET.models[0].displayName).toBe('Nano Banana 2.1');
    expect(geminiImages({ candidates: [{ content: { parts: [{ thought: true, inlineData: { mimeType: 'image/png', data: image } }] } }] })).toEqual([]);
  });

  it('retains every final inline image under one native response ID', async () => {
    const fetchMock = vi.fn(async () => Response.json({ responseId: 'multiple-final', candidates: [{ content: { parts: [
      { thought: true, inlineData: { mimeType: 'image/png', data: image } },
      { inlineData: { mimeType: 'image/png', data: image } },
      { inlineData: { mimeType: 'image/webp', data: image } },
    ] } }] }));
    const result = await new EsseApiClient(fakeSettings(), fetchMock).generate({ model: 'offline', prompt: 'fixture' });
    expect(result.requestId).toBe('multiple-final');
    expect(result.items).toEqual([{ b64_json: image }, { b64_json: image }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stores only a credential reference and tests connection with a read-only native model list', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'esse-gemini-settings-'));
    try {
      const values = new Map<string, string>();
      const credentials = { get: async (id: string) => values.get(id), has: async (id: string) => values.has(id), set: async (id: string, value: string) => { values.set(id, value); }, delete: async (id: string) => { values.delete(id); } };
      const file = path.join(directory, 'providers.json');
      const settings = new ProviderSettingsStore(file, credentials as unknown as CredentialStore);
      const saved = await settings.saveProvider({ ...createGeminiProviderDraft(), apiKey: 'offline-placeholder' });
      expect(await readFile(file, 'utf8')).not.toContain('offline-placeholder');
      const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe(`${baseUrl}/models?pageSize=100`);
        expect(init?.method).toBeUndefined();
        expect(new Headers(init?.headers).get('x-goog-api-key')).toBe('offline-placeholder');
        return Response.json({ models: [{ name: 'models/gemini-3.1-flash-image', supportedGenerationMethods: ['generateContent'] }, { name: 'models/text-model', supportedGenerationMethods: ['generateContent'] }] });
      });
      expect((await settings.testProvider({ baseUrl, profileId: saved.id }, fetchMock)).models).toEqual(['gemini-3.1-flash-image']);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
