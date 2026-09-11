import assert from 'node:assert/strict';
import test from 'node:test';
import { handleRequest, processDueReminders } from '../src/worker.mjs';

const BASE_URL = 'https://jobs.example.com';
const ADMIN_TOKEN = 'test-admin-token-123456';

class FakeKv {
  values = new Map();

  async get(key) {
    return this.values.get(key) ?? null;
  }

  async put(key, value) {
    this.values.set(key, value);
  }

  async delete(key) {
    this.values.delete(key);
  }

  async list({ prefix = '' } = {}) {
    return {
      keys: [...this.values.keys()].filter(key => key.startsWith(prefix)).map(name => ({ name })),
      list_complete: true,
    };
  }
}

function environment() {
  const pushRequests = [];
  const pushPlusRequests = [];
  return {
    MOBILE_SYNC_ADMIN_TOKEN: ADMIN_TOKEN,
    MOBILE_SYNC_KV: new FakeKv(),
    VAPID_SUBJECT: 'https://jobs.example.com',
    VAPID_SERVER_PUBLIC_KEY: 'B'.repeat(87),
    VAPID_SERVER_PRIVATE_KEY: 'C'.repeat(43),
    PUSHPLUS_CONFIG_ENCRYPTION_KEY: 'D'.repeat(43),
    BUILD_PUSH_PAYLOAD: async message => ({ method: 'POST', body: message.data }),
    PUSH_FETCH: async (url, init) => {
      pushRequests.push({ url, init });
      return new Response(null, { status: 201 });
    },
    PUSHPLUS_FETCH: async (url, init) => {
      pushPlusRequests.push({ url, init });
      return Response.json({ code: 200, msg: '执行成功', data: 'test-short-code' });
    },
    pushRequests,
    pushPlusRequests,
    ASSETS: { fetch: async () => new Response('<h1>mobile</h1>', { status: 200 }) },
  };
}

function request(path, options = {}) {
  return new Request(`${BASE_URL}${path}`, options);
}

