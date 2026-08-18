import { randomUUID } from 'node:crypto';
import { access, copyFile, link, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { decodeImageBase64, detectImageFormat, MAX_IMAGE_BYTES } from './image-format';
import { downloadRemoteImage } from './remote-image-download';
import type { SavedImage } from './types';

interface StoredImage extends Omit<SavedImage, 'mediaUrl' | 'thumbnailUrl'> {
  relativePath: string;
  batchLinks?: string[];
  hidden?: boolean;
}

interface LibraryFile {
  version: 1;
  images: StoredImage[];
}

export class ImageStore {
  readonly outputDir: string;
  private readonly libraryPath: string;
  private libraryPromise: Promise<LibraryFile> | undefined;
  private imageIndex = new Map<string, StoredImage>();
  private visibleCache: SavedImage[] | undefined;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly dataDir: string) {
    this.outputDir = path.join(dataDir, 'outputs');
    this.libraryPath = path.join(dataDir, 'library.json');
  }

  async list(): Promise<SavedImage[]> {
    if (this.visibleCache) return this.visibleCache.slice();
    const library = await this.readLibrary();
    const visible: SavedImage[] = [];
    for (const image of library.images) {
      if (image.hidden) continue;
      const fullPath = this.resolveRelative(image.relativePath);
      try {
        await access(fullPath);
        visible.push(this.savedImage(image, fullPath));
      } catch { /* omit missing user files without deleting library history */ }
    }
    this.visibleCache = visible.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return this.visibleCache.slice();
  }

  async get(id: string): Promise<SavedImage | undefined> {
    await this.readLibrary();
    const image = this.imageIndex.get(id);
    if (!image) return undefined;
    const fullPath = this.resolveRelative(image.relativePath);
    try {
      await access(fullPath);
      return this.savedImage(image, fullPath);
    } catch {
      return undefined;
    }
  }

  async getMany(ids: Iterable<string>): Promise<SavedImage[]> {
    await this.readLibrary();
    const idsToRead = [...new Set(ids)];
    const images: SavedImage[] = [];
    for (let offset = 0; offset < idsToRead.length; offset += 16) {
      const chunk = await Promise.all(idsToRead.slice(offset, offset + 16).map((id) => this.get(id)));
      images.push(...chunk.filter((image): image is SavedImage => Boolean(image)));
    }
    return images;
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
          available.push(this.savedImage(image, fullPath));
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
    this.addToIndex(stored);
    return stored.map((image) => this.savedImage(image, this.resolveRelative(image.relativePath)));
  }

  async pathForId(id: string): Promise<string> {
    await this.readLibrary();
    const image = this.imageIndex.get(id);
    if (!image) throw new Error('Image not found.');
    const fullPath = this.resolveRelative(image.relativePath);
    await access(fullPath);
    return fullPath;
  }

  async prepareBatchFolder(batchId: string, batchTitle: string, images: Array<{ id: string; name: string }>): Promise<string> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(batchId)) throw new Error('Invalid batch ID.');
    const relativeFolder = path.join('batches', `${safeFileStem(batchTitle)}-${batchId.slice(0, 8)}`);
    const batchFolder = path.join(this.outputDir, relativeFolder);
    const task = this.writeQueue.then(async () => {
      const library = await this.readLibrary();
      await mkdir(batchFolder, { recursive: true });
      let changed = false;
      const uniqueImages = [...new Map(images.map((image) => [image.id, image])).values()];
      const linkOwners = new Map<string, string>();
      for (const image of library.images) {
        for (const batchLink of image.batchLinks ?? []) linkOwners.set(batchLink, image.id);
      }

      for (const requested of uniqueImages) {
        const image = library.images.find((candidate) => candidate.id === requested.id);
        if (!image) continue;
        const source = this.resolveRelative(image.relativePath);
        try {
          await access(source);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        const existingRelative = (image.batchLinks ?? []).find((batchLink) => path.dirname(batchLink) === relativeFolder);
        const relativeLink = existingRelative || await this.availableBatchLink(relativeFolder, requested.name, source, image.id, linkOwners);
        const destination = this.resolveRelative(relativeLink);
        try {
          await access(destination);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          try {
            await link(source, destination);
          } catch (linkError) {
            if (!['EXDEV', 'EPERM', 'EACCES', 'ENOTSUP'].includes((linkError as NodeJS.ErrnoException).code ?? '')) throw linkError;
            await copyFile(source, destination);
          }
        }
        if (!image.batchLinks?.includes(relativeLink)) {
          image.batchLinks = [...(image.batchLinks ?? []), relativeLink];
          linkOwners.set(relativeLink, image.id);
          changed = true;
        }
      }

      if (changed) await this.writeLibrary(library);
    });
    this.writeQueue = task.then(() => undefined, () => undefined);
    await task;
    return batchFolder;
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
        return this.savedImage(existing, fullPath);
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
    this.addToIndex([stored]);
    return this.savedImage(stored, destination);
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
        for (const batchLink of image.batchLinks ?? []) {
          try {
            await unlink(this.resolveRelative(batchLink));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
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
    this.removeFromIndex(removed);
    return removed;
  }

  resolveMediaRequest(urlText: string): string {
    return this.resolveProtocolRequest(urlText, 'local');
  }

  resolveThumbnailRequest(urlText: string): string {
    return this.resolveProtocolRequest(urlText, 'thumbnail');
  }

  private resolveProtocolRequest(urlText: string, hostname: 'local' | 'thumbnail'): string {
    const rawPath = urlText.replace(new RegExp(`^esse-media:\\/\\/${hostname}\\/?`, 'i'), '').split(/[?#]/, 1)[0];
    for (const rawSegment of rawPath.split('/')) {
      const segment = decodeURIComponent(rawSegment);
      if (segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\')) {
        throw new Error('Invalid media path segment.');
      }
    }
    const url = new URL(urlText);
    if (url.protocol !== 'esse-media:' || url.hostname !== hostname) throw new Error('Invalid media URL.');
    const relative = url.pathname.split('/').filter(Boolean).map(decodeURIComponent).join(path.sep);
    return this.resolveRelative(relative);
  }

  private mediaUrlFor(fullPath: string): string {
    return this.protocolUrlFor(fullPath, 'local');
  }

  private thumbnailUrlFor(fullPath: string): string {
    return this.protocolUrlFor(fullPath, 'thumbnail');
  }

  private protocolUrlFor(fullPath: string, hostname: 'local' | 'thumbnail'): string {
    const relative = path.relative(this.outputDir, fullPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Image is outside the Esse output directory.');
    const encoded = relative.split(path.sep).map(encodeURIComponent).join('/');
    return `esse-media://${hostname}/${encoded}`;
  }

  private savedImage(image: StoredImage, fullPath: string): SavedImage {
    return { ...image, mediaUrl: this.mediaUrlFor(fullPath), thumbnailUrl: this.thumbnailUrlFor(fullPath) };
  }

  private resolveRelative(relative: string): string {
    const fullPath = path.resolve(this.outputDir, relative);
    const relation = path.relative(this.outputDir, fullPath);
    if (!relation || relation === '.') throw new Error('Image path must identify a file.');
    if (relation.startsWith('..') || path.isAbsolute(relation)) throw new Error('Image path escapes the Esse output directory.');
    return fullPath;
  }

  private async availableBatchLink(relativeFolder: string, imageName: string, source: string, imageId: string, owners: Map<string, string>): Promise<string> {
    const extension = path.extname(source).toLowerCase();
    const stem = safeFileStem(imageName);
    const candidates = [`${stem}${extension}`, `${stem}-${imageId.slice(0, 8)}${extension}`];
    for (const fileName of candidates) {
      const relativeLink = path.join(relativeFolder, fileName);
      const owner = owners.get(relativeLink);
      if (owner === imageId) return relativeLink;
      if (owner) continue;
      try {
        await access(this.resolveRelative(relativeLink));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return relativeLink;
        throw error;
      }
    }
    return path.join(relativeFolder, `${stem}-${imageId}${extension}`);
  }

  private async readLibrary(): Promise<LibraryFile> {
    this.libraryPromise ??= this.loadLibrary();
    return this.libraryPromise;
  }

  private async loadLibrary(): Promise<LibraryFile> {
    let library: LibraryFile;
    try {
      const parsed = JSON.parse(await readFile(this.libraryPath, 'utf8')) as LibraryFile;
      library = parsed.version === 1 && Array.isArray(parsed.images) ? parsed : { version: 1, images: [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      library = { version: 1, images: [] };
    }
    this.reindex(library);
    return library;
  }

  private async writeLibrary(library: LibraryFile): Promise<void> {
    try {
      await mkdir(this.dataDir, { recursive: true });
      const temporary = `${this.libraryPath}.tmp`;
      await writeFile(temporary, JSON.stringify(library, null, 2), { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.libraryPath);
    } catch (error) {
      this.libraryPromise = undefined;
      this.imageIndex.clear();
      this.visibleCache = undefined;
      throw error;
    }
  }

  private reindex(library: LibraryFile): void {
    this.imageIndex = new Map(library.images.map((image) => [image.id, image]));
    this.visibleCache = undefined;
  }

  private addToIndex(images: StoredImage[]): void {
    for (const image of images) this.imageIndex.set(image.id, image);
    if (!this.visibleCache) return;
    const added = images
      .filter((image) => !image.hidden)
      .map((image) => this.savedImage(image, this.resolveRelative(image.relativePath)));
    this.visibleCache = [...added, ...this.visibleCache].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  private removeFromIndex(ids: string[]): void {
    for (const id of ids) this.imageIndex.delete(id);
    if (this.visibleCache) {
      const removed = new Set(ids);
      this.visibleCache = this.visibleCache.filter((image) => !removed.has(image.id));
    }
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

function safeFileStem(value: string): string {
  const withoutControls = [...value.trim()].map((character) => character.charCodeAt(0) < 32 ? '-' : character).join('');
  const normalized = withoutControls.replace(/[<>:"/\\|?*]/g, '-').replace(/[. ]+$/g, '').slice(0, 80) || 'image';
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(normalized) ? `_${normalized}` : normalized;
}
