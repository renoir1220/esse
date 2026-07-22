import assert from 'node:assert/strict';
import { copyFile, mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsRoot = path.dirname(fileURLToPath(import.meta.url));
const sidecarRoot = path.resolve(scriptsRoot, '..');
const repositoryRoot = path.resolve(sidecarRoot, '..', '..');
const releaseRoot = path.join(repositoryRoot, 'release');
const packageJson = JSON.parse(await readFile(path.join(sidecarRoot, 'package.json'), 'utf8'));
const product = JSON.parse(await readFile(path.join(sidecarRoot, 'product.json'), 'utf8'));
const options = { platform: process.argv[2], arch: process.argv[3] };

assert.equal(options.arch === 'arm64' || options.arch === 'x64', true, `Unsupported architecture: ${options.arch}`);
await mkdir(releaseRoot, { recursive: true });

let source;
let assetName;
if (options.platform === 'windows') {
  assert.equal(process.platform, 'win32', 'Windows release staging must run on Windows.');
  source = path.join(sidecarRoot, 'out', 'make', 'squirrel.windows', options.arch, product.windowsSetupExe);
  assetName = `${product.releasePrefix}-windows-${options.arch}-v${packageJson.version}.exe`;
} else if (options.platform === 'macos') {
  assert.equal(process.platform, 'darwin', 'macOS release staging must run on macOS.');
  const dmgs = await findFiles(path.join(sidecarRoot, 'out', 'make'), (name) => name.endsWith('.dmg'));
  assert.equal(dmgs.length, 1, `Expected one macOS DMG, found ${dmgs.length}: ${dmgs.join(', ')}`);
  [source] = dmgs;
  assetName = `${product.releasePrefix}-macos-${options.arch}-v${packageJson.version}.dmg`;
} else {
  throw new Error(`Unsupported platform: ${options.platform}`);
}

const destination = path.join(releaseRoot, assetName);
await copyFile(source, destination);
console.log(JSON.stringify({ status: 'ok', platform: options.platform, arch: options.arch, version: packageJson.version, asset: assetName }));

async function findFiles(root, predicate) {
  const matches = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) matches.push(...await findFiles(fullPath, predicate));
    else if (entry.isFile() && predicate(entry.name)) matches.push(fullPath);
  }
  return matches;
}
