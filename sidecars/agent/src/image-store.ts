import { randomUUID } from 'node:crypto';
import { access, copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { decodeImageBase64, detectImageFormat, MAX_IMAGE_BYTES } from './image-format';
import { downloadRemoteImage } from './remote-image-download';
import type { SavedImage } from './types';

interface StoredImage extends Omit<SavedImage, 'mediaUrl'> {
  relativePath: string;
  hidden?: boolean;
}

interface LibraryFile {
  version: 1;
  images: StoredImage[];
}

export class ImageStore {
  readonly outputDir: string;
  private readonly libraryPath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly dataDir: string) {
    this.outputDir = path.join(dataDir, 'outputs');
    this.libraryPath = path.join(dataDir, 'library.json');
  }

  async list(): Promise<SavedImage[]> {
    const library = await this.readLibrary();
    const visible: SavedImage[] = [];
    for (const image of library.images) {
      if (image.hidden) continue;
      const fullPath = this.resolveRelative(image.relativePath);
      try {
        await access(fullPath);
        visible.push({ ...image, mediaUrl: this.mediaUrlFor(fullPath) });
      } catch { /* omit missing user files without deleting library history */ }
    }
    return visible.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async get(id: string): Promise<SavedImage | undefined> {
    const image = (await this.readLibrary()).images.find((candidate) => candidate.id === id);
    if (!image) return undefined;
    const fullPath = this.resolveRelative(image.relativePath);
    try {
      await access(fullPath);
      return { ...image, mediaUrl: this.mediaUrlFor(fullPath) };
    } catch {
      return undefined;
    }
  }

  async saveBatch(input: {
    requestId: string;
    prompt: string;
    model: string;
    items: Array<{ url?: string; b64_json?: string; revised_prompt?: string }>;
    trustedBaseUrl?: string;
  }): Promise<SavedImage[]> {
    const task = this.writeQueue.then(() => this.saveBatchOnce(input));
    this.writeQueue = task.then(() => undefined, () => undefined);
    return task;
  }

  private async saveBatchOnce(input: {
    requestId: string;
    prompt: string;
    model: string;
    items: Array<{ url?: string; b64_json?: string; revised_prompt?: string }>;
    trustedBaseUrl?: string;
  }): Promise<SavedImage[]> {
    const library = await this.readLibrary();
    const existing = library.images.filter((image) => image.requestId === input.requestId);
    if (existing.length) {
      const available: SavedImage[] = [];
      for (const image of existing) {
        const fullPath = this.resolveRelative(image.relativePath);
        try {
          await access(fullPath);
          available.push({ ...image, mediaUrl: this.mediaUrlFor(fullPath) });
        } catch { /* a replay may restore a user-deleted local file below */ }
      }
      if (available.length === existing.length) return available;
    }

    const now = new Date();
    const month = now.toISOString().slice(0, 7);
    const batchDir = path.join(this.outputDir, month, input.requestId);
    await mkdir(batchDir, { recursive: true });
    const stored: StoredImage[] = [];
    for (const [index, item] of input.items.entries()) {
      const bytes = item.b64_json
        ? decodeImageBase64(item.b64_json)
        : Buffer.from(await downloadRemoteImage({ initialUrl: item.url ?? '', trustedBaseUrl: input.trustedBaseUrl, maxBytes: MAX_IMAGE_BYTES }));
      if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('Generated image has an invalid size.');
      const format = detectImageFormat(bytes);
      if (!format) throw new Error('Provider output is not a recognized image file.');
      const id = randomUUID();
      const fileName = `${String(index + 1).padStart(2, '0')}-${id}.${format.extension}`;
      const fullPath = path.join(batchDir, fileName);
      await writeFile(fullPath, bytes, { mode: 0o600 });
      stored.push({
        id,
        requestId: input.requestId,
        relativePath: path.relative(this.outputDir, fullPath),
        fileName,
        prompt: input.prompt,
        model: input.model,
        revisedPrompt: item.revised_prompt,
        createdAt: now.toISOString(),
      });
    }
    library.images.unshift(...stored);
    await this.writeLibrary(library);
    return stored.map((image) => ({ ...image, mediaUrl: this.mediaUrlFor(this.resolveRelative(image.relativePath)) }));
  }

  async pathForId(id: string): Promise<string> {
    const image = (await this.readLibrary()).images.find((candidate) => candidate.id === id);
    if (!image) throw new Error('Image not found.');
    const fullPath = this.resolveRelative(image.relativePath);
    await access(fullPath);
    return fullPath;
  }

  async importFile(input: {
    sourcePath: string;
    requestId: string;
    prompt: string;
    model: string;
    hidden?: boolean;
  }): Promise<SavedImage> {
    const existing = (await this.readLibrary()).images.find((image) => image.requestId === input.requestId);
    if (existing) {
      const fullPath = this.resolveRelative(existing.relativePath);
      try {
        await access(fullPath);
        return { ...existing, mediaUrl: this.mediaUrlFor(fullPath) };
      } catch { /* restore a missing imported file below */ }
    }
    const source = path.resolve(input.sourcePath);
    const details = await stat(source);
    if (!details.isFile() || details.size <= 0 || details.size > MAX_IMAGE_BYTES) throw new Error('Generated image has an invalid size.');
    const format = detectImageFormat(await readFile(source));
    if (!format) throw new Error('Generated file is not a supported image.');
    const now = new Date();
    const id = randomUUID();
    const relativePath = path.join(now.toISOString().slice(0, 7), input.requestId, `01-${id}.${format.extension}`);
    const destination = this.resolveRelative(relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
    const stored: StoredImage = {
      id,
      requestId: input.requestId,
      relativePath,
      fileName: path.basename(destination),
      sourceFileName: path.basename(source),
      prompt: input.prompt,
      model: input.model,
      createdAt: now.toISOString(),
      hidden: input.hidden,
    };
    await this.updateLibrary((library) => { library.images.unshift(stored); });
    return { ...stored, mediaUrl: this.mediaUrlFor(destination) };
  }

  async trash(ids: string[]): Promise<string[]> {
    const exactIds = [...new Set(ids)];
    const removed: string[] = [];
    await this.updateLibrary(async (library) => {
      const retained: StoredImage[] = [];
      for (const image of library.images) {
        if (!exactIds.includes(image.id)) {
          retained.push(image);
          continue;
        }
        const source = this.resolveRelative(image.relativePath);
        const trashRelative = path.join('.trash', `${Date.now()}-${image.id}-${path.basename(source)}`);
        const destination = this.resolveRelative(trashRelative);
        await mkdir(path.dirname(destination), { recursive: true });
        try {
          await rename(source, destination);
          removed.push(image.id);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          removed.push(image.id);
        }
      }
      library.images = retained;
    });
    return removed;
  }

  resolveMediaRequest(urlText: string): string {
    const rawPath = urlText.replace(/^esse-media:\/\/local\/?/i, '').split(/[?#]/, 1)[0];
    for (const rawSegment of rawPath.split('/')) {
      const segment = decodeURIComponent(rawSegment);
      if (segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\')) {
        throw new Error('Invalid media path segment.');
      }
    }
    const url = new URL(urlText);
    if (url.protocol !== 'esse-media:' || url.hostname !== 'local') throw new Error('Invalid media URL.');
    const relative = url.pathname.split('/').filter(Boolean).map(decodeURIComponent).join(path.sep);
    return this.resolveRelative(relative);
  }

  private mediaUrlFor(fullPath: string): string {
    const relative = path.relative(this.outputDir, fullPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Image is outside the Esse output directory.');
    const encoded = relative.split(path.sep).map(encodeURIComponent).join('/');
    return `esse-media://local/${encoded}`;
  }

  private resolveRelative(relative: string): string {
    const fullPath = path.resolve(this.outputDir, relative);
    const relation = path.relative(this.outputDir, fullPath);
    if (!relation || relation === '.') throw new Error('Image path must identify a file.');
    if (relation.startsWith('..') || path.isAbsolute(relation)) throw new Error('Image path escapes the Esse output directory.');
    return fullPath;
  }

  private async readLibrary(): Promise<LibraryFile> {
    try {
      const parsed = JSON.parse(await readFile(this.libraryPath, 'utf8')) as LibraryFile;
      return parsed.version === 1 && Array.isArray(parsed.images) ? parsed : { version: 1, images: [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, images: [] };
      throw error;
    }
  }

  private async writeLibrary(library: LibraryFile): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    const temporary = `${this.libraryPath}.tmp`;
    await writeFile(temporary, JSON.stringify(library, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.libraryPath);
  }

  private async updateLibrary(mutate: (library: LibraryFile) => void | Promise<void>): Promise<void> {
    const task = this.writeQueue.then(async () => {
      const library = await this.readLibrary();
      await mutate(library);
      await this.writeLibrary(library);
    });
    this.writeQueue = task.then(() => undefined, () => undefined);
    await task;
  }
}
