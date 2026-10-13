import type { Database, SqlJsStatic, SqlValue } from 'sql.js';
import { Clock, Timestamp, makeNodeId, merkle, type Message, type TrieNode } from '@envelope/crdt';
import { MIGRATIONS, SYNCED_SCHEMA } from './schema';
import { uuid } from '../util/id';

export type Row = Record<string, any>;
export type Value = string | number | null;

interface UndoCell {
  dataset: string;
  row: string;
  column: string;
  oldValue: Value;
  newValue: Value;
}

export type ChangeSource = 'local' | 'remote' | 'undo';
export type ChangeListener = (tables: string[], source: ChangeSource) => void;

interface ClockRecord {
  timestamp: string;
  merkle: TrieNode;
}

/**
 * A budget file's SQLite database. Every write goes through CRDT messages:
 * the message is applied to its table (last-writer-wins per cell), stored in
 * `messages_crdt` and added to the Merkle trie so it can be synced.
 */
export class BudgetDb {
  readonly sql: Database;
  clock!: Clock;
  merkle!: TrieNode;
  private stmts = new Map<string, ReturnType<Database['prepare']>>();
  private depth = 0;
  private pendingCells: UndoCell[] = [];
  private touched = new Set<string>();
  private touchedSource: ChangeSource = 'local';
  private listeners = new Set<ChangeListener>();
  private writeListeners = new Set<(table: string) => void>();
  undoStack: UndoCell[][] = [];
  redoStack: UndoCell[][] = [];
  undoEnabled = true;
  now: () => number = Date.now;

  constructor(SQL: SqlJsStatic, data?: Uint8Array) {
    this.sql = data ? new SQL.Database(data) : new SQL.Database();
    this.migrate();
    this.loadClock();
  }

  // ---------- raw access ----------

  private stmt(sql: string) {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.sql.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  all<T = Row>(sql: string, params: SqlValue[] = []): T[] {
    const s = this.stmt(sql);
    s.bind(params);
    const out: T[] = [];
    while (s.step()) out.push(s.getAsObject() as T);
    s.reset();
    return out;
  }

  first<T = Row>(sql: string, params: SqlValue[] = []): T | null {
    const s = this.stmt(sql);
    s.bind(params);
    const row = s.step() ? (s.getAsObject() as T) : null;
    s.reset();
    return row;
  }

  run(sql: string, params: SqlValue[] = []): void {
    const s = this.stmt(sql);
    s.run(params);
    s.reset();
  }

  exec(sql: string) {
    this.sql.exec(sql);
  }

  export(): Uint8Array {
    // sql.js frees prepared statements on export.
    for (const s of this.stmts.values()) s.free();
    this.stmts.clear();
    return this.sql.export();
  }

  close() {
    for (const s of this.stmts.values()) s.free();
    this.stmts.clear();
    this.sql.close();
  }

  getMeta(key: string): string | null {
    return this.first<{ value: string }>('SELECT value FROM kvcache WHERE key = ?', [key])?.value ?? null;
  }

  setMeta(key: string, value: string | null) {
    if (value === null) this.run('DELETE FROM kvcache WHERE key = ?', [key]);
    else this.run('INSERT OR REPLACE INTO kvcache (key, value) VALUES (?, ?)', [key, value]);
  }

  // ---------- schema ----------

  private migrate() {
    this.exec('CREATE TABLE IF NOT EXISTS __migrations__ (id INTEGER PRIMARY KEY)');
    const done = new Set(this.all<{ id: number }>('SELECT id FROM __migrations__').map(r => r.id));
    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue;
      this.exec('BEGIN');
      for (const s of m.sql) this.exec(s);
      this.run('INSERT INTO __migrations__ (id) VALUES (?)', [m.id]);
      this.exec('COMMIT');
    }
  }

  private loadClock() {
    const row = this.first<{ clock: string }>('SELECT clock FROM messages_clock WHERE id = 1');
    if (row) {
      const rec: ClockRecord = JSON.parse(row.clock);
      const ts = Timestamp.parse(rec.timestamp)!;
      this.clock = new Clock({ millis: ts.millis, counter: ts.counter, node: ts.node }, () => this.now());
      this.merkle = rec.merkle;
    } else {
      this.clock = new Clock({ millis: 0, counter: 0, node: makeNodeId() }, () => this.now());
      this.merkle = merkle.emptyTrie();
      this.saveClock();
    }
  }

