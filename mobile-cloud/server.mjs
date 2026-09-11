import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MobileSnapshotStore } from './lib/snapshotStore.mjs';

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const currentDirectory = dirname(fileURLToPath(import.meta.url));

export async function createMobileSyncServer(options) {
  if (!options?.adminToken || options.adminToken.length < 16) {
    throw new Error('MOBILE_SYNC_ADMIN_TOKEN 至少需要 16 个字符');
  }
  const store = new MobileSnapshotStore(options.dataDirectory);
  await store.initialize();
  const mobileAppDirectory = options.mobileAppDirectory ?? join(currentDirectory, '../mobile-app');
  const allowedOrigin = options.allowedOrigin ?? '*';

  return createServer(async (request, response) => {
    try {
      setCommonHeaders(response, allowedOrigin);
      if (request.method === 'OPTIONS') {
        response.writeHead(204).end();
        return;
      }
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/api/health') {
        json(response, 200, { ok: true, service: 'job-application-helper-mobile' });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/devices') {
        if (!safeToken(request, options.adminToken)) return unauthorized(response);
        await readJsonBody(request, 8 * 1024);
        json(response, 201, await store.provision());
        return;
      }
      const match = /^\/api\/snapshots\/([A-Za-z0-9_-]{16,64})$/.exec(url.pathname);
      if (match) {
        const deviceId = match[1];
        const token = bearerToken(request);
        if (request.method === 'PUT') {
          if (!await store.authorize(deviceId, token, 'write')) return unauthorized(response);
          await store.putSnapshot(deviceId, await readJsonBody(request, MAX_BODY_BYTES));
          json(response, 200, { ok: true });
          return;
        }
        if (request.method === 'GET' || request.method === 'HEAD') {
          if (!await store.authorize(deviceId, token, 'read')) return unauthorized(response);
          const snapshot = await store.getSnapshot(deviceId);
          if (!snapshot) return json(response, 404, { error: '尚无手机快照' });
          response.setHeader('cache-control', 'no-store');
          response.setHeader('etag', `"${snapshot.revision}"`);
          if (request.method === 'HEAD') return response.writeHead(200).end();
          return json(response, 200, snapshot);
        }
      }
      if (request.method === 'GET' || request.method === 'HEAD') {
        const staticFile = staticFileFor(url.pathname);
        if (staticFile) {
          const content = await readFile(join(mobileAppDirectory, staticFile.name));
          response.setHeader('content-type', staticFile.contentType);
          response.setHeader('cache-control', staticFile.name === 'sw.js' ? 'no-cache' : 'public, max-age=300');
          response.writeHead(200);
          if (request.method === 'GET') response.end(content);
          else response.end();
          return;
        }
      }
      json(response, 404, { error: '未找到请求的资源' });
    } catch (error) {
      const status = error?.code === 'BODY_TOO_LARGE'
        ? 413
        : error?.code === 'INVALID_JSON' || error?.code === 'INVALID_ENVELOPE'
          ? 400
          : error?.code === 'STALE_REVISION'
            ? 409
            : error?.code === 'ENOENT'
              ? 404
              : 500;
      if (status === 500) console.error('手机同步服务请求失败', error);
      json(response, status, { error: status === 500 ? '服务器暂时无法处理请求' : error.message });
    }
  });
}

function setCommonHeaders(response, allowedOrigin) {
  response.setHeader('access-control-allow-origin', allowedOrigin);
  response.setHeader('access-control-allow-headers', 'authorization, content-type');
  response.setHeader('access-control-allow-methods', 'GET, HEAD, PUT, POST, OPTIONS');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('x-frame-options', 'DENY');
  response.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('content-security-policy', "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self' https: http://localhost:*; manifest-src 'self'; base-uri 'none'; frame-ancestors 'none'");
}

function staticFileFor(pathname) {
  const name = pathname === '/' ? 'index.html' : pathname.slice(1);
  const allowed = new Set(['index.html', 'app.js', 'styles.css', 'sw.js', 'manifest.webmanifest', 'icon.svg']);
  if (!allowed.has(name)) return undefined;
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.svg': 'image/svg+xml; charset=utf-8',
  };
  return { name, contentType: types[extname(name)] ?? 'application/octet-stream' };
}

async function readJsonBody(request, limit) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('请求内容过大');
      error.code = 'BODY_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    const error = new Error('请求内容不是有效 JSON');
    error.code = 'INVALID_JSON';
    throw error;
  }
}

function bearerToken(request) {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? '');
  return match?.[1] ?? '';
}

function safeToken(request, expected) {
  const actual = bearerToken(request);
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) {
    difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

function unauthorized(response) {
  response.setHeader('www-authenticate', 'Bearer');
  return json(response, 401, { error: '凭据无效' });
}

function json(response, status, value) {
  if (response.headersSent) return;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.writeHead(status).end(JSON.stringify(value));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const port = Number.parseInt(process.env.PORT || '8787', 10);
  const server = await createMobileSyncServer({
    adminToken: process.env.MOBILE_SYNC_ADMIN_TOKEN,
    dataDirectory: process.env.MOBILE_SYNC_DATA_DIR || join(currentDirectory, 'data'),
    mobileAppDirectory: process.env.MOBILE_APP_DIR || join(currentDirectory, '../mobile-app'),
    allowedOrigin: process.env.MOBILE_SYNC_ALLOWED_ORIGIN || '*',
  });
  server.listen(port, '0.0.0.0', () => console.log(`mobile sync server listening on ${port}`));
}
