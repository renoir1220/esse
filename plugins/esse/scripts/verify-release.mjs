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

assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "plugin version must be release semver without build metadata");
assert.equal(packageJson.version, manifest.version, "package.json and plugin.json versions must match");
if (expectedTag) assert.equal(expectedTag, `v${manifest.version}`, "Git tag must match the plugin version");
assert.equal(manifest.repository, "https://github.com/renoir1220/esse");
assert.equal(marketplace.name, "esse-local");
assert.equal(marketplace.plugins[0].source.path, "./plugins/esse");
assert(installGuide.includes("ESSE_INSTALL_RESULT"));
assert(windowsInstaller.includes("latest.json") && windowsInstaller.includes("ESSE_INSTALL_RESULT"));
assert(macInstaller.includes("latest.json") && macInstaller.includes("ESSE_INSTALL_RESULT"));
await Promise.all([
  access(path.join(repositoryRoot, "AGENTS.md")),
  access(path.join(repositoryRoot, "LICENSE")),
  access(path.join(pluginRoot, "mcp", "widget.html"))
]);

console.log(JSON.stringify({ status: "ok", version: manifest.version, tag: expectedTag || null, marketplace: marketplace.name }));
