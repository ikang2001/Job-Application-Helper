import { KvSnapshotStore } from './kvSnapshotStore.mjs';
import { buildPushPayload } from '@block65/webcrypto-web-push';

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const DEVICE_PATH = /^\/api\/snapshots\/([A-Za-z0-9_-]{16,64})$/;
const REMINDER_PATH = /^\/api\/reminders\/([A-Za-z0-9_-]{16,64})$/;
const PUSH_SUBSCRIPTION_PATH = /^\/api\/push-subscriptions\/([A-Za-z0-9_-]{16,64})$/;
const PUSHPLUS_CONFIG_PATH = /^\/api\/pushplus-config\/([A-Za-z0-9_-]{16,64})$/;
const PUSHPLUS_API_URL = 'https://www.pushplus.plus/send';

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
  scheduled(controller, env, context) {
    context.waitUntil(processDueReminders(env, controller.scheduledTime));
  },
};

export async function handleRequest(request, env) {
  const url = new URL(request.url);
  try {
    if (request.method === 'OPTIONS') return response(null, 204, env);
    if (request.method === 'GET' && url.pathname === '/api/health') {
      return json({ ok: true, service: 'job-application-helper-mobile' }, 200, env);
    }
    if (request.method === 'GET' && url.pathname === '/api/push/public-key') {
      return json({ publicKey: requireVapidPublicKey(env) }, 200, env);
    }
    if (request.method === 'POST' && url.pathname === '/api/devices') {
      return await provisionDevice(request, env);
    }
    const snapshotMatch = DEVICE_PATH.exec(url.pathname);
    if (snapshotMatch) return await handleSnapshot(request, env, snapshotMatch[1]);
    const reminderMatch = REMINDER_PATH.exec(url.pathname);
    if (reminderMatch) return await handleReminderPlan(request, env, reminderMatch[1]);
    const subscriptionMatch = PUSH_SUBSCRIPTION_PATH.exec(url.pathname);
    if (subscriptionMatch) return await handlePushSubscription(request, env, subscriptionMatch[1]);
    const pushPlusMatch = PUSHPLUS_CONFIG_PATH.exec(url.pathname);
    if (pushPlusMatch) return await handlePushPlusConfig(request, env, pushPlusMatch[1]);
    if (url.pathname.startsWith('/api/')) return json({ error: '未找到请求的资源' }, 404, env);
    return await serveAsset(request, env);
  } catch (error) {
    const status = errorStatus(error);
    if (status === 500) console.error('手机同步 Worker 请求失败', error);
    return json({ error: status === 500 ? '服务器暂时无法处理请求' : error.message }, status, env);
  }
}

export async function processDueReminders(env, scheduledTime = Date.now()) {
  requireBindings(env);
  const store = new KvSnapshotStore(env.MOBILE_SYNC_KV);
  const plans = await store.listReminderPlans();
  for (const plan of plans) {
    const channels = await reminderChannels(env, store, plan.deviceId);
    for (const channel of channels) {
      for (const group of selectDueReminderJobs(plan.jobs, scheduledTime, channel.id)) {
        try {
          const result = await channel.send(group.reminder);
          if (channel.id === 'webPush' && (result.status === 404 || result.status === 410)) {
            await store.deletePushSubscription(plan.deviceId);
            break;
          }
          if (!result.ok) throw new Error(`${channel.label}返回 HTTP ${result.status}`);
          await store.markReminderChannelHandled(
            plan.deviceId,
            group.handledIds,
            channel.id,
            new Date(scheduledTime).toISOString(),
          );
        } catch (error) {
          console.error('手机提醒发送失败，将在下次调度重试', {
            deviceId: plan.deviceId,
            reminderId: group.reminder.id,
            channel: channel.id,
            error,
          });
        }
      }
    }
  }
}

export function selectDueReminderJobs(jobs, now = Date.now(), channel) {
  const dueByEvent = new Map();
  for (const job of jobs ?? []) {
    const dueAt = Date.parse(job.dueAt);
    const eventAt = Date.parse(job.eventAt);
    if (job.handledAt || (channel && job.deliveries?.[channel]) || dueAt > now || eventAt <= now) continue;
    const due = dueByEvent.get(job.eventId) ?? [];
    due.push(job);
    dueByEvent.set(job.eventId, due);
  }
  return [...dueByEvent.values()].map(due => {
    due.sort((left, right) => Date.parse(right.dueAt) - Date.parse(left.dueAt));
    return { reminder: due[0], handledIds: due.map(job => job.id) };
  });
}

async function provisionDevice(request, env) {
  requireBindings(env);
  if (!safeToken(bearerToken(request), env.MOBILE_SYNC_ADMIN_TOKEN)) return unauthorized(env);
  await readJsonBody(request, 8 * 1024);
  return json(await new KvSnapshotStore(env.MOBILE_SYNC_KV).provision(), 201, env);
}

