// Run one explicitly authorized Tuzi request through the platform HTTPS proxy.
// The shell expands a Network secret placeholder; JavaScript never reads its value.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function reserve(ledger, entry) {
  if (ledger.currency !== 'CNY' || ledger.limit !== 10 || !Array.isArray(ledger.requests)) throw new Error('A valid cumulative CNY 10 ledger is required.');
  const used = ledger.requests.reduce((sum, item) => {
    const amount = item.chargeState === 'verified' ? item.actualCny : item.reservedCny;
    if (!Number.isFinite(amount) || amount < 0 || !Number.isFinite(item.reservedCny) || item.reservedCny <= 0) throw new Error('Invalid existing budget entry.');
    return sum + amount;
  }, 0);
  if (!Number.isFinite(used) || !Number.isFinite(entry.reservedCny) || entry.reservedCny <= 0 || used + entry.reservedCny > ledger.limit) throw new Error('The cumulative reservation exceeds the authorized budget.');
  ledger.requests.push(entry);
  return ledger;
}

export function safeError(value) {
  return String(value ?? '').replace(/https?:\/\/\S+/gi, '[URL]').replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]').replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]').slice(0, 400);
}

export function downloadUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || url.hostname !== 'apioss40.sydney-ai.com') throw new Error('Unapproved result download destination; no download attempted.');
  return url.href;
}

async function saveJson(destination, value) {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, destination);
}

async function curl(url, destination, authenticated, requestFile) {
  // Keep signed URLs in process memory/local references, out of command logs.
  await writeFile(destination, '', { mode: 0o600 });
  const headers = `${destination}.headers`;
  await writeFile(headers, '', { mode: 0o600 });
  const shell = 'curl -q --silent --show-error --max-time 120 --max-filesize 62914560 --output "$1" --dump-header "$2" --write-out "%{http_code} %{time_total}"'
    + (authenticated ? ' --header "Authorization: Bearer ${tuzi_api_key}"' : '')
    + (requestFile ? ' --header "Content-Type: application/json" --data-binary "@$4"' : '') + ' "$3"';
  const result = spawnSync('bash', ['--noprofile', '--norc', '-c', shell, 'tuzi-cloud-probe', destination, headers, url, requestFile ?? ''], { encoding: 'utf8', timeout: 125_000 });
  const [status, duration] = (result.stdout ?? '').trim().split(/\s+/);
  const headerText = await readFile(headers, 'utf8');
  await unlink(headers);
  return {
    httpStatus: /^\d{3}$/.test(status) ? Number(status) : 0,
    durationSeconds: Number(duration) || 0,
    curlExit: result.status,
    requestId: /(?:^|\n)x-oneapi-request-id:\s*([^\r\n]+)/i.exec(headerText)?.[1]?.trim(),
    proxyDenied: /(?:^|\n)x-(?:mitmproxy-blocked-reason|proxy-error):/i.test(headerText),
    error: safeError(result.error?.message ?? result.stderr),
  };
}

export async function runProbe({ ledgerPath, evidenceDir, requestPath, reservedCny = 2 }) {
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  const lock = `${ledgerPath}.lock`;
  await writeFile(lock, '', { flag: 'wx', mode: 0o600 });
  try {
    const request = JSON.parse(await readFile(requestPath, 'utf8'));
    if (request.n !== 1 || request.model !== 'nano-banana-2-2k' || request.quality !== '2k' || request.response_format !== 'url') throw new Error('Only the verified single-image 2K Tuzi quote is enabled.');
    const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
    const entry = { clientRequestId: randomUUID(), startedAt: new Date().toISOString(), model: request.model, reservedCny, actualCny: null, chargeState: 'unknown', postAttempts: 1, status: 'submission_uncertain' };
    reserve(ledger, entry);
    await saveJson(ledgerPath, ledger); // Durable reservation before the only POST.
    const directory = path.join(evidenceDir, entry.clientRequestId);
    await mkdir(directory, { mode: 0o700 });
    const bodyPath = path.join(directory, 'request.json');
    await saveJson(bodyPath, request);
    const responsePath = path.join(directory, 'response.json');
    entry.generation = await curl('https://api.tu-zi.com/v1/images/generations', responsePath, true, bodyPath);
    entry.providerRequestId = entry.generation.requestId;
    entry.responseSaved = true;
    await saveJson(ledgerPath, ledger);
    if (entry.generation.httpStatus !== 200 || entry.generation.curlExit !== 0) return entry;
    const response = JSON.parse(await readFile(responsePath, 'utf8'));
    const item = response.data?.[0];
    if (typeof item?.url !== 'string') { entry.status = 'accepted_without_download_url'; await saveJson(ledgerPath, ledger); return entry; }
    const url = downloadUrl(item.url);
    await saveJson(path.join(directory, 'download-reference.json'), { url });
    entry.status = 'generation_accepted';
    await saveJson(ledgerPath, ledger);
    const imagePath = path.join(directory, 'image.png');
    entry.download = await curl(url, imagePath, false);
    entry.status = entry.download.httpStatus === 200 && entry.download.curlExit === 0 ? 'downloaded_pending_image_validation' : 'generation_accepted_download_failed';
    if (entry.download.httpStatus !== 200 || entry.download.curlExit !== 0) {
      await rename(imagePath, path.join(directory, 'download-error-body.txt'));
      try { const error = JSON.parse(await readFile(path.join(directory, 'download-error-body.txt'), 'utf8')); entry.download.providerError = safeError(error.error?.code ?? error.code ?? error.message); } catch { /* Raw error retained privately; never print arbitrary HTML. */ }
    }
    entry.finishedAt = new Date().toISOString();
    await saveJson(ledgerPath, ledger);
    await saveJson(path.join(directory, 'evidence.json'), entry);
    return entry;
  } finally { await unlink(lock); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [execute, ledgerPath, evidenceDir, requestPath] = process.argv.slice(2);
  if (execute !== '--execute' || !ledgerPath || !evidenceDir || !requestPath) throw new Error('Usage: node scripts/cloud-tuzi-probe.mjs --execute LEDGER EVIDENCE_DIR REQUEST_JSON (requires explicit paid-test authorization).');
  const entry = await runProbe({ ledgerPath, evidenceDir, requestPath });
  process.stdout.write(`${JSON.stringify(entry)}\n`);
  if (entry.status !== 'downloaded_pending_image_validation') process.exitCode = 1;
}
