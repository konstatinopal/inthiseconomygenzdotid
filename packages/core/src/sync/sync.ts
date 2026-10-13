import { Timestamp, merkle, type SyncResponse } from '@envelope/crdt';
import type { BudgetDb } from '../db';
import { decodeMessages, encodeMessages, SyncError } from './codec';
import type { ServerClient } from './server';

export interface SyncTarget {
  fileId: string;
  groupId: string;
  keyId: string | null;
  key: CryptoKey | null;
}

/**
 * Exchange messages with the server until both Merkle tries agree.
 * Sends local messages newer than `since`, applies the server's missing ones
 * (last-writer-wins per cell) and, on divergence, resends from the earliest
 * differing minute.
 */
export async function fullSync(db: BudgetDb, server: ServerClient, target: SyncTarget): Promise<{ tables: string[]; received: number }> {
  let since = db.getMeta('lastSyncedTimestamp') ?? Timestamp.zero();
  const changed = new Set<string>();
  let received = 0;
  for (let attempt = 0; attempt < 10; attempt++) {
    const local = db.messagesSince(since);
    const res = await server.request<SyncResponse>('/sync/sync', {
      json: {
        fileId: target.fileId,
        groupId: target.groupId,
        keyId: target.keyId,
        since,
        messages: await encodeMessages(local, target.key),
      },
    });
    const incoming = await decodeMessages(res.messages, target.key);
    if (incoming.length) {
      received += incoming.length;
      for (const t of db.applyRemote(incoming)) changed.add(t);
    }
    const diff = merkle.diff(res.merkle, db.merkle);
    if (diff === null) {
      const latest = db.first<{ t: string | null }>('SELECT MAX(timestamp) t FROM messages_crdt')?.t;
      db.setMeta('lastSyncedTimestamp', latest ?? Timestamp.zero());
      return { tables: [...changed], received };
    }
    since = Timestamp.since(new Date(diff).toISOString());
  }
  throw new SyncError('out-of-sync', 'Sync did not converge; try "Repair sync" in Settings');
}

/** Drop the local message log so a freshly uploaded snapshot becomes the new base. */
export function clearMessageLog(db: BudgetDb) {
  db.run('DELETE FROM messages_crdt');
  db.merkle = merkle.emptyTrie();
  db.run('INSERT OR REPLACE INTO messages_clock (id, clock) VALUES (1, ?)', [
    JSON.stringify({
      timestamp: new Timestamp(db.clock.state.millis, db.clock.state.counter, db.clock.state.node).toString(),
      merkle: db.merkle,
    }),
  ]);
  db.setMeta('lastSyncedTimestamp', Timestamp.zero());
}
