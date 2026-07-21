import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ImageStore } from './image-store';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('desktop image store', () => {
  it('persists one original and returns a validated local media URL', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'esse-desktop-test-'));
    temporaryDirectories.push(directory);
    const store = new ImageStore(directory);
    const bytes = testPng('original-bytes');
    const [saved] = await store.saveBatch({ requestId: 'request-1', prompt: 'A test image', model: 'test', items: [{ b64_json: bytes.toString('base64') }] });
    expect(saved.mediaUrl).toMatch(/^esse-media:\/\/local\//);
    const filePath = store.resolveMediaRequest(saved.mediaUrl);
    expect(await readFile(filePath)).toEqual(bytes);
    expect((await store.list())[0].id).toBe(saved.id);
  });

  it('rejects media path traversal', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'esse-desktop-test-'));
    temporaryDirectories.push(directory);
    const store = new ImageStore(directory);
    expect(() => store.resolveMediaRequest('esse-media://local/%2E%2E/secret.txt')).toThrow();
  });

  it('reuses saved originals when an idempotent API response is replayed', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'esse-desktop-test-'));
    temporaryDirectories.push(directory);
    const store = new ImageStore(directory);
    const input = { requestId: 'request-replay', prompt: 'Replay test', model: 'test', items: [{ b64_json: testPng('same-original').toString('base64') }] };
    const first = await store.saveBatch(input);
    const replay = await store.saveBatch(input);
    expect(replay).toEqual(first);
    expect((await store.list()).filter((image) => image.requestId === 'request-replay')).toHaveLength(1);
  });

  it('collects one batch into a single output folder and removes managed links on trash', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'esse-desktop-test-'));
    temporaryDirectories.push(directory);
    const store = new ImageStore(directory);
    const firstBytes = testPng('first-batch-image');
    const secondBytes = testPng('second-batch-image');
    const [first] = await store.saveBatch({ requestId: 'provider-request-1', prompt: 'First', model: 'test', items: [{ b64_json: firstBytes.toString('base64') }] });
    const [second] = await store.saveBatch({ requestId: 'provider-request-2', prompt: 'Second', model: 'test', items: [{ b64_json: secondBytes.toString('base64') }] });

    const batchFolder = await store.prepareBatchFolder('batch-1', '测试批次', [{ id: first.id, name: '图1' }, { id: second.id, name: '图2' }]);
    expect(path.basename(batchFolder)).toBe('测试批次-batch-1');
    expect(await store.prepareBatchFolder('batch-1', '测试批次', [{ id: first.id, name: '图1' }, { id: second.id, name: '图2' }])).toBe(batchFolder);
    expect((await readdir(batchFolder)).sort()).toEqual(['图1.png', '图2.png']);
    expect(await readFile(path.join(batchFolder, '图1.png'))).toEqual(firstBytes);
    expect(await readFile(path.join(batchFolder, '图2.png'))).toEqual(secondBytes);

    await store.trash([first.id]);
    expect(await readdir(batchFolder)).toEqual(['图2.png']);
    expect(await readFile(await store.pathForId(second.id))).toEqual(secondBytes);
  });

  it('preserves the user-facing source filename for imported references', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'esse-desktop-test-'));
    temporaryDirectories.push(directory);
    const store = new ImageStore(directory);
    const sourcePath = path.join(directory, 'Clipboard_Screenshot.png');
    await writeFile(sourcePath, testPng('pasted-reference'));
    const imported = await store.importFile({
      sourcePath,
      requestId: 'pasted-reference',
      prompt: 'Esse reference image',
      model: 'local-reference',
      hidden: true,
    });

    expect(imported.sourceFileName).toBe('Clipboard_Screenshot.png');
    expect(await store.get(imported.id)).toMatchObject({ sourceFileName: 'Clipboard_Screenshot.png' });
    expect(await store.list()).toEqual([]);
  });

  it('rejects base64 data that is not a recognized image', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'esse-desktop-test-'));
    temporaryDirectories.push(directory);
    const store = new ImageStore(directory);
    await expect(store.saveBatch({ requestId: 'bad-image', prompt: 'bad', model: 'test', items: [{ b64_json: Buffer.from('not-an-image').toString('base64') }] })).rejects.toThrow('recognized image');
  });
});

function testPng(content: string): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(content)]);
}
