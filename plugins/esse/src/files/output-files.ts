import { constants } from "node:fs";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import path from "node:path";
import type { GenerateResult } from "../types.js";
import { decodedBase64Length, detectImageFormat, MAX_GENERATED_IMAGE_BYTES } from "./image-format.js";

export async function saveGeneratedImage(options: {
  result: GenerateResult;
  outputDirectory: string;
  sourceName: string;
  fetchImpl?: typeof fetch;
  trustedBaseUrl?: string;
  maxBytes?: number;
}): Promise<string> {
  await mkdir(options.outputDirectory, { recursive: true });
  const maxBytes = options.maxBytes ?? MAX_GENERATED_IMAGE_BYTES;
  let bytes: Buffer;
  if (options.result.b64Json) {
    if (decodedBase64Length(options.result.b64Json) > maxBytes) throw new Error("Generated image exceeds the 60 MB image limit.");
    bytes = Buffer.from(options.result.b64Json, "base64");
  } else if (options.result.outputUrl) {
    const response = await fetchGeneratedImage(options.result.outputUrl, options.fetchImpl ?? fetch, options.trustedBaseUrl);
    if (!response.ok) throw new Error(`Could not download generated image (HTTP ${response.status}).`);
    bytes = Buffer.from(await readResponseBytes(response, maxBytes));
  } else {
    throw new Error("Provider returned no image data.");
  }
  const format = detectImageFormat(bytes);
  if (!format) throw new Error("Provider output is not a recognized image file.");
  const baseName = sanitizeBaseName(path.parse(options.sourceName).name || "generated");
  return writeUnique(options.outputDirectory, `${baseName}-generated`, format.extension, bytes);
}

export async function importGeneratedImage(options: {
  sourcePath: string;
  outputDirectory: string;
  sourceName: string;
}): Promise<string> {
  const sourcePath = path.resolve(options.sourcePath);
  const fileStat = await stat(sourcePath);
  if (!fileStat.isFile()) throw new Error("Agent output is not a file.");
  if (fileStat.size > MAX_GENERATED_IMAGE_BYTES) throw new Error("Agent output exceeds the 60 MB image limit.");
  const bytes = await readFile(sourcePath);
  const format = detectImageFormat(bytes);
  if (!format) throw new Error("Agent output is not a recognized image file.");
  await mkdir(options.outputDirectory, { recursive: true });
  const baseName = sanitizeBaseName(path.parse(options.sourceName).name || "generated");
  return writeUnique(options.outputDirectory, `${baseName}-generated`, format.extension, bytes);
}

export async function fileDataUrl(filePath: string, maxBytes = 30 * 1024 * 1024): Promise<string> {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) throw new Error("Image preview source is not a file.");
  if (fileStat.size > maxBytes) throw new Error("Image is too large to preview in the widget.");
  const bytes = await readFile(filePath);
  const format = detectImageFormat(bytes);
  if (!format) throw new Error("Image preview source is not a recognized image file.");
  return `data:${format.mimeType};base64,${bytes.toString("base64")}`;
}

export async function backupImageVersion(options: {
  sourcePath: string;
  outputDirectory: string;
  displayName: string;
}): Promise<string> {
  await mkdir(options.outputDirectory, { recursive: true });
  const extension = path.extname(options.sourcePath).replace(/^\./, "") || "png";
  const baseName = sanitizeBaseName(options.displayName);
  for (let index = 0; index < 10_000; index += 1) {
    const suffix = index === 0 ? "" : `-${index + 1}`;
    const candidate = path.join(options.outputDirectory, `${baseName}${suffix}.${extension}`);
    try {
      await copyFile(options.sourcePath, candidate, constants.COPYFILE_EXCL);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("Could not allocate a unique backup filename.");
}

async function writeUnique(directory: string, baseName: string, extension: string, bytes: Buffer): Promise<string> {
  for (let index = 0; index < 10_000; index += 1) {
    const suffix = index === 0 ? "" : `-${index + 1}`;
    const candidate = path.join(directory, `${baseName}${suffix}.${extension}`);
    try {
      await writeFile(candidate, bytes, { flag: "wx" });
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("Could not allocate a unique output filename.");
}

function sanitizeBaseName(value: string): string {
  const sanitized = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/\s+/g, " ").trim();
  return (sanitized || "generated").slice(0, 120);
}

async function fetchGeneratedImage(initialUrl: string, fetchImpl: typeof fetch, trustedBaseUrl?: string): Promise<Response> {
  let current = new URL(initialUrl);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    await assertSafeRemoteUrl(current, trustedBaseUrl, fetchImpl === fetch);
    const response = await fetchImpl(current, { redirect: "manual", signal: AbortSignal.timeout(90_000) });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) throw new Error("Generated image download redirected without a location.");
    current = new URL(location, current);
  }
  throw new Error("Generated image download exceeded the redirect limit.");
}

async function assertSafeRemoteUrl(url: URL, trustedBaseUrl?: string, resolveHostname = false): Promise<void> {
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Generated image URL must use HTTP or HTTPS.");
  const hostname = normalizeHostname(url.hostname);
  let trustedHostname = "";
  if (trustedBaseUrl) {
    try { trustedHostname = normalizeHostname(new URL(trustedBaseUrl).hostname); }
    catch { /* Provider configuration validation reports malformed base URLs separately. */ }
  }
  if (hostname === trustedHostname) return;
  if (isPrivateHost(hostname)) throw new Error("Generated image URL points to a local or private network address.");
  if (resolveHostname && !isIP(hostname)) {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some((entry) => isPrivateHost(entry.address))) {
      throw new Error("Generated image URL resolves to a local or private network address.");
    }
  }
}

function isPrivateHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  const version = isIP(hostname);
  if (version === 4) {
    const [first = 0, second = 0] = hostname.split(".").map(Number);
    return first === 0
      || first === 10
      || first === 127
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && (second === 0 || second === 168))
      || (first === 198 && (second === 18 || second === 19))
      || first >= 224;
  }
  if (version === 6) {
    const normalized = hostname.toLowerCase();
    if (normalized.startsWith("::ffff:")) return isPrivateHost(normalized.slice("::ffff:".length));
    return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || /^fe[89ab]/.test(normalized);
  }
  return false;
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

async function readResponseBytes(response: Response, limit: number): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length") || "0");
  if (Number.isFinite(declaredLength) && declaredLength > limit) throw new Error("Generated image exceeds the 60 MB download limit.");
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
        throw new Error("Generated image exceeds the 60 MB download limit.");
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
