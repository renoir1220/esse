import type { GenerateRequest, GenerateResult, ProviderAdapter } from "../types.js";
import { extractImageResult, normalizeTransportError, parseResponse, providerError, requestId, type FetchLike } from "./http.js";

export class TuziJsonImagesAdapter implements ProviderAdapter {
  readonly id = "tuzi-json-images" as const;
  constructor(private readonly options: { baseUrl: string; apiKey: string; fetchImpl?: FetchLike; timeoutMs?: number }) {}

  async generate(request: GenerateRequest, signal?: AbortSignal): Promise<GenerateResult> {
    const body: Record<string, unknown> = {
      model: request.model,
      prompt: request.prompt,
      n: 1,
      response_format: request.responseFormat
    };
    if (request.images.length) body.image = request.images;
    if (request.size) body.size = request.size;
    if (request.quality) body.quality = request.quality;
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 240_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await (this.options.fetchImpl ?? fetch)(`${this.options.baseUrl}/v1/images/generations`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: combined
      });
      const parsed = await parseResponse(response);
      if (!response.ok) throw providerError(response, parsed);
      return { ...extractImageResult(parsed), providerRequestId: requestId(response, parsed) };
    } catch (error) {
      throw normalizeTransportError(error);
    }
  }
}
