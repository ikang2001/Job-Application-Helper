import { JsonAccountStore } from './accountStore.js';
import { KeyringCredentialStore } from './credentialStore.js';
import { handleNativeMailRequest } from './handler.js';
import { ImapMailService } from './imapService.js';
import { NativeMessageDecoder, encodeNativeMessage } from './protocol.js';
import { NATIVE_MAIL_PROTOCOL_VERSION, type NativeMailResponse } from './types.js';
import { LocalApplicationRecordsStore } from './localRecordsStore.js';
import { join } from 'node:path';
import { MailRuntime } from './mailRuntime.js';

const decoder = new NativeMessageDecoder();
const dependencies = {
  accounts: new JsonAccountStore(),
  credentials: new KeyringCredentialStore(),
  imap: new ImapMailService(undefined, new MailRuntime(join(
    process.env.LOCALAPPDATA || process.cwd(), 'JobApplicationHelper', 'mail-runtime',
  ))),
  localRecords: new LocalApplicationRecordsStore(),
};

let queue = Promise.resolve();
let idleTimer: ReturnType<typeof setTimeout>;
function resetIdleTimeout(): void {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    void dependencies.imap.close().finally(() => process.exit(0));
  }, 120_000);
  idleTimer.unref();
}
resetIdleTimeout();
// 旧版单次调用会关闭 stdin；持久连接断开也走同一个释放入口。
process.stdin.on('end', () => { clearTimeout(idleTimer); void queue.finally(() => dependencies.imap.close()); });
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => { void dependencies.imap.close().finally(() => process.exit(0)); });
}

process.stdin.on('data', (chunk: Buffer) => {
  resetIdleTimeout();
  queue = queue.then(async () => {
    const messages = decoder.push(chunk);
    for (const message of messages) {
      const response = await handleNativeMailRequest(message, dependencies);
      process.stdout.write(encodeNativeMessage(response));
      resetIdleTimeout();
    }
  }).catch((error: unknown) => {
    const response: NativeMailResponse = {
      protocolVersion: NATIVE_MAIL_PROTOCOL_VERSION,
      requestId: 'unknown',
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Native Mail protocol error',
        retryable: false,
      },
    };
    process.stderr.write(`[NativeMail] ${response.error?.message}\n`);
    process.stdout.write(encodeNativeMessage(response));
  });
});

process.stdin.resume();
