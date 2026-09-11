import { validateEnvelope, validDeviceId } from '../../mobile-cloud/lib/snapshotEnvelope.mjs';

const DEVICE_PREFIX = 'device:';
const SNAPSHOT_PREFIX = 'snapshot:';
const REMINDER_PREFIX = 'reminders:';
const PUSH_PREFIX = 'push:';
const PUSHPLUS_PREFIX = 'pushplus:';
const VALID_OFFSETS = new Set([1440, 300]);

export class KvSnapshotStore {
  constructor(namespace) {
    if (!namespace?.get || !namespace?.put) throw new Error('MOBILE_SYNC_KV 未绑定');
    this.namespace = namespace;
  }

  async provision() {
    const deviceId = randomBase64Url(16);
    const writeToken = randomBase64Url(32);
    const readToken = randomBase64Url(32);
    await this.namespace.put(deviceKey(deviceId), JSON.stringify({
      schemaVersion: 1,
      deviceId,
      writeTokenHash: await tokenHash(writeToken),
      readTokenHash: await tokenHash(readToken),
      createdAt: new Date().toISOString(),
    }));
    return { deviceId, writeToken, readToken };
  }

  async authorize(deviceId, token, access) {
    if (!validDeviceId(deviceId) || typeof token !== 'string') return false;
    const device = await readJson(this.namespace, deviceKey(deviceId));
    if (!device) return false;
    const expected = access === 'write' ? device.writeTokenHash : device.readTokenHash;
    return typeof expected === 'string' && safeEqual(expected, await tokenHash(token));
  }

  getSnapshot(deviceId) {
    if (!validDeviceId(deviceId)) return undefined;
    return readJson(this.namespace, snapshotKey(deviceId));
  }

  async putSnapshot(deviceId, envelope) {
    validateEnvelope(deviceId, envelope);
    const current = await this.getSnapshot(deviceId);
    if (current && Number(current.revision) >= envelope.revision) {
      const error = new Error('云端已有更新的快照，请重新同步');
      error.code = 'STALE_REVISION';
      throw error;
    }
    await this.namespace.put(snapshotKey(deviceId), JSON.stringify(envelope));
  }

  getReminderPlan(deviceId) {
    if (!validDeviceId(deviceId)) return undefined;
    return readJson(this.namespace, reminderKey(deviceId));
  }

  async putReminderPlan(deviceId, value) {
    const plan = validateReminderPlan(value);
    const current = await this.getReminderPlan(deviceId);
    const deliveryState = new Map((current?.jobs ?? []).map(job => [job.id, {
      handledAt: job.handledAt,
      deliveries: job.deliveries,
    }]));
    const jobs = plan.jobs.map(job => ({ ...job, ...deliveryState.get(job.id) }));
    await this.namespace.put(reminderKey(deviceId), JSON.stringify({ ...plan, deviceId, jobs }));
  }

  async listReminderPlans() {
    if (!this.namespace.list) throw new Error('MOBILE_SYNC_KV 不支持列出提醒计划');
    const plans = [];
    let cursor;
    do {
      const page = await this.namespace.list({ prefix: REMINDER_PREFIX, cursor });
      for (const key of page.keys ?? []) {
        const plan = await readJson(this.namespace, key.name);
        if (plan) plans.push(plan);
      }
      if (page.list_complete !== false) break;
      cursor = page.cursor;
    } while (cursor);
    return plans;
  }

  async markReminderChannelHandled(deviceId, reminderIds, channel, handledAt) {
    const plan = await this.getReminderPlan(deviceId);
    if (!plan) return;
    const ids = new Set(reminderIds);
    const jobs = plan.jobs.map(job => ids.has(job.id) ? {
      ...job,
      deliveries: { ...job.deliveries, [channel]: handledAt },
    } : job);
    await this.namespace.put(reminderKey(deviceId), JSON.stringify({ ...plan, jobs }));
  }

  getPushSubscription(deviceId) {
    if (!validDeviceId(deviceId)) return undefined;
    return readJson(this.namespace, pushKey(deviceId));
  }

  async putPushSubscription(deviceId, value) {
    const subscription = validatePushSubscription(value);
    await this.namespace.put(pushKey(deviceId), JSON.stringify({
      ...subscription,
      deviceId,
      updatedAt: new Date().toISOString(),
    }));
  }

  async deletePushSubscription(deviceId) {
    if (validDeviceId(deviceId) && this.namespace.delete) {
      await this.namespace.delete(pushKey(deviceId));
    }
  }

