import { safeStorage } from 'electron';
import type { SecretCodec } from './desktopStore.ts';

export class ElectronSecretCodec implements SecretCodec {
  encrypt(value: string): string {
    if (!value) return '';
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('当前系统无法安全保存 WebDAV 密码');
    }
    return safeStorage.encryptString(value).toString('base64');
  }

  decrypt(value: string): string {
    if (!value) return '';
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('当前系统无法解密 WebDAV 密码');
    }
    return safeStorage.decryptString(Buffer.from(value, 'base64'));
  }
}
