import { appendFile, chmod, readFile, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { ensureDataPaths, resolveDataPaths } from "./paths.js";
import { createSecretStore } from "./storage/secret-store.js";
import { SettingsStore } from "./storage/settings-store.js";
import { BatchStore } from "./storage/batch-store.js";
import { ProviderRegistry } from "./providers/registry.js";
import { BatchManager } from "./jobs/batch-manager.js";
import { Thumbnailer } from "./files/thumbnailer.js";
import { pruneThumbnailCache } from "./files/thumbnail-cache.js";
import { createLocalEsseServer } from "./mcp/app.js";
import { GitHubReleaseChecker } from "./update-checker.js";
import {
  CORE_PROTOCOL_VERSION,
  acquireCoreLock,
  ensureCoreToken,
  readJsonLine,
  resolveCoreEndpoint,
  writeJsonLine,
  type CoreHandshakeRequest,
  type CoreHandshakeResponse
} from "./core/ipc.js";
import { SocketServerTransport } from "./core/socket-transport.js";

declare const __ESSE_VERSION__: string;

async function main(): Promise<void> {
  if (process.argv.includes("--version")) {
    process.stdout.write(`${__ESSE_VERSION__}\n`);
    return;
  }

  const pluginRoot = resolvePluginRoot();
  const paths = resolveDataPaths();
  await ensureDataPaths(paths);
  const endpoint = resolveCoreEndpoint(paths.root);
  if (process.argv.includes("--self-test")) {
    const widgetHtml = await readFile(path.join(pluginRoot, "mcp", "widget.html"), "utf8");
    if (widgetHtml.length < 10_000) throw new Error("Compiled Esse widget is missing or incomplete.");
    process.stdout.write(JSON.stringify({ status: "ok", component: "core", version: __ESSE_VERSION__, endpoint }));
    return;
  }

  const lock = await acquireCoreLock(paths.root, __ESSE_VERSION__);
  if (!lock) return;

  let server: net.Server | undefined;
  let shuttingDown = false;
  let connectedClients = 0;
  let idleTimer: NodeJS.Timeout | undefined;
  const idleMs = resolveIdleMs(process.env.ESSE_CORE_IDLE_MS);
  const logPath = path.join(paths.root, "core.log");
  const log = async (message: string) => {
    await appendFile(logPath, `${new Date().toISOString()} ${message}\n`, { encoding: "utf8", mode: 0o600 }).catch(() => undefined);
  };

  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (idleTimer) clearTimeout(idleTimer);
    await log(`stopping pid=${process.pid} reason=${reason}`);
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    if (process.platform !== "win32") await rm(endpoint, { force: true }).catch(() => undefined);
    await lock.release();
  };

  try {
    const cachePrune = await pruneThumbnailCache(paths.thumbnailsDir).catch(() => undefined);
    const settings = new SettingsStore(paths.settingsFile, createSecretStore(paths.secretsDir));
    const registry = new ProviderRegistry(settings);
    const batches = new BatchManager(new BatchStore(paths.batchesDir), registry, paths);
    await batches.initialize();
    const thumbnailer = new Thumbnailer(paths);
    const updateChecker = new GitHubReleaseChecker();
    const widgetHtml = await readFile(path.join(pluginRoot, "mcp", "widget.html"), "utf8");
    const token = await ensureCoreToken(paths.root);

    const scheduleIdleCheck = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (connectedClients === 0 && !batches.hasActiveProviderJobs()) {
          void shutdown("idle").then(() => process.exit(0));
        } else scheduleIdleCheck();
      }, idleMs);
      idleTimer.unref();
    };

    server = net.createServer((socket) => {
      socket.setNoDelay(true);
      void acceptClient(socket, {
        token,
        connectedClients: () => connectedClients,
        hasActiveProviderJobs: () => batches.hasActiveProviderJobs(),
        onAccepted: () => {
          connectedClients += 1;
          if (idleTimer) clearTimeout(idleTimer);
        },
        onClosed: () => {
          connectedClients = Math.max(0, connectedClients - 1);
          scheduleIdleCheck();
        },
        replaceWhenIdle: () => {
          void shutdown("version-replacement").then(() => process.exit(0));
        },
        createServer: () => createLocalEsseServer({
          version: __ESSE_VERSION__,
          widgetHtml,
          settings,
          registry,
          batches,
          thumbnailer,
          updateChecker
        })
      }).catch(async (error) => {
        await log(`client-error ${safeError(error)}`);
        socket.destroy();
      });
    });
    server.on("error", (error) => void log(`server-error ${safeError(error)}`));
    if (process.platform !== "win32") await rm(endpoint, { force: true }).catch(() => undefined);
    await listen(server, endpoint);
    if (process.platform !== "win32") await chmod(endpoint, 0o600);
    await log(`ready pid=${process.pid} version=${__ESSE_VERSION__} cachePruned=${cachePrune?.removed || 0}`);
    scheduleIdleCheck();

    const stop = (signal: string) => void shutdown(signal).then(() => process.exit(0));
    process.once("SIGINT", () => stop("SIGINT"));
    process.once("SIGTERM", () => stop("SIGTERM"));
  } catch (error) {
    await log(`fatal ${safeError(error)}`);
    if (process.platform !== "win32") await rm(endpoint, { force: true }).catch(() => undefined);
    await lock.release();
    throw error;
  }
}

