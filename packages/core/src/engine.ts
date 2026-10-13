// The core engine: owns the open budget file, persists it through the
// platform adapter, runs background services (auto-posting schedules, sync)
// and exposes every operation as a named RPC handler. The UI only ever calls
// `send(name, args)`, so the engine can run in a Web Worker, Electron or Node.
import type { SqlJsStatic } from 'sql.js';
import { BudgetDb } from './db';
import { runQuery, type QueryState } from './aql';
import { uuid } from './util/id';
import { base64ToBytes, bytesToBase64 } from './util/base64';
import type { FileMeta, PlatformStorage } from './platform/storage';
import { ServerClient, type FetchFn } from './sync/server';
import { clearMessageLog, fullSync } from './sync/sync';
import { SyncError } from './sync/codec';
import { decrypt, deriveKey, encrypt, exportKey, importKey, makeTestContent, randomSalt, verifyKey } from './sync/encryption';
import * as accounts from './models/accounts';
import * as budget from './models/budget';
import * as categories from './models/categories';
import * as misc from './models/misc';
import * as payees from './models/payees';
import * as reports from './models/reports';
import * as rules from './models/rules';
import * as schedules from './models/schedules';
import * as templates from './models/templates';
import * as txns from './models/transactions';
import { createDefaultCategories, createDemoBudget } from './demo';
import { detectFormat, parseFile, previewCsv, reconcileTransactions } from './importers';

export type SyncState = 'disabled' | 'idle' | 'syncing' | 'error' | 'offline';

export interface SyncStatus {
  state: SyncState;
  error?: string;
  reason?: string;
  lastSync?: number;
}

export type EngineEvent =
  | { type: 'changed'; tables: string[]; source: string }
  | { type: 'sync-status'; status: SyncStatus }
  | { type: 'file-changed'; meta: FileMeta | null }
  | { type: 'notification'; level: 'info' | 'error' | 'success'; message: string };

export interface EngineOptions {
  storage: PlatformStorage;
  sqlJs: SqlJsStatic;
  fetch?: FetchFn;
  persistDelay?: number;
  syncDelay?: number;
  /** Run background timers (auto-post schedules, periodic sync). Off in tests. */
  timers?: boolean;
}

type Handler = (args: any) => any;

const ASYNC_HANDLERS = new Set<string>();

export class Engine {
  db: BudgetDb | null = null;
  meta: FileMeta | null = null;
  private listeners = new Set<(e: EngineEvent) => void>();
  private persistTimer: any = null;
  private syncTimer: any = null;
  private intervalTimer: any = null;
  private syncing: Promise<void> | null = null;
  private resyncRequested = false;
  private unsub: (() => void) | null = null;
  private key: CryptoKey | null = null;
  syncStatus: SyncStatus = { state: 'disabled' };
  server: ServerClient;
  readonly handlers: Record<string, Handler>;

  constructor(readonly opts: EngineOptions) {
    this.server = new ServerClient(opts.fetch ?? ((...a) => fetch(...a)), null, null);
    this.handlers = this.buildHandlers();
  }

  async init() {
    this.server.url = await this.opts.storage.getItem('serverUrl');
    this.server.token = await this.opts.storage.getItem('serverToken');
  }

