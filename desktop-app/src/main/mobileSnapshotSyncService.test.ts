import assert from 'node:assert/strict';
import { createDecipheriv } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ApplicationRecord } from '../../../src/shared/types.ts';
import { DesktopStore, type DesktopData, type SecretCodec } from './desktopStore.ts';
import { MobileSnapshotSyncService } from './mobileSnapshotSyncService.ts';

const NOW = '2026-09-09T12:00:00.000Z';

class PlainTestCodec implements SecretCodec {
  encrypt(value: string): string { return value; }
  decrypt(value: string): string { return value; }
}

test('桌面端使用写入令牌上传 AES-GCM 密文，配对链接只携带读取令牌', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'job-helper-mobile-service-'));
  const store = new DesktopStore(join(directory, 'desktop-data.json'));
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith('/api/devices')) {
      return Response.json({
        deviceId: 'device-1234567890',
        writeToken: 'write-token-1234567890',
        readToken: 'read-token-12345678901',
      }, { status: 201 });
    }
    return Response.json({ ok: true });
  };
  const service = new MobileSnapshotSyncService(store, new PlainTestCodec(), fetcher as typeof fetch);
  const record: ApplicationRecord = {
    id: 'record-1',
    companyName: '示例科技',
    jobTitle: 'Agent 开发工程师',
    sourceSite: 'jobs.example.com',
    sourceUrl: 'https://jobs.example.com/1',
    status: '面试中',
    notes: '一面链接：https://meeting.example.com/1',
    appliedAt: NOW,
    applicationEmail: 'private@example.com',
    location: '武汉',
    recruitmentSchedule: {
      assessment: { scheduledAt: '2026-09-12T20:00', url: 'https://assessment.example.com' },
    },
    events: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
  const initial: DesktopData = {
    schemaVersion: 1,
    records: [record],
    favoriteRecordIds: [],
    careerFairs: [],
    sync: { status: 'idle' },
  };

  try {
    await store.write(initial);
    const configured = await service.provision(initial, {
      serverUrl: 'https://mobile.example.com/',
      setupToken: 'setup-token-123456789',
    });
    await service.syncNow(configured);

    const upload = requests.find(request => String(request.url).includes('/api/snapshots/'));
    assert.ok(upload);
    assert.equal(new Headers(upload.init?.headers).get('authorization'), 'Bearer write-token-1234567890');
    const envelope = JSON.parse(String(upload.init?.body));
    const key = Buffer.from(configured.mobileSync?.encryptedPairingKey ?? '', 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64url'));
    decipher.setAAD(Buffer.from(`job-application-helper-mobile:${envelope.deviceId}:${envelope.revision}`));
    decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    assert.match(plaintext, /示例科技/);
    assert.doesNotMatch(plaintext, /private@example\.com/);

    const reminderUpload = requests.find(request => String(request.url).includes('/api/reminders/'));
    assert.ok(reminderUpload);
    const reminderPlan = JSON.parse(String(reminderUpload.init?.body));
    assert.equal(reminderPlan.jobs.length, 2);
    assert.deepEqual(reminderPlan.jobs.map((job: { offsetMinutes: number }) => job.offsetMinutes), [1440, 300]);
    assert.match(JSON.stringify(reminderPlan), /示例科技/);
    assert.doesNotMatch(JSON.stringify(reminderPlan), /Agent 开发工程师|private@example\.com|meeting\.example\.com/);
    assert.deepEqual(reminderPlan.jobs[0].notification, {
      title: '示例科技 · 测评开始提醒',
      body: '09/12 20:00 开始（提前 24 小时提醒）',
    });
    const reminder = reminderPlan.jobs[0];
    const reminderDecipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(reminder.payload.iv, 'base64url'),
    );
    reminderDecipher.setAAD(Buffer.from(
      `job-application-helper-reminder:${envelope.deviceId}:${reminder.id}`,
    ));
    reminderDecipher.setAuthTag(Buffer.from(reminder.payload.authTag, 'base64url'));
    const reminderPlaintext = Buffer.concat([
      reminderDecipher.update(Buffer.from(reminder.payload.ciphertext, 'base64url')),
      reminderDecipher.final(),
    ]).toString('utf8');
    assert.match(reminderPlaintext, /示例科技/);
    assert.match(reminderPlaintext, /提前 24 小时提醒/);

    const pairing = service.getPairingInfo(configured.mobileSync);
    const encoded = pairing.pairingUrl.split('#pair=')[1];
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    assert.equal(payload.readToken, 'read-token-12345678901');
    assert.equal(JSON.stringify(payload).includes('write-token'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
