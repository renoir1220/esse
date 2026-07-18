import { ProviderRequestError, type ChargeState, type GenerateResult } from "../types.js";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { return { message: text.slice(0, 1000) }; }
}

export function providerError(response: Response, body: unknown): ProviderRequestError {
  const status = response.status;
  const retryable = status === 429 || status >= 500;
  const chargeState: ChargeState = status === 429 || (status >= 400 && status < 500) ? "not_charged" : "unknown";
  const requestId = response.headers.get("x-request-id") || nestedString(body, ["request_id", "requestId"]);
  const rawMessage = nestedString(body, ["error.message", "message", "error"]);
  const message = rawMessage ? `Provider HTTP ${status}: ${sanitize(rawMessage)}` : `Provider request failed with HTTP ${status}.`;
  return new ProviderRequestError(message, { status, retryable, chargeState, requestId: requestId || undefined });
}

export function normalizeTransportError(error: unknown): ProviderRequestError {
  if (error instanceof ProviderRequestError) return error;
  const message = error instanceof Error ? error.message : "Unknown transport error";
  return new ProviderRequestError(`Provider transport failed: ${sanitize(message)}`, {
    retryable: true,
    chargeState: "unknown"
  });
}

export function extractImageResult(body: unknown): GenerateResult {
  const record = asRecord(body);
  const data = Array.isArray(record.data) ? record.data[0] : undefined;
  const candidate = asRecord(data || record.result || record.output || record);
  const outputUrl = firstString(candidate.url, candidate.image_url, candidate.output_url, record.url, record.image_url);
  const b64Json = firstString(candidate.b64_json, candidate.base64, record.b64_json, record.base64);
  if (!outputUrl && !b64Json) throw new ProviderRequestError("Provider returned no image URL or base64 image.", { retryable: false, chargeState: "unknown" });
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
