import { ProviderRequestError, type ChargeState, type GenerateResult } from "../types.js";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export const IMAGE_REQUEST_TIMEOUT_MS = 15 * 60_000;

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
  const diagnostic = transportErrorDiagnostic(error);
  const timedOut = diagnostic === "TimeoutError";
  const message = timedOut
    ? `图片服务在 ${IMAGE_REQUEST_TIMEOUT_MS / 60_000} 分钟内未返回（诊断码：${diagnostic}）；结果与扣费状态未知，不会自动重试。`
    : `图片服务请求链路失败${diagnostic ? `（诊断码：${diagnostic}）` : ""}；结果与扣费状态未知，不会自动重试。`;
  return new ProviderRequestError(message, {
    retryable: true,
    chargeState: "unknown",
    origin: "transport"
  });
}

function transportErrorDiagnostic(error: unknown): string | undefined {
  const pending = [error];
  const visited = new Set<unknown>();
  while (pending.length) {
    const candidate = pending.shift();
    if (!candidate || visited.has(candidate)) continue;
    visited.add(candidate);
    if (!(candidate instanceof Error)) continue;
    const record = candidate as Error & { code?: unknown; cause?: unknown; errors?: unknown };
    if (typeof record.code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(record.code)) return record.code;
    const chromiumCode = /\bnet::(ERR_[A-Z0-9_]+)\b/.exec(candidate.message)?.[1];
    if (chromiumCode) return chromiumCode;
    if (record.cause) pending.push(record.cause);
    if (Array.isArray(record.errors)) pending.push(...record.errors);
    if (candidate.name === "TimeoutError" || candidate.name === "AbortError") return candidate.name;
  }
  return undefined;
}

export function extractImageResult(body: unknown): GenerateResult {
  const record = asRecord(body);
  const data = Array.isArray(record.data) ? record.data[0] : undefined;
  const candidate = asRecord(data || record.result || record.output || record);
  const rawUrl = firstString(candidate.url, candidate.image_url, candidate.output_url, record.url, record.image_url);
  const inlineImage = decodeDataImage(rawUrl);
  const b64Json = inlineImage?.base64 || firstString(candidate.b64_json, candidate.base64, record.b64_json, record.base64);
  const outputUrl = rawUrl && isHttpUrl(rawUrl) ? rawUrl : undefined;
  if (!outputUrl && !b64Json) throw new ProviderRequestError("Provider returned no image URL or base64 image.", { retryable: false, chargeState: "unknown", origin: "esse" });
  return { outputUrl, b64Json, mimeType: inlineImage?.mimeType || "image/png" };
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

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

function decodeDataImage(value: string | undefined): { base64: string; mimeType: string } | undefined {
  if (!value) return undefined;
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(value);
  if (!match?.[1] || !match[2]) return undefined;
  return { mimeType: match[1].toLowerCase(), base64: match[2].replace(/\s/g, "") };
}

function sanitize(value: string): string {
  return value.replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]").slice(0, 800);
}
