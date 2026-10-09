import { ProviderRequestError, type GenerateRequest, type GenerateResult, type ProviderAdapter } from '../types.js';
import { IMAGE_REQUEST_TIMEOUT_MS, normalizeTransportError, parseResponse, providerError, requestId, type FetchLike } from './http.js';
import { GeminiInputError, geminiApiRoot, geminiBlockReason, geminiImages, geminiRequest, geminiResponseId } from './gemini-protocol.js';

export class GeminiImagesAdapter implements ProviderAdapter {
  readonly id = 'gemini-native-images' as const;
  constructor(private readonly options: { baseUrl: string; apiKey: string; fetchImpl?: FetchLike; timeoutMs?: number }) {}

  async generate(request: GenerateRequest, signal?: AbortSignal): Promise<GenerateResult> {
    let url: string;
    let body: string;
    try {
      const prepared = geminiRequest(request);
      url = `${geminiApiRoot(this.options.baseUrl)}${prepared.endpoint}`;
      body = prepared.body;
    } catch (error) {
      if (!(error instanceof GeminiInputError)) throw error;
      throw new ProviderRequestError(error.message, { retryable: false, chargeState: 'not_charged', origin: 'esse' });
    }
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? IMAGE_REQUEST_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      // One POST only. Ambiguous transport/response failures are never resubmitted.
      const response = await (this.options.fetchImpl ?? fetch)(url, {
        method: 'POST', headers: { 'x-goog-api-key': this.options.apiKey, 'content-type': 'application/json' }, body, signal: combined, redirect: 'error',
      });
      const parsed = await parseResponse(response);
      if (!response.ok) throw providerError(response, parsed);
      const id = requestId(response, parsed) || geminiResponseId(parsed);
      const images = geminiImages(parsed);
      const image = images[0];
      if (!image) throw new ProviderRequestError(`Gemini 没有返回最终图片${geminiBlockReason(parsed) ? `（${geminiBlockReason(parsed)}）` : ''}；扣费状态未知，不会自动重试。`, { retryable: false, chargeState: 'unknown', requestId: id, origin: 'upstream' });
      return { ...image, ...(images.length > 1 ? { additionalImages: images.slice(1) } : {}), providerRequestId: id };
    } catch (error) {
      throw normalizeTransportError(error);
    }
  }
}
