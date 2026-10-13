export * from './timestamp';
export * as merkle from './merkle';
export type { TrieNode } from './merkle';
export { murmur3 } from './hash';

/** A decoded CRDT message: set `column` of `row` in `dataset` to `value`. */
export interface Message {
  timestamp: string;
  dataset: string;
  row: string;
  column: string;
  value: string | number | null;
}

/** What travels over the wire. `content` is base64 JSON or base64 ciphertext. */
export interface EnvelopeMessage {
  timestamp: string;
  isEncrypted: boolean;
  content: string;
}

export interface SyncRequest {
  fileId: string;
  groupId: string;
  keyId: string | null;
  since: string;
  messages: EnvelopeMessage[];
}

export interface SyncResponse {
  messages: EnvelopeMessage[];
  merkle: import('./merkle').TrieNode;
}
