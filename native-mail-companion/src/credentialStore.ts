import { Entry } from '@napi-rs/keyring';
import type { CredentialStore } from './types.js';

const SERVICE_NAME = 'JobApplicationHelper.Mail';

export class KeyringCredentialStore implements CredentialStore {
  async get(accountId: string): Promise<string | null> {
    const value = new Entry(SERVICE_NAME, accountId).getPassword();
    return value || null;
  }

  async set(accountId: string, credential: string): Promise<void> {
    new Entry(SERVICE_NAME, accountId).setPassword(credential);
  }

  async delete(accountId: string): Promise<void> {
    try {
      new Entry(SERVICE_NAME, accountId).deletePassword();
    } catch (error) {
      if (!isMissingCredentialError(error)) throw error;
    }
  }
}

function isMissingCredentialError(error: unknown): boolean {
  return error instanceof Error && /not found|no entry|missing/i.test(error.message);
}
