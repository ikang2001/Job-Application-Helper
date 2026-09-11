import { JsonAccountStore } from './accountStore.js';
import { KeyringCredentialStore } from './credentialStore.js';
import { handleNativeMailRequest } from './handler.js';
import { ImapMailService } from './imapService.js';
import { NativeMessageDecoder, encodeNativeMessage } from './protocol.js';
import { NATIVE_MAIL_PROTOCOL_VERSION, type NativeMailResponse } from './types.js';
import { LocalApplicationRecordsStore } from './localRecordsStore.js';

const decoder = new NativeMessageDecoder();
const dependencies = {
  accounts: new JsonAccountStore(),
  credentials: new KeyringCredentialStore(),
  imap: new ImapMailService(),
  localRecords: new LocalApplicationRecordsStore(),
};

let queue = Promise.resolve();

process.stdin.on('data', (chunk: Buffer) => {
  queue = queue.then(async () => {
    const messages = decoder.push(chunk);
    for (const message of messages) {
      const response = await handleNativeMailRequest(message, dependencies);
      process.stdout.write(encodeNativeMessage(response));
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
