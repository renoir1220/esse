import { safeStorage } from 'electron';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface CredentialFile {
  version: 1;
  encryptedApiKeys: Record<string, string>;
}

export class CredentialStore {
  private readonly filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly dataDir: string) {
    this.filePath = path.join(dataDir, 'provider-credentials.json');
  }

  async get(profileId: string): Promise<string | undefined> {
    const encrypted = (await this.read()).encryptedApiKeys[profileId];
    if (!encrypted) return undefined;
    this.requireEncryption();
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  }

  async has(profileId: string): Promise<boolean> {
    return Boolean((await this.read()).encryptedApiKeys[profileId]);
  }

  async set(profileId: string, apiKey: string): Promise<void> {
    const cleanId = requiredProfileId(profileId);
    const cleanKey = apiKey.trim();
    if (!cleanKey) throw new Error('请输入 API Key。');
    this.requireEncryption();
    await this.update((document) => {
      document.encryptedApiKeys[cleanId] = safeStorage.encryptString(cleanKey).toString('base64');
    });
  }

  async delete(profileId: string): Promise<void> {
    const cleanId = requiredProfileId(profileId);
    await this.update((document) => { delete document.encryptedApiKeys[cleanId]; });
  }

  async clearAll(): Promise<void> {
    await rm(this.filePath, { force: true });
  }

  private requireEncryption(): void {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('操作系统安全存储当前不可用。');
  }

  private async update(mutator: (document: CredentialFile) => void): Promise<void> {
    const task = this.writeQueue.then(async () => {
      const document = await this.read();
      mutator(document);
      await mkdir(this.dataDir, { recursive: true });
      const temporary = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.filePath);
    });
    this.writeQueue = task.then(() => undefined, () => undefined);
    await task;
  }

  private async read(): Promise<CredentialFile> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as CredentialFile;
      if (parsed.version === 1 && parsed.encryptedApiKeys && typeof parsed.encryptedApiKeys === 'object') return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return { version: 1, encryptedApiKeys: {} };
  }
}

function requiredProfileId(value: string): string {
  const clean = value.trim();
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(clean)) throw new Error('Invalid Provider profile ID.');
  return clean;
}
