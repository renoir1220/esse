import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

export interface SecretStore {
  get(id: string): Promise<string | undefined>;
  set(id: string, value: string): Promise<void>;
  delete(id: string): Promise<void>;
}

export function createSecretStore(secretsDir: string, platform = process.platform): SecretStore {
  if (platform === "win32") return new WindowsDpapiSecretStore(secretsDir);
  if (platform === "darwin") return new MacKeychainSecretStore();
  return new UnsupportedSecretStore(platform);
}

export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>();
  async get(id: string): Promise<string | undefined> { return this.values.get(id); }
  async set(id: string, value: string): Promise<void> { this.values.set(id, value); }
  async delete(id: string): Promise<void> { this.values.delete(id); }
}

class WindowsDpapiSecretStore implements SecretStore {
  constructor(private readonly secretsDir: string) {}

  async get(id: string): Promise<string | undefined> {
    try {
      const encrypted = await readFile(this.fileFor(id), "utf8");
      return await runPowerShell(DPAPI_DECRYPT, encrypted);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async set(id: string, value: string): Promise<void> {
    const encrypted = await runPowerShell(DPAPI_ENCRYPT, value);
    await writeFile(this.fileFor(id), encrypted, { encoding: "utf8", mode: 0o600 });
  }

  async delete(id: string): Promise<void> {
    await rm(this.fileFor(id), { force: true });
  }

  private fileFor(id: string): string {
    return path.join(this.secretsDir, `${safeSecretId(id)}.dpapi`);
  }
}

class MacKeychainSecretStore implements SecretStore {
  private readonly service = "com.renoir.esse.provider";

  async get(id: string): Promise<string | undefined> {
    try {
      return (await runProcess("security", ["find-generic-password", "-a", id, "-s", this.service, "-w"])).trim();
    } catch (error) {
      if ((error as ProcessError).exitCode === 44) return undefined;
      throw error;
    }
  }

  async set(id: string, value: string): Promise<void> {
    await runProcess("security", ["add-generic-password", "-U", "-a", id, "-s", this.service, "-w", value]);
  }

  async delete(id: string): Promise<void> {
    try {
      await runProcess("security", ["delete-generic-password", "-a", id, "-s", this.service]);
    } catch (error) {
      if ((error as ProcessError).exitCode !== 44) throw error;
    }
  }
}

class UnsupportedSecretStore implements SecretStore {
  constructor(private readonly platform: string) {}
  async get(): Promise<undefined> { return undefined; }
  async set(): Promise<void> { throw new Error(`Secure provider storage is not implemented for ${this.platform}.`); }
  async delete(): Promise<void> {}
}

interface ProcessError extends Error { exitCode?: number }

async function runPowerShell(script: string, stdin: string): Promise<string> {
  let lastError: unknown;
  for (const command of ["powershell.exe", "pwsh.exe"]) {
    try {
      return await runProcess(command, ["-NoProfile", "-NonInteractive", "-Command", script], stdin);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      lastError = error;
    }
  }
  throw lastError || new Error("PowerShell is required for Windows DPAPI storage.");
}

function runProcess(command: string, args: string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else {
        const error = new Error(Buffer.concat(stderr).toString("utf8").trim() || `${command} exited with code ${code}`) as ProcessError;
        error.exitCode = code ?? undefined;
        reject(error);
      }
    });
    child.stdin.end(stdin);
  });
}

function safeSecretId(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

const DPAPI_ENCRYPT = String.raw`$value=[Console]::In.ReadToEnd(); Add-Type -AssemblyName System.Security; $bytes=[Text.Encoding]::UTF8.GetBytes($value); $protected=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($protected))`;
const DPAPI_DECRYPT = String.raw`$value=[Console]::In.ReadToEnd(); Add-Type -AssemblyName System.Security; $bytes=[Convert]::FromBase64String($value.Trim()); $plain=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))`;
