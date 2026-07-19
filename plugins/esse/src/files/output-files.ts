import { constants } from "node:fs";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GenerateResult } from "../types.js";

export async function saveGeneratedImage(options: {
  result: GenerateResult;
  outputDirectory: string;
  sourceName: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  await mkdir(options.outputDirectory, { recursive: true });
  let bytes: Buffer;
  let mime = options.result.mimeType || "image/png";
  if (options.result.b64Json) {
    bytes = Buffer.from(options.result.b64Json, "base64");
  } else if (options.result.outputUrl) {
    const response = await (options.fetchImpl ?? fetch)(options.result.outputUrl, { signal: AbortSignal.timeout(90_000) });
    if (!response.ok) throw new Error(`Could not download generated image (HTTP ${response.status}).`);
    const length = Number(response.headers.get("content-length") || "0");
    if (length > 60 * 1024 * 1024) throw new Error("Generated image exceeds the 60 MB download limit.");
    bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 60 * 1024 * 1024) throw new Error("Generated image exceeds the 60 MB download limit.");
    mime = response.headers.get("content-type")?.split(";")[0] || mime;
  } else {
    throw new Error("Provider returned no image data.");
  }
  if (!looksLikeImage(bytes)) throw new Error("Provider output is not a recognized image file.");
  const extension = extensionForMime(mime, bytes);
  const baseName = sanitizeBaseName(path.parse(options.sourceName).name || "generated");
  return writeUnique(options.outputDirectory, `${baseName}-generated`, extension, bytes);
}

export async function importGeneratedImage(options: {
  sourcePath: string;
  outputDirectory: string;
  sourceName: string;
}): Promise<string> {
  const sourcePath = path.resolve(options.sourcePath);
  const fileStat = await stat(sourcePath);
  if (!fileStat.isFile()) throw new Error("Agent output is not a file.");
  if (fileStat.size > 60 * 1024 * 1024) throw new Error("Agent output exceeds the 60 MB image limit.");
  const bytes = await readFile(sourcePath);
  if (!looksLikeImage(bytes)) throw new Error("Agent output is not a recognized image file.");
  await mkdir(options.outputDirectory, { recursive: true });
  const mime = mimeForBytes(bytes, path.extname(sourcePath));
  const extension = extensionForMime(mime, bytes);
  const baseName = sanitizeBaseName(path.parse(options.sourceName).name || "generated");
  return writeUnique(options.outputDirectory, `${baseName}-generated`, extension, bytes);
}

export async function fileDataUrl(filePath: string, maxBytes = 30 * 1024 * 1024): Promise<string> {
  const fileStat = await stat(filePath);
  if (fileStat.size > maxBytes) throw new Error("Image is too large to preview in the widget.");
  const bytes = await readFile(filePath);
  return `data:${mimeForBytes(bytes, path.extname(filePath))};base64,${bytes.toString("base64")}`;
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

function looksLikeImage(bytes: Buffer): boolean {
  if (bytes.length < 12) return false;
  return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    || bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
    || bytes.subarray(0, 4).toString("ascii") === "RIFF"
    || bytes.subarray(0, 3).toString("ascii") === "GIF"
    || bytes.subarray(4, 12).toString("ascii").includes("ftyp");
}

function extensionForMime(mime: string, bytes: Buffer): string {
  if (mime.includes("jpeg") || bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "jpg";
  if (mime.includes("webp") || bytes.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  if (mime.includes("avif")) return "avif";
  return "png";
}

function mimeForBytes(bytes: Buffer, extension: string): string {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (extension.toLowerCase() === ".avif") return "image/avif";
  return "image/png";
}

function sanitizeBaseName(value: string): string {
  const sanitized = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/\s+/g, " ").trim();
  return (sanitized || "generated").slice(0, 120);
}
