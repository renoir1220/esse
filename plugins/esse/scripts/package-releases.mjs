import { chmod, cp, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const pluginRoot = process.cwd();
const marketplaceRoot = path.resolve(pluginRoot, "..", "..");
const releaseRoot = path.join(marketplaceRoot, "release");
const manifest = JSON.parse(await readFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
const version = manifest.version.split("+")[0];

const targets = [
  { name: "windows-x64", bunTarget: "bun-windows-x64", binary: "esse.exe" },
  { name: "macos-arm64", bunTarget: "bun-darwin-arm64", binary: "esse" },
  { name: "macos-x64", bunTarget: "bun-darwin-x64", binary: "esse" }
];

await mkdir(releaseRoot, { recursive: true });
await Promise.all([
  "image-workbench-windows-x64-v0.1.0.zip",
  "image-workbench-macos-arm64-v0.1.0.zip",
  "image-workbench-macos-x64-v0.1.0.zip"
].map((name) => rm(path.join(releaseRoot, name), { force: true })));
for (const target of targets) {
  const staging = path.join(releaseRoot, `.staging-${target.name}`);
  const stagedPlugin = path.join(staging, "plugins", "esse");
  const archive = path.join(releaseRoot, `esse-${target.name}-v${version}.zip`);
  await rm(staging, { recursive: true, force: true });
  await rm(archive, { force: true });
  await mkdir(path.join(stagedPlugin, "bin"), { recursive: true });

  await Promise.all([
    copyPath(path.join(marketplaceRoot, ".agents"), path.join(staging, ".agents")),
    copyPath(path.join(marketplaceRoot, "README.md"), path.join(staging, "README.md")),
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
  await run("tar", ["-a", "-c", "-f", archive, "-C", staging, "."], marketplaceRoot);
  const listing = await run("tar", ["-t", "-f", archive], marketplaceRoot, true);
  for (const expected of [".agents/plugins/marketplace.json", "plugins/esse/.codex-plugin/plugin.json", `plugins/esse/bin/${target.binary}`]) {
    if (!listing.replaceAll("\\", "/").includes(expected)) throw new Error(`${target.name} archive is missing ${expected}`);
  }
  await rm(staging, { recursive: true, force: true });
  console.log(`Packaged ${path.basename(archive)}`);
}

async function copyPath(source, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true });
}

function run(command, args, cwd, capture = false) {
  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ["ignore", capture ? "pipe" : "inherit", "pipe"] });
    if (capture) child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => { stderr.push(chunk); if (!capture) process.stderr.write(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `${command} exited with ${code}`));
    });
  });
}
