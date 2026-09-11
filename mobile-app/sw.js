const CACHE_NAME = 'job-helper-mobile-v10';
const APP_SHELL = ['./', './index.html', './app.js?v=10', './career-fairs.js?v=10', './schedules.js?v=9', './styles.css?v=9', './manifest.webmanifest', './icon.svg'];
const DB_NAME = 'job-application-helper-mobile';
const DB_VERSION = 1;
const STORE_NAME = 'private-state';

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) return;
  event.respondWith(fetch(event.request)
    .then(response => {
      if (response.ok) caches.open(CACHE_NAME).then(cache => cache.put(event.request, response.clone()));
      return response;
    })
    .catch(() => caches.match(event.request).then(cached => cached || caches.match('./index.html'))));
});

self.addEventListener('push', event => {
  event.waitUntil(showRecruitmentReminder(event.data));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(openMobileApp());
});

async function showRecruitmentReminder(data) {
  let message = { title: '求职安排提醒', body: '你有一项笔试、测评或面试安排即将开始' };
  let reminderId = 'unknown';
  try {
    const value = data?.json();
    if (value?.type !== 'recruitment-reminder' || typeof value.reminderId !== 'string') {
      throw new Error('提醒消息格式无效');
    }
    reminderId = value.reminderId;
    message = await decryptReminderPayload(value.payload, reminderId);
  } catch (error) {
    console.error('手机提醒内容解密失败，将显示通用提醒', error);
  }
  await self.registration.showNotification(message.title, {
    body: message.body,
    icon: './icon.svg',
    badge: './icon.svg',
    tag: `recruitment-reminder:${reminderId}`,
    data: { url: './' },
  });
}

async function decryptReminderPayload(payload, reminderId) {
  if (payload?.algorithm !== 'A256GCM') throw new Error('提醒加密格式无效');
  const configuration = await databaseGet('configuration');
  if (!configuration?.deviceId || !configuration?.key) throw new Error('手机尚未完成安全配对');
  const keyBytes = fromBase64Url(configuration.key);
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  const ciphertext = fromBase64Url(payload.ciphertext);
  const authTag = fromBase64Url(payload.authTag);
  const encrypted = new Uint8Array(ciphertext.length + authTag.length);
  encrypted.set(ciphertext);
  encrypted.set(authTag, ciphertext.length);
  const plaintext = await crypto.subtle.decrypt({
    name: 'AES-GCM',
    iv: fromBase64Url(payload.iv),
    additionalData: new TextEncoder().encode(
      `job-application-helper-reminder:${configuration.deviceId}:${reminderId}`,
    ),
    tagLength: 128,
  }, key, encrypted);
  const message = JSON.parse(new TextDecoder().decode(plaintext));
  if (typeof message?.title !== 'string' || typeof message?.body !== 'string') {
    throw new Error('提醒内容格式无效');
  }
  return message;
}

async function openMobileApp() {
  const url = new URL('./', self.location.href).href;
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of windows) {
    if ('navigate' in client) await client.navigate(url);
    return client.focus();
  }
  return self.clients.openWindow(url);
}

function databaseGet(key) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => {
      const transaction = request.result.transaction(STORE_NAME, 'readonly');
      const getRequest = transaction.objectStore(STORE_NAME).get(key);
      getRequest.onerror = () => reject(getRequest.error);
      getRequest.onsuccess = () => resolve(getRequest.result);
    };
  });
}

function fromBase64Url(value) {
  const base64 = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}
