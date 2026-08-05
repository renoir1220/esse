import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThumbnailStore, THUMBNAIL_LONG_EDGE } from './thumbnail-store';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('thumbnail store', () => {
  it('deduplicates concurrent generation and reuses the cached preview', async () => {
    const directory = await createTemporaryDirectory();
    const source = path.join(directory, 'source.png');
    await writeFile(source, Buffer.from('source-image'));
    const generate = vi.fn(async () => Buffer.from('thumbnail'));
    const store = new ThumbnailStore(path.join(directory, 'cache'), generate);

    const [first, second] = await Promise.all([store.ensure(source), store.ensure(source)]);
    expect(first).toBe(second);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith(source, THUMBNAIL_LONG_EDGE);
    expect(await readFile(first, 'utf8')).toBe('thumbnail');
    expect(await store.ensure(source)).toBe(first);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('regenerates when the source file changes', async () => {
    const directory = await createTemporaryDirectory();
    const source = path.join(directory, 'source.png');
    await writeFile(source, Buffer.from('first-source'));
    const generate = vi.fn(async () => Buffer.from(`thumbnail-${Date.now()}`));
    const store = new ThumbnailStore(path.join(directory, 'cache'), generate);

    const first = await store.ensure(source);
    await writeFile(source, Buffer.from('a-longer-second-source'));
    const second = await store.ensure(source);

    expect(second).not.toBe(first);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('keeps generation serial and prunes older cache entries over the size limit', async () => {
    const directory = await createTemporaryDirectory();
    const cache = path.join(directory, 'cache');
    const active = { count: 0, maximum: 0 };
    const generate = vi.fn(async (sourcePath: string) => {
      active.count += 1;
      active.maximum = Math.max(active.maximum, active.count);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active.count -= 1;
      return Buffer.alloc(8, path.basename(sourcePath).charCodeAt(0));
    });
    const store = new ThumbnailStore(cache, generate, 12);
    const sources = await Promise.all(['a.png', 'b.png', 'c.png'].map(async (name) => {
      const source = path.join(directory, name);
      await writeFile(source, Buffer.from(name));
      return source;
    }));

    await Promise.all(sources.map((source) => store.ensure(source)));

    expect(active.maximum).toBe(1);
    const cached = await readdir(cache);
    expect(cached).toHaveLength(1);
    expect((await stat(path.join(cache, cached[0]))).size).toBe(8);
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'esse-thumbnail-test-'));
  temporaryDirectories.push(directory);
  return directory;
}
