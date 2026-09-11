import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { AccountStore, NativeMailAccountConfig } from './types.js';

interface AccountDocument {
  schemaVersion: 1;
  accounts: NativeMailAccountConfig[];
}

export function defaultAccountStorePath(): string {
  const base = process.platform === 'win32'
    ? process.env.LOCALAPPDATA || process.env.APPDATA || homedir()
    : process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support')
      : process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'JobApplicationHelper', 'mail-accounts.json');
}

export class JsonAccountStore implements AccountStore {
  constructor(private readonly filePath = defaultAccountStorePath()) {}

  async get(accountId: string): Promise<NativeMailAccountConfig | null> {
    const document = await this.read();
    return document.accounts.find(account => account.id === accountId) ?? null;
  }

  async upsert(account: NativeMailAccountConfig): Promise<void> {
    const document = await this.read();
    const existingIndex = document.accounts.findIndex(item => item.id === account.id);
    if (existingIndex >= 0) document.accounts[existingIndex] = account;
    else document.accounts.push(account);
    await this.write(document);
  }

  async delete(accountId: string): Promise<void> {
    const document = await this.read();
    document.accounts = document.accounts.filter(account => account.id !== accountId);
    await this.write(document);
  }

  private async read(): Promise<AccountDocument> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as AccountDocument;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.accounts)) {
        throw new Error('Mail account store has an unsupported schema');
      }
      return parsed;
    } catch (error) {
      if (isFileMissing(error)) return { schemaVersion: 1, accounts: [] };
      throw error;
    }
  }

  private async write(document: AccountDocument): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(document, null, 2), { encoding: 'utf8', mode: 0o600 });
    if (process.platform !== 'win32') await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, this.filePath);
  }
}

function isFileMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
