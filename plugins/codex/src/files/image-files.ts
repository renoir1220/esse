import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { LocalImageFile } from "../types.js";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".avif"]);

export async function scanImageFolder(options: {
  folderPath: string;
  recursive?: boolean;
  maxImages?: number;
}): Promise<{ folderPath: string; files: LocalImageFile[]; truncated: boolean }> {
  const folderPath = path.resolve(options.folderPath);
  const rootStat = await stat(folderPath);
  if (!rootStat.isDirectory()) throw new Error(`${folderPath} is not a directory.`);
  const maxImages = Math.max(1, Math.min(1000, options.maxImages ?? 200));
  const files: LocalImageFile[] = [];
  let truncated = false;

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= maxImages) { truncated = true; return; }
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (options.recursive && !isIgnoredDirectory(entry.name)) await walk(fullPath);
        continue;
      }
      if (!entry.isFile() || !IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      const fileStat = await stat(fullPath);
      files.push({
        path: fullPath,
        name: entry.name,
        sizeBytes: fileStat.size,
        modifiedAt: fileStat.mtime.toISOString(),
        mimeType: mimeForPath(fullPath)
      });
    }
  }

  await walk(folderPath);
  return { folderPath, files, truncated };
}

export async function imageFileToDataUrl(filePath: string, maxBytes = 25 * 1024 * 1024): Promise<string> {
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error(`${filePath} is not a file.`);
  if (info.size > maxBytes) throw new Error(`${path.basename(filePath)} exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB input limit.`);
  return `data:${mimeForPath(filePath)};base64,${(await readFile(filePath)).toString("base64")}`;
}

export async function imageFilesToDataUrls(
  filePaths: string[],
  options: { maxImages?: number; maxBytesPerImage?: number; maxTotalBytes?: number } = {}
): Promise<string[]> {
  const maxImages = options.maxImages ?? 20;
  const maxBytesPerImage = options.maxBytesPerImage ?? 25 * 1024 * 1024;
  const maxTotalBytes = options.maxTotalBytes ?? 60 * 1024 * 1024;
  if (filePaths.length > maxImages) throw new Error(`A generation job can use at most ${maxImages} reference images.`);
  let totalBytes = 0;
  for (const filePath of filePaths) {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error(`${filePath} is not a file.`);
    if (info.size > maxBytesPerImage) throw new Error(`${path.basename(filePath)} exceeds the ${Math.round(maxBytesPerImage / 1024 / 1024)} MB input limit.`);
    totalBytes += info.size;
    if (totalBytes > maxTotalBytes) throw new Error(`Reference images exceed the ${Math.round(maxTotalBytes / 1024 / 1024)} MB total input limit.`);
  }
  const dataUrls: string[] = [];
  for (const filePath of filePaths) dataUrls.push(await imageFileToDataUrl(filePath, maxBytesPerImage));
  return dataUrls;
}

export function mimeForPath(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
  if (extension === ".bmp") return "image/bmp";
  if (extension === ".tif" || extension === ".tiff") return "image/tiff";
  if (extension === ".avif") return "image/avif";
  return "image/png";
}

export function thumbnailCacheName(filePath: string, modifiedAt: string, maxDimension: number): string {
  return `${createHash("sha256").update(`${filePath}\0${modifiedAt}\0${maxDimension}`).digest("hex")}.jpg`;
}

function isIgnoredDirectory(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized === ".git" || normalized === "node_modules" || normalized === "esse output" || normalized === ".esse";
}
