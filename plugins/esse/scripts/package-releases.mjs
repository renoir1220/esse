import { chmod, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";

const pluginRoot = process.cwd();
const marketplaceRoot = path.resolve(pluginRoot, "..", "..");
const releaseRoot = path.join(marketplaceRoot, "release");
const manifest = JSON.parse(await readFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
const version = manifest.version;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`Release version must be clean semver without build metadata: ${version}`);

const targets = [
  { name: "windows-x64", metadata: "windowsX64", bunTarget: "bun-windows-x64", binary: "esse.exe" },
  { name: "macos-arm64", metadata: "macosArm64", bunTarget: "bun-darwin-arm64", binary: "esse" },
  { name: "macos-x64", metadata: "macosX64", bunTarget: "bun-darwin-x64", binary: "esse" }
];

await mkdir(releaseRoot, { recursive: true });
for (const entry of await readdir(releaseRoot, { withFileTypes: true })) {
  if (entry.isFile() && (/^esse-(?:windows|macos)-.+\.zip$/.test(entry.name) || entry.name === "checksums.txt" || entry.name === "latest.json")) {
    await rm(path.join(releaseRoot, entry.name), { force: true });
  }
}

const archives = [];
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
    copyPath(path.join(pluginRoot, "mcp", "widget.html"), path.join(stagedPlugin, "mcp", "widget.html"))
  ]);

  const binaryPath = path.join(stagedPlugin, "bin", target.binary);
  await run("bun", ["build", path.join(pluginRoot, "mcp", "server.cjs"), "--compile", "--compile-exec-argv=--use-system-ca", `--target=${target.bunTarget}`, `--outfile=${binaryPath}`], pluginRoot);
  if (target.name.startsWith("macos")) await chmod(binaryPath, 0o755);
  if (target.name === "windows-x64" && process.platform === "win32") {
    const selfTestData = path.join(staging, ".self-test-data");
    const selfTest = await run(binaryPath, ["--self-test"], stagedPlugin, true, { ...process.env, ESSE_DATA_DIR: selfTestData });
    if (!selfTest.includes('"status":"ok"')) throw new Error(`Compiled Windows runtime self-test failed: ${selfTest}`);
    await rm(selfTestData, { recursive: true, force: true });
  }
  await run("tar", ["-a", "-c", "-f", archive, "-C", staging, "."], marketplaceRoot);
  const listing = await run("tar", ["-t", "-f", archive], marketplaceRoot, true);
  for (const expected of [".agents/plugins/marketplace.json", "plugins/esse/.codex-plugin/plugin.json", `plugins/esse/bin/${target.binary}`, "install.ps1", "install.sh"]) {
    if (!listing.replaceAll("\\", "/").includes(expected)) throw new Error(`${target.name} archive is missing ${expected}`);
  }
  const sha256 = await hashFile(archive);
  archives.push({ ...target, archiveName, sha256 });
  await rm(staging, { recursive: true, force: true });
  console.log(`Packaged ${archiveName}`);
}

const metadata = {
  schemaVersion: 1,
  repository: "https://github.com/renoir1220/esse",
  version,
  tag: `v${version}`
};
for (const archive of archives) {
  metadata[`${archive.metadata}Asset`] = archive.archiveName;
  metadata[`${archive.metadata}Sha256`] = archive.sha256;
}
await writeFile(path.join(releaseRoot, "latest.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
await writeFile(path.join(releaseRoot, "checksums.txt"), `${archives.map((archive) => `${archive.sha256}  ${archive.archiveName}`).join("\n")}\n`, "utf8");
console.log(`Created latest.json and checksums.txt for v${version}`);

async function copyPath(source, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true });
}

async function hashFile(filePath) {
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
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
