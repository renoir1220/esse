import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { safeStorage } from 'electron';

interface PairingFile {
  version: 1;
  encryptedToken: string;
}

export class McpPairingStore {
  private readonly filePath: string;

  constructor(private readonly dataDir: string) {
    this.filePath = path.join(dataDir, 'mcp-pairing.json');
  }

  async getOrCreate(): Promise<string> {
    const existing = await this.load();
    if (existing) return existing;
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Operating system credential encryption is unavailable.');
    const token = randomBytes(32).toString('base64url');
    await mkdir(this.dataDir, { recursive: true });
    const payload: PairingFile = {
      version: 1,
      encryptedToken: safeStorage.encryptString(token).toString('base64'),
    };
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.filePath);
    return token;
  }

  private async load(): Promise<string | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as PairingFile;
      if (parsed.version !== 1 || !parsed.encryptedToken) return undefined;
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Operating system credential encryption is unavailable.');
      return safeStorage.decryptString(Buffer.from(parsed.encryptedToken, 'base64'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
}
