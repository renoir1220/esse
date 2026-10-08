import assert from 'node:assert/strict';
import test from 'node:test';
import { reserve, safeError, downloadUrl } from './cloud-tuzi-probe.mjs';

test('unknown charges reserve the full amount and block requests beyond CNY 10', () => {
  const ledger = { currency: 'CNY', limit: 10, requests: [{ actualCny: null, reservedCny: 2 }] };
  for (let i = 0; i < 4; i++) reserve(ledger, { reservedCny: 2 });
  assert.equal(ledger.requests.length, 5);
  assert.throws(() => reserve(ledger, { reservedCny: 2 }), /budget/);
  assert.equal(ledger.requests.length, 5);
  assert.throws(() => reserve({ ...ledger, limit: 20 }, { reservedCny: 2 }), /valid cumulative/);
});

test('download references remain on the approved HTTPS host and diagnostics redact URLs/keys', () => {
  assert.equal(downloadUrl('https://apioss40.sydney-ai.com/result.png?signature=local-only'), 'https://apioss40.sydney-ai.com/result.png?signature=local-only');
  for (const url of ['http://apioss40.sydney-ai.com/x', 'https://127.0.0.1/x', 'https://apioss40.sydney-ai.com:444/x', 'https://user:secret@apioss40.sydney-ai.com/x']) assert.throws(() => downloadUrl(url));
  const result = safeError('403 https://example.test/private?signature=hidden Bearer secret-key sk-secretvalue');
  assert(!result.includes('hidden') && !result.includes('secret-key') && !result.includes('sk-secretvalue'));
});
