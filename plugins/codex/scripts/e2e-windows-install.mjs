import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error(`Windows installation E2E requires win32/x64; current host is ${process.platform}/${process.arch}.`);
}

const scriptsRoot = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptsRoot, "..");
const repositoryRoot = path.resolve(pluginRoot, "..", "..");
const releaseRoot = path.join(repositoryRoot, "release");
const manifest = JSON.parse(await readFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
const archiveName = `esse-windows-x64-v${manifest.version}.zip`;
const archivePath = path.join(releaseRoot, archiveName);
await stat(archivePath);

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "esse-windows-e2e-"));
const packageRoot = path.join(temporaryRoot, "package");
const installRoot = path.join(temporaryRoot, "installed");
const dataRoot = path.join(temporaryRoot, "data");
const fakeCodexLog = path.join(temporaryRoot, "fake-codex.log");
const onePixelPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=", "base64");

try {
  await mkdir(packageRoot, { recursive: true });
  await run("tar.exe", ["-xf", archivePath, "-C", packageRoot], repositoryRoot);
  const installer = path.join(packageRoot, "install.ps1");
  const installerBytes = await readFile(installer);
  assert(installerBytes.every((byte) => byte < 0x80), "install.ps1 must remain ASCII-compatible for Windows PowerShell 5 system code pages.");
  const fakeCodex = path.join(pluginRoot, "test", "fixtures", "fake-codex.ps1");
  const install = await runInstaller(installer, fakeCodex);
  const resultLine = install.stdout.split(/\r?\n/u).find((line) => line.startsWith("ESSE_INSTALL_RESULT="));
  assert(resultLine, `Installer did not emit ESSE_INSTALL_RESULT:\n${install.stdout}\n${install.stderr}`);
  const installResult = JSON.parse(resultLine.slice("ESSE_INSTALL_RESULT=".length));
  assert.deepEqual(
    { status: installResult.status, version: installResult.version, marketplace: installResult.marketplace, restartRequired: installResult.restartRequired },
    { status: "installed", version: manifest.version, marketplace: "esse-local", restartRequired: true },
  );

  const receipt = JSON.parse(await readFile(path.join(installRoot, "install-receipt.json"), "utf8"));
  assert.equal(receipt.version, manifest.version);
  const installedPlugin = path.resolve(receipt.pluginPath);
  const installedBinary = path.join(installedPlugin, "bin", "esse.exe");
  const installedCoreBinary = path.join(installedPlugin, "bin", "esse-core.exe");
  const packagedBinary = path.join(packageRoot, "plugins", "esse", "bin", "esse.exe");
  const packagedCoreBinary = path.join(packageRoot, "plugins", "esse", "bin", "esse-core.exe");
  assert.equal(await sha256(installedBinary), await sha256(packagedBinary), "Installed runtime must match the verified package runtime.");
  assert.equal(await sha256(installedCoreBinary), await sha256(packagedCoreBinary), "Installed Core must match the verified package Core.");

  const version = await run(installedBinary, ["--version"], installedPlugin);
  assert.equal(version.stdout.trim(), manifest.version);
  const selfTest = await run(installedBinary, ["--self-test"], installedPlugin, { env: { ...process.env, ESSE_DATA_DIR: dataRoot } });
  assert.equal(JSON.parse(selfTest.stdout).status, "ok");
  const coreSelfTest = await run(installedCoreBinary, ["--self-test"], installedPlugin, { env: { ...process.env, ESSE_DATA_DIR: dataRoot, ESSE_PLUGIN_ROOT: installedPlugin } });
  assert.equal(JSON.parse(coreSelfTest.stdout).component, "core");

  const transport = new StdioClientTransport({
    command: installedBinary,
    args: [],
    cwd: installedPlugin,
    env: { ...process.env, ESSE_DATA_DIR: dataRoot, ESSE_CORE_IDLE_MS: "100" },
  });
  const secondTransport = new StdioClientTransport({
    command: installedBinary,
    args: [],
    cwd: installedPlugin,
    env: { ...process.env, ESSE_DATA_DIR: dataRoot, ESSE_CORE_IDLE_MS: "100" },
  });
  const client = new Client({ name: "esse-windows-install-e2e", version: "1.0.0" });
  const secondClient = new Client({ name: "esse-windows-install-e2e-second", version: "1.0.0" });
  try {
    await Promise.all([client.connect(transport), secondClient.connect(secondTransport)]);
    const tools = await client.listTools();
    assert(tools.tools.some((tool) => tool.name === "open_esse"));
    const opened = await client.callTool({ name: "open_esse", arguments: { tab: "settings" } });
    const state = opened.structuredContent?.state;
    assert(state && typeof state === "object");

    const defaultResult = await client.callTool({ name: "ui_set_default_offering", arguments: { offeringId: "esse-codex-generation" } });
    assert.equal(defaultResult.isError, undefined);
    const sharedArguments = { title: "Windows multi-client E2E", prompt: "one shared batch", count: 1, requestKey: "windows-install-multi-client-e2e" };
    const [firstShared, secondShared] = await Promise.all([
      client.callTool({ name: "create_image_batch", arguments: sharedArguments }),
      secondClient.callTool({ name: "create_image_batch", arguments: sharedArguments }),
    ]);
    assert.equal(secondShared.structuredContent?.batch?.id, firstShared.structuredContent?.batch?.id, "Installed adapters must share one idempotent Core.");
    const created = await client.callTool({ name: "create_image_batch", arguments: { title: "Windows E2E", prompt: "one pixel", count: 1, requestKey: "windows-install-e2e" } });
    const batch = created.structuredContent?.batch;
    assert(batch && typeof batch === "object");
    const batchId = batch.id;
    const jobId = batch.jobs?.[0]?.id;
    assert.equal(typeof batchId, "string");
    assert.equal(typeof jobId, "string");

    await client.callTool({ name: "start_agent_image_job", arguments: { batchId, jobId } });
    const agentOutput = path.join(temporaryRoot, "agent-output.png");
    await writeFile(agentOutput, onePixelPng);
    const completed = await client.callTool({ name: "complete_agent_image_job", arguments: { batchId, jobId, imagePath: agentOutput } });
    assert.equal(completed.structuredContent?.job?.status, "succeeded");
    const original = await client.callTool({ name: "ui_get_original_image_resource", arguments: { batchId, jobId } });
    const resourceUri = original._meta?.resourceUri;
    assert.equal(typeof resourceUri, "string");
    const resource = await client.readResource({ uri: resourceUri });
    assert.deepEqual(Buffer.from(resource.contents[0].blob, "base64"), onePixelPng);
  } finally {
    await Promise.all([
      client.close().catch(() => undefined),
      secondClient.close().catch(() => undefined),
    ]);
    await delay(300);
  }

  const fakeCalls = await readFile(fakeCodexLog, "utf8");
  for (const expected of ["plugin marketplace list", "plugin marketplace add", "plugin add esse@esse-local", "plugin list"]) {
    assert(fakeCalls.includes(expected), `Installer did not exercise registration command: ${expected}`);
  }

  const installedWidget = path.join(installedPlugin, "mcp", "widget.html");
  const packagedWidget = path.join(packageRoot, "plugins", "esse", "mcp", "widget.html");
  await writeFile(installedWidget, "corrupt same-version widget", "utf8");
  await Promise.all([
    mkdir(path.join(installRoot, "versions", "0.0.1"), { recursive: true }),
    mkdir(path.join(installRoot, "versions", "0.0.2"), { recursive: true })
  ]);
  const repair = await runInstaller(installer, fakeCodex);
  assert(repair.stdout.includes('"status":"installed"'), "Same-version repair did not complete successfully.");
  assert.equal(await sha256(installedWidget), await sha256(packagedWidget), "Same-version reinstall must repair changed installed files.");
  const installedVersions = await readdir(path.join(installRoot, "versions"));
  assert.deepEqual(installedVersions, [manifest.version]);
  console.log(JSON.stringify({ status: "ok", version: manifest.version, archive: archiveName, install: "ok", registration: "ok", installedStdio: "ok", installedMultiClientCore: "ok", originalResource: "ok", sameVersionRepair: "ok", versionCleanup: "ok" }));
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function sha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function run(command, args, cwd, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: options.env || process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
      if (code === 0) resolve(result);
      else reject(new Error(`${command} exited with ${code}: ${result.stderr || result.stdout}`));
    });
  });
}

function runInstaller(installer, fakeCodex) {
  return run("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", installer,
    "-InstallRoot", installRoot,
    "-CodexCommand", fakeCodex,
  ], repositoryRoot, {
    env: {
      ...process.env,
      ESSE_FAKE_PLUGIN_VERSION: manifest.version,
      ESSE_FAKE_CODEX_LOG: fakeCodexLog,
    },
  });
}
