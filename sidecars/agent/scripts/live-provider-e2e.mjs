import { randomUUID } from 'node:crypto';
import { access, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const MCP_PORT = '43181';
const DEFAULT_TIMEOUT_MS = 16 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const MINIMUM_IMAGE_BYTES = 1_024;

const timeoutMs = positiveInteger(process.env.ESSE_E2E_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
const pollIntervalMs = positiveInteger(process.env.ESSE_E2E_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS);
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const startedAt = Date.now();
let pairingAuthorization = '';
let client;

try {
  const connection = await connectLocalEsse();
  pairingAuthorization = connection.authorization;
  client = connection.client;

  const offeringsPayload = toolPayload(
    await client.callTool({ name: 'list_image_offerings', arguments: {} }),
    'list_image_offerings',
  );
  const offering = resolveBanana1kOffering(offeringsPayload.offerings);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const title = `Esse ${packageJson.version} Banana 1K E2E ${timestamp}`;
  const requestKey = `release-e2e-${packageJson.version}-${timestamp}-${randomUUID()}`;

  toolPayload(await client.callTool({
    name: 'create_image_batch',
    arguments: {
      title,
      offeringId: offering.id,
      prompt: '一只戴着圆框飞行护目镜的橘猫，驾驶由旧木板和黄铜零件拼成的迷你双翼飞机，穿越金色夕阳下的蓬松云海；电影感，细腻毛发，画面干净，无文字，无水印。',
      count: 1,
      requestKey,
    },
  }), 'create_image_batch');

  const batchId = await findCreatedBatch(client, title, requestKey);
  const batch = await waitForTerminalBatch(client, batchId);
  const image = await verifySuccessfulBatch(batch);

  process.stdout.write(`${JSON.stringify({
    status: 'ok',
    version: packageJson.version,
    offering: 'Nano Banana 2 · 1K',
    durationMs: Date.now() - startedAt,
    batchId,
    imageId: image.id,
  })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    status: 'failed',
    version: packageJson.version,
    durationMs: Date.now() - startedAt,
    diagnostic: safeDiagnostic(error, pairingAuthorization),
  })}\n`);
  process.exitCode = 1;
} finally {
  await client?.close().catch(() => undefined);
}

async function connectLocalEsse() {
  const connections = await loadLocalConnections();
  let lastError;
  for (const connection of connections) {
    const candidate = new Client({ name: 'esse-release-e2e', version: packageJson.version });
    try {
      await candidate.connect(new StreamableHTTPClientTransport(new URL(connection.url), {
        requestInit: { headers: { authorization: connection.authorization } },
      }));
      return { ...connection, client: candidate };
    } catch (error) {
      lastError = error;
      await candidate.close().catch(() => undefined);
    }
  }
  throw new Error(
    `None of the ${connections.length} local Esse MCP configurations could connect${lastError ? `: ${safeDiagnostic(lastError, '')}` : '.'}`,
    { cause: lastError },
  );
}

async function loadLocalConnections() {
  const candidates = [
    path.join(os.homedir(), '.workbuddy', '.mcp.json'),
    path.join(os.homedir(), '.workbuddy', 'mcp.json'),
  ];
  const connections = [];
  const seen = new Set();
  for (const configPath of candidates) {
    let parsed;
    try {
      parsed = JSON.parse(await readFile(configPath, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      continue;
    }
    const servers = parsed?.mcpServers ?? parsed?.servers;
    if (!servers || typeof servers !== 'object') continue;
    const preferredEntries = Object.entries(servers).sort(([left], [right]) => {
      const rank = (name) => name === 'esse' ? 0 : name === 'esse-desktop' ? 1 : 2;
      return rank(left) - rank(right);
    });
    for (const [, server] of preferredEntries) {
      if (!server || typeof server !== 'object') continue;
      const url = typeof server.url === 'string'
        ? server.url
        : typeof server.endpoint === 'string'
          ? server.endpoint
          : '';
      if (!isLocalEsseEndpoint(url)) continue;
      const headers = server.headers ?? {};
      const authorization = headers.Authorization ?? headers.authorization;
      if (typeof authorization !== 'string' || !/^Bearer\s+\S+$/i.test(authorization)) continue;
      const identity = `${url}\n${authorization}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      connections.push({ url, authorization });
    }
  }
  if (!connections.length) throw new Error('No usable local Esse MCP entry was found in the WorkBuddy configuration.');
  return connections;
}

function isLocalEsseEndpoint(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:'
      && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      && url.port === MCP_PORT
      && url.pathname.replace(/\/+$/, '') === '/mcp';
  } catch {
    return false;
  }
}

function resolveBanana1kOffering(rawOfferings) {
  if (!Array.isArray(rawOfferings)) throw new Error('Esse did not return an offering list.');
  const candidates = rawOfferings.filter((offering) => {
    if (!offering || offering.configured === false || offering.providerType === 'agent-generation') return false;
    const providerModelId = normalize(offering.providerModelId);
    const displayName = normalize(offering.displayName);
    return providerModelId === 'nano banana 2'
      && displayName.includes('nano banana 2')
      && /(^|\s)1k($|\s)/.test(displayName);
  });
  if (candidates.length !== 1) {
    throw new Error(`Expected exactly one configured Nano Banana 2 · 1K offering, found ${candidates.length}.`);
  }
  return candidates[0];
}

async function findCreatedBatch(mcpClient, title, requestKey) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const payload = toolPayload(
      await mcpClient.callTool({ name: 'list_image_batches', arguments: { limit: 50 } }),
      'list_image_batches',
    );
    const exact = Array.isArray(payload.batches)
      ? payload.batches.find((batch) => batch?.title === title && batch?.requestKey === requestKey)
      : undefined;
    if (exact?.id) return exact.id;
    await delay(500);
  }
  throw new Error('The accepted E2E batch could not be resolved by its exact title and request key.');
}

async function waitForTerminalBatch(mcpClient, batchId) {
  const deadline = startedAt + timeoutMs;
  let nextHeartbeat = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const payload = toolPayload(
      await mcpClient.callTool({ name: 'get_image_batch', arguments: { batchId } }),
      'get_image_batch',
    );
    const batch = payload.batch;
    if (!batch) throw new Error('Esse did not return the E2E batch.');
    if (batch.queued === 0 && batch.running === 0) return batch;
    if (Date.now() >= nextHeartbeat) {
      process.stderr.write(`${JSON.stringify({
        status: 'running',
        elapsedMs: Date.now() - startedAt,
        batchId,
        progress: {
          succeeded: batch.succeeded,
          failed: batch.failed,
          total: batch.total,
        },
      })}\n`);
      nextHeartbeat = Date.now() + 30_000;
    }
    await delay(pollIntervalMs);
  }
  throw new Error(`The Banana 1K E2E batch did not finish within ${Math.round(timeoutMs / 60_000)} minutes.`);
}

async function verifySuccessfulBatch(batch) {
  if (batch.status !== 'completed'
    || batch.total !== 1
    || batch.succeeded !== 1
    || batch.failed !== 0
    || batch.canceled !== 0) {
    const job = Array.isArray(batch.jobs) ? batch.jobs[0] : undefined;
    throw new Error(
      `E2E batch ended as ${batch.status}; succeeded=${batch.succeeded}, failed=${batch.failed}, canceled=${batch.canceled}, origin=${job?.errorOrigin ?? 'unknown'}, charge=${job?.chargeState ?? 'unknown'}.`,
    );
  }
  const succeededImages = Array.isArray(batch.images)
    ? batch.images.filter((image) => image?.status === 'succeeded' && image?.id && image?.path)
    : [];
  if (succeededImages.length !== 1) throw new Error(`Expected one succeeded output image, found ${succeededImages.length}.`);
  const image = succeededImages[0];
  await access(image.path);
  const metadata = await stat(image.path);
  if (!metadata.isFile() || metadata.size < MINIMUM_IMAGE_BYTES) {
    throw new Error(`The E2E output is missing or smaller than ${MINIMUM_IMAGE_BYTES} bytes.`);
  }
  const header = await readFile(image.path).then((buffer) => buffer.subarray(0, 16));
  if (!hasSupportedImageHeader(header)) throw new Error('The E2E output does not have a recognized raster image header.');
  return image;
}

function hasSupportedImageHeader(header) {
  const hex = header.toString('hex');
  const ascii = header.toString('ascii');
  return hex.startsWith('89504e470d0a1a0a')
    || hex.startsWith('ffd8ff')
    || ascii.startsWith('GIF87a')
    || ascii.startsWith('GIF89a')
    || (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP');
}

function toolPayload(result, toolName) {
  const structured = result?.structuredContent;
  if (result?.isError) {
    const message = structured?.error
      ?? result?.content?.find((item) => item?.type === 'text')?.text
      ?? `${toolName} failed.`;
    throw new Error(String(message));
  }
  if (structured && typeof structured === 'object') return structured;
  const text = result?.content?.find((item) => item?.type === 'text')?.text;
  if (typeof text !== 'string') throw new Error(`${toolName} returned no structured result.`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${toolName} returned an unreadable result.`);
  }
}

function normalize(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[·._/-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function positiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Expected a positive integer but received ${value}.`);
  return parsed;
}

function safeDiagnostic(error, authorization) {
  const raw = error instanceof Error ? error.message : String(error);
  const withoutCredential = authorization ? raw.split(authorization).join('[REDACTED]') : raw;
  return withoutCredential
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .slice(0, 600);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
