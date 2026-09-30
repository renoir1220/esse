import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EsseApiClient, EsseApiError, IMAGE_REQUEST_TIMEOUT_MS, sanitizeProviderError } from './api-client';
import type { ProviderSettingsStore } from './provider-settings';
import type { OfferingConfig, OfferingSummary, ProviderProfile } from './types';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('Esse Provider client', () => {
  it('allows queue-heavy image models up to fifteen minutes', () => {
    expect(IMAGE_REQUEST_TIMEOUT_MS).toBe(900_000);
  });

  it('sends the locally stored Provider key and requests original image data', async () => {
    vi.useFakeTimers();
    let queries = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer local-provider-key');
      if (String(url).endsWith('/v1/videos')) {
        expect((init?.body as FormData).get('model')).toBe('gpt-image-2');
        expect(new Headers(init?.headers).has('content-type')).toBe(false);
        return new Response(JSON.stringify({ id: 'task-1', status: 'queued' }), { status: 202, headers: { 'x-oneapi-request-id': 'request-1' } });
      }
      expect(String(url)).toBe('https://provider.example/v1/videos/task-1');
      queries += 1;
      if (queries === 1) return new Response(JSON.stringify({ error: { message: 'system cpu overloaded' } }), { status: 503 });
      return new Response(JSON.stringify({ id: 'task-1', status: 'completed', video_url: 'https://cdn.example/image.png' }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new EsseApiClient(fakeSettings('tuzi-json-images'), fetchMock);
    const updates: string[] = [];
    const pending = client.generate({ prompt: 'test', model: 'provider-1:gpt-image-2' }, 'stable-key', {
      onTask: (task) => { updates.push(`${task.status}:${task.progress ?? ''}`); },
    });
    await vi.advanceTimersByTimeAsync(3_000);
    const result = await pending;
    vi.useRealTimers();
    expect(result).toMatchObject({ requestId: 'request-1', items: [{ url: 'https://cdn.example/image.png' }] });
    expect(updates).toEqual(['queued:', 'completed:']);
  });

  it('uses the Tuzi video contract for reference images', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'esse-api-tuzi-edit-test-'));
    temporaryDirectories.push(directory);
    const sourcePath = path.join(directory, 'source.png');
    await writeFile(sourcePath, 'reference-image');
    let queries = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer local-provider-key');
      if (String(url).endsWith('/v1/videos')) {
        const body = init?.body as FormData;
        expect(body.get('model')).toBe('gpt-image-2');
        expect(body.get('quality')).toBe('4K');
        expect((body.get('input_reference') as Blob).type).toBe('image/png');
        expect(new Headers(init?.headers).has('content-type')).toBe(false);
        return new Response(JSON.stringify({ id: 'task-edit-1', status: 'queued' }), { status: 202, headers: { 'x-oneapi-request-id': 'request-edit-1' } });
      }
      expect(String(url)).toBe('https://provider.example/v1/videos/task-edit-1');
      queries += 1;
      return new Response(JSON.stringify({ id: 'task-edit-1', status: 'completed', video_url: 'https://cdn.example/edited.png' }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new EsseApiClient(fakeSettings('tuzi-json-images'), fetchMock);
    const pending = client.edit({ prompt: 'add a scarf', model: 'provider-1:gpt-image-2', quality: '4K' }, [sourcePath]);
    await expect(pending).resolves.toMatchObject({ requestId: 'request-edit-1', items: [{ url: 'https://cdn.example/edited.png' }] });
    expect(queries).toBe(1);
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

  it('keeps newly submitted other models on the legacy result endpoint', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/async/v1/images/generations')) return Response.json({ id: 'legacy', status: 'submitted' });
      expect(String(url)).toBe('https://provider.example/get-async?id=legacy');
      return Response.json({ status: 'completed', result: { data: [{ url: 'https://cdn.example/legacy.png' }] } });
    }) as unknown as typeof fetch;
    const client = new EsseApiClient(fakeSettings('tuzi-json-images', 'doubao-seedream-4-5-251128'), fetchMock);
    await expect(client.generate({ model: 'legacy', prompt: 'test' })).resolves.toMatchObject({ items: [{ url: 'https://cdn.example/legacy.png' }] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('queries a timed-out task once and preserves its pending status without resubmitting', async () => {
    const fetchMock = vi.fn(async () => Response.json({ status: 'in_progress', progress: 30 })) as unknown as typeof fetch;
    const client = new EsseApiClient(fakeSettings('tuzi-json-images'), fetchMock);
    const onTask = vi.fn();
    await expect(client.resume({ model: 'test', prompt: 'test' }, {
      id: 'timed-out', protocol: 'tuzi-video', status: 'queued', submittedAt: '2020-01-01T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z',
    }, { singleQuery: true, onTask })).rejects.toMatchObject({ details: { code: 'provider_task_pending' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onTask).toHaveBeenCalledWith(expect.objectContaining({ id: 'timed-out', status: 'in_progress' }));
  });

  it('recognizes the video failed state as a terminal provider failure', async () => {
    const fetchMock = vi.fn(async () => Response.json({ status: 'failed', error: { message: 'generation failed' } })) as unknown as typeof fetch;
    const client = new EsseApiClient(fakeSettings('tuzi-json-images'), fetchMock);
    const now = new Date().toISOString();
    await expect(client.resume({ model: 'test', prompt: 'test' }, {
      id: 'failed-task', protocol: 'tuzi-video', status: 'in_progress', submittedAt: now, updatedAt: now,
    })).rejects.toMatchObject({ details: { code: 'provider_task_failure' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it('attributes a safe nested network diagnostic to an inconclusive request path', async () => {
    const failure = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connection timed out for a private endpoint'), { code: 'ETIMEDOUT' }),
    });
    const fetchMock = vi.fn(async () => { throw failure; }) as unknown as typeof fetch;
    const client = new EsseApiClient(fakeSettings('tuzi-json-images'), fetchMock);

    const error = await client.generate({ prompt: 'diagnose', model: 'provider-1:gpt-image-2' }).catch((cause) => cause);
    expect(error).toBeInstanceOf(EsseApiError);
    expect((error as EsseApiError).details.origin).toBe('transport');
    expect((error as EsseApiError).message).toContain('诊断码：ETIMEDOUT');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not blame Esse or the upstream service when asynchronous submission times out', async () => {
    const fetchMock = vi.fn(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }) as unknown as typeof fetch;
    const client = new EsseApiClient(fakeSettings('tuzi-json-images'), fetchMock);

    const error = await client.generate({ prompt: 'slow queue', model: 'provider-1:gpt-image-2' }).catch((cause) => cause);
    expect(error).toBeInstanceOf(EsseApiError);
    expect((error as EsseApiError).details).toMatchObject({ code: 'submit_timeout', chargeState: 'unknown', origin: 'transport' });
    expect((error as EsseApiError).message).toContain('是否已被上游接收及扣费状态未知');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

for (const model of ['gemini-3.1-flash-image-preview', 'gemini-3-pro-image-preview', 'gemini-3-pro-image-preview-2k', 'gemini-3-pro-image-preview-4k', 'nano-banana-2', 'nano-banana-2-2k', 'nano-banana-2-4k']) {
  for (const count of [0, 1, 2]) it(`${model}: synchronous JSON with ${count} local references`, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'esse-sync-contract-'));
    temporaryDirectories.push(directory);
    const source = path.join(directory, 'source.png');
    await writeFile(source, 'image');
    const references = Array(count).fill('data:image/png;base64,aW1hZ2U=');
    const onTask = vi.fn();
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://provider.example/v1/images/generations');
      expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
      expect(JSON.parse(String(init?.body))).toEqual({ model, prompt: 'contract', n: 1, size: '9x16', quality: '2k', response_format: 'url', ...(count ? { image: count === 1 ? references[0] : references } : {}) });
      return new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/output.png' }] }), { headers: { 'x-request-id': 'sync-request' } });
    }) as unknown as typeof fetch;
    const client = new EsseApiClient(fakeSettings('tuzi-json-images', model, 'https://provider.example/v1/'), fetchMock);
    const input = { model: 'offering', prompt: 'contract', size: '9:16', quality: '2K' };
    const result = count ? await client.edit(input, Array(count).fill(source), 'dummy', { onTask }) : await client.generate(input, 'dummy', { onTask });
    expect(result).toMatchObject({ requestId: 'sync-request', items: [{ url: 'https://cdn.example/output.png' }] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onTask).not.toHaveBeenCalled();
  });
}

it('normalizes saved Flash resolution suffix to the documented base model and quality', async () => {
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe('https://provider.example/v1/images/generations');
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'gemini-3.1-flash-image-preview', quality: '4k' });
    return Response.json({ data: [{ url: 'https://cdn.example/image.png' }] });
  }) as unknown as typeof fetch;
  const client = new EsseApiClient(fakeSettings('tuzi-json-images', 'gemini-3.1-flash-image-preview-4k'), fetchMock);
  await client.generate({ model: 'offering', prompt: 'legacy config' });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

for (const model of ['gemini-3-pro-image-preview-async', 'gemini-3-pro-image-preview-2k-async', 'gemini-3-pro-image-preview-4k-async', 'gpt-image-2']) it(`${model}: multipart video image contract`, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'esse-video-contract-'));
  temporaryDirectories.push(directory);
  const source = path.join(directory, 'source.png');
  await writeFile(source, 'image');
  const urls: string[] = [];
  const onTask = vi.fn();
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url));
    if (init?.method === 'POST') {
      expect(String(url)).toBe('https://provider.example/v1/videos');
      expect(new Headers(init.headers).has('content-type')).toBe(false);
      const form = init.body as FormData;
      expect(form.get('model')).toBe(model);
      expect(form.get('size')).toBe(model === 'gpt-image-2' ? '1024x1536' : '9:16');
      expect(form.has('image')).toBe(false);
      expect(form.has('response_format')).toBe(false);
      if (model !== 'gpt-image-2') expect(form.has('quality')).toBe(false);
      const references = form.getAll('input_reference');
      expect(references).toHaveLength(2);
      expect(await (references[0] as Blob).text()).toBe('image');
      return Response.json({ id: 'accepted', status: 'processing', progress: '15' });
    }
    return Response.json({ status: 'completed', video_url: 'https://cdn.example/image.png' });
  }) as unknown as typeof fetch;
  const client = new EsseApiClient(fakeSettings('tuzi-json-images', model, 'https://provider.example/v1'), fetchMock);
  await expect(client.edit({ model: 'offering', prompt: 'contract', size: model === 'gpt-image-2' ? '1024x1536' : '9x16', quality: '4K' }, [source, source], 'dummy', { onTask })).resolves.toMatchObject({ items: [{ url: 'https://cdn.example/image.png' }] });
  expect(urls).toEqual(['https://provider.example/v1/videos', 'https://provider.example/v1/videos/accepted']);
  expect(onTask).toHaveBeenCalledWith(expect.objectContaining({ protocol: 'tuzi-video', status: 'in_progress', progress: 15 }));
});

