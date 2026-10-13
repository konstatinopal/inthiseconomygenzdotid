// A base-3 Merkle trie over message timestamps, keyed by minute.
// Two replicas holding the same set of messages have identical root hashes;
// `diff` finds the earliest minute where they disagree so sync can resend
// from there.
import { murmur3 } from './hash';
import { Timestamp } from './timestamp';

export interface TrieNode {
  hash?: number;
  '0'?: TrieNode;
  '1'?: TrieNode;
  '2'?: TrieNode;
}

type Branch = '0' | '1' | '2';

export function emptyTrie(): TrieNode {
  return { hash: 0 };
}

function keyFor(ts: Timestamp): string {
  return Math.floor(ts.millis / 1000 / 60).toString(3);
}

function insertKey(node: TrieNode, key: string, hash: number): TrieNode {
  if (key.length === 0) return node;
  const c = key[0] as Branch;
  const child = node[c] ?? {};
  const updated: TrieNode = {
    ...insertKey(child, key.slice(1), hash),
    hash: ((child.hash ?? 0) ^ hash) >>> 0,
  };
  return { ...node, [c]: updated };
}

export function insert(trie: TrieNode, ts: Timestamp): TrieNode {
  const hash = murmur3(ts.toString());
  const key = keyFor(ts);
  const root: TrieNode = { ...trie, hash: ((trie.hash ?? 0) ^ hash) >>> 0 };
  return insertKey(root, key, hash);
}

export function build(timestamps: Timestamp[]): TrieNode {
  let trie = emptyTrie();
  for (const ts of timestamps) trie = insert(trie, ts);
  return trie;
}

function childKeys(node: TrieNode): Branch[] {
  return (['0', '1', '2'] as Branch[]).filter(k => node[k] !== undefined);
}

/** Returns the millisecond time (minute precision) of the earliest divergence, or null when equal. */
export function diff(a: TrieNode, b: TrieNode): number | null {
  if ((a.hash ?? 0) === (b.hash ?? 0)) return null;
  let n1: TrieNode = a;
  let n2: TrieNode = b;
  let k = '';
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const keys = Array.from(new Set([...childKeys(n1), ...childKeys(n2)])).sort();
    let diffKey: Branch | null = null;
    for (const key of keys) {
      const c1 = n1[key];
      const c2 = n2[key];
      if (!c1 || !c2 || (c1.hash ?? 0) !== (c2.hash ?? 0)) {
        diffKey = key;
        break;
      }
    }
    if (!diffKey) return keyToTime(k);
    k += diffKey;
    n1 = n1[diffKey] ?? emptyTrie();
    n2 = n2[diffKey] ?? emptyTrie();
  }
}

function keyToTime(key: string): number {
  // Keys for minutes since epoch are 16 base-3 digits for the foreseeable future.
  const full = key.length < 16 ? key + '0'.repeat(16 - key.length) : key;
  return parseInt(full, 3) * 1000 * 60;
}

/** Drop branches older than needed to keep the serialized trie small. */
export function prune(trie: TrieNode, n = 2): TrieNode {
  if (!trie.hash) return trie;
  const keys = childKeys(trie);
  const next: TrieNode = { hash: trie.hash };
  for (const k of keys.slice(-n)) next[k] = prune(trie[k]!, n);
  return next;
}
