import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAIL_SCAN_ALARM_NAME,
  MAIL_SCAN_PERIOD_MINUTES,
  ensureMailScanAlarm,
} from './mailScheduler.ts';
import { MAIL_RETRY_ALARM_PREFIX, restoreMailRetries, scheduleMailRetry, clearMailRetry } from './mailRetry.ts';

test('alarm 不存在时按 15 分钟创建，存在时保持不变', async () => {
  const created: Array<{ name: string; info: chrome.alarms.AlarmCreateInfo }> = [];
  await ensureMailScanAlarm({
    get: async () => undefined,
    create: async (name, info) => { created.push({ name, info }); },
  });
  assert.deepEqual(created, [{
    name: MAIL_SCAN_ALARM_NAME,
    info: { delayInMinutes: MAIL_SCAN_PERIOD_MINUTES, periodInMinutes: MAIL_SCAN_PERIOD_MINUTES },
  }]);

  await ensureMailScanAlarm({
    get: async () => ({ name: MAIL_SCAN_ALARM_NAME, scheduledTime: Date.now() }),
    create: async () => { throw new Error('不应重建'); },
  });
});

test('限流恢复闹钟按账号合并，重启从保存的时间恢复，成功后清除', async () => {
  const original = globalThis.chrome;
  const retryAt = new Date(Date.now() + 30 * 60_000).toISOString();
  const entries = new Map<string, chrome.alarms.Alarm>();
  let creates = 0;
  globalThis.chrome = {
    alarms: {
      get: async (name: string) => entries.get(name),
      create: async (name: string, info: chrome.alarms.AlarmCreateInfo) => {
        creates++; entries.set(name, { name, scheduledTime: info.when ?? 0 });
      },
      clear: async (name: string) => entries.delete(name),
    },
    storage: { local: { get: async () => ({ mailAccounts: [{ id: 'test', enabled: true, retryAt }] }) } },
  } as unknown as typeof chrome;
  try {
    await restoreMailRetries(); await scheduleMailRetry('test', retryAt);
    assert.equal(creates, 1); assert.ok(entries.has(`${MAIL_RETRY_ALARM_PREFIX}test`));
    entries.clear(); await restoreMailRetries(); assert.equal(creates, 2);
    await clearMailRetry('test'); assert.equal(entries.size, 0);
  } finally { globalThis.chrome = original; }
});