  private saveClock() {
    const s = this.clock.state;
    const rec: ClockRecord = {
      timestamp: new Timestamp(s.millis, s.counter, s.node).toString(),
      merkle: this.merkle,
    };
    this.run('INSERT OR REPLACE INTO messages_clock (id, clock) VALUES (1, ?)', [JSON.stringify(rec)]);
  }

  /** Give this replica a fresh node id, e.g. after downloading a file another device made. */
  resetNodeId() {
    this.clock.state = { ...this.clock.state, node: makeNodeId() };
    this.saveClock();
  }

  // ---------- change notification ----------

  subscribe(fn: ChangeListener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Called synchronously for every applied cell write, even mid-batch (for cache invalidation). */
  onWrite(fn: (table: string) => void) {
    this.writeListeners.add(fn);
    return () => this.writeListeners.delete(fn);
  }

  // ---------- batching ----------

  /**
   * Run `fn` inside one SQLite transaction. All messages generated inside
   * form a single undo step. Nested calls join the outer batch.
   */
  batch<T>(fn: () => T, opts: { source?: ChangeSource } = {}): T {
    if (this.depth > 0) return fn();
    this.depth++;
    this.pendingCells = [];
    this.touched = new Set();
    this.touchedSource = opts.source ?? 'local';
    this.exec('BEGIN');
    let result: T;
    try {
      result = fn();
      this.saveClock();
      this.exec('COMMIT');
    } catch (e) {
      this.exec('ROLLBACK');
      this.depth--;
      this.loadClock();
      this.pendingCells = [];
      for (const t of this.touched) for (const l of this.writeListeners) l(t);
      throw e;
    }
    this.depth--;
    const cells = this.pendingCells;
    this.pendingCells = [];
    if (cells.length > 0 && this.touchedSource === 'local' && this.undoEnabled) {
      this.undoStack.push(cells);
      if (this.undoStack.length > 100) this.undoStack.shift();
      this.redoStack = [];
    }
    if (this.touched.size > 0) {
      const tables = [...this.touched];
      for (const l of this.listeners) l(tables, this.touchedSource);
    }
    return result;
  }

  // ---------- writes ----------

  private checkCell(dataset: string, column: string) {
    const cols = SYNCED_SCHEMA[dataset];
    if (!cols) throw new Error(`Unknown table: ${dataset}`);
    if (!(column in cols)) throw new Error(`Unknown column: ${dataset}.${column}`);
  }

  private currentValue(dataset: string, row: string, column: string): { exists: boolean; value: Value } {
    const r = this.first<Row>(`SELECT ${column} AS v FROM ${dataset} WHERE id = ?`, [row]);
    return r ? { exists: true, value: r.v } : { exists: false, value: null };
  }

  /** Write cells through CRDT messages. Values are compared so unchanged cells produce no message. */
  private writeCells(dataset: string, row: string, fields: Row, force = false) {
    const inBatch = this.depth > 0;
    const go = () => {
      // Whether the row existed before this write decides what undo restores.
      const existed = !!this.first(`SELECT 1 FROM ${dataset} WHERE id = ?`, [row]);
      for (const [column, raw] of Object.entries(fields)) {
        if (column === 'id' || raw === undefined) continue;
        this.checkCell(dataset, column);
        const value: Value = typeof raw === 'boolean' ? (raw ? 1 : 0) : raw;
        const cur = this.currentValue(dataset, row, column);
        if (!force && cur.exists && cur.value === value) continue;
        const oldValue = existed ? cur.value : column === 'tombstone' ? 1 : null;
        const msg: Message = {
          timestamp: this.clock.send().toString(),
          dataset,
          row,
          column,
          value,
        };
        this.applyOne(msg, true);
        this.pendingCells.push({ dataset, row, column, oldValue, newValue: value });
      }
    };
    if (inBatch) go();
    else this.batch(go);
  }

  insert(table: string, row: Row): string {
    const id: string = row.id ?? uuid();
    const fields: Row = { ...row };
    delete fields.id;
    fields.tombstone = 0;
    // Force so that re-inserting a tombstoned id resurrects it.
    this.writeCells(table, id, fields, true);
    return id;
  }

  update(table: string, row: Row): void {
    if (!row.id) throw new Error('update requires id');
    this.writeCells(table, row.id, row);
  }

  /** Upsert where the row may or may not exist yet (e.g. budget cells keyed by month+category). */
  upsert(table: string, row: Row): void {
    const exists = this.first(`SELECT id FROM ${table} WHERE id = ?`, [row.id]);
    if (exists) this.writeCells(table, row.id, { ...row, tombstone: 0 });
    else this.insert(table, row);
  }

  delete(table: string, id: string): void {
    this.writeCells(table, id, { tombstone: 1 });
  }

  // ---------- message application ----------

  private applyOne(msg: Message, isLocal: boolean): boolean {
    if (!isLocal) {
      const dup = this.first('SELECT 1 FROM messages_crdt WHERE timestamp = ?', [msg.timestamp]);
      if (dup) return false;
    }
    let shouldApply = true;
    if (!isLocal) {
      const latest = this.first<{ timestamp: string }>(
        'SELECT timestamp FROM messages_crdt WHERE dataset = ? AND row = ? AND column = ? ORDER BY timestamp DESC LIMIT 1',
        [msg.dataset, msg.row, msg.column],
      );
      shouldApply = !latest || latest.timestamp < msg.timestamp;
    }
    const known = SYNCED_SCHEMA[msg.dataset] && msg.column in SYNCED_SCHEMA[msg.dataset];
    if (shouldApply && known) {
      this.run(
        `INSERT INTO ${msg.dataset} (id, ${msg.column}) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET ${msg.column} = excluded.${msg.column}`,
        [msg.row, msg.value],
      );
      this.touched.add(msg.dataset);
      for (const l of this.writeListeners) l(msg.dataset);
    }
    this.run('INSERT INTO messages_crdt (timestamp, dataset, row, column, value) VALUES (?, ?, ?, ?, ?)', [
      msg.timestamp,
      msg.dataset,
      msg.row,
      msg.column,
      JSON.stringify(msg.value),
    ]);
    this.merkle = merkle.insert(this.merkle, Timestamp.parse(msg.timestamp)!);
    return true;
  }

  /** Apply messages received from another replica. Returns the tables that changed. */
  applyRemote(messages: Message[]): string[] {
    const sorted = [...messages].sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
    let tables: string[] = [];
    this.batch(
      () => {
        for (const m of sorted) {
          const ts = Timestamp.parse(m.timestamp);
          if (!ts) continue;
          this.clock.recv(ts);
          this.applyOne(m, false);
        }
        tables = [...this.touched];
      },
      { source: 'remote' },
    );
    return tables;
  }

  messagesSince(since: string): Message[] {
    return this.all<Row>('SELECT * FROM messages_crdt WHERE timestamp > ? ORDER BY timestamp', [since]).map(r => ({
      timestamp: r.timestamp,
      dataset: r.dataset,
      row: r.row,
      column: r.column,
      value: JSON.parse(r.value),
    }));
  }

  // ---------- undo / redo ----------

  private replay(cells: UndoCell[], useOld: boolean) {
    this.batch(
      () => {
        const ordered = useOld ? [...cells].reverse() : cells;
        for (const c of ordered) {
          const msg: Message = {
            timestamp: this.clock.send().toString(),
            dataset: c.dataset,
            row: c.row,
            column: c.column,
            value: useOld ? c.oldValue : c.newValue,
          };
          this.applyOne(msg, true);
        }
      },
      { source: 'undo' },
    );
  }

  undo(): boolean {
    const cells = this.undoStack.pop();
    if (!cells) return false;
    this.replay(cells, true);
    this.redoStack.push(cells);
    return true;
  }

  redo(): boolean {
    const cells = this.redoStack.pop();
    if (!cells) return false;
    this.replay(cells, false);
    this.undoStack.push(cells);
    return true;
  }
}
