import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ensureDataPaths, resolveDataPaths } from "./paths.js";
import {
  CORE_PROTOCOL_VERSION,
  ensureCoreToken,
  readJsonLine,
  resolveCoreEndpoint,
  writeJsonLine,
  type CoreHandshakeRequest,
  type CoreHandshakeResponse
} from "./core/ipc.js";

declare const __ESSE_VERSION__: string;

async function runSelfTest(): Promise<void> {
  const pluginRoot = resolvePluginRoot();
  const paths = resolveDataPaths();
  await ensureDataPaths(paths);
  const [widgetHtml, manifestText] = await Promise.all([
    readFile(path.join(pluginRoot, "mcp", "widget.html"), "utf8"),
    readFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8")
  ]);
  const manifest = JSON.parse(manifestText) as { name?: string; version?: string };
  if (manifest.name !== "esse") throw new Error("Plugin manifest name is not esse.");
  if (manifest.version !== __ESSE_VERSION__) throw new Error(`Runtime version ${__ESSE_VERSION__} does not match manifest ${manifest.version}.`);
  if (widgetHtml.length < 10_000) throw new Error("Compiled Esse widget is missing or incomplete.");
  process.stdout.write(JSON.stringify({
    status: "ok",
    version: __ESSE_VERSION__,
    platform: process.platform,
    architecture: process.arch,
    widget: "ok",
    dataRoot: paths.root
  }));
}

async function main(): Promise<void> {
  if (process.argv.includes("--version")) {
    process.stdout.write(`${__ESSE_VERSION__}\n`);
    return;
  }
  if (process.argv.includes("--self-test")) {
    await runSelfTest();
    return;
  }

  const paths = resolveDataPaths();
  await ensureDataPaths(paths);
  const socket = await ensureCoreConnection(paths.root, resolvePluginRoot());
  process.stderr.write(`esse local MCP adapter ${__ESSE_VERSION__} connected. Data: ${paths.root}.\n`);
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
  process.stdin.once("end", () => socket.end());
  socket.once("error", (error) => {
    process.stderr.write(`esse Core connection failed: ${safeError(error)}\n`);
    process.exitCode = 1;
  });
}

async function ensureCoreConnection(dataRoot: string, pluginRoot: string): Promise<net.Socket> {
  const endpoint = resolveCoreEndpoint(dataRoot);
  const token = await ensureCoreToken(dataRoot);
  let spawned = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const result = await connectAndHandshake(endpoint, token);
      if (result.response.ok) return result.socket;
      result.socket.destroy();
      if (result.response.code === "VERSION_MISMATCH" && result.response.replaceable) {
        await delay(100);
        spawned = false;
        continue;
      }
      throw new Error(result.response.message || `Esse Core rejected the adapter (${result.response.code || "unknown"}).`);
    } catch (error) {
      if (!isRetryableConnectionError(error)) throw error;
      if (!spawned) {
        await spawnCore(pluginRoot);
        spawned = true;
      }
      await delay(100);
    }
  }
  throw new Error("Timed out waiting for the Esse Core process to become ready.");
}

async function connectAndHandshake(endpoint: string, token: string): Promise<{ socket: net.Socket; response: CoreHandshakeResponse }> {
  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const candidate = net.createConnection(endpoint);
    const timer = setTimeout(() => {
      candidate.destroy();
      reject(new Error("Timed out connecting to Esse Core."));
    }, 1_000);
    candidate.once("connect", () => {
      clearTimeout(timer);
      candidate.off("error", reject);
      resolve(candidate);
    });
    candidate.once("error", reject);
  });
  const request: CoreHandshakeRequest = {
    type: "esse-core-connect",
    protocolVersion: CORE_PROTOCOL_VERSION,
    pluginVersion: __ESSE_VERSION__,
    token,
    replaceIfIdle: true
  };
  await writeJsonLine(socket, request);
  const response = await readJsonLine(socket) as CoreHandshakeResponse;
  return { socket, response };
}

async function spawnCore(pluginRoot: string): Promise<void> {
  const command = await resolveCoreCommand(pluginRoot);
  const child = spawn(command.executable, command.args, {
    cwd: pluginRoot,
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    env: { ...process.env, ESSE_PLUGIN_ROOT: pluginRoot }
  });
  child.unref();
}

async function resolveCoreCommand(pluginRoot: string): Promise<{ executable: string; args: string[] }> {
  const compiledCore = path.join(pluginRoot, "bin", "esse-core.exe");
  const runningUnderNode = /^node(?:\.exe)?$/i.test(path.basename(process.execPath));
  if (process.platform === "win32" && !runningUnderNode) {
    if (!await exists(compiledCore)) throw new Error(`Esse Core executable is missing: ${compiledCore}`);
    return { executable: compiledCore, args: [] };
  }
  const coreScript = path.join(pluginRoot, "mcp", "core.cjs");
  if (!await exists(coreScript)) throw new Error(`Esse Core runtime is missing: ${coreScript}`);
  return { executable: process.execPath, args: [coreScript] };
}

async function exists(filePath: string): Promise<boolean> {
  return access(filePath).then(() => true, () => false);
}

function isRetryableConnectionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return ["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE"].includes(code || "") || /closed during handshake|Timed out connecting/u.test(safeError(error));
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " ").slice(0, 1000);
}

function resolvePluginRoot(): string {
  return path.resolve(process.env.ESSE_PLUGIN_ROOT || process.cwd());
}

main().catch((error) => {
  process.stderr.write(`esse failed to start: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