async function handleSnapshot(request, env, deviceId) {
  requireBindings(env);
  const store = new KvSnapshotStore(env.MOBILE_SYNC_KV);
  const token = bearerToken(request);
  if (request.method === 'PUT') {
    if (!await store.authorize(deviceId, token, 'write')) return unauthorized(env);
    await store.putSnapshot(deviceId, await readJsonBody(request, MAX_BODY_BYTES));
    return json({ ok: true }, 200, env);
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ error: '请求方法不受支持' }, 405, env);
  }
  if (!await store.authorize(deviceId, token, 'read')) return unauthorized(env);
  const snapshot = await store.getSnapshot(deviceId);
  if (!snapshot) return json({ error: '尚无手机快照' }, 404, env);
  const headers = { 'cache-control': 'no-store', etag: `"${snapshot.revision}"` };
  return request.method === 'HEAD'
    ? response(null, 200, env, headers)
    : json(snapshot, 200, env, headers);
}

async function handleReminderPlan(request, env, deviceId) {
  requireBindings(env);
  if (request.method !== 'PUT') return json({ error: '请求方法不受支持' }, 405, env);
  const store = new KvSnapshotStore(env.MOBILE_SYNC_KV);
  if (!await store.authorize(deviceId, bearerToken(request), 'write')) return unauthorized(env);
  await store.putReminderPlan(deviceId, await readJsonBody(request, 1024 * 1024));
  return json({ ok: true }, 200, env);
}

async function handlePushSubscription(request, env, deviceId) {
  requireBindings(env);
  const store = new KvSnapshotStore(env.MOBILE_SYNC_KV);
  if (!await store.authorize(deviceId, bearerToken(request), 'read')) return unauthorized(env);
  if (request.method === 'DELETE') {
    await store.deletePushSubscription(deviceId);
    return json({ ok: true }, 200, env);
  }
  if (request.method !== 'PUT') return json({ error: '请求方法不受支持' }, 405, env);
  await store.putPushSubscription(deviceId, await readJsonBody(request, 16 * 1024));
  return json({ ok: true }, 200, env);
}

async function handlePushPlusConfig(request, env, deviceId) {
  requireBindings(env);
  const store = new KvSnapshotStore(env.MOBILE_SYNC_KV);
  if (!await store.authorize(deviceId, bearerToken(request), 'read')) return unauthorized(env);
  if (request.method === 'GET') {
    const config = await store.getPushPlusConfig(deviceId);
    return json({
      enabled: Boolean(config),
      tokenHint: config?.tokenLastFour ? `••••${config.tokenLastFour}` : '',
      updatedAt: config?.updatedAt,
    }, 200, env, { 'cache-control': 'no-store' });
  }
  if (request.method === 'DELETE') {
    await store.deletePushPlusConfig(deviceId);
    return json({ ok: true }, 200, env);
  }
  if (request.method === 'PUT') {
    const token = validatePushPlusToken((await readJsonBody(request, 4 * 1024))?.token);
    await store.putPushPlusConfig(deviceId, {
      schemaVersion: 1,
      ...await encryptPushPlusToken(env, deviceId, token),
      tokenLastFour: token.slice(-4),
      updatedAt: new Date().toISOString(),
    });
    return json({ ok: true, enabled: true, tokenHint: `••••${token.slice(-4)}` }, 200, env);
  }
  if (request.method === 'POST') {
    const config = await store.getPushPlusConfig(deviceId);
    if (!config) throw requestError('PUSHPLUS_NOT_CONFIGURED', '请先保存 PushPlus token');
    const token = await decryptPushPlusToken(env, deviceId, config);
    await sendPushPlusMessage(env, token, {
      title: '求职进度 · 测试提醒',
      body: '国内手机提醒已连接。之后会在安排前 24 小时和 5 小时自动提醒。',
    }, Date.now() + 5 * 60_000);
    return json({ ok: true }, 200, env);
  }
  return json({ error: '请求方法不受支持' }, 405, env);
}

async function reminderChannels(env, store, deviceId) {
  const channels = [];
  const subscription = await store.getPushSubscription(deviceId);
  if (subscription) {
    channels.push({
      id: 'webPush',
      label: '浏览器推送服务',
      send: reminder => sendWebPushReminder(env, subscription, reminder),
    });
  }
  const pushPlusConfig = await store.getPushPlusConfig(deviceId);
  if (pushPlusConfig) {
    try {
      const token = await decryptPushPlusToken(env, deviceId, pushPlusConfig);
      channels.push({
        id: 'pushPlus',
        label: 'PushPlus',
        send: reminder => sendPushPlusReminder(env, token, reminder),
      });
    } catch (error) {
      console.error('国内手机提醒配置无法解密', { deviceId, channel: 'pushPlus', error });
    }
  }
  return channels;
}

