import assert from 'node:assert/strict';
import test from 'node:test';
import { reserve, safeError, downloadUrl, diagnoseCurlTransfer } from './cloud-tuzi-probe.mjs';

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

test('CONNECT 403 without a proxy marker remains a proxy-stage refusal', () => {
  for (const stdout of ['000 0.003831 403', '000 0.003831']) {
    const result = diagnoseCurlTransfer({ stdout, stderr: 'curl: (56) CONNECT tunnel failed, response 403\n', status: 56 });
    assert.equal(result.connectHttpStatus, 403);
    assert.equal(result.proxyDenied, true);
    assert.equal(result.failureStage, 'platform_proxy_connect');
    assert.equal(result.originHttpStatus, null);
  }
});

test('an origin 403 after a successful CONNECT is separate from proxy refusal', () => {
  const result = diagnoseCurlTransfer({ stdout: '403 0.2 200', stderr: '', status: 0 }, 'HTTP/1.1 200 Connection established\r\n\r\nHTTP/2 403\r\n');
  assert.equal(result.connectHttpStatus, 200);
  assert.equal(result.originHttpStatus, 403);
  assert.equal(result.proxyDenied, false);
  assert.equal(result.failureStage, 'origin_http_response');
});

test('a generic HTTP 403 with no CONNECT evidence does not inherit proxy attribution', () => {
  const result = diagnoseCurlTransfer({ stdout: '403 0.2', stderr: 'HTTP 403', status: 22 });
  assert.equal(result.httpStatus, 403);
  assert.equal(result.connectHttpStatus, null);
  assert.equal(result.originHttpStatus, null);
  assert.equal(result.proxyDenied, null);
  assert.equal(result.failureStage, 'http_response_unattributed');
});

test('a proxy response marker without a CONNECT status preserves that narrower evidence', () => {
  const result = diagnoseCurlTransfer({ stdout: '403 0.2 000', stderr: '', status: 22 }, 'HTTP/2 403\r\nx-mitmproxy-blocked-reason: policy\r\n');
  assert.equal(result.proxyDenied, true);
  assert.equal(result.connectHttpStatus, null);
  assert.equal(result.originHttpStatus, null);
  assert.equal(result.failureStage, 'platform_proxy_response');
});

test('a TLS failure after CONNECT does not imply an origin HTTP response and redacts private diagnostics', () => {
  const result = diagnoseCurlTransfer({ stdout: '000 0.2 200', stderr: 'curl: (60) TLS failed https://example.test/image?signature=hidden Bearer secret-key', status: 60 });
  assert.equal(result.proxyDenied, false);
  assert.equal(result.originHttpStatus, null);
  assert.equal(result.failureStage, 'transport');
  assert(!result.error.includes('hidden') && !result.error.includes('secret-key'));
});

test('a successful response records HTTP and CONNECT separately, and a spawn failure remains transport-only', () => {
  const ok = diagnoseCurlTransfer({ stdout: '200 0.1 200', stderr: '', status: 0 }, 'x-oneapi-request-id: test-request\r\n');
  assert.equal(ok.originHttpStatus, 200);
  assert.equal(ok.requestId, 'test-request');
  assert.equal(ok.failureStage, null);
  const failed = diagnoseCurlTransfer({ status: null, error: { message: 'spawn timed out' } });
  assert.equal(failed.httpStatus, 0);
  assert.equal(failed.connectHttpStatus, null);
  assert.equal(failed.proxyDenied, null);
  assert.equal(failed.failureStage, 'transport');
});
