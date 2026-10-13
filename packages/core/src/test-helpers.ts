import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { BudgetDb } from './db';

let SQL: SqlJsStatic | null = null;

export async function sqlJs() {
  SQL ??= await initSqlJs();
  return SQL;
}

export async function emptyDb() {
  return new BudgetDb(await sqlJs());
}