  getPushPlusConfig(deviceId) {
    if (!validDeviceId(deviceId)) return undefined;
    return readJson(this.namespace, pushPlusKey(deviceId));
  }

  async putPushPlusConfig(deviceId, value) {
    if (!validDeviceId(deviceId)) throw dataError('INVALID_PUSHPLUS_CONFIG', '国内手机提醒配置无效');
    await this.namespace.put(pushPlusKey(deviceId), JSON.stringify(value));
  }

  async deletePushPlusConfig(deviceId) {
    if (validDeviceId(deviceId) && this.namespace.delete) {
      await this.namespace.delete(pushPlusKey(deviceId));
    }
  }
}

async function readJson(namespace, key) {
  const value = await namespace.get(key);
  return value ? JSON.parse(value) : undefined;
}

function deviceKey(deviceId) {
  return `${DEVICE_PREFIX}${deviceId}`;
}

function snapshotKey(deviceId) {
  return `${SNAPSHOT_PREFIX}${deviceId}`;
}

function reminderKey(deviceId) {
  return `${REMINDER_PREFIX}${deviceId}`;
}

function pushKey(deviceId) {
  return `${PUSH_PREFIX}${deviceId}`;
}

function pushPlusKey(deviceId) {
  return `${PUSHPLUS_PREFIX}${deviceId}`;
}

function validateReminderPlan(value) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.jobs) || value.jobs.length > 1000) {
    throw dataError('INVALID_REMINDER_PLAN', '手机提醒计划格式无效');
  }
  if (typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw dataError('INVALID_REMINDER_PLAN', '手机提醒计划更新时间无效');
  }
  return {
    schemaVersion: 1,
    updatedAt: value.updatedAt,
    jobs: value.jobs.map(validateReminderJob),
  };
}

function validateReminderJob(job) {
  const dueAt = typeof job?.dueAt === 'string' ? Date.parse(job.dueAt) : Number.NaN;
  const eventAt = typeof job?.eventAt === 'string' ? Date.parse(job.eventAt) : Number.NaN;
  if (
    typeof job?.id !== 'string' || !job.id || job.id.length > 512
    || typeof job.eventId !== 'string' || !job.eventId || job.eventId.length > 512
    || !Number.isFinite(dueAt) || !Number.isFinite(eventAt) || dueAt >= eventAt
    || !VALID_OFFSETS.has(job.offsetMinutes)
    || !validEncryptedPayload(job.payload)
  ) throw dataError('INVALID_REMINDER_PLAN', '手机提醒任务格式无效');
  return {
    id: job.id,
    eventId: job.eventId,
    dueAt: new Date(dueAt).toISOString(),
    eventAt: new Date(eventAt).toISOString(),
    offsetMinutes: job.offsetMinutes,
    payload: job.payload,
    notification: validateNotification(job.notification),
  };
}

function validateNotification(value) {
  if (value === undefined) return undefined;
  if (
    typeof value?.title !== 'string' || !value.title.trim() || value.title.length > 120
    || typeof value.body !== 'string' || !value.body.trim() || value.body.length > 320
  ) throw dataError('INVALID_REMINDER_PLAN', '手机提醒公开文案格式无效');
  return { title: value.title.trim(), body: value.body.trim() };
}

function validEncryptedPayload(value) {
  return value?.algorithm === 'A256GCM'
    && validBase64Url(value.iv, 64)
    && validBase64Url(value.authTag, 64)
    && validBase64Url(value.ciphertext, 4096);
}

function validatePushSubscription(value) {
  let endpoint;
  try {
    endpoint = new URL(value?.endpoint);
  } catch {
    throw dataError('INVALID_PUSH_SUBSCRIPTION', '手机推送订阅地址无效');
  }
  if (
    endpoint.protocol !== 'https:' || endpoint.toString().length > 2048
    || !validBase64Url(value?.keys?.p256dh, 256)
    || !validBase64Url(value?.keys?.auth, 256)
  ) throw dataError('INVALID_PUSH_SUBSCRIPTION', '手机推送订阅格式无效');
  return {
    endpoint: endpoint.toString(),
    expirationTime: Number.isFinite(value.expirationTime) ? value.expirationTime : null,
    keys: { p256dh: value.keys.p256dh, auth: value.keys.auth },
  };
}

function validBase64Url(value, maxLength) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
    && /^[A-Za-z0-9_-]+$/.test(value);
}

function dataError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function randomBase64Url(byteLength) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function tokenHash(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function safeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
