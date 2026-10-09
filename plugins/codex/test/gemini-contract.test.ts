import assert from 'node:assert/strict';
import test from 'node:test';
import { GeminiImagesAdapter } from '../src/providers/gemini-images.js';
import { GeminiInputError, geminiImages, geminiRequest } from '../src/providers/gemini-protocol.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { ProviderRequestError } from '../src/types.js';
import { createGeminiProviderDraft, GEMINI_PROVIDER_PRESET } from '../web/gemini-catalog.js';
import type { SettingsStore } from '../src/storage/settings-store.js';

const image = 'AAECAw==';
const baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
const request = { model: 'gemini-3.1-flash-image', prompt: 'Offline fixture', images: [], responseFormat: 'b64_json' as const };

test('Gemini REST submits native authentication, references, ratio and resolution once', async () => {
  let posts = 0;
  const adapter = new GeminiImagesAdapter({ baseUrl, apiKey: 'offline-placeholder', fetchImpl: async (url, init) => {
    posts++;
    assert.equal(url, `${baseUrl}/models/gemini-3.1-flash-image:generateContent`);
    assert.equal(init?.method, 'POST');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('x-goog-api-key'), 'offline-placeholder');
    assert.equal(headers.has('authorization'), false);
    assert.deepEqual(JSON.parse(String(init?.body)), { contents: [{ role: 'user', parts: [{ text: 'Offline fixture' }, { inlineData: { mimeType: 'image/png', data: image } }] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '9:16', imageSize: '2K' } } });
    return Response.json({ responseId: 'google-fixture', candidates: [{ content: { parts: [{ thought: true, inlineData: { mimeType: 'image/png', data: 'dGhvdWdodA==' } }, { text: 'Final image' }, { inlineData: { mimeType: 'image/webp', data: image } }] }, finishReason: 'STOP' }] });
  } });
  assert.deepEqual(await adapter.generate({ ...request, images: [`data:image/png;base64,${image}`], size: '9x16', quality: '2k' }), { b64Json: image, mimeType: 'image/webp', providerRequestId: 'google-fixture' });
  assert.equal(posts, 1);
});

test('Gemini rejects unsupported local inputs before a potentially billable POST', async () => {
  let posts = 0;
  const adapter = new GeminiImagesAdapter({ baseUrl, apiKey: 'offline-placeholder', fetchImpl: async () => { posts++; throw new Error('must not submit'); } });
  for (const invalid of [{ ...request, size: '1920x1000' }, { ...request, quality: 'high' }, { ...request, model: '../bad' }, { ...request, images: ['https://reference.example/image.png'] }, { ...request, images: Array(15).fill(`data:image/png;base64,${image}`) }, { ...request, model: 'gemini-2.5-flash-image', quality: '2K' }]) {
    await assert.rejects(adapter.generate(invalid), (error) => error instanceof ProviderRequestError && error.details.chargeState === 'not_charged' && !error.details.retryable);
  }
  assert.throws(() => geminiRequest({ ...request, n: 2 }), GeminiInputError);
  assert.equal(posts, 0);
});

test('Gemini transport, malformed and safety-blocked results retain unknown charge without reposting', async () => {
  for (const mode of ['network', 'blocked', 'malformed', 'server'] as const) {
    let calls = 0;
    const adapter = new GeminiImagesAdapter({ baseUrl, apiKey: 'offline-placeholder', fetchImpl: async () => {
      calls++;
      if (mode === 'network') throw new TypeError('offline network failure');
      if (mode === 'server') return Response.json({ error: { message: 'Unavailable' } }, { status: 503 });
      return mode === 'blocked' ? Response.json({ responseId: 'blocked-fixture', promptFeedback: { blockReason: 'SAFETY' } }) : new Response('{');
    } });
    await assert.rejects(adapter.generate(request), (error) => error instanceof ProviderRequestError && error.details.chargeState === 'unknown');
    assert.equal(calls, 1);
  }
});

