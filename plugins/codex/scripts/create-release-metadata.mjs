import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptsRoot = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptsRoot, "..");
const repositoryRoot = path.resolve(pluginRoot, "..", "..");
const releaseRoot = path.join(repositoryRoot, "release");
const manifest = JSON.parse(await readFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
const version = manifest.version;
const targets = [
  { name: "windows-x64", metadata: "windowsX64" },
  { name: "macos-arm64", metadata: "macosArm64" },
  { name: "macos-x64", metadata: "macosX64" }
];
const archives = [];
for (const target of targets) {
  const archiveName = `esse-${target.name}-v${version}.zip`;
  const archivePath = path.join(releaseRoot, archiveName);
  const content = await readFile(archivePath);
  archives.push({ ...target, archiveName, sha256: createHash("sha256").update(content).digest("hex") });
}
const sidecarTargets = [
  { name: "windows-x64", metadata: "windowsX64", extension: "exe" },
  { name: "macos-arm64", metadata: "macosArm64", extension: "dmg" },
  { name: "macos-x64", metadata: "macosX64", extension: "dmg" }
];
const sidecarAssets = [];
for (const target of sidecarTargets) {
  const assetName = `esse-agent-sidecar-${target.name}-v${version}.${target.extension}`;
  const content = await readFile(path.join(releaseRoot, assetName));
  sidecarAssets.push({ ...target, assetName, sha256: createHash("sha256").update(content).digest("hex") });
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
const sidecarMetadata = {
  schemaVersion: 1,
  repository: metadata.repository,
  version,
  tag: metadata.tag,
  distribution: "agent-sidecar"
};
for (const asset of sidecarAssets) {
  sidecarMetadata[`${asset.metadata}Asset`] = asset.assetName;
  sidecarMetadata[`${asset.metadata}Sha256`] = asset.sha256;
}
await writeFile(path.join(releaseRoot, "sidecar-latest.json"), `${JSON.stringify(sidecarMetadata, null, 2)}\n`, "utf8");
const checksumEntries = [
  ...archives.map((archive) => `${archive.sha256}  ${archive.archiveName}`),
  ...sidecarAssets.map((asset) => `${asset.sha256}  ${asset.assetName}`)
];
await writeFile(path.join(releaseRoot, "checksums.txt"), `${checksumEntries.join("\n")}\n`, "utf8");
console.log(`Created latest.json, sidecar-latest.json, and checksums.txt for v${version}`);
