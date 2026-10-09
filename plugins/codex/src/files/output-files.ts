import { constants } from "node:fs";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GenerateResult } from "../types.js";
import { decodedBase64Length, detectImageFormat, MAX_GENERATED_IMAGE_BYTES } from "./image-format.js";
import { downloadRemoteImage } from "./remote-image-download.js";

/** Publish all final parts together; a failed later part leaves no unowned files. */
export async function saveGeneratedImages(options: Parameters<typeof saveGeneratedImage>[0]): Promise<string[]> {
  const paths: string[] = [];
  try {
    for (const [index, result] of [options.result, ...(options.result.additionalImages || [])].entries()) {
      paths.push(await saveGeneratedImage({ ...options, result, sourceName: index ? `${options.sourceName}-结果${index + 1}` : options.sourceName }));
    }
    return paths;
  } catch (error) {
    await Promise.all(paths.map((filePath) => rm(filePath, { force: true })));
    throw error;
  }
}

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
    bytes = Buffer.from(await downloadRemoteImage({
      initialUrl: options.result.outputUrl,
      trustedBaseUrl: options.trustedBaseUrl,
      maxBytes,
      fetchImpl: options.fetchImpl
    }));
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
