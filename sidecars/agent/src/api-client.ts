import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ProviderSettingsStore } from './provider-settings';
import type { ErrorOrigin, GenerateInput, OfferingSummary, ProviderProfile } from './types';
import product from '../product.json';

interface ApiImageItem {
  url?: string;
  b64_json?: string;
  revised_prompt?: string;
}

export const IMAGE_REQUEST_TIMEOUT_MS = 15 * 60_000;

export interface ApiGenerateResult {
  requestId: string;
  items: ApiImageItem[];
  reused: boolean;
  trustedBaseUrl?: string;
}

export class EsseApiError extends Error {
  constructor(
    message: string,
    readonly details: { status?: number; code: string; requestId?: string; chargeState: 'not_charged' | 'unknown'; origin: ErrorOrigin },
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'EsseApiError';
  }
}

export class EsseApiClient {
  constructor(private readonly settings: ProviderSettingsStore, private readonly fetchImpl: typeof fetch = fetch) {}

  async offerings(): Promise<OfferingSummary[]> {
    return this.settings.listOfferings();
  }

  async generate(input: GenerateInput, _idempotencyKey: string = randomUUID()): Promise<ApiGenerateResult> {
    return this.request(input, []);
  }

  async edit(input: GenerateInput, sourcePaths: string[], _idempotencyKey: string = randomUUID()): Promise<ApiGenerateResult> {
    if (!sourcePaths.length || sourcePaths.length > 20) throw new Error('Provide between 1 and 20 source images.');
    const images = await Promise.all(sourcePaths.map(async (sourcePath) => {
      const bytes = await readFile(sourcePath);
      return `data:${mimeFor(sourcePath)};base64,${bytes.toString('base64')}`;
    }));
    return this.request(input, images);
  }

  private async request(input: GenerateInput, images: string[]): Promise<ApiGenerateResult> {
    const { profile, offering } = await this.settings.resolveOffering(input.model);
    if (!profile.hasApiKey) throw new EsseApiError('这个 Provider 还没有 API Key，请在 Esse 设置中填写。', { code: 'provider_not_configured', chargeState: 'not_charged', origin: 'esse' });
    const apiKey = await this.settings.getApiKey(profile.id);
    let response: Response;
    try {
      response = profile.adapterId === 'tuzi-json-images'
        ? await this.tuziRequest(profile.baseUrl, apiKey, offering.providerModelId, input, images)
        : await this.openAiRequest(profile.baseUrl, apiKey, offering.providerModelId, input, images);
    } catch (error) {
      if (error instanceof EsseApiError) throw error;
      const diagnostic = networkErrorDiagnostic(error);
      const timedOut = diagnostic === 'TimeoutError' || diagnostic === 'AbortError';
      const message = timedOut
        ? `图片服务在 ${IMAGE_REQUEST_TIMEOUT_MS / 60_000} 分钟内未返回${diagnostic ? `（诊断码：${diagnostic}）` : ''}；结果与扣费状态未知，不会自动重试。`
        : `图片服务请求链路失败${diagnostic ? `（诊断码：${diagnostic}）` : ''}；结果与扣费状态未知，不会自动重试。`;
      throw new EsseApiError(message, { code: timedOut ? 'request_timeout' : 'network_error', chargeState: 'unknown', origin: 'transport' }, { cause: error });
    }
    const body = await parseResponse(response);
    if (!response.ok) throw providerError(response, body, profile);
    const items = extractItems(body);
    if (!items.length) throw new EsseApiError('Provider 没有返回可用图片。', { code: 'empty_provider_result', requestId: requestId(response, body), chargeState: 'unknown', origin: 'esse' });
    return { requestId: requestId(response, body) || randomUUID(), items, reused: false, trustedBaseUrl: profile.baseUrl };
  }