test('Gemini parses the documented inline response and never treats thought-only output as final', () => {
  assert.deepEqual(geminiImages({ candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/png', data: image } }] } }] }), [{ b64Json: image, mimeType: 'image/png' }]);
  assert.deepEqual(geminiImages({ candidates: [{ content: { parts: [{ thought: true, inlineData: { mimeType: 'image/png', data: image } }] } }] }), []);
});

test('Gemini adapter returns every final inline image under one request ID', async () => {
  const adapter = new GeminiImagesAdapter({ baseUrl, apiKey: 'offline-placeholder', fetchImpl: async () => Response.json({ responseId: 'multi-result', candidates: [{ content: { parts: [
    { thought: true, inlineData: { mimeType: 'image/png', data: image } },
    { inlineData: { mimeType: 'image/png', data: image } },
    { inlineData: { mimeType: 'image/webp', data: image } },
  ] } }] }) });
  assert.deepEqual(await adapter.generate(request), { b64Json: image, mimeType: 'image/png', additionalImages: [{ b64Json: image, mimeType: 'image/webp' }], providerRequestId: 'multi-result' });
});

test('Gemini preset capability matrix matches native model options', () => {
  for (const model of GEMINI_PROVIDER_PRESET.models) {
    for (const size of model.sizes) for (const quality of model.qualities.length ? model.qualities : ['1K']) {
      const body = JSON.parse(geminiRequest({ ...request, model: model.providerModelId, size, quality }).body);
      assert.equal(body.generationConfig.imageConfig.aspectRatio, size);
      assert.equal(body.generationConfig.imageConfig.imageSize, model.providerModelId === 'gemini-2.5-flash-image' ? undefined : quality);
    }
  }
  assert.equal(JSON.parse(geminiRequest({ ...request, size: '1024x1024' }).body).generationConfig.imageConfig.aspectRatio, '1:1');
  assert.equal(JSON.parse(geminiRequest({ ...request, size: '2520x1080' }).body).generationConfig.imageConfig.aspectRatio, '21:9');
  assert.equal(JSON.parse(geminiRequest({ ...request, size: '1920x1080', quality: '4k' }).body).generationConfig.imageConfig.imageSize, '4K');
  assert.throws(() => geminiRequest({ ...request, model: 'gemini-3-pro-image', size: '1:8' }), GeminiInputError);
  assert.throws(() => geminiRequest({ ...request, model: 'gemini-2.5-flash-image', size: '4:1' }), GeminiInputError);
  for (const mime of ['image/png', 'image/jpeg', 'image/webp']) geminiRequest({ ...request, images: Array(14).fill(`data:${mime};base64,${image}`) });
  geminiRequest({ ...request, model: 'gemini-2.5-flash-image', images: Array(3).fill(`data:image/png;base64,${image}`) });
  assert.throws(() => geminiRequest({ ...request, model: 'gemini-2.5-flash-image', images: Array(4).fill(`data:image/png;base64,${image}`) }), GeminiInputError);
  for (const mime of ['image/gif', 'image/heic', 'image/heif']) assert.throws(() => geminiRequest({ ...request, images: [`data:${mime};base64,${image}`] }), GeminiInputError);
  assert.throws(() => geminiRequest({ ...request, prompt: 'x'.repeat(20_000_000) }), GeminiInputError);
});

test('Gemini preset is ready for a locally entered key without embedding credentials or guessed prices', () => {
  const draft = createGeminiProviderDraft();
  assert.equal(draft.baseUrl, baseUrl);
  assert.equal(draft.adapterId, 'gemini-native-images');
  assert.equal(draft.apiKey, '');
  assert.equal(draft.hasApiKey, false);
  assert.equal(draft.offerings[0]?.providerModelId, 'gemini-nano-banana-2.1');
  assert(GEMINI_PROVIDER_PRESET.models.every(model => model.price.mode === 'unknown' && model.price.amount === undefined));
  draft.offerings[0]!.displayName = 'Changed';
  assert.equal(GEMINI_PROVIDER_PRESET.models[0]?.displayName, 'Nano Banana 2.1');
});

test('Gemini connection testing uses a read-only native model list, not an image request', async () => {
  const registry = new ProviderRegistry({} as SettingsStore, async (url, init) => {
    assert.equal(url, `${baseUrl}/models?pageSize=100`);
    assert.equal(new Headers(init?.headers).get('x-goog-api-key'), 'offline-placeholder');
    assert.equal(init?.method, undefined);
    return Response.json({ models: [{ name: 'models/gemini-3.1-flash-image', supportedGenerationMethods: ['generateContent'] }, { name: 'models/text-model', supportedGenerationMethods: ['generateContent'] }] });
  });
  assert.deepEqual((await registry.testProfile({ baseUrl, apiKey: 'offline-placeholder', adapterId: 'gemini-native-images' })).models, ['gemini-3.1-flash-image']);
});
