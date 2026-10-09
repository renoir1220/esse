import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { app, session } from 'electron';

// A new process, own temporary app paths and a memory-only partition. No real key.
app.setPath('userData', process.argv[2]);
app.setPath('sessionData', process.argv[2]);
app.whenReady().then(async () => {
  const networkSession = session.fromPartition(`esse-redirect-fixture-${randomUUID()}`);
  for (const status of [302, 307, 308]) for (const method of ['GET', 'POST']) {
    let targetRequests = 0;
    let sourceRequests = 0;
    let receivedKey;
    const target = createServer((_req, res) => { targetRequests++; res.end('{}'); });
    const targetUrl = await listen(target);
    const source = createServer((req, res) => {
      sourceRequests++;
      receivedKey = req.headers['x-goog-api-key'];
      res.writeHead(status, { location: `${targetUrl}/forbidden` }).end();
    });
    const sourceUrl = await listen(source);
    try {
      await assert.rejects(networkSession.fetch(sourceUrl, {
        method, redirect: 'error', headers: { 'x-goog-api-key': 'fictional-redirect-fixture' },
        ...(method === 'POST' ? { body: '{}' } : {}), signal: AbortSignal.timeout(10_000),
      }));
      assert.equal(sourceRequests, 1);
      assert.equal(receivedKey, 'fictional-redirect-fixture');
      assert.equal(targetRequests, 0);
    } finally { await Promise.all([close(source), close(target)]); }
  }
  console.log('Electron session.fetch redirect:error: six GET/POST fixtures passed; target requests=0.');
  app.exit(0);
}).catch((error) => { console.error(error.message); app.exit(1); });

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