async function acceptClient(socket: net.Socket, options: {
  token: string;
  connectedClients(): number;
  hasActiveProviderJobs(): boolean;
  onAccepted(): void;
  onClosed(): void;
  replaceWhenIdle(): void;
  createServer(): ReturnType<typeof createLocalEsseServer>;
}): Promise<void> {
  const request = await readJsonLine(socket) as Partial<CoreHandshakeRequest>;
  let response: CoreHandshakeResponse;
  if (request.type !== "esse-core-connect" || request.token !== options.token) {
    response = failure("UNAUTHORIZED", "Esse Core rejected the local client.");
  } else if (request.protocolVersion !== CORE_PROTOCOL_VERSION) {
    response = failure("PROTOCOL_MISMATCH", `Esse Core protocol ${CORE_PROTOCOL_VERSION} is incompatible with adapter protocol ${String(request.protocolVersion)}.`);
  } else if (request.pluginVersion !== __ESSE_VERSION__) {
    const replaceable = options.connectedClients() === 0 && !options.hasActiveProviderJobs();
    response = {
      ...failure(replaceable ? "VERSION_MISMATCH" : "CORE_BUSY", `Esse Core ${__ESSE_VERSION__} does not match adapter ${String(request.pluginVersion)}.`),
      replaceable
    };
    await writeJsonLine(socket, response);
    socket.end();
    if (replaceable && request.replaceIfIdle) setTimeout(options.replaceWhenIdle, 20).unref();
    return;
  } else {
    response = { ok: true, protocolVersion: CORE_PROTOCOL_VERSION, pluginVersion: __ESSE_VERSION__ };
  }
  await writeJsonLine(socket, response);
  if (!response.ok) {
    socket.end();
    return;
  }

  options.onAccepted();
  socket.once("close", options.onClosed);
  const mcp = options.createServer();
  await mcp.connect(new SocketServerTransport(socket));
}

function failure(code: NonNullable<CoreHandshakeResponse["code"]>, message: string): CoreHandshakeResponse {
  return { ok: false, protocolVersion: CORE_PROTOCOL_VERSION, pluginVersion: __ESSE_VERSION__, code, message };
}

function listen(server: net.Server, endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(endpoint);
  });
}

function resolveIdleMs(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(100, Math.trunc(parsed)) : 5 * 60_000;
}

function resolvePluginRoot(): string {
  return path.resolve(process.env.ESSE_PLUGIN_ROOT || process.cwd());
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " ").slice(0, 1000);
}

main().catch((error) => {
  process.stderr.write(`esse-core failed: ${safeError(error)}\n`);
  process.exitCode = 1;
});
