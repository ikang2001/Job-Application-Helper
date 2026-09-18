import { app, BrowserWindow } from 'electron';
import { createCipheriv, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMobileSyncServer } from '../server.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outputPath = join(projectRoot, '.artifacts/mobile-pwa-smoke.png');

void app.whenReady().then(run).catch(error => {
  console.error(error);
  app.exit(1);
});

async function run() {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'job-helper-mobile-smoke-'));
  const adminToken = 'smoke-admin-token-123456';
  const server = await createMobileSyncServer({
    adminToken,
    dataDirectory,
    mobileAppDirectory: join(projectRoot, 'mobile-app'),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('手机烟测服务未启动');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const provisioned = await fetch(`${baseUrl}/api/devices`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: '{}',
    }).then(response => response.json());
    const key = randomBytes(32);
    const revision = Date.now();
    const generatedAt = new Date().toISOString();
    const snapshot = sampleSnapshot(revision, generatedAt);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`job-application-helper-mobile:${provisioned.deviceId}:${revision}`));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(snapshot), 'utf8'), cipher.final()]);
    await fetch(`${baseUrl}/api/snapshots/${provisioned.deviceId}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${provisioned.writeToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: 1,
        deviceId: provisioned.deviceId,
        revision,
        updatedAt: generatedAt,
        algorithm: 'A256GCM',
        iv: iv.toString('base64url'),
        authTag: cipher.getAuthTag().toString('base64url'),
        ciphertext: ciphertext.toString('base64url'),
      }),
    });
    const pairing = Buffer.from(JSON.stringify({
      v: 1,
      serverUrl: baseUrl,
      deviceId: provisioned.deviceId,
      readToken: provisioned.readToken,
      key: key.toString('base64url'),
    }), 'utf8').toString('base64url');
    const window = new BrowserWindow({
      width: 390,
      height: 844,
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    await window.loadURL(`${baseUrl}/#pair=${pairing}`);
    let rendered = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      rendered = await window.webContents.executeJavaScript(`Boolean(document.querySelector('#record-list .data-card'))`);
      if (rendered) break;
      await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
    }
    if (!rendered) throw new Error('手机 PWA 未渲染加密快照');
    await new Promise(resolvePromise => setTimeout(resolvePromise, 350));
    const renderedState = await window.webContents.executeJavaScript(`({
      cards: document.querySelectorAll('#record-list .data-card').length,
      total: document.querySelector('#metric-total')?.textContent,
      caption: document.querySelector('#sync-caption')?.textContent,
    })`);
    console.log(JSON.stringify(renderedState));
    const image = await window.webContents.capturePage();
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, image.toPNG());
    console.log(outputPath);
    window.destroy();
  } finally {
    server.close();
    await once(server, 'close');
    await rm(dataDirectory, { recursive: true, force: true });
    app.quit();
  }
}

function sampleSnapshot(revision, generatedAt) {
  return {
    schemaVersion: 1,
    revision,
    generatedAt,
    applications: [{
      id: 'smoke-record', companyName: '示例科技', jobTitle: 'Agent 开发工程师',
      sourceSite: 'jobs.example.com', sourceUrl: 'https://jobs.example.com/1', status: '面试中',
      notes: '二面时间已确认', appliedAt: '2026-09-09T18:30:00.000Z', location: '武汉',
      recruitmentSchedule: { interviews: { second: { scheduledAt: '2026-09-12T19:00', url: 'https://meeting.example.com/2' } } },
      createdAt: generatedAt, updatedAt: generatedAt,
    }],
    careerFairs: [{
      id: 'smoke-fair', name: '示例大学秋季双选会', status: '计划参加', startsAt: '2026-09-15T19:00',
      endsAt: '', mode: '线下', location: '中心校区', organizer: '就业中心', registrationDeadline: '',
      eventUrl: 'https://career.example.com/fair', targetCompanies: '示例科技', targetRoles: 'Agent 开发工程师',
      preparation: '纸质简历', notes: '', createdAt: generatedAt, updatedAt: generatedAt,
    }],
  };
}
