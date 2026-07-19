import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { mimeForPath } from "./image-files.js";

export const MAX_ORIGINAL_IMAGE_BYTES = 60 * 1024 * 1024;
export const ORIGINAL_IMAGE_RESOURCE_TEMPLATE = "esse-image://original/{token}";

interface RegisteredImage {
  filePath: string;
  size: number;
  mtimeMs: number;
  signature: string;
}

export interface OriginalImageResource {
  mimeType: string;
  blob: string;
  sizeBytes: number;
}

export class OriginalImageRegistry {
  private readonly images = new Map<string, RegisteredImage>();
  private readonly tokensBySignature = new Map<string, string>();

  async register(filePath: string): Promise<string> {
    const resolvedPath = path.resolve(filePath);
    const file = await stat(resolvedPath);
    if (!file.isFile()) throw new Error("Esse original image resource must be a file.");
    if (file.size > MAX_ORIGINAL_IMAGE_BYTES) throw new Error("原图超过 60 MB，无法在 Esse 中打开。");

    const signature = `${resolvedPath}\0${file.size}\0${file.mtimeMs}`;
    let token = this.tokensBySignature.get(signature);
    if (!token) {
      token = randomUUID();
      this.tokensBySignature.set(signature, token);
      this.images.set(token, { filePath: resolvedPath, size: file.size, mtimeMs: file.mtimeMs, signature });
      this.trim();
    }
    return `esse-image://original/${token}`;
  }

  async read(token: string): Promise<OriginalImageResource> {
    const image = this.images.get(token);
    if (!image) throw new Error("原图读取凭据已失效，请关闭预览后重试。");

    const current = await stat(image.filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!current) throw new Error("原图文件已被删除。");
    if (!current.isFile() || current.size !== image.size || current.mtimeMs !== image.mtimeMs) {
      throw new Error("原图文件已发生变化，请关闭预览后重试。");
    }
    if (current.size > MAX_ORIGINAL_IMAGE_BYTES) throw new Error("原图超过 60 MB，无法在 Esse 中打开。");

    const bytes = await readFile(image.filePath);
    if (bytes.length !== image.size) throw new Error("原图读取不完整，请重试。");
    return { mimeType: mimeForPath(image.filePath), blob: bytes.toString("base64"), sizeBytes: bytes.length };
  }

  private trim(): void {
    while (this.images.size > 512) {
      const oldest = this.images.entries().next().value as [string, RegisteredImage] | undefined;
      if (!oldest) return;
      this.images.delete(oldest[0]);
      if (this.tokensBySignature.get(oldest[1].signature) === oldest[0]) this.tokensBySignature.delete(oldest[1].signature);
    }
  }
}
