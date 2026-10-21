// Proves the budget engine runs unchanged on native SQLite through the
// sql.js shim, by comparing it against the sql.js engine the web app uses.
// Uses better-sqlite3 (native SQLite for Node) in place of expo-sqlite.
//   npx tsx mobile/scripts/check-engine.mts   (from the repo root)
import Database from 'better-sqlite3';
import initSqlJs from 'sql.js';
import { Engine, MemoryStorage } from '../../packages/core/src/index.ts';
import { createSqlJsShim, type DriverFactory } from '../src/engine/sqljs-compat.ts';

const betterDriver: DriverFactory = data => {
  const db = data ? new Database(Buffer.from(data)) : new Database(':memory:');
  const cache = new Map<string, Database.Statement>();
  const stmt = (sql: string) => cache.get(sql) ?? (cache.set(sql, db.prepare(sql)), cache.get(sql)!);
  return {
    exec: sql => db.exec(sql),
    all: (sql, params) => stmt(sql).all(...params) as Record<string, unknown>[],
    run: (sql, params) => void stmt(sql).run(...params),
    serialize: () => new Uint8Array(db.serialize()),
    close: () => db.close(),
  };
};

let failures = 0;
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

async function build(sqlJs: any) {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage, sqlJs, timers: false, persistDelay: 1 });
  await engine.init();
  const meta = await engine.send('file-create', { name: 'Demo', demo: true });
  return { engine, storage, meta };
}

const web = await build(await initSqlJs());
const phone = await build(createSqlJsShim(betterDriver));

const pick = async (e: Engine) => {
  const month = new Date().toISOString().slice(0, 7);
  const m = await e.send('budget-month', { month });
  const accounts = (await e.send('accounts-get')).map((a: any) => [a.name, a.balance, a.cleared]);
  const txns = await e.send('transactions-get', {});
  return {
    toBudget: m.toBudget,
    income: m.income,
    spent: m.totalSpent,
    categories: Object.values(m.categories).map((c: any) => [c.budgeted, c.spent, c.balance]),
    accounts,
    count: txns.length,
  };
};
const a = await pick(web.engine);
const b = await pick(phone.engine);
check(JSON.stringify(a.accounts) === JSON.stringify(b.accounts), 'account balances match the web engine', JSON.stringify(b.accounts.slice(0, 2)));
check(a.toBudget === b.toBudget && a.income === b.income && a.spent === b.spent, 'To Budget, income and spending match to the cent', `${b.toBudget} / ${b.income} / ${b.spent}`);
check(JSON.stringify(a.categories) === JSON.stringify(b.categories), 'every category budgeted / spent / balance matches');
check(a.count === b.count && b.count > 100, 'same number of transactions', String(b.count));

// Writes, undo and transfers go through the shim too.
const checking = (await phone.engine.send('accounts-get')).find((x: any) => x.name === 'Checking');
const id = await phone.engine.send('transaction-add', { account: checking.id, date: '2026-10-14', amount: -2500000, payee_name: 'Kopi Kenangan', notes: 'shim test' });
check(!!(await phone.engine.send('transaction-get', { id })), 'adding a transaction works');
await phone.engine.send('undo');
check(!(await phone.engine.send('transaction-get', { id })), 'undo works');

// Persist to storage and reopen from the serialized image.
const id2 = await phone.engine.send('transaction-add', { account: checking.id, date: '2026-10-14', amount: -1000, payee_name: 'Persisted' });
await phone.engine.flush();
const bytes = await phone.storage.readDb(phone.meta.id);
check(!!bytes && bytes.length > 10000, 'database serializes to storage', `${bytes?.length} bytes`);
await phone.engine.closeFile();
await phone.engine.send('file-load', { id: phone.meta.id });
check(!!(await phone.engine.send('transaction-get', { id: id2 })), 'reopened database still has the new transaction');
check((await pick(phone.engine)).count === a.count + 1, 'reopened database has everything else too');

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
