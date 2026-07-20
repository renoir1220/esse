import type { IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 90_000;
const DOH_TIMEOUT_MS = 8_000;
const TRUSTED_DOH_ENDPOINTS = [
  "https://cloudflare-dns.com/dns-query",
  "https://dns.google/resolve"
] as const;

export interface ResolvedRemoteAddress {
  address: string;
  family: 4 | 6;
}

export interface RemoteImageResponse {
  status: number;
  headers: Headers;
  bytes: Uint8Array;
}

export type RemoteHostnameResolver = (hostname: string) => Promise<ResolvedRemoteAddress[]>;
export type PinnedImageRequester = (
  url: URL,
  addresses: readonly ResolvedRemoteAddress[],
  maxBytes: number,
  signal: AbortSignal
) => Promise<RemoteImageResponse>;

export async function downloadRemoteImage(options: {
  initialUrl: string;
  trustedBaseUrl?: string;
  maxBytes: number;
  fetchImpl?: typeof fetch;
  resolveHostname?: RemoteHostnameResolver;
  requestPinned?: PinnedImageRequester;
}): Promise<Uint8Array> {
  const trustedOrigin = parseTrustedOrigin(options.trustedBaseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const resolveHostname = options.resolveHostname ?? ((hostname) => resolveHostnameWithTrustedDoh(hostname));
  const requestPinned = options.requestPinned ?? requestPinnedImage;
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  let current = parseRemoteUrl(options.initialUrl);

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = current.origin === trustedOrigin
      ? await requestTrustedOrigin(current, fetchImpl, options.maxBytes, signal)
      : await requestCrossOrigin(current, resolveHostname, requestPinned, options.maxBytes, signal);

    if (!REDIRECT_STATUSES.has(response.status)) {
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Could not download generated image (HTTP ${response.status}).`);
      }
      if (response.bytes.byteLength > options.maxBytes) throw downloadLimitError();
      return response.bytes;
    }

    const location = response.headers.get("location");
    if (!location) throw new Error("Generated image download redirected without a location.");
    current = parseRemoteUrl(new URL(location, current).href);
  }

  throw new Error("Generated image download exceeded the redirect limit.");
}

export async function resolveHostnameWithTrustedDoh(
  hostname: string,
  fetchImpl: typeof fetch = fetch
): Promise<ResolvedRemoteAddress[]> {
  let lastError: unknown;
  for (const endpoint of TRUSTED_DOH_ENDPOINTS) {
    try {
      const [ipv4, ipv6] = await Promise.all([
        queryDohAddressRecords(endpoint, hostname, 1, fetchImpl),
        queryDohAddressRecords(endpoint, hostname, 28, fetchImpl)
      ]);
      return deduplicateAddresses([...ipv4, ...ipv6]);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error("Could not securely resolve the generated image host.", { cause: lastError });
}

export function isGloballyRoutableAddress(address: string): boolean {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}

async function requestCrossOrigin(
  url: URL,
  resolveHostname: RemoteHostnameResolver,
  requestPinned: PinnedImageRequester,
  maxBytes: number,
  signal: AbortSignal
): Promise<RemoteImageResponse> {
  const hostname = normalizeHostname(url.hostname);
  if (hostname === "localhost" || hostname.endsWith(".localhost")) throw privateNetworkError();

  const parsedLiteral = parseIpLiteral(hostname);
  if (parsedLiteral && !isGloballyRoutableAddress(parsedLiteral.address)) throw privateNetworkError();
  if (url.protocol !== "https:") throw new Error("Cross-origin generated image URLs must use HTTPS.");
  const addresses = parsedLiteral
    ? [{ address: parsedLiteral.address, family: parsedLiteral.family }]
    : await resolveHostname(hostname);
  if (!addresses.length || addresses.some((entry) => !isGloballyRoutableAddress(entry.address))) {
    throw privateNetworkError();
  }

  return requestPinned(url, deduplicateAddresses(addresses), maxBytes, signal);
}

async function requestTrustedOrigin(
  url: URL,
  fetchImpl: typeof fetch,
  maxBytes: number,
  signal: AbortSignal
): Promise<RemoteImageResponse> {
  const response = await fetchImpl(url, { redirect: "manual", signal });
  if (REDIRECT_STATUSES.has(response.status) || !response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { status: response.status, headers: response.headers, bytes: new Uint8Array() };
  }
  return {
    status: response.status,
    headers: response.headers,
    bytes: await readWebResponseBytes(response, maxBytes)
  };
}

async function requestPinnedImage(
  url: URL,
  addresses: readonly ResolvedRemoteAddress[],
  maxBytes: number,
  signal: AbortSignal
): Promise<RemoteImageResponse> {
  let lastError: unknown;
  for (const address of addresses) {
    try {
      return await requestPinnedAddress(url, address, maxBytes, signal);
    } catch (error) {
      if (signal.aborted || isDownloadLimitError(error)) throw error;
      lastError = error;
    }
  }
  throw new Error("Could not connect to the generated image host.", { cause: lastError });
}

function requestPinnedAddress(
  url: URL,
  address: ResolvedRemoteAddress,
  maxBytes: number,
  signal: AbortSignal
): Promise<RemoteImageResponse> {
  return new Promise((resolve, reject) => {
    const expectedHostname = normalizeHostname(url.hostname);
    const lookup: LookupFunction = (hostname, lookupOptions, callback) => {
      if (normalizeHostname(hostname) !== expectedHostname) {
        callback(Object.assign(new Error("Pinned lookup received an unexpected hostname."), { code: "ESECURITY" }), "", 0);
        return;
      }
      if (lookupOptions.all) callback(null, [address]);
      else callback(null, address.address, address.family);
    };

    const request = httpsRequest(url, {
      method: "GET",
      headers: { accept: "image/*", connection: "close" },
      lookup,
      agent: false,
      maxHeaderSize: 64 * 1024,
      signal
    }, (response) => {
      const headers = headersFromIncoming(response.headers);
      if (REDIRECT_STATUSES.has(response.statusCode ?? 0) || (response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
        response.destroy();
        resolve({ status: response.statusCode ?? 0, headers, bytes: new Uint8Array() });
        return;
      }

      const declaredLength = Number(headers.get("content-length") || "0");
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        response.destroy();
        reject(downloadLimitError());
        return;
      }

      const chunks: Buffer[] = [];
      let total = 0;
      response.on("data", (chunk: Buffer) => {
        total += chunk.byteLength;
        if (total > maxBytes) {
          response.destroy(downloadLimitError());
          return;
        }
        chunks.push(chunk);
      });
      response.once("end", () => resolve({ status: response.statusCode ?? 0, headers, bytes: Buffer.concat(chunks, total) }));
      response.once("error", reject);
      response.once("aborted", () => reject(new Error("Generated image download was interrupted.")));
    });
    request.once("error", reject);
    request.end();
  });
}

async function queryDohAddressRecords(
  endpoint: string,
  hostname: string,
  recordType: 1 | 28,
  fetchImpl: typeof fetch
): Promise<ResolvedRemoteAddress[]> {
  let currentName = normalizeDnsName(hostname);
  for (let depth = 0; depth < 6; depth += 1) {
    const queryUrl = new URL(endpoint);
    queryUrl.searchParams.set("name", currentName);
    queryUrl.searchParams.set("type", String(recordType));
    const response = await fetchImpl(queryUrl, {
      headers: { accept: "application/dns-json" },
      redirect: "error",
      signal: AbortSignal.timeout(DOH_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`Trusted DNS resolver returned HTTP ${response.status}.`);
    const payload = await response.json() as {
      Status?: number;
      Answer?: Array<{ name?: string; type?: number; data?: string }>;
    };
    if (payload.Status === 3) return [];
    if (payload.Status !== 0) throw new Error(`Trusted DNS resolver returned status ${payload.Status ?? "unknown"}.`);
    const answers = Array.isArray(payload.Answer) ? payload.Answer : [];
    const resolved = answers.flatMap((answer): ResolvedRemoteAddress[] => {
      if (answer.type !== recordType || typeof answer.data !== "string") return [];
      const literal = parseIpLiteral(answer.data);
      if (!literal || literal.family !== (recordType === 1 ? 4 : 6)) return [];
      return [literal];
    });
    if (resolved.length) return resolved;

    const cname = answers.find((answer) => answer.type === 5
      && typeof answer.name === "string"
      && normalizeDnsName(answer.name) === currentName
      && typeof answer.data === "string");
    if (!cname?.data) return [];
    currentName = normalizeDnsName(cname.data);
  }
  throw new Error("Generated image host exceeded the DNS alias limit.");
}

async function readWebResponseBytes(response: Response, limit: number): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length") || "0");
  if (Number.isFinite(declaredLength) && declaredLength > limit) throw downloadLimitError();
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
        throw downloadLimitError();
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

function parseRemoteUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Generated image URL must use HTTP or HTTPS.");
  if (url.username || url.password) throw new Error("Generated image URL must not include credentials.");
  return url;
}

function parseTrustedOrigin(baseUrl?: string): string | undefined {
  if (!baseUrl) return undefined;
  try {
    return new URL(baseUrl).origin;
  } catch {
    return undefined;
  }
}

function parseIpLiteral(value: string): ResolvedRemoteAddress | undefined {
  const normalized = normalizeHostname(value);
  try {
    const parsed = ipaddr.process(normalized);
    return { address: parsed.toString(), family: parsed.kind() === "ipv4" ? 4 : 6 };
  } catch {
    return undefined;
  }
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

function normalizeDnsName(hostname: string): string {
  return hostname.replace(/\.$/, "").toLowerCase();
}

function deduplicateAddresses(addresses: readonly ResolvedRemoteAddress[]): ResolvedRemoteAddress[] {
  const seen = new Set<string>();
  return addresses.filter((entry) => {
    const key = `${entry.family}:${entry.address}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function headersFromIncoming(incoming: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming)) {
    if (Array.isArray(value)) value.forEach((entry) => headers.append(name, entry));
    else if (value !== undefined) headers.set(name, value);
  }
  return headers;
}

function privateNetworkError(): Error {
  return new Error("Generated image URL resolves to a local or private network address.");
}

function downloadLimitError(): Error {
  return Object.assign(new Error("Generated image exceeds the 60 MB download limit."), { code: "ESSE_DOWNLOAD_LIMIT" });
}

function isDownloadLimitError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ESSE_DOWNLOAD_LIMIT";
}
