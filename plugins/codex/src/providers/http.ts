import { ProviderRequestError, type ChargeState, type GenerateResult } from "../types.js";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const MAX_SUCCESS_RESPONSE_BYTES = 82 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 1024 * 1024;

export async function parseResponse(response: Response): Promise<unknown> {
  const limit = response.ok ? MAX_SUCCESS_RESPONSE_BYTES : MAX_ERROR_RESPONSE_BYTES;
  const text = new TextDecoder().decode(await readResponseBytes(response, limit));
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { return { message: text.slice(0, 1000) }; }
}

async function readResponseBytes(response: Response, limit: number): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length") || "0");
  if (Number.isFinite(declaredLength) && declaredLength > limit) throw new ProviderRequestError("Provider response exceeds the allowed size.", { retryable: false, chargeState: "unknown", origin: "esse" });
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new ProviderRequestError("Provider response exceeds the allowed size.", { retryable: false, chargeState: "unknown", origin: "esse" });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function providerError(response: Response, body: unknown): ProviderRequestError {
  const status = response.status;
  const retryable = status === 429 || status >= 500;
  const chargeState: ChargeState = status === 429 || (status >= 400 && status < 500) ? "not_charged" : "unknown";
  const requestId = response.headers.get("x-request-id") || nestedString(body, ["request_id", "requestId"]);
  const rawMessage = nestedString(body, ["error.message", "message", "error"]);
  const message = rawMessage ? sanitize(rawMessage) : `HTTP ${status}`;
  return new ProviderRequestError(message, { status, retryable, chargeState, requestId: requestId || undefined, origin: "upstream" });
}

export function normalizeTransportError(error: unknown): ProviderRequestError {
  if (error instanceof ProviderRequestError) return error;
  const message = error instanceof Error ? error.message : "Unknown transport error";
  return new ProviderRequestError(`Provider transport failed: ${sanitize(message)}`, {
    retryable: true,
    chargeState: "unknown",
    origin: "esse"
  });
}

export function extractImageResult(body: unknown): GenerateResult {
  const record = asRecord(body);
  const data = Array.isArray(record.data) ? record.data[0] : undefined;
  const candidate = asRecord(data || record.result || record.output || record);
  const outputUrl = firstString(candidate.url, candidate.image_url, candidate.output_url, record.url, record.image_url);
  const b64Json = firstString(candidate.b64_json, candidate.base64, record.b64_json, record.base64);
  if (!outputUrl && !b64Json) throw new ProviderRequestError("Provider returned no image URL or base64 image.", { retryable: false, chargeState: "unknown", origin: "esse" });
  return { outputUrl, b64Json, mimeType: "image/png" };
}

export function requestId(response: Response, body: unknown): string | undefined {
  return response.headers.get("x-request-id") || nestedString(body, ["request_id", "requestId"]) || undefined;
}

function nestedString(value: unknown, paths: string[]): string | undefined {
  for (const candidatePath of paths) {
    let current: unknown = value;
    for (const part of candidatePath.split(".")) current = asRecord(current)[part];
    if (typeof current === "string" && current.trim()) return current;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function sanitize(value: string): string {
  return value.replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]").slice(0, 800);
}
