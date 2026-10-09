import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import { GeminiImagesAdapter } from '../src/providers/gemini-images.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import type { SettingsStore } from '../src/storage/settings-store.js';

const apiKey = 'fictional-redirect-fixture';
const request = { model: 'gemini-3.1-flash-image', prompt: 'Offline fixture', images: [], responseFormat: 'b64_json' as const };

for (const status of [302, 307, 308]) for (const operation of ['generate', 'models'] as const) {
  test(`native Gemini ${operation} refuses cross-origin ${status} without forwarding the key`, async () => {
    let targetRequests = 0;
    let sourceRequests = 0;
    let receivedKey: string | string[] | undefined;
    const target = createServer((_req, res) => { targetRequests++; res.end('{}'); });
    const targetUrl = await listen(target);
    const source = createServer((req, res) => {
      sourceRequests++;
      receivedKey = req.headers['x-goog-api-key'];
      res.writeHead(status, { location: `${targetUrl}/forbidden` }).end();
    });
    const baseUrl = await listen(source);
    try {
      const action = operation === 'generate'
        ? new GeminiImagesAdapter({ baseUrl, apiKey }).generate(request)
        : new ProviderRegistry({} as SettingsStore).testProfile({ baseUrl, apiKey, adapterId: 'gemini-native-images' });
      await assert.rejects(action);
      assert.equal(sourceRequests, 1);
      assert.equal(receivedKey, apiKey);
      assert.equal(targetRequests, 0);
    } finally { await Promise.all([close(source), close(target)]); }
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
