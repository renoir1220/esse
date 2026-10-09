import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const directory = await mkdtemp(path.join(os.tmpdir(), 'esse-electron-redirect-'));
try {
  const entry = fileURLToPath(new URL('./provider-redirect-fixture.mjs', import.meta.url));
  const code = await new Promise((resolve, reject) => {
    const child = spawn(require('electron'), [entry, directory], { stdio: 'inherit', windowsHide: true });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Electron redirect fixture timed out.')); }, 45_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (exitCode) => { clearTimeout(timer); resolve(exitCode ?? 1); });
  });
  if (code !== 0) throw new Error(`Electron redirect fixture exited with code ${code}.`);
} finally { await rm(directory, { recursive: true, force: true }); }
