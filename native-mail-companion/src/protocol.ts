import {
  NATIVE_MAIL_PROTOCOL_VERSION,
  type NativeMailResponse,
} from './types.js';

export const MAX_NATIVE_INPUT_BYTES = 64 * 1024 * 1024;
export const MAX_NATIVE_OUTPUT_BYTES = 1024 * 1024;

export class NativeMessageDecoder {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: unknown[] = [];

    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length === 0 || length > MAX_NATIVE_INPUT_BYTES) {
        throw new Error(`Native message length is invalid: ${length}`);
      }
      if (this.buffer.length < length + 4) break;

      const payload = this.buffer.subarray(4, length + 4).toString('utf8');
      this.buffer = this.buffer.subarray(length + 4);
      messages.push(JSON.parse(payload) as unknown);
    }

    return messages;
  }
}

export function encodeNativeMessage(message: NativeMailResponse): Buffer {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  if (payload.length > MAX_NATIVE_OUTPUT_BYTES) {
    const fallback: NativeMailResponse = {
      protocolVersion: NATIVE_MAIL_PROTOCOL_VERSION,
      requestId: message.requestId,
      success: false,
      error: {
        code: 'MESSAGE_TOO_LARGE',
        message: 'Native host response exceeds the 1 MiB browser limit',
        retryable: false,
      },
    };
    return encodeNativeMessage(fallback);
  }

  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}
