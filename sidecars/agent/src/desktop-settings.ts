import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface DesktopSettingsDocument {
  version: 1;
  defaultOfferingId?: string;
  updatedAt: string;
}

export class DesktopSettingsStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async getDefaultOfferingId(): Promise<string | undefined> {
    return (await this.read()).defaultOfferingId;
  }

  async setDefaultOfferingId(id: string): Promise<void> {
    const clean = id.trim();
    if (!clean || clean.length > 200) throw new Error('Invalid default model.');
    const task = this.writeQueue.then(async () => {
      const document = await this.read();
      document.defaultOfferingId = clean;
      document.updatedAt = new Date().toISOString();
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(document, null, 2), { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.filePath);
    });
    this.writeQueue = task.then(() => undefined, () => undefined);
    await task;
  }

  private async read(): Promise<DesktopSettingsDocument> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as DesktopSettingsDocument;
      if (parsed?.version === 1) return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return { version: 1, updatedAt: new Date(0).toISOString() };
  }
}
