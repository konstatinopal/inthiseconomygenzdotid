import * as SQLite from 'expo-sqlite';
import type { DriverFactory, SqlParam, SyncDriver } from './sqljs-compat';

/** Native SQLite through expo-sqlite, with prepared statements cached per SQL string. */
export const expoDriver: DriverFactory = data => {
  const db = data ? SQLite.deserializeDatabaseSync(data) : SQLite.openDatabaseSync(':memory:');
  const statements = new Map<string, SQLite.SQLiteStatement>();
  const stmt = (sql: string) => {
    let s = statements.get(sql);
    if (!s) {
      s = db.prepareSync(sql);
      statements.set(sql, s);
    }
    return s;
  };
  const driver: SyncDriver = {
    exec: sql => db.execSync(sql),
    all: (sql, params) => {
      const result = stmt(sql).executeSync<Record<string, unknown>>(params as SqlParam[] as SQLite.SQLiteBindParams);
      const rows = result.getAllSync();
      result.resetSync();
      return rows;
    },
    run: (sql, params) => {
      const result = stmt(sql).executeSync(params as SqlParam[] as SQLite.SQLiteBindParams);
      result.resetSync();
    },
    serialize: () => db.serializeSync(),
    close: () => {
      for (const s of statements.values()) s.finalizeSync();
      statements.clear();
      db.closeSync();
    },
  };
  return driver;
};
