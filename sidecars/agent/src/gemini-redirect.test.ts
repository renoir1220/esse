import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { EsseApiClient } from './api-client';
import { ProviderSettingsStore } from './provider-settings';
import { ProviderNetworkTransport } from './provider-network';
import type { CredentialStore } from './credential-store';

const apiKey = 'fictional-redirect-fixture';
for (const status of [302, 307, 308]) for (const operation of ['generate', 'models'] as const) {
  it(`native Gemini ${operation} refuses cross-origin ${status} through the session transport`, async () => {
    let targetRequests = 0;
    let sourceRequests = 0;
    let receivedKey: string | string[] | undefined;
    const directory = await mkdtemp(path.join(os.tmpdir(), 'esse-redirect-'));
    const target = createServer((_req, res) => { targetRequests++; res.end('{}'); });
    const targetUrl = await listen(target);
    const source = createServer((req, res) => {
      sourceRequests++;
      receivedKey = req.headers['x-goog-api-key'];
      res.writeHead(status, { location: `${targetUrl}/forbidden` }).end();
    });
    const baseUrl = await listen(source);
    const transport = new ProviderNetworkTransport({ fetch: async (input, init) => {
      expect(init?.redirect).toBe('error');
      return fetch(input, init);
    } });
    try {
      const settings = operation === 'generate'
        ? { resolveOffering: async () => ({ profile: { id: 'offline', baseUrl, adapterId: 'gemini-native-images', hasApiKey: true }, offering: { providerModelId: 'gemini-3.1-flash-image' } }), getApiKey: async () => apiKey } as unknown as ProviderSettingsStore
        : new ProviderSettingsStore(path.join(directory, 'providers.json'), {} as CredentialStore);
      const action = operation === 'generate'
        ? new EsseApiClient(settings, transport.fetch).generate({ model: 'offline', prompt: 'Offline fixture' })
        : settings.testProvider({ baseUrl, apiKey, adapterId: 'gemini-native-images' }, transport.fetch);
      await expect(action).rejects.toThrow();
      expect(sourceRequests).toBe(1);
      expect(receivedKey).toBe(apiKey);
      expect(targetRequests).toBe(0);
    } finally {
      await Promise.all([close(source), close(target)]);
      await rm(directory, { recursive: true, force: true });
    }
  });
}
async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not listen.');
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
