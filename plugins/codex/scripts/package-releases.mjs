import { chmod, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const pluginRoot = process.cwd();
const marketplaceRoot = path.resolve(pluginRoot, "..", "..");
const releaseRoot = path.join(marketplaceRoot, "release");
const manifest = JSON.parse(await readFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
const version = manifest.version;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`Release version must be clean semver without build metadata: ${version}`);

const targetDefinitions = [
  { name: "windows-x64", bunTarget: "bun-windows-x64", binary: "esse.exe", coreBinary: "esse-core.exe", platform: "win32", architecture: "x64", runtime: "compiled" },
  { name: "macos-arm64", binary: "esse", platform: "darwin", architecture: "arm64", runtime: "codex-node" },
  { name: "macos-x64", binary: "esse", platform: "darwin", architecture: "x64", runtime: "codex-node" }
];
const targetOptionIndex = process.argv.indexOf("--target");
const requestedTarget = targetOptionIndex >= 0 ? process.argv[targetOptionIndex + 1] : undefined;
if (targetOptionIndex >= 0 && !requestedTarget) throw new Error("--target requires a target name.");
const targets = requestedTarget ? targetDefinitions.filter((target) => target.name === requestedTarget) : targetDefinitions;
if (!targets.length) throw new Error(`Unknown release target: ${requestedTarget}`);

await mkdir(releaseRoot, { recursive: true });
for (const entry of await readdir(releaseRoot, { withFileTypes: true })) {
  if (entry.isFile() && targets.some((target) => entry.name.startsWith(`esse-${target.name}-v`) && entry.name.endsWith(".zip"))) {
    await rm(path.join(releaseRoot, entry.name), { force: true });
  }
}

for (const target of targets) {
  const staging = path.join(releaseRoot, `.staging-${target.name}`);
  const stagedPlugin = path.join(staging, "plugins", "esse");
  const archiveName = `esse-${target.name}-v${version}.zip`;
  const archive = path.join(releaseRoot, archiveName);
  await rm(staging, { recursive: true, force: true });
  await mkdir(path.join(stagedPlugin, "bin"), { recursive: true });

  await Promise.all([
    copyPath(path.join(marketplaceRoot, ".agents"), path.join(staging, ".agents")),
    copyPath(path.join(marketplaceRoot, "README.md"), path.join(staging, "README.md")),
    copyPath(path.join(marketplaceRoot, "INSTALL.md"), path.join(staging, "INSTALL.md")),
    copyPath(path.join(marketplaceRoot, "LICENSE"), path.join(staging, "LICENSE")),
    copyPath(path.join(marketplaceRoot, "install.ps1"), path.join(staging, "install.ps1")),
    copyPath(path.join(marketplaceRoot, "install.sh"), path.join(staging, "install.sh")),
    copyPath(path.join(pluginRoot, ".codex-plugin"), path.join(stagedPlugin, ".codex-plugin")),
    copyPath(path.join(pluginRoot, ".mcp.json"), path.join(stagedPlugin, ".mcp.json")),
    copyPath(path.join(pluginRoot, "assets"), path.join(stagedPlugin, "assets")),
    copyPath(path.join(pluginRoot, "skills"), path.join(stagedPlugin, "skills")),
    copyPath(path.join(pluginRoot, "README.md"), path.join(stagedPlugin, "README.md")),
    copyPath(path.join(pluginRoot, "mcp", "server.cjs"), path.join(stagedPlugin, "mcp", "server.cjs")),
    copyPath(path.join(pluginRoot, "mcp", "core.cjs"), path.join(stagedPlugin, "mcp", "core.cjs")),
    copyPath(path.join(pluginRoot, "mcp", "widget.html"), path.join(stagedPlugin, "mcp", "widget.html"))
  ]);

  // Source checkouts use plugins/codex. Keep the historical plugins/esse
  // layout inside Plugin archives so existing installers and upgrades remain compatible.
  const stagedMarketplacePath = path.join(staging, ".agents", "plugins", "marketplace.json");
  const stagedMarketplace = JSON.parse(await readFile(stagedMarketplacePath, "utf8"));
  stagedMarketplace.plugins[0].source.path = "./plugins/esse";
  await writeFile(stagedMarketplacePath, `${JSON.stringify(stagedMarketplace, null, 2)}\n`, "utf8");

  const binaryPath = path.join(stagedPlugin, "bin", target.binary);
  if (target.runtime === "compiled") {
    await run("bun", ["build", path.join(pluginRoot, "mcp", "server.cjs"), "--compile", "--compile-exec-argv=--use-system-ca", `--target=${target.bunTarget}`, `--outfile=${binaryPath}`], pluginRoot);
    await run("bun", ["build", path.join(pluginRoot, "mcp", "core.cjs"), "--compile", "--compile-exec-argv=--use-system-ca", `--target=${target.bunTarget}`, `--outfile=${path.join(stagedPlugin, "bin", target.coreBinary)}`], pluginRoot);
  } else {
    await copyPath(path.join(pluginRoot, "scripts", "esse-macos-launcher.sh"), binaryPath);
    await chmod(binaryPath, 0o755);
  }

  const mcpCommand = target.runtime === "compiled"
    ? { command: "./bin/esse.exe", args: [], cwd: "." }
    : { command: "/bin/bash", args: ["./bin/esse"], cwd: "." };
  await writeFile(path.join(stagedPlugin, ".mcp.json"), `${JSON.stringify({ mcpServers: { esse: {
    title: "esse",
    description: "Local image folders, provider settings, parallel generation queues, previews, and follow-up edits.",
    ...mcpCommand
  } } }, null, 2)}\n`, "utf8");

  let selfTestedNatively = false;
  if (process.platform === target.platform && process.arch === target.architecture) {
    const selfTestData = path.join(staging, ".self-test-data");
    const selfTestCommand = target.runtime === "compiled" ? binaryPath : "/bin/bash";
    const selfTestArgs = target.runtime === "compiled" ? ["--self-test"] : [binaryPath, "--self-test"];
    const selfTest = await run(selfTestCommand, selfTestArgs, stagedPlugin, true, {
      ...process.env,
      ESSE_DATA_DIR: selfTestData,
      ...(target.runtime === "codex-node" ? { ESSE_NODE_BIN: process.execPath } : {})
    });
    if (!selfTest.includes('"status":"ok"')) throw new Error(`Packaged ${target.name} runtime self-test failed: ${selfTest}`);
    const coreSelfTestCommand = target.runtime === "compiled" ? path.join(stagedPlugin, "bin", target.coreBinary) : process.execPath;
    const coreSelfTestArgs = target.runtime === "compiled" ? ["--self-test"] : [path.join(stagedPlugin, "mcp", "core.cjs"), "--self-test"];
    const coreSelfTest = await run(coreSelfTestCommand, coreSelfTestArgs, stagedPlugin, true, {
      ...process.env,
      ESSE_DATA_DIR: selfTestData,
      ESSE_PLUGIN_ROOT: stagedPlugin
    });
    if (!coreSelfTest.includes('"status":"ok"') || !coreSelfTest.includes('"component":"core"')) throw new Error(`Packaged ${target.name} Core self-test failed: ${coreSelfTest}`);
    await rm(selfTestData, { recursive: true, force: true });
    selfTestedNatively = true;
  } else if (requestedTarget) {
    throw new Error(`Target ${target.name} must be packaged on ${target.platform}/${target.architecture}; current runner is ${process.platform}/${process.arch}.`);
  }
  await run("tar", ["-a", "-c", "-f", archive, "-C", staging, "."], marketplaceRoot);
  const listing = await run("tar", ["-t", "-f", archive], marketplaceRoot, true);
  const expectedEntries = [".agents/plugins/marketplace.json", "plugins/esse/.codex-plugin/plugin.json", `plugins/esse/bin/${target.binary}`, "plugins/esse/mcp/server.cjs", "plugins/esse/mcp/core.cjs", "install.ps1", "install.sh"];
  if (target.coreBinary) expectedEntries.push(`plugins/esse/bin/${target.coreBinary}`);
  for (const expected of expectedEntries) {
    if (!listing.replaceAll("\\", "/").includes(expected)) throw new Error(`${target.name} archive is missing ${expected}`);
  }
  await rm(staging, { recursive: true, force: true });
  console.log(`Packaged ${archiveName} on ${process.platform}/${process.arch}${selfTestedNatively ? " and self-tested it natively" : ""}`);
}

async function copyPath(source, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true });
}

function run(command, args, cwd, capture = false, env = process.env) {
  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ["ignore", capture ? "pipe" : "inherit", "pipe"] });
    if (capture) child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => { stderr.push(chunk); if (!capture) process.stderr.write(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `${command} exited with ${code}`));
    });
  });
}
