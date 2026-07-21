import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configureWorkBuddyForDevelopment } from './dev-bootstrap';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('development bootstrap', () => {
  it('merges Esse into WorkBuddy without replacing existing MCP servers', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'esse-workbuddy-test-'));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, '.mcp.json');
    await writeFile(configPath, JSON.stringify({ mcpServers: { 'connector-proxy': { type: 'http', url: 'http://127.0.0.1:1234/mcp' } } }), 'utf8');
    await configureWorkBuddyForDevelopment({
      endpoint: 'http://127.0.0.1:43181/mcp',
      pairingToken: 'local-pairing-token',
      configPath,
    });
    const configured = JSON.parse(await readFile(configPath, 'utf8')) as { mcpServers: Record<string, { url: string; headers?: { Authorization?: string } }> };
    expect(configured.mcpServers['connector-proxy'].url).toBe('http://127.0.0.1:1234/mcp');
    expect(configured.mcpServers.esse).toMatchObject({
      url: 'http://127.0.0.1:43181/mcp',
      headers: { Authorization: 'Bearer local-pairing-token' },
    });
    expect(await readFile(`${configPath}.pre-esse.bak`, 'utf8')).not.toContain('local-pairing-token');
  });
});
