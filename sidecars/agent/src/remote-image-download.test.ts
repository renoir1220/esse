import { describe, expect, it } from 'vitest';
import { downloadRemoteImage, isGloballyRoutableAddress, type PinnedImageRequester } from './remote-image-download';

const imageBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);

describe('remote Provider image download', () => {
  it('trusts only the exact configured Provider origin', async () => {
    const fetchImpl = async () => new Response(imageBytes, { status: 200 });
    await expect(downloadRemoteImage({
      initialUrl: 'http://127.0.0.1/result.png',
      trustedBaseUrl: 'http://127.0.0.1/v1',
      maxBytes: 1024,
      fetchImpl,
      resolveHostname: async () => { throw new Error('same origin must not use DNS'); },
      requestPinned: async () => { throw new Error('same origin must not use pinned request'); },
    })).resolves.toEqual(imageBytes);

    await expect(downloadRemoteImage({
      initialUrl: 'http://127.0.0.1:9999/result.png',
      trustedBaseUrl: 'http://127.0.0.1/v1',
      maxBytes: 1024,
      fetchImpl,
    })).rejects.toThrow(/local or private network/);
  });

  it('pins public cross-origin addresses and rejects mixed private DNS answers', async () => {
    const requester: PinnedImageRequester = async (_url, addresses) => {
      expect(addresses).toEqual([{ address: '8.8.8.8', family: 4 }]);
      return { status: 200, headers: new Headers(), bytes: imageBytes };
    };
    await expect(downloadRemoteImage({
      initialUrl: 'https://cdn.provider.example/result.png',
      trustedBaseUrl: 'https://api.provider.example/v1',
      maxBytes: 1024,
      resolveHostname: async () => [{ address: '8.8.8.8', family: 4 }],
      requestPinned: requester,
    })).resolves.toEqual(imageBytes);

    await expect(downloadRemoteImage({
      initialUrl: 'https://cdn.provider.example/result.png',
      trustedBaseUrl: 'https://api.provider.example/v1',
      maxBytes: 1024,
      resolveHostname: async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.8', family: 4 }],
      requestPinned: requester,
    })).rejects.toThrow(/local or private network/);
  });

  it('validates every redirect independently', async () => {
    await expect(downloadRemoteImage({
      initialUrl: 'https://cdn.provider.example/result.png',
      trustedBaseUrl: 'https://api.provider.example/v1',
      maxBytes: 1024,
      resolveHostname: async () => [{ address: '8.8.8.8', family: 4 }],
      requestPinned: async () => ({ status: 302, headers: new Headers({ location: 'https://127.0.0.1/private.png' }), bytes: new Uint8Array() }),
    })).rejects.toThrow(/local or private network/);
  });

  it('accepts only globally routable unicast addresses', () => {
    expect(isGloballyRoutableAddress('8.8.8.8')).toBe(true);
    expect(isGloballyRoutableAddress('2001:4860:4860::8888')).toBe(true);
    for (const address of ['127.0.0.1', '10.0.0.1', '169.254.1.1', '198.18.0.1', '::1', 'fc00::1', 'fe80::1', '2001:db8::1']) {
      expect(isGloballyRoutableAddress(address), address).toBe(false);
    }
  });
});
