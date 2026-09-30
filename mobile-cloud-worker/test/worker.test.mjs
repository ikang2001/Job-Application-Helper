import assert from 'node:assert/strict';
import test from 'node:test';
import worker, { handleRequest, processDueReminders } from '../src/worker.mjs';

const BASE_URL = 'https://jobs.example.com';
const ADMIN_TOKEN = 'test-admin-token-123456';

class FakeKv {
  values = new Map();
  listCalls = 0;

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
    this.listCalls += 1;
    return {
      keys: [...this.values.keys()].filter(key => key.startsWith(prefix)).map(name => ({ name })),
      list_complete: true,
    };
  }
}

test('旧的一分钟触发器每日最多列举288次，空计划不额外写KV', async () => {
  const env = environment();
  const day = Date.parse('2026-09-29T00:00:00Z');
  for (let minute = 0; minute < 1440; minute += 1) {
    const tasks = [];
    worker.scheduled({ scheduledTime: day + minute * 60_000 }, env, { waitUntil: task => tasks.push(task) });
    await Promise.all(tasks);
  }
  assert.equal(env.MOBILE_SYNC_KV.listCalls, 288);
  assert.equal(env.MOBILE_SYNC_KV.values.size, 0);
});

test('提醒检查间隔按设备鉴权保存，保留计划与送达状态，延迟检查可补发且不重复', async () => {
  const env = environment();
  const provision = () => handleRequest(request('/api/devices', {
    method: 'POST', headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, body: '{}',
  }), env).then(result => result.json());
  const device = await provision();
  const other = await provision();
  const path = `/api/reminder-settings/${device.deviceId}`;
  const save = (minutes, token = device.writeToken) => handleRequest(request(path, {
    method: 'PUT', headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ checkIntervalMinutes: minutes }),
  }), env);
  assert.equal((await save(10, device.readToken)).status, 401);
  assert.equal((await save(10, other.writeToken)).status, 401);
  for (const value of [0, 1, 6, 65, 5.5, '10', null]) assert.equal((await save(value)).status, 400);
  const result = await save(10);
  assert.equal(result.status, 200);
  assert.equal((await result.json()).checkIntervalMinutes, 10);
  const job = {
    id: 'example-reminder', eventId: 'example-event', offsetMinutes: 300,
    dueAt: '2026-09-29T12:03:00Z', eventAt: '2026-09-29T17:03:00Z',
    payload: { algorithm: 'A256GCM', iv: 'AAAAAAAAAAAAAAAA', authTag: 'AAAAAAAAAAAAAAAAAAAAAA', ciphertext: 'AQ' },
  };
  const upload = () => handleRequest(request(`/api/reminders/${device.deviceId}`, {
    method: 'PUT', headers: { authorization: `Bearer ${device.writeToken}` },
    body: JSON.stringify({ schemaVersion: 1, updatedAt: '2026-09-29T12:00:00Z', jobs: [job] }),
  }), env);
  assert.equal((await upload()).status, 200);
  await handleRequest(request(`/api/push-subscriptions/${device.deviceId}`, {
    method: 'PUT', headers: { authorization: `Bearer ${device.readToken}` },
    body: JSON.stringify({ endpoint: 'https://push.example.com/test', keys: { p256dh: 'A'.repeat(87), auth: 'B'.repeat(22) } }),
  }), env);
  await processDueReminders(env, Date.parse('2026-09-29T12:05:00Z'));
  assert.equal(env.pushRequests.length, 0);
  await processDueReminders(env, Date.parse('2026-09-29T12:10:00Z'));
  assert.equal(env.pushRequests.length, 1);
  await save(15);
  await upload();
  await processDueReminders(env, Date.parse('2026-09-29T12:15:00Z'));
  assert.equal(env.pushRequests.length, 1);
  const plan = JSON.parse(await env.MOBILE_SYNC_KV.get(`reminders:${device.deviceId}`));
  assert.equal(plan.checkIntervalMinutes, 15);
  assert.ok(plan.jobs[0].deliveries.webPush);
  assert.equal(await env.MOBILE_SYNC_KV.get(`reminders:${other.deviceId}`), null);
});

test('提醒发送失败会在下个检查周期重试，过期事件不补发', async () => {
  const env = environment();
  const deviceId = 'example-device-123456';
  const job = { id: 'retry', eventId: 'retry-event', offsetMinutes: 300,
    dueAt: '2026-09-29T12:03:00Z', eventAt: '2026-09-29T17:03:00Z', payload: {} };
  env.MOBILE_SYNC_KV.values.set(`reminders:${deviceId}`, JSON.stringify({ deviceId, checkIntervalMinutes: 10, jobs: [job] }));
  env.MOBILE_SYNC_KV.values.set(`push:${deviceId}`, JSON.stringify({ endpoint: 'https://push.example.com/retry' }));
  let attempts = 0;
  env.PUSH_FETCH = async () => new Response(null, { status: ++attempts === 1 ? 503 : 201 });
  await processDueReminders(env, Date.parse('2026-09-29T12:10:00Z'));
  await processDueReminders(env, Date.parse('2026-09-29T12:20:00Z'));
  await processDueReminders(env, Date.parse('2026-09-29T12:30:00Z'));
  assert.equal(attempts, 2);
  env.MOBILE_SYNC_KV.values.set(`reminders:${deviceId}`, JSON.stringify({ deviceId, checkIntervalMinutes: 10, jobs: [job] }));
  await processDueReminders(env, Date.parse('2026-09-29T18:00:00Z'));
  assert.equal(attempts, 2);
});

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
