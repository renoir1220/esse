import { randomUUID } from "node:crypto";
import { ProviderRequestError, type GenerateRequest, type GenerateResult, type ProviderAdapter } from "../types.js";
import { extractImageResult, IMAGE_REQUEST_TIMEOUT_MS, normalizeTransportError, parseResponse, providerError, requestId, type FetchLike } from "./http.js";

export class OpenAiImagesAdapter implements ProviderAdapter {
  readonly id = "openai-images" as const;
  constructor(private readonly options: { baseUrl: string; apiKey: string; fetchImpl?: FetchLike; timeoutMs?: number }) {}

  async generate(request: GenerateRequest, signal?: AbortSignal): Promise<GenerateResult> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? IMAGE_REQUEST_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const base = apiBase(this.options.baseUrl);
    const official = /^https:\/\/api\.openai\.com(?::443)?$/i.test(base);
    if (official && request.images.length > 16) {
      throw new ProviderRequestError("OpenAI Images supports up to 16 reference images.", { retryable: false, chargeState: "not_charged", origin: "esse" });
    }
    try {
      const response = request.images.length
        ? await this.edit(base, request, combined, official)
        : await this.create(base, request, combined, official);
      const parsed = await parseResponse(response);
      if (!response.ok) throw providerError(response, parsed);
      return { ...extractImageResult(parsed), providerRequestId: requestId(response, parsed) };
    } catch (error) {
      throw normalizeTransportError(error);
    }
  }

  private create(base: string, request: GenerateRequest, signal: AbortSignal, official: boolean): Promise<Response> {
    return (this.options.fetchImpl ?? fetch)(`${base}/v1/images/generations`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: request.model,
        prompt: request.prompt,
        n: 1,
        size: request.size,
        quality: request.quality,
        ...(!official ? { response_format: request.responseFormat } : {})
      }),
      ...(official ? { redirect: "error" } : {}),
      signal
    });
  }

  private async edit(base: string, request: GenerateRequest, signal: AbortSignal, official: boolean): Promise<Response> {
    const form = new FormData();
    form.append("model", request.model);
    form.append("prompt", request.prompt);
    form.append("n", "1");
    if (request.size) form.append("size", request.size);
    if (request.quality) form.append("quality", request.quality);
    if (!official) form.append("response_format", request.responseFormat);
    const imageField = official && request.images.length > 1 ? "image[]" : "image";
    for (const image of request.images) {
      const { blob, extension } = await imageToBlob(image, this.options.fetchImpl ?? fetch, signal);
      form.append(imageField, blob, `input-${randomUUID()}.${extension}`);
    }
    return (this.options.fetchImpl ?? fetch)(`${base}/v1/images/edits`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.options.apiKey}` },
      body: form,
      ...(official ? { redirect: "error" } : {}),
      signal
    });
  }
}

function apiBase(value: string): string {
  return value.trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
}

async function imageToBlob(value: string, fetchImpl: FetchLike, signal: AbortSignal): Promise<{ blob: Blob; extension: string }> {
  if (value.startsWith("data:")) {
    const match = /^data:([^;,]+);base64,(.+)$/s.exec(value);
    if (!match?.[1] || !match[2]) throw new Error("Invalid base64 image input.");
    return { blob: new Blob([Buffer.from(match[2], "base64")], { type: match[1] }), extension: extensionForMime(match[1]) };
  }
  const response = await fetchImpl(value, { signal });
  if (!response.ok) throw new Error(`Could not download input image (HTTP ${response.status}).`);
  const mime = response.headers.get("content-type")?.split(";")[0] || "image/png";
  return { blob: await response.blob(), extension: extensionForMime(mime) };
}

function extensionForMime(mime: string): string {
  if (mime.includes("jpeg")) return "jpg";
  if (mime.includes("webp")) return "webp";
  return "png";
}