  on(fn: (e: EngineEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: EngineEvent) {
    for (const l of this.listeners) l(e);
  }

  notify(level: 'info' | 'error' | 'success', message: string) {
    this.emit({ type: 'notification', level, message });
  }

  requireDb(): BudgetDb {
    if (!this.db) throw new Error('No budget file is open');
    return this.db;
  }

  /** Call a handler by name. Synchronous handlers run inside one batch, so each call is one undo step. */
  async send(name: string, args: any = {}) {
    const h = this.handlers[name];
    if (!h) throw new Error(`Unknown handler: ${name}`);
    if (ASYNC_HANDLERS.has(name) || !this.db) return await h(args);
    return this.db.batch(() => h(args));
  }

  // ---------- file lifecycle ----------

  private attach(db: BudgetDb, meta: FileMeta) {
    this.db = db;
    this.meta = meta;
    this.unsub = db.subscribe((tables, source) => {
      this.emit({ type: 'changed', tables, source });
      this.schedulePersist();
      if (source !== 'remote') this.scheduleSync();
    });
    this.emit({ type: 'file-changed', meta });
    this.setSyncStatus({ state: this.isCloudFile() ? 'idle' : 'disabled' });
    if (this.opts.timers !== false) {
      this.runBackgroundServices();
      this.intervalTimer = setInterval(() => this.runBackgroundServices(), 5 * 60 * 1000);
    }
  }

  private runBackgroundServices() {
    if (!this.db) return;
    try {
      const n = schedules.autoPostSchedules(this.db);
      if (n > 0) this.notify('info', `Posted ${n} scheduled transaction${n === 1 ? '' : 's'}`);
    } catch (e: any) {
      this.notify('error', `Could not post schedules: ${e.message}`);
    }
    this.scheduleSync(0);
  }

  async closeFile() {
    if (!this.db) return;
    await this.flush();
    clearInterval(this.intervalTimer);
    clearTimeout(this.syncTimer);
    this.unsub?.();
    this.db.close();
    this.db = null;
    this.meta = null;
    this.key = null;
    this.setSyncStatus({ state: 'disabled' });
    this.emit({ type: 'file-changed', meta: null });
  }

  async createFile(args: { name: string; demo?: boolean; empty?: boolean }) {
    await this.closeFile();
    const meta: FileMeta = { id: uuid(), name: args.name || 'My Budget', createdAt: Date.now(), lastOpened: Date.now() };
    const db = new BudgetDb(this.opts.sqlJs);
    if (args.demo) createDemoBudget(db);
    else if (!args.empty) {
      db.batch(() => createDefaultCategories(db));
      db.undoStack = [];
    }
    await this.opts.storage.setMeta(meta);
    await this.opts.storage.writeDb(meta.id, db.export());
    this.attach(db, meta);
    return meta;
  }

  async loadFile(id: string) {
    if (this.meta?.id === id) return this.meta;
    await this.closeFile();
    const meta = await this.opts.storage.getMeta(id);
    const data = await this.opts.storage.readDb(id);
    if (!meta || !data) throw new Error('Budget file not found');
    const db = new BudgetDb(this.opts.sqlJs, data);
    meta.lastOpened = Date.now();
    await this.opts.storage.setMeta(meta);
    if (meta.encryptKeyId) {
      const raw = await this.opts.storage.getItem(`key:${meta.encryptKeyId}`);
      this.key = raw ? await importKey(raw) : null;
    }
    this.attach(db, meta);
    return meta;
  }

  schedulePersist() {
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => void this.flush(), this.opts.persistDelay ?? 300);
  }

  async flush() {
    clearTimeout(this.persistTimer);
    this.persistTimer = null;
    if (!this.db || !this.meta) return;
    await this.opts.storage.writeDb(this.meta.id, this.db.export());
  }

  // ---------- sync ----------

  isCloudFile() {
    return !!(this.meta?.cloudFileId && this.meta.groupId && this.server.url);
  }

  private setSyncStatus(s: SyncStatus) {
    this.syncStatus = { lastSync: this.syncStatus.lastSync, ...s };
    this.emit({ type: 'sync-status', status: this.syncStatus });
  }