async function sendWebPushReminder(env, subscription, reminder) {
  requireVapidConfiguration(env);
  const buildPayload = typeof env.BUILD_PUSH_PAYLOAD === 'function'
    ? env.BUILD_PUSH_PAYLOAD
    : buildPushPayload;
  const payload = await buildPayload({
    data: JSON.stringify({
      type: 'recruitment-reminder',
      reminderId: reminder.id,
      payload: reminder.payload,
    }),
    options: { ttl: 6 * 60 * 60 },
  }, subscription, {
    subject: env.VAPID_SUBJECT,
    publicKey: env.VAPID_SERVER_PUBLIC_KEY,
    privateKey: env.VAPID_SERVER_PRIVATE_KEY,
  });
  const pushFetch = typeof env.PUSH_FETCH === 'function' ? env.PUSH_FETCH : fetch;
  return pushFetch(subscription.endpoint, payload);
}

async function sendPushPlusReminder(env, token, reminder) {
  const notification = reminder.notification ?? fallbackPushPlusMessage(reminder);
  return sendPushPlusMessage(env, token, notification, Date.parse(reminder.eventAt));
}

async function sendPushPlusMessage(env, token, message, expiresAt) {
  const pushPlusFetch = typeof env.PUSHPLUS_FETCH === 'function' ? env.PUSHPLUS_FETCH : fetch;
  const response = await pushPlusFetch(PUSHPLUS_API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token,
      title: message.title,
      content: message.body,
      channel: 'app',
      template: 'txt',
      timestamp: expiresAt,
    }),
  });
  if (!response.ok) throw requestError(
    'PUSHPLUS_DELIVERY_FAILED',
    `PushPlus 暂时无法接收提醒（HTTP ${response.status}）`,
  );
  const result = await response.json().catch(() => undefined);
  if (Number(result?.code) !== 200) throw requestError(
    'PUSHPLUS_DELIVERY_FAILED',
    pushPlusErrorMessage(result?.code),
  );
  return response;
}

function pushPlusErrorMessage(code) {
  const messages = {
    401: 'PushPlus 请求未授权，请检查账号状态',
    888: 'PushPlus 账号额度不足',
    900: 'PushPlus 账号当前受限，请稍后重试',
    903: 'PushPlus token 无效，请重新复制并保存',
    905: 'PushPlus 账号尚未实名认证，请先在官网完成认证',
  };
  return messages[Number(code)] ?? `PushPlus 拒绝发送提醒（code ${String(code ?? 'unknown')}）`;
}

function fallbackPushPlusMessage(reminder) {
  const eventAt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(reminder.eventAt));
  const lead = reminder.offsetMinutes === 1440 ? '24 小时' : '5 小时';
  return {
    title: '求职安排提醒',
    body: `${eventAt} 有一项安排开始或截止（提前 ${lead}提醒）`,
  };
}

async function serveAsset(request, env) {
  if (!env.ASSETS?.fetch) return json({ error: '手机页面资源未绑定' }, 500, env);
  const asset = await env.ASSETS.fetch(request);
  return response(asset.body, asset.status, env, asset.headers);
}

function requireBindings(env) {
  if (typeof env.MOBILE_SYNC_ADMIN_TOKEN !== 'string' || env.MOBILE_SYNC_ADMIN_TOKEN.length < 16) {
    throw new Error('MOBILE_SYNC_ADMIN_TOKEN 未配置或长度不足');
  }
  if (!env.MOBILE_SYNC_KV?.get || !env.MOBILE_SYNC_KV?.put) throw new Error('MOBILE_SYNC_KV 未绑定');
}

function requireVapidPublicKey(env) {
  if (typeof env.VAPID_SERVER_PUBLIC_KEY !== 'string' || env.VAPID_SERVER_PUBLIC_KEY.length < 40) {
    throw new Error('VAPID_SERVER_PUBLIC_KEY 未配置或格式无效');
  }
  return env.VAPID_SERVER_PUBLIC_KEY;
}

function requireVapidConfiguration(env) {
  requireVapidPublicKey(env);
  if (typeof env.VAPID_SERVER_PRIVATE_KEY !== 'string' || env.VAPID_SERVER_PRIVATE_KEY.length < 40) {
    throw new Error('VAPID_SERVER_PRIVATE_KEY 未配置或格式无效');
  }
  if (typeof env.VAPID_SUBJECT !== 'string' || !/^(mailto:|https:\/\/)/.test(env.VAPID_SUBJECT)) {
    throw new Error('VAPID_SUBJECT 未配置或格式无效');
  }
}

