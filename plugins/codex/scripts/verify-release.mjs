import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

const pluginRoot = process.cwd();
const repositoryRoot = path.resolve(pluginRoot, "..", "..");
const expectedTag = process.argv[2];
const manifest = JSON.parse(await readFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
const packageJson = JSON.parse(await readFile(path.join(pluginRoot, "package.json"), "utf8"));
const marketplace = JSON.parse(await readFile(path.join(repositoryRoot, ".agents", "plugins", "marketplace.json"), "utf8"));
const installGuide = await readFile(path.join(repositoryRoot, "INSTALL.md"), "utf8");
const windowsInstaller = await readFile(path.join(repositoryRoot, "install.ps1"), "utf8");
const macInstaller = await readFile(path.join(repositoryRoot, "install.sh"), "utf8");
const macLauncher = await readFile(path.join(pluginRoot, "scripts", "esse-macos-launcher.sh"), "utf8");
const packageScript = await readFile(path.join(pluginRoot, "scripts", "package-releases.mjs"), "utf8");
const releaseWorkflow = await readFile(path.join(repositoryRoot, ".github", "workflows", "release.yml"), "utf8");

assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "plugin version must be release semver without build metadata");
assert.equal(packageJson.version, manifest.version, "package.json and plugin.json versions must match");
if (expectedTag) assert.equal(expectedTag, `v${manifest.version}`, "Git tag must match the plugin version");
assert.equal(manifest.repository, "https://github.com/renoir1220/esse");
assert.equal(marketplace.name, "esse-local");
assert.equal(marketplace.plugins[0].source.path, "./plugins/codex");
assert(installGuide.includes("ESSE_INSTALL_RESULT"));
assert(windowsInstaller.includes("latest.json") && windowsInstaller.includes("ESSE_INSTALL_RESULT"));
assert(macInstaller.includes("latest.json") && macInstaller.includes("ESSE_INSTALL_RESULT"));
assert(macInstaller.includes("Gatekeeper-approved") && macInstaller.includes("will not execute an arbitrary 'codex' command from PATH"));
assert(macInstaller.includes("is_safe_macos_launcher") && macInstaller.includes("/bin/bash \"$PACKAGE_LAUNCHER\" --self-test"));
assert(macLauncher.includes("codex-primary-runtime/dependencies/node/bin/node"));
assert(macLauncher.includes("codesign --verify --strict") && macLauncher.includes("spctl --assess --type execute") && !macLauncher.includes("command -v node"));
assert(packageScript.includes('runtime: "codex-node"') && packageScript.includes('command: "/bin/bash"'));
assert(releaseWorkflow.includes("macOS package must not contain an Esse-built Mach-O launcher"));
assert(releaseWorkflow.includes("--prerelease"), "prerelease tags must not replace the latest stable GitHub Release");
await Promise.all([
  access(path.join(repositoryRoot, "AGENTS.md")),
  access(path.join(repositoryRoot, "LICENSE")),
  access(path.join(pluginRoot, "mcp", "widget.html")),
  access(path.join(pluginRoot, "mcp", "core.cjs"))
]);

console.log(JSON.stringify({ status: "ok", version: manifest.version, tag: expectedTag || null, marketplace: marketplace.name }));
