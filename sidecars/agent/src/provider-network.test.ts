import { describe, expect, it, vi } from 'vitest';
import { ProviderNetworkTransport, type ProviderNetworkSession } from './provider-network';

describe('Provider network transport', () => {
  it('does not retry an ambiguous request and refreshes the network session before the next request', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('net::ERR_CONNECTION_TIMED_OUT'), { code: 'ERR_CONNECTION_TIMED_OUT' }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const session = fakeSession(fetchMock);
    const transport = new ProviderNetworkTransport(session);

    await expect(transport.fetch('https://provider.example/v1/images/generations')).rejects.toThrow('ERR_CONNECTION_TIMED_OUT');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(session.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(session.clearHostResolverCache).toHaveBeenCalledTimes(1);
    expect(session.forceReloadProxyConfig).toHaveBeenCalledTimes(1);

    await expect(transport.fetch('https://provider.example/v1/models')).resolves.toMatchObject({ status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('waits for concurrent requests to settle before resetting shared connections', async () => {
    let finishSecond: (() => void) | undefined;
    const secondRequest = new Promise<Response>((resolve) => {
      finishSecond = () => resolve(new Response('{}', { status: 200 }));
    });
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('net::ERR_NETWORK_CHANGED'))
      .mockReturnValueOnce(secondRequest);
    const session = fakeSession(fetchMock);
    const transport = new ProviderNetworkTransport(session);

    const failed = transport.fetch('https://provider.example/first').catch((error) => error);
    const running = transport.fetch('https://provider.example/second');
    await Promise.resolve();
    expect(session.closeAllConnections).not.toHaveBeenCalled();

    finishSecond?.();
    await running;
    await expect(failed).resolves.toBeInstanceOf(Error);
    expect(session.closeAllConnections).toHaveBeenCalledTimes(1);
  });
});

function fakeSession(fetchMock: ReturnType<typeof vi.fn>): ProviderNetworkSession {
  return {
    fetch: fetchMock as ProviderNetworkSession['fetch'],
    closeAllConnections: vi.fn(async () => {}),
    clearHostResolverCache: vi.fn(async () => {}),
    forceReloadProxyConfig: vi.fn(async () => {}),
  };
}