function validatePushPlusToken(value) {
  const token = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) {
    throw requestError('INVALID_PUSHPLUS_CONFIG', 'PushPlus token 格式无效，请从个人中心完整复制');
  }
  return token;
}

async function encryptPushPlusToken(env, deviceId, token) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({
    name: 'AES-GCM',
    iv,
    additionalData: new TextEncoder().encode(`job-application-helper-pushplus:${deviceId}:v1`),
  }, await pushPlusEncryptionKey(env), new TextEncoder().encode(token));
  return {
    algorithm: 'A256GCM',
    iv: toBase64Url(iv),
    ciphertext: toBase64Url(new Uint8Array(encrypted)),
  };
}

async function decryptPushPlusToken(env, deviceId, config) {
  if (
    config?.schemaVersion !== 1 || config.algorithm !== 'A256GCM'
    || typeof config.iv !== 'string' || typeof config.ciphertext !== 'string'
  ) throw new Error('PushPlus 加密配置格式无效');
  try {
    const plaintext = await crypto.subtle.decrypt({
      name: 'AES-GCM',
      iv: fromBase64Url(config.iv),
      additionalData: new TextEncoder().encode(`job-application-helper-pushplus:${deviceId}:v1`),
    }, await pushPlusEncryptionKey(env), fromBase64Url(config.ciphertext));
    return validatePushPlusToken(new TextDecoder().decode(plaintext));
  } catch (error) {
    if (error?.code === 'INVALID_PUSHPLUS_CONFIG') throw error;
    throw new Error('PushPlus 加密配置无法解密');
  }
}

async function pushPlusEncryptionKey(env) {
  let keyBytes;
  try {
    keyBytes = fromBase64Url(env.PUSHPLUS_CONFIG_ENCRYPTION_KEY);
  } catch {
    throw new Error('PUSHPLUS_CONFIG_ENCRYPTION_KEY 配置格式无效');
  }
  if (keyBytes.length !== 32) throw new Error('PUSHPLUS_CONFIG_ENCRYPTION_KEY 必须为 32 字节密钥');
  return crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function fromBase64Url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Base64URL 格式无效');
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function toBase64Url(value) {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function readJsonBody(request, limit) {
  const declaredLength = Number.parseInt(request.headers.get('content-length') || '0', 10);
  if (Number.isFinite(declaredLength) && declaredLength > limit) throw requestError('BODY_TOO_LARGE', '请求内容过大');
  const body = await request.arrayBuffer();
  if (body.byteLength > limit) throw requestError('BODY_TOO_LARGE', '请求内容过大');
  try {
    return JSON.parse(new TextDecoder().decode(body) || '{}');
  } catch {
    throw requestError('INVALID_JSON', '请求内容不是有效 JSON');
  }
}

function bearerToken(request) {
  return /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') || '')?.[1] ?? '';
}

function safeToken(actual, expected) {
  if (typeof expected !== 'string' || actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) {
    difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

function unauthorized(env) {
  return json({ error: '凭据无效' }, 401, env, { 'www-authenticate': 'Bearer' });
}

function json(value, status, env, headers) {
  return response(JSON.stringify(value), status, env, {
    'content-type': 'application/json; charset=utf-8',
    ...headers,
  });
}

function response(body, status, env, additionalHeaders) {
  const headers = new Headers(additionalHeaders);
  headers.set('access-control-allow-origin', env.MOBILE_SYNC_ALLOWED_ORIGIN || '*');
  headers.set('access-control-allow-headers', 'authorization, content-type');
  headers.set('access-control-allow-methods', 'GET, HEAD, PUT, POST, DELETE, OPTIONS');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('x-frame-options', 'DENY');
  headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  headers.set('content-security-policy', "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self' https:; manifest-src 'self'; base-uri 'none'; frame-ancestors 'none'");
  return new Response(body, { status, headers });
}

function errorStatus(error) {
  if (error?.code === 'BODY_TOO_LARGE') return 413;
  if (error?.code === 'INVALID_JSON' || error?.code === 'INVALID_ENVELOPE') return 400;
  if (error?.code === 'STALE_REVISION') return 409;
  if (
    error?.code === 'INVALID_REMINDER_PLAN'
    || error?.code === 'INVALID_PUSH_SUBSCRIPTION'
    || error?.code === 'INVALID_PUSHPLUS_CONFIG'
  ) return 400;
  if (error?.code === 'PUSHPLUS_NOT_CONFIGURED') return 409;
  if (error?.code === 'PUSHPLUS_DELIVERY_FAILED') return 502;
  return 500;
}

function requestError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
