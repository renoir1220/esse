import { spawn } from 'node:child_process';
import path from 'node:path';

const cliPath = path.resolve(process.cwd(), 'node_modules', '@electron-forge', 'cli', 'dist', 'electron-forge.js');
const child = spawn(process.execPath, [cliPath, 'start'], {
  cwd: process.cwd(),
  env: { ...process.env, ESSE_SMOKE_TEST: '1' },
  stdio: 'inherit',
  windowsHide: true,
});

child.on('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
