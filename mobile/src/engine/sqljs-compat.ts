/**
 * The budget engine (packages/core) was written against sql.js, the
 * WebAssembly SQLite the web app uses. On the phone we use native SQLite
 * instead. This shim exposes the small slice of the sql.js API the engine
 * calls (Database: prepare / exec / export / close; Statement: bind / step /
 * getAsObject / reset / run / free) on top of any synchronous SQLite driver.
 */

export type SqlParam = string | number | null | Uint8Array;
export type Row = Record<string, unknown>;

/** A synchronous SQLite connection: expo-sqlite on iOS, better-sqlite3 in tests. */
export interface SyncDriver {
  exec(sql: string): void;
  all(sql: string, params: SqlParam[]): Row[];
  run(sql: string, params: SqlParam[]): void;
  serialize(): Uint8Array;
  close(): void;
}

/** Opens an empty in-memory database, or one loaded from a serialized image. */
export type DriverFactory = (data?: Uint8Array) => SyncDriver;

const normalize = (params: unknown): SqlParam[] =>
  (Array.isArray(params) ? params : []).map(p => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : (p as SqlParam)));

class Statement {
  private params: SqlParam[] = [];
  private rows: Row[] | null = null;
  private index = -1;

  constructor(
    private driver: SyncDriver,
    private sql: string,
  ) {}

  bind(params?: unknown): boolean {
    this.params = normalize(params);
    this.rows = null;
    this.index = -1;
    return true;
  }

  step(): boolean {
    if (!this.rows) this.rows = this.driver.all(this.sql, this.params);
    this.index++;
    return this.index < this.rows.length;
  }

  getAsObject(): Row {
    return this.rows?.[this.index] ?? {};
  }

  reset(): boolean {
    this.rows = null;
    this.index = -1;
    return true;
  }

  run(params?: unknown): void {
    this.driver.run(this.sql, params === undefined ? this.params : normalize(params));
  }

  free(): boolean {
    this.rows = null;
    return true;
  }
}

export function createSqlJsShim(open: DriverFactory) {
  class Database {
    private driver: SyncDriver;
    constructor(data?: Uint8Array) {
      this.driver = open(data && data.length ? data : undefined);
    }
    prepare(sql: string) {
      return new Statement(this.driver, sql);
    }
    exec(sql: string) {
      this.driver.exec(sql);
      return [];
    }
    export(): Uint8Array {
      return this.driver.serialize();
    }
    close() {
      this.driver.close();
    }
  }
  return { Database };
}
