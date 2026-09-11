import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateEnvelope, validDeviceId } from './snapshotEnvelope.mjs';

export { validateEnvelope } from './snapshotEnvelope.mjs';

export class MobileSnapshotStore {
  constructor(dataDirectory) {
    this.dataDirectory = dataDirectory;
    this.devicesDirectory = join(dataDirectory, 'devices');
    this.snapshotsDirectory = join(dataDirectory, 'snapshots');
  }

  async initialize() {
    await Promise.all([
      mkdir(this.devicesDirectory, { recursive: true }),
      mkdir(this.snapshotsDirectory, { recursive: true }),
    ]);
  }

  async provision() {
    const deviceId = randomBytes(16).toString('base64url');
    const writeToken = randomBytes(32).toString('base64url');
    const readToken = randomBytes(32).toString('base64url');
    await this.atomicWrite(this.devicePath(deviceId), JSON.stringify({
      schemaVersion: 1,
      deviceId,
      writeTokenHash: tokenHash(writeToken),
      readTokenHash: tokenHash(readToken),
      createdAt: new Date().toISOString(),
    }));
    return { deviceId, writeToken, readToken };
  }

  async authorize(deviceId, token, access) {
    if (!validDeviceId(deviceId) || typeof token !== 'string') return false;
    const device = await this.readJson(this.devicePath(deviceId));
    if (!device) return false;
    const expected = access === 'write' ? device.writeTokenHash : device.readTokenHash;
    return typeof expected === 'string' && safeEqual(expected, tokenHash(token));
  }

  async getSnapshot(deviceId) {
    if (!validDeviceId(deviceId)) return undefined;
    return this.readJson(this.snapshotPath(deviceId));
  }

  async putSnapshot(deviceId, envelope) {
    validateEnvelope(deviceId, envelope);
    const current = await this.getSnapshot(deviceId);
    if (current && Number(current.revision) >= envelope.revision) {
      const error = new Error('云端已有更新的快照，请重新同步');
      error.code = 'STALE_REVISION';
      throw error;
    }
    await this.atomicWrite(this.snapshotPath(deviceId), JSON.stringify(envelope));
  }

  devicePath(deviceId) {
    return join(this.devicesDirectory, `${deviceId}.json`);
  }

  snapshotPath(deviceId) {
    return join(this.snapshotsDirectory, `${deviceId}.json`);
  }

  async atomicWrite(targetPath, content) {
    const temporaryPath = `${targetPath}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx' });
    await rename(temporaryPath, targetPath);
  }

  async readJson(filePath) {
    try {
      return JSON.parse(await readFile(filePath, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined;
      throw error;
    }
  }
}

function tokenHash(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
