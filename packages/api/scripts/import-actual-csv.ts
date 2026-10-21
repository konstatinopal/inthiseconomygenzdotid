// Imports an Actual Budget "All Accounts" CSV export into a budget on the sync server.
//
//   ENVELOPE_URL=https://budget.example.com ENVELOPE_USER=admin ENVELOPE_PASSWORD=… \
//     npx tsx packages/api/scripts/import-actual-csv.ts All-Accounts.csv --budget HarusKaya --dry-run
//
// Columns: Account,Date,Payee,Notes,Category_Group,Category,Amount,Split_Amount,Cleared
// - Missing accounts, category groups and categories are created (the "Income" group as an income group).
// - A pair of rows between two of your accounts (payee = the other account, no category) becomes one transfer.
// - "Starting Balances" rows become starting balances.
// - Safe to run again: rows already in the budget are skipped (same account, date, amount and payee).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { init } from '../src/index';
import { parseCsvRows } from '../../core/src/importers/csv';
import { addTransaction } from '../../core/src/models/transactions';
import { createCategory, createGroup } from '../../core/src/models/categories';
import { createAccount, getStartingBalanceCategory } from '../../core/src/models/accounts';
import { findOrCreatePayee } from '../../core/src/models/payees';
import type { BudgetDb } from '../../core/src/db';

export interface Row {
  line: number;
  account: string;
  date: string;
  payee: string;
  notes: string;
  group: string;
  category: string;
  amount: number; // cents
  cleared: boolean;
}

export interface Report {
  accounts: string[];
  groups: string[];
  categories: string[];
  added: number;
  transfers: number;
  startingBalances: number;
  skippedExisting: number;
  skippedEmpty: number[];
  warnings: string[];
}

const norm = (s: string | null | undefined) => String(s ?? '').trim().toLowerCase();

export function parseActualCsv(text: string): Row[] {
  const rows = parseCsvRows(text.replace(/^﻿/, ''));
  const head = rows.shift()?.map(h => h.trim().toLowerCase()) ?? [];
  const col = (name: string) => {
    const i = head.indexOf(name);
    if (i < 0) throw new Error(`Column "${name}" not found; is this an Actual "All Accounts" export?`);
    return i;
  };
  const c = { account: col('account'), date: col('date'), payee: col('payee'), notes: col('notes'), group: col('category_group'), category: col('category'), amount: col('amount'), split: head.indexOf('split_amount'), cleared: head.indexOf('cleared') };
  return rows
    .map((r, i) => ({ r, line: i + 2 }))
    .filter(({ r }) => r.some(v => v.trim() !== ''))
    .map(({ r, line }) => {
      const amount = Math.round(parseFloat(r[c.amount]) * 100);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r[c.date] ?? '') || !Number.isFinite(amount)) throw new Error(`Line ${line}: bad date or amount`);
      if (c.split >= 0 && Number(r[c.split] || 0) !== 0) throw new Error(`Line ${line}: split transactions are not supported by this script`);
      return {
        line,
        account: r[c.account].trim(),
        date: r[c.date],
        payee: (r[c.payee] ?? '').trim(),
        notes: (r[c.notes] ?? '').trim(),
        group: (r[c.group] ?? '').trim(),
        category: (r[c.category] ?? '').trim(),
        amount,
        cleared: c.cleared < 0 || /^(cleared|reconciled|true|1)$/i.test((r[c.cleared] ?? '').trim()),
      };
    });
}