  private tuziRequest(baseUrl: string, apiKey: string, model: string, input: GenerateInput, images: string[]): Promise<Response> {
    return this.fetchImpl(`${baseUrl}/v1/images/generations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: input.prompt,
        n: input.n ?? 1,
        response_format: 'b64_json',
        ...(images.length ? { image: images } : {}),
        ...(input.size ? { size: input.size } : {}),
        ...(input.quality ? { quality: input.quality } : {}),
      }),
      signal: AbortSignal.timeout(IMAGE_REQUEST_TIMEOUT_MS),
    });
  }

  private openAiRequest(baseUrl: string, apiKey: string, model: string, input: GenerateInput, images: string[]): Promise<Response> {
    if (!images.length) {
      return this.fetchImpl(`${baseUrl}/v1/images/generations`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, prompt: input.prompt, n: input.n ?? 1, response_format: 'b64_json', size: input.size, quality: input.quality }),
        signal: AbortSignal.timeout(IMAGE_REQUEST_TIMEOUT_MS),
      });
    }
    const form = new FormData();
    form.set('model', model);
    form.set('prompt', input.prompt);
    form.set('n', String(input.n ?? 1));
    form.set('response_format', 'b64_json');
    if (input.size) form.set('size', input.size);
    if (input.quality) form.set('quality', input.quality);
    for (const [index, image] of images.entries()) {
      const match = /^data:([^;,]+);base64,(.+)$/s.exec(image);
      if (!match?.[1] || !match[2]) throw new Error('Invalid local reference image.');
      form.append('image', new Blob([Buffer.from(match[2], 'base64')], { type: match[1] }), `input-${index + 1}.${extensionForMime(match[1])}`);
    }
    return this.fetchImpl(`${baseUrl}/v1/images/edits`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(IMAGE_REQUEST_TIMEOUT_MS),
    });
  }
}

async function parseResponse(response: Response): Promise<unknown> {
  const maxBytes = response.ok ? 82 * 1024 * 1024 : 1024 * 1024;
  const declared = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw new EsseApiError('Provider 响应超过允许大小。', { code: 'response_too_large', chargeState: 'unknown', origin: 'esse' });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new EsseApiError('Provider 响应超过允许大小。', { code: 'response_too_large', chargeState: 'unknown', origin: 'esse' });
  const text = new TextDecoder().decode(bytes);
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { message: text.slice(0, 1000) }; }
}

function providerError(response: Response, body: unknown, profile: ProviderProfile): EsseApiError {
  const status = response.status;
  const record = asRecord(body);
  const error = asRecord(record.error);
  const raw = firstString(error.message, record.message, error.type, error.code) || `HTTP ${status}`;
  const code = firstString(error.code, error.type) || `http_${status}`;
  return new EsseApiError(sanitizeProviderError(raw, profile), {
    status,
    code,
    requestId: requestId(response, body),
    chargeState: status === 429 || (status >= 400 && status < 500) ? 'not_charged' : 'unknown',
    origin: 'upstream',
  });
}

function extractItems(body: unknown): ApiImageItem[] {
  const record = asRecord(body);
  const candidates = Array.isArray(record.data) ? record.data : [record.result || record.output || record];
  return candidates.flatMap((candidate) => {
    const value = asRecord(candidate);
    const url = firstString(value.url, value.image_url, value.output_url);
    const b64 = firstString(value.b64_json, value.base64);
    return url || b64 ? [{ ...(url ? { url } : {}), ...(b64 ? { b64_json: b64 } : {}), ...(typeof value.revised_prompt === 'string' ? { revised_prompt: value.revised_prompt } : {}) }] : [];
  });
}

function requestId(response: Response, body: unknown): string | undefined {
  const record = asRecord(body);
  return response.headers.get('x-request-id') || firstString(record.request_id, record.requestId);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

export function sanitizeProviderError(
  value: string,
  profile: Pick<ProviderProfile, 'displayName' | 'baseUrl'>,
  attribution: { showProviderIdentity: boolean; redactProviderTerms: readonly string[] } = product.errorAttribution,
): string {
  let result = value.replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted]');
  if (!attribution.showProviderIdentity) {
    const configuredTerms = [
      profile.displayName,
      profile.baseUrl,
      providerHostname(profile.baseUrl),
      ...attribution.redactProviderTerms,
    ];
    for (const term of configuredTerms) {
      if (!term?.trim()) continue;
      result = result.replace(new RegExp(escapeRegExp(term.trim()), 'gi'), '上游服务');
    }
  }
  return result.slice(0, 800);
}

function providerHostname(baseUrl: string): string {
  try { return new URL(baseUrl).hostname; } catch { return ''; }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function networkErrorDiagnostic(error: unknown): string | undefined {
  const pending = [error];
  const visited = new Set<unknown>();
  while (pending.length) {
    const candidate = pending.shift();
    if (!candidate || visited.has(candidate)) continue;
    visited.add(candidate);
    if (candidate instanceof Error) {
      const record = candidate as Error & { code?: unknown; cause?: unknown; errors?: unknown };
      if (typeof record.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(record.code)) return record.code;
      const chromiumCode = /\bnet::(ERR_[A-Z0-9_]+)\b/.exec(candidate.message)?.[1];
      if (chromiumCode) return chromiumCode;
      if (record.cause) pending.push(record.cause);
      if (Array.isArray(record.errors)) pending.push(...record.errors);
      if (candidate.name === 'TimeoutError' || candidate.name === 'AbortError') return candidate.name;
    }
  }
  return undefined;
}

function mimeFor(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.gif') return 'image/gif';
  return 'image/png';
}

function extensionForMime(mime: string): string {
  if (mime.includes('jpeg')) return 'jpg';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  return 'png';
}
