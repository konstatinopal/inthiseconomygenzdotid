// Server storage: one SQLite database for accounts, sessions and file
// metadata, plus a message log per sync group, and a directory of uploaded
// file snapshots. The server never interprets budget data.
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Timestamp, merkle, type EnvelopeMessage, type TrieNode } from '@envelope/crdt';

export interface FileRow {
  id: string;
  group_id: string | null;
  name: string;
  encrypt_keyid: string | null;
  encrypt_salt: string | null;
  encrypt_test: string | null;
  deleted: number;
  owner: string | null;
  updated_at: number;
}

export interface UserRow {
  id: string;
  user_name: string;
  display_name: string | null;
  picture: string | null;
  role: 'ADMIN' | 'BASIC';
  enabled: number;
  oidc_sub: string | null;
  password_hash: string | null;
  must_change_password: number;
  created_at: number | null;
  last_login: number | null;
}

export class Store {
  db: Database.Database;
  filesDir: string;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.filesDir = path.join(dataDir, 'user-files');
    fs.mkdirSync(this.filesDir, { recursive: true });
    this.db = new Database(path.join(dataDir, 'server.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS auth (method TEXT PRIMARY KEY, extra_data TEXT);
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, user_name TEXT UNIQUE, role TEXT, enabled INTEGER DEFAULT 1);
      CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT, expires_at INTEGER);
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY, group_id TEXT, name TEXT, encrypt_keyid TEXT, encrypt_salt TEXT, encrypt_test TEXT,
        deleted INTEGER DEFAULT 0, owner TEXT, updated_at INTEGER);
      CREATE TABLE IF NOT EXISTS file_access (file_id TEXT, user_id TEXT, PRIMARY KEY (file_id, user_id));
      CREATE TABLE IF NOT EXISTS messages (group_id TEXT, timestamp TEXT, is_encrypted INTEGER, content TEXT, PRIMARY KEY (group_id, timestamp));
      CREATE TABLE IF NOT EXISTS merkles (group_id TEXT PRIMARY KEY, merkle TEXT);
      CREATE TABLE IF NOT EXISTS openid_pending (state TEXT PRIMARY KEY, code_verifier TEXT, nonce TEXT, return_url TEXT, expires_at INTEGER);
      CREATE TABLE IF NOT EXISTS login_codes (code TEXT PRIMARY KEY, user_id TEXT, expires_at INTEGER);
    `);
    // Additive migration of the users table.
    const cols = new Set((this.db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map(c => c.name));
    for (const [c, def] of [
      ['display_name', 'TEXT'],
      ['password_hash', 'TEXT'],
      ['must_change_password', 'INTEGER DEFAULT 0'],
      ['picture', 'TEXT'],
      ['oidc_sub', 'TEXT'],
      ['created_at', 'INTEGER'],
      ['last_login', 'INTEGER'],
    ]) {
      if (!cols.has(c)) this.db.exec(`ALTER TABLE users ADD COLUMN ${c} ${def}`);
    }
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_sub ON users (oidc_sub) WHERE oidc_sub IS NOT NULL');
  }

  // ---------- users ----------

  getUser(id: string): UserRow | null {
    return (this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined) ?? null;
  }

  getUserByEmail(email: string): UserRow | null {
    return (this.db.prepare('SELECT * FROM users WHERE lower(user_name) = lower(?)').get(email) as UserRow | undefined) ?? null;
  }

  getUserBySub(sub: string): UserRow | null {
    return (this.db.prepare('SELECT * FROM users WHERE oidc_sub = ?').get(sub) as UserRow | undefined) ?? null;
  }

  listUsers(): UserRow[] {
    return this.db.prepare("SELECT * FROM users WHERE id != 'owner' OR oidc_sub IS NOT NULL ORDER BY lower(user_name)").all() as UserRow[];
  }

  countOidcUsers(): number {
    return (this.db.prepare('SELECT COUNT(*) c FROM users WHERE oidc_sub IS NOT NULL').get() as { c: number }).c;
  }

  countEnabledAdmins(): number {
    return (this.db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'ADMIN' AND enabled = 1 AND id != 'owner'").get() as { c: number }).c;
  }

  createUser(u: {
    id?: string;
    userName: string;
    displayName?: string | null;
    role: 'ADMIN' | 'BASIC';
    enabled?: boolean;
    sub?: string | null;
    picture?: string | null;
    passwordHash?: string | null;
    mustChangePassword?: boolean;
  }): UserRow {
    const id = u.id ?? crypto.randomUUID();
    this.db
      .prepare(
        'INSERT INTO users (id, user_name, display_name, role, enabled, oidc_sub, picture, password_hash, must_change_password, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        u.userName.toLowerCase(),
        u.displayName ?? null,
        u.role,
        u.enabled === false ? 0 : 1,
        u.sub ?? null,
        u.picture ?? null,
        u.passwordHash ?? null,
        u.mustChangePassword ? 1 : 0,
        Date.now(),
      );
    return this.getUser(id)!;
  }

  updateUser(
    id: string,
    patch: Partial<{
      display_name: string | null;
      role: string;
      enabled: number;
      oidc_sub: string;
      picture: string | null;
      last_login: number;
      user_name: string;
      password_hash: string | null;
      must_change_password: number;
    }>,
  ) {
    const keys = Object.keys(patch).filter(k => (patch as any)[k] !== undefined);
    if (!keys.length) return;
    this.db.prepare(`UPDATE users SET ${keys.map(k => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...patch, id });
    if (patch.enabled === 0) this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  }

  /** Delete users; their files move to `heir` and their grants go away. */
  deleteUser(id: string, heir: string) {
    this.db.transaction(() => {
      this.db.prepare('UPDATE files SET owner = ? WHERE owner = ?').run(heir, id);
      this.db.prepare('DELETE FROM file_access WHERE user_id = ?').run(id);
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
    })();
  }

  /** Give the legacy password account's files to a new owner (switching to OpenID). */
  adoptLegacyFiles(userId: string) {
    this.db.prepare("UPDATE files SET owner = ? WHERE owner IS NULL OR owner = 'owner'").run(userId);
  }

  // ---------- file access ----------

  grantAccess(fileId: string, userId: string) {
    this.db.prepare('INSERT OR IGNORE INTO file_access (file_id, user_id) VALUES (?, ?)').run(fileId, userId);
  }

  revokeAccess(fileId: string, userId: string) {
    this.db.prepare('DELETE FROM file_access WHERE file_id = ? AND user_id = ?').run(fileId, userId);
  }

  hasAccess(fileId: string, userId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM file_access WHERE file_id = ? AND user_id = ?').get(fileId, userId);
  }

  fileCollaborators(fileId: string): UserRow[] {
    return this.db.prepare('SELECT u.* FROM file_access a JOIN users u ON u.id = a.user_id WHERE a.file_id = ? ORDER BY lower(u.user_name)').all(fileId) as UserRow[];
  }

  // ---------- OpenID handshakes ----------

  savePending(p: { state: string; codeVerifier: string; nonce: string; returnUrl: string }) {
    this.db.prepare('DELETE FROM openid_pending WHERE expires_at < ?').run(Date.now());
    this.db
      .prepare('INSERT INTO openid_pending (state, code_verifier, nonce, return_url, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(p.state, p.codeVerifier, p.nonce, p.returnUrl, Date.now() + 10 * 60_000);
  }

  /** Single use: the row is deleted as it is read. */
  takePending(state: string): { code_verifier: string; nonce: string; return_url: string } | null {
    const row = this.db.prepare('SELECT * FROM openid_pending WHERE state = ?').get(state) as any;
    this.db.prepare('DELETE FROM openid_pending WHERE state = ?').run(state);
    if (!row || row.expires_at < Date.now()) return null;
    return row;
  }

  createLoginCode(userId: string): string {
    const code = crypto.randomBytes(32).toString('base64url');
    this.db.prepare('DELETE FROM login_codes WHERE expires_at < ?').run(Date.now());
    this.db.prepare('INSERT INTO login_codes (code, user_id, expires_at) VALUES (?, ?, ?)').run(code, userId, Date.now() + 60_000);
    return code;
  }

  takeLoginCode(code: string): string | null {
    const row = this.db.prepare('SELECT * FROM login_codes WHERE code = ?').get(code) as any;
    this.db.prepare('DELETE FROM login_codes WHERE code = ?').run(code);
    if (!row || row.expires_at < Date.now()) return null;
    return row.user_id;
  }

  // ---------- auth ----------

  getPasswordHash(): string | null {
    const r = this.db.prepare("SELECT extra_data FROM auth WHERE method = 'password'").get() as { extra_data: string } | undefined;
    return r?.extra_data ?? null;
  }

  setPasswordHash(hash: string) {
    this.db.prepare("INSERT OR REPLACE INTO auth (method, extra_data) VALUES ('password', ?)").run(hash);
    this.db.prepare("INSERT OR IGNORE INTO users (id, user_name, role) VALUES ('owner', 'owner', 'ADMIN')").run();
  }

  createSession(token: string, userId: string, ttlDays: number) {
    this.db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, Date.now() + ttlDays * 86400000);
  }

  getSession(token: string): { user_id: string } | null {
    const r = this.db.prepare('SELECT user_id, expires_at FROM sessions WHERE token = ?').get(token) as
      | { user_id: string; expires_at: number }
      | undefined;
    if (!r) return null;
    if (r.expires_at < Date.now()) {
      this.deleteSession(token);
      return null;
    }
    return r;
  }

  /** Sign a user out everywhere except, optionally, one session. */
  deleteUserSessions(userId: string, keep?: string) {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(userId, keep ?? '');
  }

  deleteSession(token: string) {
    this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  deleteAllSessions() {
    this.db.prepare('DELETE FROM sessions').run();
  }

  // ---------- files ----------

  getFile(id: string): FileRow | null {
    return (this.db.prepare('SELECT * FROM files WHERE id = ?').get(id) as FileRow | undefined) ?? null;
  }

  listFiles(): FileRow[] {
    return this.db.prepare('SELECT * FROM files WHERE deleted = 0 ORDER BY name').all() as FileRow[];
  }

  upsertFile(f: Partial<FileRow> & { id: string }) {
    const cur = this.getFile(f.id);
    const row = { ...(cur ?? { group_id: null, name: '', encrypt_keyid: null, encrypt_salt: null, encrypt_test: null, deleted: 0, owner: null }), ...f, updated_at: Date.now() };
    this.db
      .prepare(
        `INSERT OR REPLACE INTO files (id, group_id, name, encrypt_keyid, encrypt_salt, encrypt_test, deleted, owner, updated_at)
         VALUES (@id, @group_id, @name, @encrypt_keyid, @encrypt_salt, @encrypt_test, @deleted, @owner, @updated_at)`,
      )
      .run(row);
  }

  snapshotPath(id: string) {
    if (!/^[\w-]+$/.test(id)) throw new Error('Invalid file id');
    return path.join(this.filesDir, `file-${id}.blob`);
  }

  writeSnapshot(id: string, data: Buffer) {
    const p = this.snapshotPath(id);
    fs.writeFileSync(p + '.tmp', data);
    fs.renameSync(p + '.tmp', p);
  }

  readSnapshot(id: string): Buffer | null {
    try {
      return fs.readFileSync(this.snapshotPath(id));
    } catch {
      return null;
    }
  }

  deleteGroup(groupId: string) {
    this.db.prepare('DELETE FROM messages WHERE group_id = ?').run(groupId);
    this.db.prepare('DELETE FROM merkles WHERE group_id = ?').run(groupId);
  }

  // ---------- messages ----------

  getMerkle(groupId: string): TrieNode {
    const r = this.db.prepare('SELECT merkle FROM merkles WHERE group_id = ?').get(groupId) as { merkle: string } | undefined;
    return r ? JSON.parse(r.merkle) : merkle.emptyTrie();
  }

  /** Store new messages (ignoring duplicates), update the trie and return messages newer than `since` the client lacks. */
  sync(groupId: string, since: string, incoming: EnvelopeMessage[]): { messages: EnvelopeMessage[]; merkle: TrieNode } {
    const insert = this.db.prepare('INSERT OR IGNORE INTO messages (group_id, timestamp, is_encrypted, content) VALUES (?, ?, ?, ?)');
    const run = this.db.transaction(() => {
      let trie = this.getMerkle(groupId);
      for (const m of incoming) {
        const ts = Timestamp.parse(m.timestamp);
        if (!ts) continue;
        const res = insert.run(groupId, m.timestamp, m.isEncrypted ? 1 : 0, m.content);
        if (res.changes > 0) trie = merkle.insert(trie, ts);
      }
      this.db.prepare('INSERT OR REPLACE INTO merkles (group_id, merkle) VALUES (?, ?)').run(groupId, JSON.stringify(trie));
      return trie;
    });
    const trie = run();
    const sent = new Set(incoming.map(m => m.timestamp));
    const rows = this.db
      .prepare('SELECT timestamp, is_encrypted, content FROM messages WHERE group_id = ? AND timestamp > ? ORDER BY timestamp')
      .all(groupId, since) as { timestamp: string; is_encrypted: number; content: string }[];
    return {
      messages: rows.filter(r => !sent.has(r.timestamp)).map(r => ({ timestamp: r.timestamp, isEncrypted: !!r.is_encrypted, content: r.content })),
      merkle: trie,
    };
  }
}
