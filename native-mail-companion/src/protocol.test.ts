import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeMessageDecoder, encodeNativeMessage } from './protocol.js';

test('Native Messaging frame 支持分片输入和多条消息', () => {
  const first = encodeNativeMessage({ protocolVersion: 1, requestId: 'one', success: true, data: { ok: 1 } });
  const second = encodeNativeMessage({ protocolVersion: 1, requestId: 'two', success: true, data: { ok: 2 } });
  const joined = Buffer.concat([first, second]);
  const decoder = new NativeMessageDecoder();

  assert.deepEqual(decoder.push(joined.subarray(0, 3)), []);
  assert.deepEqual(decoder.push(joined.subarray(3, first.length + 2)), [
    { protocolVersion: 1, requestId: 'one', success: true, data: { ok: 1 } },
  ]);
  assert.deepEqual(decoder.push(joined.subarray(first.length + 2)), [
    { protocolVersion: 1, requestId: 'two', success: true, data: { ok: 2 } },
  ]);
});

test('超过 1 MiB 的响应被替换为稳定错误', () => {
  const frame = encodeNativeMessage({
    protocolVersion: 1,
    requestId: 'large',
    success: true,
    data: 'x'.repeat(1024 * 1024),
  });
  const length = frame.readUInt32LE(0);
  const response = JSON.parse(frame.subarray(4, 4 + length).toString('utf8')) as {
    success: boolean;
    error?: { code: string };
  };

  assert.equal(response.success, false);
  assert.equal(response.error?.code, 'MESSAGE_TOO_LARGE');
});

test('非法长度前缀会被拒绝', () => {
  const decoder = new NativeMessageDecoder();
  const frame = Buffer.alloc(4);
  frame.writeUInt32LE(0, 0);
  assert.throws(() => decoder.push(frame), /length is invalid/);
});
