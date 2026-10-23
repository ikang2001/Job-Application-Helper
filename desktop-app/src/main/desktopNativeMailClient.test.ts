import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeHostSpawnCommand } from './desktopNativeMailClient.ts';
import { NativeMailTransport, DesktopMailError } from './nativeMailTransport.ts';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

test('Windows 批处理邮箱组件路径只由 spawn 转义，不额外嵌入引号', () => {
  const hostPath = 'C:\\Users\\candidate\\Desktop\\Job Helper\\mail-host.cmd';
  assert.deepEqual(nativeHostSpawnCommand(hostPath, 'win32', 'C:\\Windows\\System32\\cmd.exe'), {
    executable: 'C:\\Windows\\System32\\cmd.exe',
    arguments: ['/d', '/s', '/c', hostPath],
  });
});

test('可执行邮箱组件由系统直接启动', () => {
  const hostPath = 'C:\\Program Files\\Job Helper\\mail-host.exe';
  assert.deepEqual(nativeHostSpawnCommand(hostPath, 'win32'), {
    executable: hostPath,
    arguments: [],
  });
});

function fakeHost() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: () => { child.emit('exit', 0); return true; },
  });
  child.stdin.on('finish', () => child.emit('exit', 0));
  return child as unknown as ChildProcessWithoutNullStreams;
}

function reply(request: Record<string, unknown>, data: unknown, error?: Record<string, unknown>): Buffer {
  const bytes = Buffer.from(JSON.stringify({ protocolVersion: 1, requestId: request.requestId, success: !error, data, error }));
  const frame = Buffer.alloc(bytes.length + 4); frame.writeUInt32LE(bytes.length); bytes.copy(frame, 4); return frame;
}

test('持久桌面通信60次响应复用一个宿主，累计超过1MiB且支持分片', async () => {
  const child = fakeHost();
  let requests = 0;
  child.stdin.on('data', (chunk: Buffer) => {
    const request = JSON.parse(chunk.subarray(4).toString()) as Record<string, unknown>;
    requests++;
    const frame = reply(request, { text: 'a'.repeat(30_000) });
    child.stdout.emit('data', frame.subarray(0, 3));
    child.stdout.emit('data', frame.subarray(3));
  });
  const transport = new NativeMailTransport(child);
  try {
    for (let index = 0; index < 60; index++) {
      assert.equal((await transport.request<{ text: string }>('GET_MESSAGE', { messageId: index })).text.length, 30_000);
    }
    assert.equal(requests, 60);
  } finally { transport.close(); }
});

test('传递限流错误和重试时间，不将其丢失为通用错误', async () => {
  const child = fakeHost();
  const retryAt = '2026-10-23T08:00:00Z';
  child.stdin.on('data', (chunk: Buffer) => child.stdout.emit('data', reply(JSON.parse(chunk.subarray(4).toString()), undefined,
    { code: 'RATE_LIMITED', message: '等待自动重试', retryable: true, retryAt })));
  const transport = new NativeMailTransport(child);
  try {
    await assert.rejects(transport.request('LIST_MESSAGES', {}),
      (error: DesktopMailError) => error.code === 'RATE_LIMITED' && error.retryAt === retryAt);
  } finally { transport.close(); }
});

test('宿主超时、中途退出和超长响应均释放并拒绝请求', async () => {
  for (const mode of ['timeout', 'exit', 'oversize']) {
    const child = fakeHost();
    const transport = new NativeMailTransport(child, 10);
    const pending = transport.request('PING', {});
    if (mode === 'exit') child.emit('exit', 1);
    if (mode === 'oversize') { const frame = Buffer.alloc(4); frame.writeUInt32LE(1024 * 1024 + 1); child.stdout.emit('data', frame); }
    await assert.rejects(pending, (error: DesktopMailError) => error.code === (
      mode === 'timeout' ? 'TIMEOUT' : mode === 'exit' ? 'CONNECTION_FAILED' : 'INVALID_RESPONSE'));
    transport.close();
  }
});