test('Cloudflare Worker 保持桌面端配对、密文上传和手机只读协议', async () => {
  const env = environment();
  assert.equal((await handleRequest(request('/api/health'), env)).status, 200);
  assert.equal((await handleRequest(request('/api/devices', {
    method: 'POST',
    headers: { authorization: 'Bearer wrong-token', 'content-type': 'application/json' },
    body: '{}',
  }), env)).status, 401);

  const provisionResponse = await handleRequest(request('/api/devices', {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
    body: '{}',
  }), env);
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
  const snapshotPath = `/api/snapshots/${device.deviceId}`;
  assert.equal((await handleRequest(request(snapshotPath, {
    method: 'PUT',
    headers: { authorization: `Bearer ${device.readToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(envelope),
  }), env)).status, 401);
  assert.equal((await handleRequest(request(snapshotPath, {
    method: 'PUT',
    headers: { authorization: `Bearer ${device.writeToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(envelope),
  }), env)).status, 200);

  const downloaded = await handleRequest(request(snapshotPath, {
    headers: { authorization: `Bearer ${device.readToken}` },
  }), env);
  assert.equal(downloaded.status, 200);
  assert.equal((await downloaded.json()).ciphertext, 'AQ');
  assert.equal((await handleRequest(request(snapshotPath, {
    method: 'PUT',
    headers: { authorization: `Bearer ${device.writeToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(envelope),
  }), env)).status, 409);
});

test('Cloudflare Worker 只存令牌哈希并为静态手机页附加安全响应头', async () => {
  const env = environment();
  const provisioned = await handleRequest(request('/api/devices', {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
    body: '{}',
  }), env).then(response => response.json());
  const storedDevice = [...env.MOBILE_SYNC_KV.values.values()].join('\n');
  assert.doesNotMatch(storedDevice, new RegExp(provisioned.readToken));
  assert.doesNotMatch(storedDevice, new RegExp(provisioned.writeToken));

  const asset = await handleRequest(request('/'), env);
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await asset.text(), /mobile/);
});

test('Cloudflare Worker 保存提醒计划并在电脑关机后幂等发送 24h 和 5h 手机推送', async () => {
  const env = environment();
  const device = await handleRequest(request('/api/devices', {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
    body: '{}',
  }), env).then(response => response.json());
  const subscriptionPath = `/api/push-subscriptions/${device.deviceId}`;
  const subscription = {
    endpoint: 'https://push.example.com/subscription-1',
    expirationTime: null,
    keys: { p256dh: 'A'.repeat(87), auth: 'B'.repeat(22) },
  };
  assert.equal((await handleRequest(request(subscriptionPath, {
    method: 'PUT',
    headers: { authorization: `Bearer ${device.readToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(subscription),
  }), env)).status, 200);

  const reminderPath = `/api/reminders/${device.deviceId}`;
  const job = {
    id: 'record-1:assessment:2026-09-12T20%3A00:1440',
    eventId: 'record-1:assessment:2026-09-12T20%3A00',
    dueAt: '2026-09-11T12:00:00.000Z',
    eventAt: '2026-09-12T12:00:00.000Z',
    offsetMinutes: 1440,
    payload: {
      algorithm: 'A256GCM',
      iv: 'AAAAAAAAAAAAAAAA',
      authTag: 'AAAAAAAAAAAAAAAAAAAAAA',
      ciphertext: 'AQ',
    },
  };
  const fiveHourJob = {
    ...job,
    id: 'record-1:assessment:2026-09-12T20%3A00:300',
    dueAt: '2026-09-12T07:00:00.000Z',
    offsetMinutes: 300,
  };
  assert.equal((await handleRequest(request(reminderPath, {
    method: 'PUT',
    headers: { authorization: `Bearer ${device.writeToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      schemaVersion: 1,
      updatedAt: '2026-09-10T00:00:00.000Z',
      jobs: [job, fiveHourJob],
    }),
  }), env)).status, 200);

  await processDueReminders(env, Date.parse('2026-09-11T12:01:00.000Z'));
  await processDueReminders(env, Date.parse('2026-09-11T12:02:00.000Z'));
  await processDueReminders(env, Date.parse('2026-09-12T07:01:00.000Z'));
  await processDueReminders(env, Date.parse('2026-09-12T07:02:00.000Z'));
  assert.equal(env.pushRequests.length, 2);
  assert.equal(env.pushRequests[0].url, subscription.endpoint);
  assert.match(String(env.pushRequests[0].init.body), /recruitment-reminder/);
  const storedPlan = JSON.parse(await env.MOBILE_SYNC_KV.get(`reminders:${device.deviceId}`));
  assert.equal(storedPlan.jobs.every(item => typeof item.deliveries?.webPush === 'string'), true);
});

test('国内手机提醒加密保存 token，并通过 PushPlus App 独立发送和关闭', async () => {
  const env = environment();
  const device = await handleRequest(request('/api/devices', {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
    body: '{}',
  }), env).then(response => response.json());
  const configPath = `/api/pushplus-config/${device.deviceId}`;
  const pushPlusToken = '1234567890abcdef1234567890abcdef';
  const saved = await handleRequest(request(configPath, {
    method: 'PUT',
    headers: { authorization: `Bearer ${device.readToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ token: pushPlusToken }),
  }), env);
  assert.equal(saved.status, 200);
  assert.doesNotMatch(await env.MOBILE_SYNC_KV.get(`pushplus:${device.deviceId}`), new RegExp(pushPlusToken));
  const status = await handleRequest(request(configPath, {
    headers: { authorization: `Bearer ${device.readToken}` },
  }), env).then(response => response.json());
  assert.deepEqual({ enabled: status.enabled, tokenHint: status.tokenHint }, {
    enabled: true,
    tokenHint: '••••cdef',
  });

  const job = {
    id: 'record-pushplus:assessment:1440',
    eventId: 'record-pushplus:assessment',
    dueAt: '2026-09-11T12:00:00.000Z',
    eventAt: '2026-09-12T12:00:00.000Z',
    offsetMinutes: 1440,
    payload: {
      algorithm: 'A256GCM',
      iv: 'AAAAAAAAAAAAAAAA',
      authTag: 'AAAAAAAAAAAAAAAAAAAAAA',
      ciphertext: 'AQ',
    },
    notification: {
      title: '示例科技 · 测评截止提醒',
      body: '09/12 20:00 截止（提前 24 小时提醒）',
    },
  };
  await handleRequest(request(`/api/reminders/${device.deviceId}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${device.writeToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ schemaVersion: 1, updatedAt: '2026-09-10T00:00:00.000Z', jobs: [job] }),
  }), env);
  await processDueReminders(env, Date.parse('2026-09-11T12:01:00.000Z'));
  await processDueReminders(env, Date.parse('2026-09-11T12:02:00.000Z'));
  assert.equal(env.pushPlusRequests.length, 1);
  const scheduledMessage = JSON.parse(String(env.pushPlusRequests[0].init.body));
  assert.equal(scheduledMessage.channel, 'app');
  assert.equal(scheduledMessage.title, job.notification.title);
  assert.equal(scheduledMessage.content, job.notification.body);

  assert.equal((await handleRequest(request(configPath, {
    method: 'POST',
    headers: { authorization: `Bearer ${device.readToken}` },
  }), env)).status, 200);
  assert.equal(env.pushPlusRequests.length, 2);
  assert.equal((await handleRequest(request(configPath, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${device.readToken}` },
  }), env)).status, 200);
  assert.equal(await env.MOBILE_SYNC_KV.get(`pushplus:${device.deviceId}`), null);
});

test('手机提醒订阅可独立删除且不影响设备配对', async () => {
  const env = environment();
  const device = await handleRequest(request('/api/devices', {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
    body: '{}',
  }), env).then(response => response.json());
  const subscriptionPath = `/api/push-subscriptions/${device.deviceId}`;
  const subscription = {
    endpoint: 'https://push.example.com/subscription-delete',
    expirationTime: null,
    keys: { p256dh: 'A'.repeat(87), auth: 'B'.repeat(22) },
  };
  await handleRequest(request(subscriptionPath, {
    method: 'PUT',
    headers: { authorization: `Bearer ${device.readToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(subscription),
  }), env);

  const response = await handleRequest(request(subscriptionPath, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${device.readToken}` },
  }), env);

  assert.equal(response.status, 200);
  assert.match(response.headers.get('access-control-allow-methods'), /DELETE/);
  assert.equal(await env.MOBILE_SYNC_KV.get(`push:${device.deviceId}`), null);
  assert.ok(await env.MOBILE_SYNC_KV.get(`device:${device.deviceId}`));
});