  scheduleSync(delay = this.opts.syncDelay ?? 1000) {
    if (!this.isCloudFile()) return;
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => void this.sync(), delay);
  }

  async sync(): Promise<SyncStatus> {
    if (!this.db || !this.isCloudFile()) return this.syncStatus;
    if (this.syncing) {
      this.resyncRequested = true;
      await this.syncing;
      return this.syncStatus;
    }
    const db = this.db;
    const meta = this.meta!;
    this.syncing = (async () => {
      this.setSyncStatus({ state: 'syncing' });
      try {
        if (meta.encryptKeyId && !this.key) throw new SyncError('missing-key', 'Enter the encryption password to sync this file');
        const { tables } = await fullSync(db, this.server, {
          fileId: meta.cloudFileId!,
          groupId: meta.groupId!,
          keyId: meta.encryptKeyId ?? null,
          key: this.key,
        });
        if (this.db !== db) return;
        if (tables.length) {
          this.emit({ type: 'changed', tables, source: 'remote' });
          this.schedulePersist();
        }
        this.setSyncStatus({ state: 'idle', lastSync: Date.now(), error: undefined, reason: undefined });
      } catch (e: any) {
        const reason = e instanceof SyncError ? e.reason : 'internal';
        this.setSyncStatus({ state: reason === 'network-failure' ? 'offline' : 'error', error: e.message, reason });
      }
    })();
    await this.syncing;
    this.syncing = null;
    if (this.resyncRequested) {
      this.resyncRequested = false;
      this.scheduleSync(0);
    }
    return this.syncStatus;
  }

  private async updateMeta(patch: Partial<FileMeta>) {
    if (!this.meta) return;
    this.meta = { ...this.meta, ...patch };
    await this.opts.storage.setMeta(this.meta);
    this.emit({ type: 'file-changed', meta: this.meta });
  }

  /** Upload the current file as a fresh snapshot (new sync group). Used for first upload and "reset sync". */
  async uploadFile() {
    const db = this.requireDb();
    const meta = this.meta!;
    clearMessageLog(db);
    await this.flush();
    let bytes = db.export();
    let encryptMeta: string | null = null;
    if (meta.encryptKeyId) {
      if (!this.key) throw new Error('Enter the encryption password first');
      bytes = await encrypt(this.key, bytes);
      encryptMeta = JSON.stringify({ keyId: meta.encryptKeyId });
    }
    const cloudFileId = meta.cloudFileId ?? meta.id;
    const res = await this.server.request<{ groupId: string }>('/sync/upload-user-file', {
      bytes,
      headers: {
        'x-actual-file-id': cloudFileId,
        'x-actual-name': encodeURIComponent(meta.name),
        'x-actual-reset': '1',
        ...(encryptMeta ? { 'x-actual-encrypt-meta': encryptMeta } : {}),
      },
    });
    await this.updateMeta({ cloudFileId, groupId: res.groupId });
    this.setSyncStatus({ state: 'idle', lastSync: Date.now() });
    return this.meta;
  }

  async downloadFile(args: { cloudFileId: string; password?: string }) {
    await this.closeFile();
    const files = await this.server.request<any[]>('/sync/list-user-files');
    const info = files.find(f => f.fileId === args.cloudFileId);
    if (!info) throw new Error('File not found on server');
    let key: CryptoKey | null = null;
    if (info.encryptKeyId) {
      const raw = await this.opts.storage.getItem(`key:${info.encryptKeyId}`);
      if (raw) key = await importKey(raw);
      else {
        if (!args.password) throw new SyncError('missing-key', 'This file is encrypted. Enter its password.');
        key = await this.unlockKey(args.cloudFileId, args.password);
      }
    }
    let bytes = await this.server.request<Uint8Array>(`/sync/download-user-file`, {
      raw: true,
      headers: { 'x-actual-file-id': args.cloudFileId },
    });
    if (info.encryptKeyId && key) bytes = await decrypt(key, bytes);
    const db = new BudgetDb(this.opts.sqlJs, bytes);
    db.resetNodeId();
    // The snapshot's message log is the base; sync forward from the group start.
    clearMessageLog(db);
    const existing = (await this.opts.storage.listFiles()).find(f => f.cloudFileId === args.cloudFileId);
    const meta: FileMeta = {
      id: existing?.id ?? uuid(),
      name: info.name,
      cloudFileId: args.cloudFileId,
      groupId: info.groupId,
      encryptKeyId: info.encryptKeyId ?? null,
      lastOpened: Date.now(),
      createdAt: Date.now(),
    };
    await this.opts.storage.setMeta(meta);
    await this.opts.storage.writeDb(meta.id, db.export());
    this.key = key;
    this.attach(db, meta);
    await this.sync();
    return meta;
  }

  private async unlockKey(cloudFileId: string, password: string): Promise<CryptoKey> {
    const k = await this.server.request<{ id: string; salt: string; test: string }>('/sync/user-get-key', { json: { fileId: cloudFileId } });
    const key = await deriveKey(password, k.salt);
    if (!(await verifyKey(key, k.test))) throw new SyncError('invalid-password', 'Wrong encryption password');
    await this.opts.storage.setItem(`key:${k.id}`, await exportKey(key));
    return key;
  }

  async enableEncryption(password: string) {
    const meta = this.meta;
    if (!meta) throw new Error('No budget file is open');
    if (!meta.cloudFileId) await this.uploadFile();
    const keyId = uuid();
    const salt = randomSalt();
    const key = await deriveKey(password, salt);
    await this.server.request('/sync/user-create-key', {
      json: { fileId: this.meta!.cloudFileId, keyId, keySalt: salt, testContent: await makeTestContent(key) },
    });
    await this.opts.storage.setItem(`key:${keyId}`, await exportKey(key));
    this.key = key;
    await this.updateMeta({ encryptKeyId: keyId });
    // Re-encrypt: upload a new encrypted snapshot and force other devices to re-download.
    await this.uploadFile();
  }

  // ---------- handlers ----------

  private buildHandlers(): Record<string, Handler> {
    const db = () => this.requireDb();
    const async = (name: string, fn: Handler) => {
      ASYNC_HANDLERS.add(name);
      return [name, fn] as const;
    };

    const asyncHandlers = Object.fromEntries([
      // files
      async('files-list', async () => (await this.opts.storage.listFiles()).sort((a, b) => (b.lastOpened ?? 0) - (a.lastOpened ?? 0))),
      async('file-create', (a: { name: string; demo?: boolean }) => this.createFile(a)),
      async('file-load', (a: { id: string }) => this.loadFile(a.id)),
      async('file-close', () => this.closeFile()),
      async('file-current', () => this.meta),
      async('file-rename', async (a: { id: string; name: string }) => {
        const m = await this.opts.storage.getMeta(a.id);
        if (!m) throw new Error('File not found');
        m.name = a.name.trim() || m.name;
        await this.opts.storage.setMeta(m);
        if (this.meta?.id === a.id) {
          this.meta = m;
          this.emit({ type: 'file-changed', meta: m });
          if (m.cloudFileId && this.server.url)
            await this.server.request('/sync/update-user-filename', { json: { fileId: m.cloudFileId, name: m.name } }).catch(() => {});
        }
        return m;
      }),
      async('file-delete', async (a: { id: string; fromServer?: boolean }) => {
        const m = await this.opts.storage.getMeta(a.id);
        if (this.meta?.id === a.id) await this.closeFile();
        if (a.fromServer && m?.cloudFileId) await this.server.request('/sync/delete-user-file', { json: { fileId: m.cloudFileId } });
        await this.opts.storage.deleteFile(a.id);
      }),
      async('file-duplicate', async (a: { id: string; name: string }) => {
        if (this.meta?.id === a.id) await this.flush();
        const data = await this.opts.storage.readDb(a.id);
        if (!data) throw new Error('File not found');
        const copy = new BudgetDb(this.opts.sqlJs, data);
        copy.resetNodeId();
        clearMessageLog(copy);
        const meta: FileMeta = { id: uuid(), name: a.name, createdAt: Date.now() };
        await this.opts.storage.setMeta(meta);
        await this.opts.storage.writeDb(meta.id, copy.export());
        copy.close();
        return meta;
      }),
      async('file-export', async () => {
        await this.flush();
        const d = this.requireDb();
        return { name: this.meta!.name, data: bytesToBase64(d.export()) };
      }),
      async('file-import', async (a: { name: string; data: string }) => {
        await this.closeFile();
        const db = new BudgetDb(this.opts.sqlJs, base64ToBytes(a.data));
        if (!db.first("SELECT name FROM sqlite_master WHERE name = 'transactions'")) throw new Error('Not a budget file');
        db.resetNodeId();
        clearMessageLog(db);
        const meta: FileMeta = { id: uuid(), name: a.name, createdAt: Date.now(), lastOpened: Date.now() };
        await this.opts.storage.setMeta(meta);
        await this.opts.storage.writeDb(meta.id, db.export());
        this.attach(db, meta);
        return meta;
      }),

      // server and sync
      async('server-get', async () => {
        const out: any = { url: this.server.url, loggedIn: !!this.server.token, loginMethod: null, user: null, reachable: false };
        if (!this.server.url) return out;
        try {
          const b = await this.server.request<{ loginMethod: string; bootstrapped: boolean; googleLogin?: boolean; multiuser?: boolean }>('/account/needs-bootstrap', {
            auth: false,
          });
          out.reachable = true;
          out.loginMethod = b.loginMethod;
          out.bootstrapped = b.bootstrapped;
          out.googleLogin = !!b.googleLogin;
          out.multiuser = !!b.multiuser;
          if (this.server.token) {
            try {
              out.user = await this.server.request('/account/validate');
            } catch (e: any) {
              if (e.reason === 'unauthorized') {
                this.server.token = null;
                await this.opts.storage.setItem('serverToken', null);
                out.loggedIn = false;
              }
            }
          }
        } catch {
          /* offline: keep the cached login state */
        }
        return out;
      }),
      async('server-openid-start', (a: { returnUrl: string }) =>
        this.server.request<{ url: string }>(`/openid/login?returnUrl=${encodeURIComponent(a.returnUrl)}`, { auth: false }),
      ),
      async('server-openid-exchange', async (a: { code: string }) => {
        const r = await this.server.request<{ token: string; user: any }>('/openid/exchange', { json: { code: a.code }, auth: false });
        this.server.token = r.token;
        await this.opts.storage.setItem('serverToken', r.token);
        this.scheduleSync(0);
        return r.user;
      }),
      // user directory (admins) and sharing
      async('users-list', () => this.server.request('/admin/users')),
      async('users-directory', () => this.server.request('/admin/directory')),
      async('user-create', (a: any) => this.server.request('/admin/users', { json: a })),
      async('user-update', (a: any) => this.server.request('/admin/users/update', { json: a })),
      async('users-delete', (a: { ids: string[] }) => this.server.request('/admin/users/delete', { json: a })),
      async('file-access-get', (a: { fileId?: string }) => this.server.request(`/admin/access?fileId=${encodeURIComponent(a.fileId ?? this.meta?.cloudFileId ?? '')}`)),
      async('file-access-grant', (a: { fileId?: string; userId: string }) =>
        this.server.request('/admin/access/grant', { json: { fileId: a.fileId ?? this.meta?.cloudFileId, userId: a.userId } }),
      ),
      async('file-access-revoke', (a: { fileId?: string; userId: string }) =>
        this.server.request('/admin/access/revoke', { json: { fileId: a.fileId ?? this.meta?.cloudFileId, userId: a.userId } }),
      ),
      async('file-access-transfer', (a: { fileId?: string; newUserId: string }) =>
        this.server.request('/admin/access/transfer', { json: { fileId: a.fileId ?? this.meta?.cloudFileId, newUserId: a.newUserId } }),
      ),
      async('file-cloud-info', async () => {
        if (!this.meta?.cloudFileId) return null;
        return this.server.request('/sync/get-user-file-info', { headers: { 'x-actual-file-id': this.meta.cloudFileId } });
      }),
      async('server-set-url', async (a: { url: string | null }) => {
        const url = a.url ? a.url.trim().replace(/\/+$/, '') : null;
        if (url) {
          const probe = new ServerClient(this.opts.fetch ?? fetch, url, null);
          await probe.request('/account/needs-bootstrap', { auth: false });
        }
        this.server.url = url;
        this.server.token = null;
        await this.opts.storage.setItem('serverUrl', url);
        await this.opts.storage.setItem('serverToken', null);
        return { url };
      }),
      async('server-needs-bootstrap', () => this.server.request('/account/needs-bootstrap', { auth: false })),
      async('server-bootstrap', async (a: { password: string }) => {
        const r = await this.server.request<{ token: string }>('/account/bootstrap', { json: { password: a.password }, auth: false });
        this.server.token = r.token;
        await this.opts.storage.setItem('serverToken', r.token);
        return true;
      }),
      async('server-login', async (a: { userName?: string; password: string }) => {
        const r = await this.server.request<{ token: string; mustChangePassword?: boolean; user?: any }>('/account/login', {
          json: { userName: a.userName, password: a.password },
          auth: false,
        });
        this.server.token = r.token;
        await this.opts.storage.setItem('serverToken', r.token);
        if (!r.mustChangePassword) this.scheduleSync(0);
        return { mustChangePassword: !!r.mustChangePassword, user: r.user ?? null };
      }),
      async('server-logout', async () => {
        await this.server.request('/account/logout', { json: {} }).catch(() => {});
        this.server.token = null;
        await this.opts.storage.setItem('serverToken', null);
      }),
      async('server-change-password', async (a: { currentPassword?: string; password: string }) => {
        const r = await this.server.request<{ token: string; user?: any }>('/account/change-password', { json: a });
        if (r?.token) {
          this.server.token = r.token;
          await this.opts.storage.setItem('serverToken', r.token);
        }
        this.scheduleSync(0);
        return r?.user ?? null;
      }),
      async('user-set-password', (a: { id: string; password: string | null }) => this.server.request('/admin/users/set-password', { json: a })),
      async('server-info', () => this.server.request('/info', { auth: false })),
      async('cloud-files-list', () => this.server.request('/sync/list-user-files')),
      async('cloud-file-download', (a: { cloudFileId: string; password?: string }) => this.downloadFile(a)),
      async('file-upload', () => this.uploadFile()),
      async('sync-now', () => this.sync()),
      async('sync-status', () => this.syncStatus),
      async('sync-reset', async () => {
        await this.uploadFile();
        this.notify('success', 'Sync was reset. Other devices must re-download this file.');
      }),
      async('sync-repair', async () => {
        // Rebuild the trie from the local log and resend everything.
        const d = db();
        const { merkle, Timestamp } = await import('@envelope/crdt');
        d.merkle = merkle.build(d.all<{ timestamp: string }>('SELECT timestamp FROM messages_crdt').map(r => Timestamp.parse(r.timestamp)!));
        d.setMeta('lastSyncedTimestamp', Timestamp.zero());
        return this.sync();
      }),
      async('encryption-enable', (a: { password: string }) => this.enableEncryption(a.password)),
      async('encryption-unlock', async (a: { password: string }) => {
        if (!this.meta?.cloudFileId) throw new Error('Not a cloud file');
        this.key = await this.unlockKey(this.meta.cloudFileId, a.password);
        this.scheduleSync(0);
        return true;
      }),
      async('encryption-status', async () => ({ enabled: !!this.meta?.encryptKeyId, unlocked: !!this.key })),
    ]);

    const syncHandlers: Record<string, Handler> = {
      // accounts
      'accounts-get': () => accounts.getAccounts(db()),
      'account-create': (a: any) => accounts.createAccount(db(), a),
      'account-update': (a: any) => accounts.updateAccount(db(), a),
      'account-move': (a: { id: string; targetId: string | null }) => accounts.moveAccount(db(), a.id, a.targetId),
      'account-close': (a: any) => accounts.closeAccount(db(), a),
      'account-reopen': (a: { id: string }) => accounts.reopenAccount(db(), a.id),
      'account-delete': (a: { id: string }) => accounts.deleteAccount(db(), a.id),
      'account-reconcile-lock': (a: { id: string }) => accounts.reconcileLock(db(), a.id),
      'account-reconcile-adjust': (a: { id: string; balance: number }) => accounts.reconcileAdjust(db(), a.id, a.balance),
      'account-balance-history': (a: { id: string; months?: number }) => {
        const end = new Date().toISOString().slice(0, 7);
        const start = budget.getBudgetBounds(db()).start;
        return reports.netWorth(db(), { start: start > end ? end : start, end, accounts: [a.id] }).slice(-(a.months ?? 12));
      },

      // transactions
      'transactions-get': (a: txns.TransactionQuery) => txns.getTransactions(db(), a),
      'transaction-get': (a: { id: string }) => txns.getTransaction(db(), a.id),
      'transaction-add': (a: any) => txns.addTransaction(db(), a, { learn: true }),
      'transaction-update': (a: any) => txns.updateTransaction(db(), a),
      'transaction-delete': (a: { id: string }) => txns.deleteTransaction(db(), a.id),
      'transactions-batch': (a: any) => txns.batchUpdateTransactions(db(), a, { learn: true }),
      'transactions-duplicate': (a: { ids: string[] }) => txns.duplicateTransactions(db(), a.ids),
      'transactions-merge': (a: { a: string; b: string }) => txns.mergeTransactions(db(), a.a, a.b),
      'transactions-make-transfer': (a: { a: string; b: string }) => txns.makeTransfer(db(), a.a, a.b),
      'transactions-export-csv': (a: txns.TransactionQuery) => txns.transactionsToCsv(db(), txns.getTransactions(db(), a)),
      'transactions-run-rules': (a: { ids: string[] }) => {
        const d = db();
        const all = rules.getRules(d);
        const ctx = txns.accountCtx(d);
        for (const id of a.ids) {
          const t = txns.getTransaction(d, id);
          if (!t || t.is_parent) continue;
          const out = rules.runRules(all, txns.toRuleTxn(t), ctx);
          if (out.tombstone) txns.deleteTransaction(d, id);
          else txns.updateTransaction(d, { id, payee: out.payee, category: out.category, notes: out.notes, cleared: out.cleared, date: out.date, amount: out.amount, schedule: out.schedule }, { learn: false });
        }
      },
      'schedule-from-transaction': (a: { id: string }) => schedules.scheduleFromTransaction(db(), a.id),

      // categories
      'categories-get': () => categories.getCategoryGroups(db()),
      'category-create': (a: any) => categories.createCategory(db(), a),
      'category-update': (a: any) => categories.updateCategory(db(), a),
      'category-move': (a: { id: string; groupId: string; targetId: string | null }) => categories.moveCategory(db(), a.id, a.groupId, a.targetId),
      'category-delete': (a: { id: string; transferId?: string | null }) => categories.deleteCategory(db(), a.id, a.transferId ?? null),
      'category-group-create': (a: any) => categories.createGroup(db(), a),
      'category-group-update': (a: any) => categories.updateGroup(db(), a),
      'category-group-move': (a: { id: string; targetId: string | null }) => categories.moveGroup(db(), a.id, a.targetId),
      'category-group-delete': (a: { id: string; transferId?: string | null }) => categories.deleteGroup(db(), a.id, a.transferId ?? null),

      // budget
      'budget-bounds': () => budget.getBudgetBounds(db()),
      'budget-month': (a: { month: string }) => {
        const d = db();
        const mb = budget.getBudgetMonth(d, a.month);
        const goals = templates.runTemplates(d, a.month, { dryRun: true }).goals;
        return { ...mb, goals };
      },
      'budget-set-amount': (a: { month: string; category: string; amount: number }) => budget.setBudget(db(), a.month, a.category, a.amount),
      'budget-set-carryover': (a: { month: string; category: string; flag: boolean }) => budget.setCarryover(db(), a.month, a.category, a.flag),
      'budget-transfer': (a: { month: string; from: string | null; to: string | null; amount: number }) =>
        budget.transferBudget(db(), a.month, a.from, a.to, a.amount),
      'budget-cover-overspending': (a: { month: string; to: string; from: string | null }) => budget.coverOverspending(db(), a.month, a.to, a.from),
      'budget-hold': (a: { month: string; amount: number }) => budget.holdForNextMonth(db(), a.month, a.amount),
      'budget-reset-hold': (a: { month: string }) => budget.resetHold(db(), a.month),
      'budget-month-action': (a: { month: string; action: budget.CategoryBudgetAction }) => budget.budgetActionForMonth(db(), a.month, a.action),
      'budget-category-action': (a: { month: string; category: string; action: budget.CategoryBudgetAction }) =>
        budget.budgetActionForCategory(db(), a.month, a.category, a.action),
      'budget-apply-templates': (a: { month: string; category?: string; dryRun?: boolean }) => templates.runTemplates(db(), a.month, a),
      'budget-check-templates': () => templates.checkTemplates(db()),
      'budget-cleanup': (a: { month: string }) => templates.runCleanup(db(), a.month),
      'budget-set-type': (a: { type: budget.BudgetType }) => budget.setBudgetType(db(), a.type),
      'budget-type': () => budget.getBudgetType(db()),

      // payees
      'payees-get': () => payees.getPayees(db()),
      'payees-common': () => payees.getCommonPayees(db()),
      'payee-create': (a: { name: string }) => payees.findOrCreatePayee(db(), a.name),
      'payee-update': (a: any) => payees.updatePayee(db(), a),
      'payees-merge': (a: { targetId: string; mergeIds: string[] }) => payees.mergePayees(db(), a.targetId, a.mergeIds),
      'payees-delete': (a: { ids: string[] }) => payees.deletePayees(db(), a.ids),
      'payees-orphaned': () => payees.getOrphanedPayees(db()),
      'payee-rules': (a: { id: string }) => rules.getPayeeRules(db(), a.id),

      // rules
      'rules-get': () => rules.getRules(db()),
      'rule-create': (a: any) => rules.createRule(db(), a),
      'rule-update': (a: any) => rules.updateRule(db(), a),
      'rules-delete': (a: { ids: string[] }) => rules.deleteRules(db(), a.ids),
      'rule-validate': (a: any) => rules.validateRule(a),
      'rule-preview': (a: { conditionsOp: 'and' | 'or'; conditions: rules.Condition[] }) =>
        a.conditions.length ? txns.getTransactions(db(), { filter: a }).slice(0, 200) : [],
      'rule-apply-actions': (a: { ids: string[]; actions: rules.Action[] }) => {
        const d = db();
        for (const id of a.ids) {
          const t = txns.getTransaction(d, id);
          if (!t) continue;
          const out = rules.applyActions(a.actions, txns.toRuleTxn(t));
          if (out.tombstone) txns.deleteTransaction(d, id);
          else txns.updateTransaction(d, { id, payee: out.payee, category: t.is_parent ? undefined : out.category, notes: out.notes, cleared: out.cleared, date: out.date, amount: t.is_parent ? undefined : out.amount, account: out.account ?? undefined, schedule: out.schedule }, { learn: false });
        }
      },

      // schedules
      'schedules-get': () => schedules.getSchedules(db()),
      'schedule-create': (a: schedules.ScheduleInput) => schedules.createSchedule(db(), a),
      'schedule-update': (a: { id: string } & Partial<schedules.ScheduleInput>) => schedules.updateSchedule(db(), a.id, a),
      'schedule-delete': (a: { id: string }) => schedules.deleteSchedule(db(), a.id),
      'schedule-skip': (a: { id: string }) => schedules.skipNextDate(db(), a.id),
      'schedule-post': (a: { id: string; date?: string }) => schedules.postTransactionForSchedule(db(), a.id, a.date),
      'schedule-complete': (a: { id: string; completed: boolean }) => schedules.setScheduleCompleted(db(), a.id, a.completed),
      'schedules-upcoming': (a: { account?: string | null }) => schedules.getUpcomingPreview(db(), a.account),
      'schedules-discover': () => schedules.discoverSchedules(db()),
      'schedules-run-auto': () => schedules.autoPostSchedules(db()),

      // import
      'import-detect': (a: { filename: string; text: string }) => detectFormat(a.filename, a.text),
      'import-csv-preview': (a: { text: string; options: any }) => {
        const p = previewCsv(a.text, a.options);
        return { ...p, rows: p.rows.slice(0, 10), total: p.rows.length };
      },
      'import-parse': (a: { format: any; text: string; options: any }) => parseFile(a.format, a.text, a.options),
      'import-reconcile': (a: { account: string; transactions: any[]; options: any }) =>
        reconcileTransactions(db(), a.account, a.transactions, a.options),

      // reports
      'report-net-worth': (a: any) => reports.netWorth(db(), a),
      'report-cash-flow': (a: any) => reports.cashFlow(db(), a),
      'report-custom': (a: reports.CustomReportArgs) => reports.customReport(db(), a),
      'report-drilldown': (a: any) => {
        const ids = reports.reportDrilldown(db(), a);
        const parentIds = new Set(
          ids.map(id => db().first<{ parent_id: string | null }>('SELECT parent_id FROM transactions WHERE id = ?', [id])?.parent_id ?? id),
        );
        return txns.getTransactions(db(), { ids: [...parentIds] });
      },
      'report-spending': (a: { month: string }) => reports.spendingAnalysis(db(), a.month),
      'report-calendar': (a: { month: string }) => reports.calendar(db(), a.month),
      'report-age-of-money': (a: any) => reports.ageOfMoney(db(), a),

      // notes, prefs, filters, tags
      'note-get': (a: { id: string }) => misc.getNote(db(), a.id),
      'note-set': (a: { id: string; note: string }) => misc.setNote(db(), a.id, a.note),
      'notes-all': () => misc.getNotesMap(db()),
      'prefs-get': () => misc.getPrefs(db()),
      'pref-set': (a: { id: string; value: unknown }) => misc.setPref(db(), a.id, a.value),
      'filters-get': () => misc.getFilters(db()),
      'filter-save': (a: any) => misc.saveFilter(db(), a),
      'filter-delete': (a: { id: string }) => misc.deleteFilter(db(), a.id),
      'tags-get': () => misc.getTags(db()),

      // query and maintenance
      query: (a: { query: QueryState }) => runQuery(db(), a.query),
      'repair-splits': () => misc.repairSplits(db()),
      'reset-cache': () => budget.invalidateBudget(db()),
      undo: () => db().undo(),
      redo: () => db().redo(),
      'undo-state': () => ({ canUndo: db().undoStack.length > 0, canRedo: db().redoStack.length > 0 }),
    };

    return { ...asyncHandlers, ...syncHandlers };
  }
}

/** Handlers that write but shouldn't run inside an outer batch (they manage their own). */
for (const h of ['undo', 'redo']) ASYNC_HANDLERS.add(h);
