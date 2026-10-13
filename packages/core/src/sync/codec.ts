import type { EnvelopeMessage, Message } from '@envelope/crdt';
import { base64ToBytes, bytesToBase64 } from '../util/base64';
import { decrypt, encrypt } from './encryption';

export async function encodeMessages(messages: Message[], key: CryptoKey | null): Promise<EnvelopeMessage[]> {
  return Promise.all(
    messages.map(async m => {
      const body = new TextEncoder().encode(JSON.stringify({ dataset: m.dataset, row: m.row, column: m.column, value: m.value }));
      return {
        timestamp: m.timestamp,
        isEncrypted: !!key,
        content: bytesToBase64(key ? await encrypt(key, body) : body),
      };
    }),
  );
}

export async function decodeMessages(envs: EnvelopeMessage[], key: CryptoKey | null): Promise<Message[]> {
  const out: Message[] = [];
  for (const e of envs) {
    let bytes = base64ToBytes(e.content);
    if (e.isEncrypted) {
      if (!key) throw new SyncError('missing-key', 'This file is encrypted; enter its password to sync');
      try {
        bytes = await decrypt(key, bytes);
      } catch {
        throw new SyncError('decrypt-failure', 'Could not decrypt changes from the server; the key may be wrong');
      }
    }
    const body = JSON.parse(new TextDecoder().decode(bytes));
    out.push({ timestamp: e.timestamp, dataset: body.dataset, row: body.row, column: body.column, value: body.value });
  }
  return out;
}

export class SyncError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}