for (const protocol of ['tuzi-video', 'tuzi-images'] as const) it(`persisted ${protocol} wins over today's model routing`, async () => {
  const urls: string[] = [];
  const now = new Date().toISOString();
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url)); expect(init?.method).not.toBe('POST');
    return Response.json(protocol === 'tuzi-video' ? { status: 'completed', video_url: 'https://cdn.example/image.png' } : { status: 'completed', result: JSON.stringify({ data: [{ url: 'https://cdn.example/image.png' }] }) });
  }) as unknown as typeof fetch;
  const client = new EsseApiClient(fakeSettings('tuzi-json-images', 'gemini-3.1-flash-image-preview', 'https://provider.example/v1/'), fetchMock);
  await client.resume({ model: 'offering', prompt: 'resume' }, { id: 'old/id', protocol, status: 'in_progress', submittedAt: now, updatedAt: now });
  expect(urls).toEqual([protocol === 'tuzi-video' ? 'https://provider.example/v1/videos/old%2Fid' : 'https://provider.example/get-async?id=old%2Fid']);
});

for (const status of ['failed', 'expired', 'unexpected']) it(`${status} remains charge-unknown and never resubmits`, async () => {
  const now = new Date().toISOString();
  const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => { expect(init?.method).not.toBe('POST'); return Response.json({ status }); }) as unknown as typeof fetch;
  const client = new EsseApiClient(fakeSettings('tuzi-json-images'), fetchMock);
  await expect(client.resume({ model: 'offering', prompt: 'resume' }, { id: 'accepted', protocol: 'tuzi-video', status: 'in_progress', submittedAt: now, updatedAt: now })).rejects.toMatchObject({ details: { chargeState: 'unknown' } });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

function fakeSettings(adapterId: 'tuzi-json-images' | 'openai-images', providerModelId = 'gpt-image-2', baseUrl = 'https://provider.example'): ProviderSettingsStore {
  const offering: OfferingConfig = {
    id: 'provider-1:gpt-image-2',
    canonicalModelId: 'gpt-image-2',
    providerModelId,
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
    resolveOffering: async () => ({ profile: { ...profile, baseUrl }, offering }),
    getApiKey: async () => 'local-provider-key',
  } as unknown as ProviderSettingsStore;
}
