import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const FIXTURE_COUNT = 120;
const offering = {
  id: 'workbuddy-agent-generation',
  canonicalModelId: 'workbuddy-agent-generation',
  providerModelId: 'current-workbuddy-agent',
  displayName: 'WorkBuddy Generation',
  providerName: 'Current WorkBuddy Agent',
  providerType: 'agent-generation',
  tierName: 'Built-in',
  concurrency: 1,
  priceMicros: 0,
  currency: 'CNY',
  price: { mode: 'model_quota', currency: 'MODEL' },
  configured: true,
  sizes: [],
  supportsTextToImage: true,
  supportsImageToImage: true,
};

async function main(): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'esse-thumbnail-e2e-'));
  const capturePath = path.join(directory, 'capture.png');
  const sourceAsset = path.resolve(process.cwd(), 'assets', 'esse.png');
  const images: Array<Record<string, unknown>> = [];
  const outputPaths: string[] = [];
  try {
    await mkdir(path.join(directory, 'batches'), { recursive: true });
    for (let index = 0; index < FIXTURE_COUNT; index += 1) {
      const suffix = String(index + 1).padStart(12, '0');
      const imageId = `10000000-0000-4000-8000-${suffix}`;
      const batchId = `20000000-0000-4000-8000-${suffix}`;
      const jobId = `30000000-0000-4000-8000-${suffix}`;
      const requestId = `qa-thumbnail-request-${suffix}`;
      const createdAt = new Date(Date.now() - index * 1_000).toISOString();
      const relativeImagePath = path.join('2026-08', requestId, `01-${imageId}.png`);
      const outputPath = path.join(directory, 'outputs', relativeImagePath);
      await mkdir(path.dirname(outputPath), { recursive: true });
      await copyFile(sourceAsset, outputPath);
      outputPaths.push(outputPath);
      images.push({
        id: imageId,
        requestId,
        relativePath: relativeImagePath,
        fileName: path.basename(outputPath),
        prompt: `Thumbnail cache E2E ${index + 1}`,
        model: offering.displayName,
        createdAt,
      });
      await writeFile(path.join(directory, 'batches', `${batchId}.json`), JSON.stringify({
        id: batchId,
        requestKey: `qa-thumbnail-batch-${suffix}`,
        appendKeys: {},
        modificationKeys: {},
        mergeKeys: {},
        title: `Thumbnail cache test ${index + 1}`,
        prompt: `Thumbnail cache E2E ${index + 1}`,
        offering,
        jobs: [{
          id: jobId,
          index: 0,
          name: 'Image 1',
          prompt: `Thumbnail cache E2E ${index + 1}`,
          requestKey: `qa-thumbnail-job-${suffix}`,
          operation: 'generate',
          status: 'succeeded',
          progress: 100,
          attempt: 1,
          retryable: false,
          chargeState: 'charged',
          referenceImageIds: [],
          outputImageId: imageId,
          backups: [],
          createdAt,
          startedAt: createdAt,
          finishedAt: createdAt,
          durationMs: 1,
          callHistory: [],
        }],
        createdAt,
        updatedAt: createdAt,
      }, null, 2));
    }
    await writeFile(path.join(directory, 'library.json'), JSON.stringify({ version: 1, images }, null, 2));

    const cliPath = path.resolve(process.cwd(), 'node_modules', '@electron-forge', 'cli', 'dist', 'electron-forge.js');
    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, [cliPath, 'start'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ESSE_QA_USER_DATA_PATH: directory,
          ESSE_QA_CAPTURE_PATH: capturePath,
          ESSE_QA_FIXTURE: 'thumbnail-stress',
          ESSE_QA_CAPTURE_STATE: 'thumbnail-stress',
          ESSE_QA_SKIP_INTERACTIONS: '1',
          ESSE_QA_VIEWPORT: '1000x760',
        },
        stdio: 'inherit',
        windowsHide: true,
      });
      child.once('error', reject);
      child.once('exit', (code) => resolve(code ?? 1));
    });
    if (exitCode !== 0) throw new Error(`Electron thumbnail E2E exited with code ${exitCode}.`);

    const cacheDirectory = path.join(directory, 'cache', 'thumbnails', 'v1');
    const cached = (await readdir(cacheDirectory)).filter((name) => name.endsWith('.png'));
    if (cached.length <= 0 || cached.length >= FIXTURE_COUNT) {
      throw new Error(`Expected a bounded subset of cached thumbnails, found ${cached.length} of ${FIXTURE_COUNT}.`);
    }
    for (const name of cached) {
      const thumbnail = await readFile(path.join(cacheDirectory, name));
      if (thumbnail.length < 24 || thumbnail.subarray(1, 4).toString('ascii') !== 'PNG') throw new Error(`${name} is not a PNG image.`);
      const width = thumbnail.readUInt32BE(16);
      const height = thumbnail.readUInt32BE(20);
      if (Math.max(width, height) > 512) throw new Error(`${name} is unexpectedly large: ${width}x${height}.`);
    }
    if (!Buffer.from(await readFile(outputPaths[0])).equals(await readFile(sourceAsset))) throw new Error('Original image changed during thumbnail generation.');
    console.log(`ESSE_THUMBNAIL_E2E=${JSON.stringify({ ok: true, totalImages: FIXTURE_COUNT, cacheFiles: cached.length })}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
