import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMobileSyncServer } from '../server.mjs';

test('云端为桌面和手机分配不同权限，并拒绝旧快照覆盖', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'job-helper-mobile-cloud-'));
  const server = await createMobileSyncServer({
    adminToken: 'test-admin-token-123456',
    dataDirectory: directory,
    mobileAppDirectory: join(import.meta.dirname, '../../mobile-app'),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const provisionResponse = await fetch(`${baseUrl}/api/devices`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-admin-token-123456', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(provisionResponse.status, 201);
    const device = await provisionResponse.json();
    const envelope = {
      schemaVersion: 1,
      deviceId: device.deviceId,
      revision: 100,
      updatedAt: '2026-09-09T12:00:00.000Z',
      algorithm: 'A256GCM',
      iv: 'AAAAAAAAAAAAAAAA',
      authTag: 'AAAAAAAAAAAAAAAAAAAAAA',
      ciphertext: 'AQ',
    };
    const snapshotUrl = `${baseUrl}/api/snapshots/${device.deviceId}`;
    assert.equal((await fetch(snapshotUrl, {
      method: 'PUT',
      headers: { authorization: `Bearer ${device.readToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
    })).status, 401);
    assert.equal((await fetch(snapshotUrl, {
      method: 'PUT',
      headers: { authorization: `Bearer ${device.writeToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
    })).status, 200);
    const downloaded = await fetch(snapshotUrl, {
      headers: { authorization: `Bearer ${device.readToken}` },
    });
    assert.equal(downloaded.status, 200);
    assert.equal((await downloaded.json()).ciphertext, 'AQ');
    assert.equal((await fetch(snapshotUrl, {
      method: 'PUT',
      headers: { authorization: `Bearer ${device.writeToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
    })).status, 409);
  } finally {
    server.close();
    await once(server, 'close');
    await rm(directory, { recursive: true, force: true });
  }
});
