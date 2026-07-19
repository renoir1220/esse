import { randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { mimeForPath } from "./image-files.js";

interface RegisteredAsset {
  filePath: string;
  size: number;
  mtimeMs: number;
}

export interface LocalMediaServerLike {
  readonly origin: string;
  urlFor(filePath: string): Promise<string>;
  close(): Promise<void>;
}

export function describeLocalMediaStartupError(error: unknown, platform = process.platform): Error {
  const source = error instanceof Error ? error : new Error(String(error));
  const code = "code" in source && typeof source.code === "string" ? ` [${source.code}]` : "";
  return new Error(
    `Esse 无法启动本机原图直读服务，因此已停止启动（不会回退到慢速 Base64 预览）。` +
    `请确认安全软件和系统网络权限允许 Codex/ChatGPT 在 localhost 监听临时端口，然后完全重启桌面应用。` +
    `平台：${platform}；原因${code}：${source.message}`,
    { cause: source }
  );
}

export class LocalMediaServer implements LocalMediaServerLike {
  readonly origin: string;
  private readonly secret = randomBytes(32).toString("base64url");
  private readonly assets = new Map<string, RegisteredAsset>();
  private readonly assetIdsBySignature = new Map<string, string>();

  private constructor(private readonly server: ReturnType<typeof createServer>, port: number) {
    this.origin = `http://localhost:${port}`;
  }

  static async start(): Promise<LocalMediaServer> {
    let instance: LocalMediaServer | undefined;
    const server = createServer((request, response) => {
      if (!instance) {
        response.writeHead(503).end();
        return;
      }
      void instance.respond(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(0, "localhost", () => {
        server.off("error", onError);
        resolve();
      });
    });
    const address = server.address() as AddressInfo | null;
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Esse local media server did not receive a TCP port.");
    }
    instance = new LocalMediaServer(server, address.port);
    server.unref();
    return instance;
  }

  async urlFor(filePath: string): Promise<string> {
    const resolvedPath = path.resolve(filePath);
    const file = await stat(resolvedPath);
    if (!file.isFile()) throw new Error("Esse local media assets must be files.");
    const signature = `${resolvedPath}\0${file.size}\0${file.mtimeMs}`;
    let id = this.assetIdsBySignature.get(signature);
    if (!id) {
      id = randomUUID();
      this.assetIdsBySignature.set(signature, id);
      this.assets.set(id, { filePath: resolvedPath, size: file.size, mtimeMs: file.mtimeMs });
      this.trimAssets();
    }
    return `${this.origin}/media/${this.secret}/${id}/${encodeURIComponent(path.basename(resolvedPath))}`;
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((error) => error ? reject(error) : resolve());
    });
  }

  private async respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS") {
        this.finish(response, 405, { Allow: "GET, HEAD, OPTIONS" });
        return;
      }
      const url = new URL(request.url || "/", this.origin);
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length !== 4 || parts[0] !== "media" || parts[1] !== this.secret) {
        this.finish(response, 404);
        return;
      }
      const assetId = parts[2];
      if (!assetId) {
        this.finish(response, 404);
        return;
      }
      const asset = this.assets.get(assetId);
      if (!asset) {
        this.finish(response, 404);
        return;
      }
      if (request.method === "OPTIONS") {
        this.finish(response, 204, {
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Private-Network": "true"
        });
        return;
      }
      const current = await stat(asset.filePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!current) {
        this.finish(response, 410);
        return;
      }
      if (!current.isFile() || current.size !== asset.size || current.mtimeMs !== asset.mtimeMs) {
        this.finish(response, 410);
        return;
      }
      const commonHeaders = {
        "Accept-Ranges": "bytes",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Private-Network": "true",
        "Cache-Control": "private, no-store",
        "Content-Type": mimeForPath(asset.filePath),
        "Cross-Origin-Resource-Policy": "cross-origin",
        Expires: "0",
        Pragma: "no-cache",
        "X-Content-Type-Options": "nosniff"
      };
      const range = parseSingleRange(request.headers.range, asset.size);
      if (range === "invalid") {
        this.finish(response, 416, { ...commonHeaders, "Content-Range": `bytes */${asset.size}` });
        return;
      }
      const start = range?.start ?? 0;
      const end = range?.end ?? asset.size - 1;
      const status = range ? 206 : 200;
      response.writeHead(status, {
        ...commonHeaders,
        "Content-Length": String(Math.max(0, end - start + 1)),
        ...(range ? { "Content-Range": `bytes ${start}-${end}/${asset.size}` } : {})
      });
      if (request.method === "HEAD" || asset.size === 0) {
        response.end();
        return;
      }
      const stream = createReadStream(asset.filePath, { start, end });
      stream.on("error", () => {
        if (!response.headersSent) this.finish(response, 500);
        else response.destroy();
      });
      stream.pipe(response);
    } catch {
      this.finish(response, 500);
    }
  }

  private finish(response: ServerResponse, status: number, headers: Record<string, string> = {}): void {
    if (!response.headersSent) response.writeHead(status, { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", ...headers });
    response.end();
  }

  private trimAssets(): void {
    while (this.assets.size > 512) {
      const oldest = this.assets.entries().next().value as [string, RegisteredAsset] | undefined;
      if (!oldest) return;
      this.assets.delete(oldest[0]);
      const signature = `${oldest[1].filePath}\0${oldest[1].size}\0${oldest[1].mtimeMs}`;
      if (this.assetIdsBySignature.get(signature) === oldest[0]) this.assetIdsBySignature.delete(signature);
    }
  }
}

function parseSingleRange(value: string | undefined, size: number): { start: number; end: number } | "invalid" | undefined {
  if (!value) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || size <= 0) return "invalid";
  const [, startText, endText] = match;
  if (!startText && !endText) return "invalid";
  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return "invalid";
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }
  const start = Number(startText);
  const requestedEnd = endText ? Number(endText) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start >= size || requestedEnd < start) return "invalid";
  return { start, end: Math.min(requestedEnd, size - 1) };
}
