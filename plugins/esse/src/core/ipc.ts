import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const CORE_PROTOCOL_VERSION = 1;
export const CORE_TOKEN_FILE = "core.token";
export const CORE_LOCK_FILE = "core.lock";
const HANDSHAKE_LIMIT_BYTES = 16 * 1024;

export interface CoreHandshakeRequest {
  type: "esse-core-connect";
  protocolVersion: number;
  pluginVersion: string;
  token: string;
  replaceIfIdle?: boolean;
}

export interface CoreHandshakeResponse {
  ok: boolean;
  protocolVersion: number;
  pluginVersion: string;
  code?: "UNAUTHORIZED" | "PROTOCOL_MISMATCH" | "VERSION_MISMATCH" | "CORE_BUSY";
  message?: string;
  replaceable?: boolean;
}

export function resolveCoreEndpoint(dataRoot: string, platform = process.platform): string {
  const identity = createHash("sha256").update(path.resolve(dataRoot).toLowerCase()).digest("hex").slice(0, 24);
  if (platform === "win32") return `\\\\.\\pipe\\esse-core-${identity}`;
  const localPath = path.join(dataRoot, "core.sock");
  if (Buffer.byteLength(localPath) <= 96) return localPath;
  return path.join(os.tmpdir(), `esse-core-${typeof process.getuid === "function" ? process.getuid() : "user"}-${identity}.sock`);
}

export async function ensureCoreToken(dataRoot: string): Promise<string> {
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const tokenPath = path.join(dataRoot, CORE_TOKEN_FILE);
  const generated = randomBytes(32).toString("base64url");
  try {
    await writeFile(tokenPath, `${generated}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await chmod(tokenPath, 0o600).catch(() => undefined);
    return generated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const token = (await readFile(tokenPath, "utf8").catch(() => "")).trim();
    if (/^[A-Za-z0-9_-]{40,}$/.test(token)) return token;
    await delay(20);
  }
  throw new Error(`Esse Core token is missing or invalid: ${tokenPath}`);
}

export async function acquireCoreLock(dataRoot: string, pluginVersion: string): Promise<CoreLock | undefined> {
  const lockPath = path.join(dataRoot, CORE_LOCK_FILE);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, pluginVersion, createdAt: new Date().toISOString() })}\n`, "utf8");
      await handle.sync();
      return new CoreLock(lockPath, handle);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = await readLockOwner(lockPath);
      if (owner?.pid && processIsAlive(owner.pid)) return undefined;
      await rm(lockPath, { force: true });
    }
  }
  return undefined;
}

export class CoreLock {
  constructor(private readonly lockPath: string, private readonly handle: Awaited<ReturnType<typeof open>>) {}

  async release(): Promise<void> {
    await this.handle.close().catch(() => undefined);
    await rm(this.lockPath, { force: true });
  }
}

export function readJsonLine(socket: net.Socket, timeoutMs = 5_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error("Timed out waiting for Esse Core handshake.")), timeoutMs);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > HANDSHAKE_LIMIT_BYTES) return finish(new Error("Esse Core handshake exceeded the size limit."));
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) return;
      const line = buffered.toString("utf8", 0, newline).replace(/\r$/, "");
      const remainder = buffered.subarray(newline + 1);
      try {
        const parsed = JSON.parse(line) as unknown;
        cleanup();
        if (remainder.length) socket.unshift(remainder);
        resolve(parsed);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const onError = (error: Error) => finish(error);
    const onClose = () => finish(new Error("Esse Core connection closed during handshake."));
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const finish = (error: Error) => {
      cleanup();
      reject(error);
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

export function writeJsonLine(socket: net.Socket, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(`${JSON.stringify(value)}\n`, "utf8", (error) => error ? reject(error) : resolve());
  });
}

async function readLockOwner(lockPath: string): Promise<{ pid?: number } | undefined> {
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown };
    return { pid: typeof parsed.pid === "number" ? parsed.pid : undefined };
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
