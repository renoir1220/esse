import { describe, expect, it, vi } from 'vitest';
import { resolveSessionPairingToken } from './mcp-pairing-policy';

describe('MCP pairing token policy', () => {
  it('keeps smoke and QA sessions out of persistent OS credential storage', async () => {
    const persistent = vi.fn(async () => 'persistent-token');

    const token = await resolveSessionPairingToken({
      ephemeral: true,
      persistent,
      randomToken: () => 'ephemeral-token',
    });

    expect(token).toBe('ephemeral-token');
    expect(persistent).not.toHaveBeenCalled();
  });

  it('uses the protected persistent token in ordinary application sessions', async () => {
    const persistent = vi.fn(async () => 'persistent-token');

    await expect(resolveSessionPairingToken({ ephemeral: false, persistent })).resolves.toBe('persistent-token');
    expect(persistent).toHaveBeenCalledTimes(1);
  });
});
