import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ProviderSettingsStore } from './provider-settings';
import type { ErrorOrigin, GenerateInput, OfferingSummary, ProviderProfile, ProviderTaskState, ProviderTaskStatus } from './types';
import product from '../product.json';

interface ApiImageItem {
  url?: string;
  b64_json?: string;
  revised_prompt?: string;
}

export const IMAGE_REQUEST_TIMEOUT_MS = 15 * 60_000;
export const TUZI_SUBMIT_TIMEOUT_MS = 2 * 60_000;
export const TUZI_POLL_TIMEOUT_MS = 20_000;

export interface ProviderTaskHooks {
  resumeTask?: ProviderTaskState;
  onTask?: (task: ProviderTaskState) => void | Promise<void>;
}

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

  async generate(input: GenerateInput, _idempotencyKey: string = randomUUID(), hooks: ProviderTaskHooks = {}): Promise<ApiGenerateResult> {
    return this.request(input, [], hooks);
  }

  async edit(input: GenerateInput, sourcePaths: string[], _idempotencyKey: string = randomUUID(), hooks: ProviderTaskHooks = {}): Promise<ApiGenerateResult> {
    if (!sourcePaths.length || sourcePaths.length > 20) throw new Error('Provide between 1 and 20 source images.');
    const images: string[] = [];
    for (const sourcePath of sourcePaths) {
      const bytes = await readFile(sourcePath);
      images.push(`data:${mimeFor(sourcePath)};base64,${bytes.toString('base64')}`);
    }
    return this.request(input, images, hooks);
  }

  async resume(input: GenerateInput, task: ProviderTaskState, hooks: Omit<ProviderTaskHooks, 'resumeTask'> = {}): Promise<ApiGenerateResult> {
    return this.request(input, [], { ...hooks, resumeTask: task });
  }

  private async request(input: GenerateInput, images: string[], hooks: ProviderTaskHooks): Promise<ApiGenerateResult> {
    const { profile, offering } = await this.settings.resolveOffering(input.model);
    if (!profile.hasApiKey) throw new EsseApiError('这个 Provider 还没有 API Key，请在 Esse 设置中填写。', { code: 'provider_not_configured', chargeState: 'not_charged', origin: 'esse' });
    const apiKey = await this.settings.getApiKey(profile.id);
    let response: Response;
    try {
      if (profile.adapterId === 'tuzi-json-images') {
        return await this.tuziRequest(profile, apiKey, offering.providerModelId, input, images, hooks);
      }
      response = await this.openAiRequest(profile.baseUrl, apiKey, offering.providerModelId, input, images);
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

  private async tuziRequest(
    profile: ProviderProfile,
    apiKey: string,
    model: string,
    input: GenerateInput,
    images: string[],
    hooks: ProviderTaskHooks,
  ): Promise<ApiGenerateResult> {
    let task = hooks.resumeTask;
    if (!task) {
      let response: Response;
      try {
        if (images.length) {
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
          response = await this.fetchImpl(`${profile.baseUrl}/async/v1/images/edits`, {
            method: 'POST',
            headers: { authorization: `Bearer ${apiKey}` },
            body: form,
            signal: AbortSignal.timeout(TUZI_SUBMIT_TIMEOUT_MS),
          });
        } else {
          response = await this.fetchImpl(`${profile.baseUrl}/async/v1/images/generations`, {
            method: 'POST',
            headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
            body: JSON.stringify({
              model,
              prompt: input.prompt,
              n: input.n ?? 1,
              response_format: 'b64_json',
              ...(input.size ? { size: input.size } : {}),
              ...(input.quality ? { quality: input.quality } : {}),
            }),
            signal: AbortSignal.timeout(TUZI_SUBMIT_TIMEOUT_MS),
          });
        }
      } catch (error) {
        const diagnostic = networkErrorDiagnostic(error);
        throw new EsseApiError(`图片任务提交失败${diagnostic ? `（诊断码：${diagnostic}）` : ''}；是否已被上游接收及扣费状态未知。`, {
          code: diagnostic === 'TimeoutError' || diagnostic === 'AbortError' ? 'submit_timeout' : 'submit_network_error',
          chargeState: 'unknown',
          origin: 'transport',
        }, { cause: error });
      }
      const body = await parseResponse(response);
      if (!response.ok) throw providerError(response, body, profile);
      const record = asRecord(body);
      const id = firstString(record.id, record.task_id, record.taskId);
      if (!id) throw new EsseApiError('图片服务接受了异步请求，但没有返回任务 ID。', {
        code: 'missing_provider_task_id', requestId: requestId(response, body), chargeState: 'unknown', origin: 'esse',
      });
      const now = new Date().toISOString();
      task = {
        id,
        status: providerTaskStatus(record.status) || 'queued',
        progress: providerProgress(record.progress),
        requestId: requestId(response, body),
        submittedAt: now,
        updatedAt: now,
      };
      await hooks.onTask?.(task);
    }
    return this.pollTuziTask(profile, apiKey, task, hooks.onTask);
  }

  private async pollTuziTask(
    profile: ProviderProfile,
    apiKey: string,
    initialTask: ProviderTaskState,
    onTask?: ProviderTaskHooks['onTask'],
  ): Promise<ApiGenerateResult> {
    let task = { ...initialTask };
    const submitted = Date.parse(task.submittedAt);
    const deadline = (Number.isFinite(submitted) ? submitted : Date.now()) + IMAGE_REQUEST_TIMEOUT_MS;
    let delay = initialTask.status === 'queued' ? 1_000 : 0;
    let lastError: unknown;
    while (true) {
      if (delay) await wait(delay);
      let response: Response;
      let body: unknown;
      try {
        response = await this.fetchImpl(`${profile.baseUrl}/get-async?id=${encodeURIComponent(task.id)}`, {
          headers: { authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(TUZI_POLL_TIMEOUT_MS),
        });
        body = await parseResponse(response);
      } catch (error) {
        lastError = error;
        if (Date.now() >= deadline) throw providerTaskTimeout(task, error);
        delay = Math.min(Math.max(delay * 2, 1_000), 10_000);
        continue;
      }
      if (!response.ok) {
        const queryError = providerTaskQueryError(response, body, profile, task);
        if (isTransientTaskQueryStatus(response.status)) {
          lastError = queryError;
          if (Date.now() >= deadline) throw providerTaskTimeout(task, queryError);
          delay = Math.min(Math.max(delay * 2, 1_000), 10_000);
          continue;
        }
        throw queryError;
      }
      const record = asRecord(body);
      const status = providerTaskStatus(record.status);
      if (!status) throw new EsseApiError('图片服务返回了无法识别的异步任务状态。', {
        code: 'invalid_provider_task_status', requestId: task.requestId, chargeState: 'unknown', origin: 'upstream',
      });
      const now = new Date().toISOString();
      task = {
        ...task,
        status,
        progress: providerProgress(record.progress),
        requestId: task.requestId || requestId(response, body),
        updatedAt: now,
        ...(!task.startedAt && status === 'in_progress' ? { startedAt: now } : {}),
        ...(['completed', 'failure', 'expired'].includes(status) ? { completedAt: now } : {}),
      };
      await onTask?.(task);
      if (status === 'completed') {
        const result = asyncResult(record.result);
        const items = extractItems(result);
        if (!items.length) throw new EsseApiError('Provider 没有返回可用图片。', {
          code: 'empty_provider_result', requestId: task.requestId, chargeState: 'unknown', origin: 'esse',
        });
        return { requestId: task.requestId || task.id, items, reused: false, trustedBaseUrl: profile.baseUrl };
      }
      if (status === 'failure') throw providerTaskFailure(record, profile, task);
      if (status === 'expired') throw new EsseApiError('图片任务结果已在上游过期，结果与扣费状态需要核对。', {
        code: 'provider_task_expired', requestId: task.requestId, chargeState: 'unknown', origin: 'upstream',
      });
      if (Date.now() >= deadline) throw providerTaskTimeout(task, lastError);
      delay = Math.min(Math.max(delay * 2, 1_000), 10_000);
    }
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

function providerTaskQueryError(response: Response, body: unknown, profile: ProviderProfile, task: ProviderTaskState): EsseApiError {
  const record = asRecord(body);
  const error = asRecord(record.error);
  const raw = firstString(error.message, record.message, error.type, error.code) || `HTTP ${response.status}`;
  return new EsseApiError(sanitizeProviderError(raw, profile), {
    status: response.status,
    code: firstString(error.code, error.type) || `task_query_http_${response.status}`,
    requestId: task.requestId,
    chargeState: 'unknown',
    origin: 'upstream',
  });
}

function providerTaskFailure(body: Record<string, unknown>, profile: ProviderProfile, task: ProviderTaskState): EsseApiError {
  const error = asRecord(body.error);
  const result = asRecord(body.result);
  const resultError = asRecord(result.error);
  const raw = firstString(error.message, resultError.message, body.message, result.message, error.code, resultError.code)
    || '图片服务确认异步任务失败。';
  return new EsseApiError(sanitizeProviderError(raw, profile), {
    code: firstString(error.code, resultError.code) || 'provider_task_failure',
    requestId: task.requestId,
    chargeState: 'unknown',
    origin: 'upstream',
  });
}

function providerTaskTimeout(task: ProviderTaskState, cause?: unknown): EsseApiError {
  return new EsseApiError(`图片任务在 ${IMAGE_REQUEST_TIMEOUT_MS / 60_000} 分钟期限内没有完成；最后确认状态为 ${task.status}，结果与扣费状态未知。`, {
    code: 'provider_task_timeout', requestId: task.requestId, chargeState: 'unknown', origin: 'transport',
  }, cause ? { cause } : undefined);
}

function isTransientTaskQueryStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
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
  return response.headers.get('x-oneapi-request-id') || response.headers.get('x-request-id') || firstString(record.request_id, record.requestId);
}

function providerTaskStatus(value: unknown): ProviderTaskStatus | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.trim().toLowerCase();
  return ['not_start', 'submitted', 'queued', 'in_progress', 'completed', 'failure', 'expired'].includes(clean)
    ? clean as ProviderTaskStatus
    : undefined;
}

function providerProgress(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseFloat(value) : Number.NaN;
  return Number.isFinite(parsed) ? Math.min(100, Math.max(0, parsed)) : undefined;
}

function asyncResult(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