/** Adds the rows to the open budget in one batch. */
export function importRows(db: BudgetDb, rows: Row[]): Report {
  const report: Report = { accounts: [], groups: [], categories: [], added: 0, transfers: 0, startingBalances: 0, skippedExisting: 0, skippedEmpty: [], warnings: [] };
  const run = () => {
    // ---- accounts ----
    const accounts = new Map<string, string>();
    for (const a of db.all<{ id: string; name: string }>('SELECT id, name FROM accounts WHERE tombstone = 0')) accounts.set(norm(a.name), a.id);
    for (const name of new Set(rows.map(r => r.account))) {
      if (accounts.has(norm(name))) continue;
      accounts.set(norm(name), createAccount(db, { name }));
      report.accounts.push(name);
    }
    const accountId = (name: string) => accounts.get(norm(name))!;
    const isAccount = (name: string) => accounts.has(norm(name));

    // ---- categories ----
    const groups = new Map<string, string>();
    for (const g of db.all<{ id: string; name: string }>('SELECT id, name FROM category_groups WHERE tombstone = 0')) groups.set(norm(g.name), g.id);
    const cats = new Map<string, string>(); // "group/category" and "category" → id
    for (const c of db.all<{ id: string; name: string; group: string }>(
      'SELECT c.id, c.name, g.name AS "group" FROM categories c JOIN category_groups g ON g.id = c.cat_group WHERE c.tombstone = 0 AND g.tombstone = 0',
    )) {
      cats.set(norm(c.group) + '/' + norm(c.name), c.id);
      if (!cats.has(norm(c.name))) cats.set(norm(c.name), c.id);
    }
    const categoryId = (r: Row): string | null => {
      if (!r.category) return null;
      if (norm(r.category) === 'starting balances') return getStartingBalanceCategory(db);
      const hit = cats.get(norm(r.group) + '/' + norm(r.category)) ?? cats.get(norm(r.category));
      if (hit) return hit;
      const groupName = r.group || 'Imported';
      let g = groups.get(norm(groupName));
      if (!g) {
        g = createGroup(db, { name: groupName, is_income: norm(groupName) === 'income' });
        groups.set(norm(groupName), g);
        report.groups.push(groupName);
      }
      const id = createCategory(db, { name: r.category, group: g });
      cats.set(norm(groupName) + '/' + norm(r.category), id);
      cats.set(norm(r.category), id);
      report.categories.push(`${groupName} / ${r.category}`);
      return id;
    };

    // ---- what's already there (so a second run, or WhatsApp entries, aren't doubled) ----
    const toInt = (d: string) => Number(d.replace(/-/g, ''));
    const existing = new Map<string, number>();
    for (const t of db.all<{ account: string; date: number; amount: number; payee: string | null }>(
      `SELECT t.account, t.date, t.amount, p.name AS payee FROM transactions t LEFT JOIN payees p ON p.id = t.payee
       WHERE t.tombstone = 0 AND t.is_child = 0`,
    )) {
      const k = [t.account, t.date, t.amount, norm(t.payee)].join('|');
      existing.set(k, (existing.get(k) ?? 0) + 1);
    }
    const alreadyThere = (account: string, date: string, amount: number, payee: string) => {
      const k = [account, toInt(date), amount, norm(payee)].join('|');
      const n = existing.get(k) ?? 0;
      if (n > 0) existing.set(k, n - 1);
      return n > 0;
    };
    const transferPayee = (account: string) => db.first<{ id: string }>('SELECT id FROM payees WHERE transfer_acct = ? AND tombstone = 0', [account])!.id;
    const importedId = (r: Row) => 'actual-csv:' + createHash('sha1').update([r.account, r.date, r.amount, r.payee, r.notes].join('|')).digest('hex').slice(0, 16);

    // ---- transfers: pair "A → payee B" with "B → payee A", opposite amounts, same date ----
    const used = new Set<number>();
    const isTransferRow = (r: Row) => !r.category && isAccount(r.payee) && norm(r.payee) !== norm(r.account);
    for (const r of rows) {
      if (used.has(r.line) || !isTransferRow(r)) continue;
      const mate = rows.find(o => !used.has(o.line) && o.line !== r.line && isTransferRow(o) && norm(o.account) === norm(r.payee) && norm(o.payee) === norm(r.account) && o.amount === -r.amount && o.date === r.date);
      if (!mate) {
        report.warnings.push(`Line ${r.line}: transfer to ${r.payee} has no matching row; imported as a transfer anyway`);
      } else used.add(mate.line);
      used.add(r.line);
      // Add the outgoing side; the engine creates the mirror in the other account.
      const out = mate && r.amount > 0 ? mate : r;
      const from = accountId(out.account);
      const to = accountId(out.payee);
      const dup = db.first(
        `SELECT t.id FROM transactions t JOIN payees p ON p.id = t.payee
         WHERE t.tombstone = 0 AND t.account = ? AND t.date = ? AND t.amount = ? AND p.transfer_acct = ?`,
        [from, toInt(out.date), out.amount, to],
      );
      if (dup) {
        report.skippedExisting += mate ? 2 : 1;
        continue;
      }
      addTransaction(db, { account: from, date: out.date, amount: out.amount, payee: transferPayee(to), notes: out.notes || null, cleared: out.cleared, imported_id: importedId(out) }, { runRules: false });
      report.transfers++;
    }

    // ---- everything else ----
    for (const r of rows) {
      if (used.has(r.line)) continue;
      if (r.amount === 0 && !r.payee && !r.notes) {
        report.skippedEmpty.push(r.line);
        continue;
      }
      const account = accountId(r.account);
      const starting = norm(r.category) === 'starting balances';
      if (alreadyThere(account, r.date, r.amount, starting ? 'Starting Balance' : r.payee)) {
        report.skippedExisting++;
        continue;
      }
      addTransaction(
        db,
        {
          account,
          date: r.date,
          amount: r.amount,
          payee: r.payee ? findOrCreatePayee(db, r.payee) : null,
          category: categoryId(r),
          notes: r.notes || null,
          cleared: r.cleared,
          imported_id: importedId(r),
          starting_balance_flag: starting,
        } as any,
        { runRules: false },
      );
      if (starting) report.startingBalances++;
      else report.added++;
    }
  };
  db.batch(run);
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args.splice(i, 2)[1] : undefined;
  };
  const dryRun = args.includes('--dry-run') ? (args.splice(args.indexOf('--dry-run'), 1), true) : false;
  const budget = flag('--budget');
  const file = args[0];
  const env = process.env;
  if (!file || !budget || !env.ENVELOPE_URL) {
    console.error('Usage: ENVELOPE_URL=… ENVELOPE_USER=… ENVELOPE_PASSWORD=… import-actual-csv.ts <export.csv> --budget <name> [--dry-run]');
    process.exit(1);
  }
  const rows = parseActualCsv(fs.readFileSync(file, 'utf8'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'actual-import-'));
  const api = await init({ dataDir, serverURL: env.ENVELOPE_URL, userName: env.ENVELOPE_USER, password: env.ENVELOPE_PASSWORD });
  try {
    const files: any[] = await api.getCloudBudgets();
    const hit = files.filter(f => f.fileId === budget || norm(f.name) === norm(budget));
    if (hit.length !== 1) throw new Error(hit.length ? `Several budgets are named "${budget}"; pass its id` : `No budget "${budget}" on the server. Available: ${files.map(f => f.name).join(', ')}`);
    await api.downloadBudget(hit[0].fileId, env.ENVELOPE_KEY_PASSWORD);
    // Dry run: cut the link to the server first, so the changes stay in this temporary local copy.
    if (dryRun) api.engine.server.url = null;
    const report = importRows(api.engine.requireDb(), rows);
    if (!dryRun) await api.sync();
    console.log(`${dryRun ? 'DRY RUN, nothing written. ' : ''}${rows.length} rows in ${path.basename(file)} → "${hit[0].name}"`);
    console.log(`  new accounts:     ${report.accounts.join(', ') || '-'}`);
    console.log(`  new groups:       ${report.groups.join(', ') || '-'}`);
    console.log(`  new categories:   ${report.categories.join(', ') || '-'}`);
    console.log(`  transactions:     ${report.added} added`);
    console.log(`  transfers:        ${report.transfers}`);
    console.log(`  starting balance: ${report.startingBalances}`);
    console.log(`  already there:    ${report.skippedExisting} skipped`);
    if (report.skippedEmpty.length) console.log(`  empty rows:       skipped (line ${report.skippedEmpty.join(', ')})`);
    for (const w of report.warnings) console.log(`  warning: ${w}`);
    if (!dryRun) console.log('Synced to the server. Open the app to see it.');
  } finally {
    await api.shutdown().catch(() => {});
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch(e => {
    console.error('Import failed:', e.message ?? e);
    process.exit(1);
  });
}
