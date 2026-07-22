import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cliPath = path.resolve(process.cwd(), 'node_modules', '@electron-forge', 'cli', 'dist', 'electron-forge.js');
const userDataPath = mkdtempSync(path.join(os.tmpdir(), 'esse-agent-sidecar-smoke-'));
const child = spawn(process.execPath, [cliPath, 'start'], {
  cwd: process.cwd(),
  env: { ...process.env, ESSE_QA_USER_DATA_PATH: userDataPath, ESSE_SMOKE_TEST: '1' },
  stdio: 'inherit',
  windowsHide: true,
});

child.on('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  rmSync(userDataPath, { force: true, recursive: true });
  process.exitCode = code ?? 1;
});
