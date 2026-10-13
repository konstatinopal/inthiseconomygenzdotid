import type { BudgetDb, Row } from '../db';
import { today } from '../util/dates';
import { createCategory, createGroup, sortBefore } from './categories';
import { createPayee, findOrCreatePayee, getTransferPayee } from './payees';
import { addTransaction, deleteTransaction } from './transactions';
import type { AccountEntity } from './types';

export function getAccounts(db: BudgetDb): AccountEntity[] {
  const rows = db.all<Row>(
    `SELECT a.*,
       COALESCE(SUM(t.amount), 0) AS balance,
       COALESCE(SUM(CASE WHEN t.cleared = 1 THEN t.amount ELSE 0 END), 0) AS cleared_bal
     FROM accounts a
     LEFT JOIN transactions t ON t.account = a.id AND t.tombstone = 0 AND t.is_parent = 0
     WHERE a.tombstone = 0
     GROUP BY a.id
     ORDER BY a.sort_order, a.name`,
  );
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    offbudget: !!r.offbudget,
    closed: !!r.closed,
    sort_order: r.sort_order,
    last_reconciled: r.last_reconciled ?? null,
    balance: r.balance,
    cleared: r.cleared_bal,
    uncleared: r.balance - r.cleared_bal,
  }));
}

export function getAccount(db: BudgetDb, id: string): AccountEntity | null {
  return getAccounts(db).find(a => a.id === id) ?? null;
}

export function getAccountBalance(db: BudgetDb, id: string, cutoff?: string): number {
  const r = db.first<{ b: number }>(
    `SELECT COALESCE(SUM(amount), 0) b FROM transactions WHERE account = ? AND tombstone = 0 AND is_parent = 0 ${cutoff ? 'AND date <= ?' : ''}`,
    cutoff ? [id, parseInt(cutoff.replace(/-/g, ''), 10)] : [id],
  );
  return r?.b ?? 0;
}

export function getStartingBalanceCategory(db: BudgetDb): string {
  const existing = db.first<{ id: string }>(
    "SELECT c.id FROM categories c WHERE c.tombstone = 0 AND c.is_income = 1 AND lower(c.name) = 'starting balances'",
  );
  if (existing) return existing.id;
  let group = db.first<{ id: string }>('SELECT id FROM category_groups WHERE is_income = 1 AND tombstone = 0');
  const groupId = group?.id ?? createGroup(db, { name: 'Income', is_income: true });
  return createCategory(db, { name: 'Starting Balances', group: groupId });
}

export function createAccount(
  db: BudgetDb,
  a: { name: string; offbudget?: boolean; balance?: number; date?: string; closed?: boolean },
): string {
  return db.batch(() => {
    const max = db.first<{ m: number | null }>('SELECT MAX(sort_order) m FROM accounts WHERE tombstone = 0');
    const id = db.insert('accounts', {
      name: a.name.trim(),
      offbudget: a.offbudget ? 1 : 0,
      closed: a.closed ? 1 : 0,
      sort_order: (max?.m ?? 0) + 16384,
    });
    createPayee(db, { name: '', transfer_acct: id });
    if (a.balance) {
      addTransaction(
        db,
        {
          account: id,
          date: a.date ?? today(),
          amount: a.balance,
          payee: findOrCreatePayee(db, 'Starting Balance'),
          category: a.offbudget ? null : getStartingBalanceCategory(db),
          cleared: true,
          starting_balance_flag: true,
        },
        { runRules: false },
      );
    }
    return id;
  });
}

export function updateAccount(db: BudgetDb, a: { id: string; name?: string; offbudget?: boolean }) {
  db.update('accounts', {
    id: a.id,
    name: a.name?.trim(),
    offbudget: a.offbudget === undefined ? undefined : a.offbudget ? 1 : 0,
  });
}

export function moveAccount(db: BudgetDb, id: string, targetId: string | null) {
  const items = db.all<{ id: string; sort_order: number }>('SELECT id, sort_order FROM accounts WHERE tombstone = 0 AND id != ? ORDER BY sort_order', [id]);
  db.update('accounts', { id, sort_order: sortBefore(items, targetId) });
}

/**
 * Close an account. A remaining balance must be moved: either transferred
 * to another account or categorized (e.g. written off), unless `forced`.
 */
export function closeAccount(
  db: BudgetDb,
  args: { id: string; transferAccountId?: string | null; categoryId?: string | null; forced?: boolean },
) {
  db.batch(() => {
    const balance = getAccountBalance(db, args.id);
    if (balance !== 0) {
      if (args.transferAccountId) {
        const payee = getTransferPayee(db, args.transferAccountId);
        addTransaction(
          db,
          {
            account: args.id,
            date: today(),
            amount: -balance,
            payee: payee?.id ?? null,
            category: args.categoryId ?? null,
            notes: 'Transfer remaining balance before closing',
            cleared: true,
          },
          { runRules: false },
        );
      } else if (args.categoryId) {
        addTransaction(
          db,
          { account: args.id, date: today(), amount: -balance, category: args.categoryId, notes: 'Closing account', cleared: true },
          { runRules: false },
        );
      } else if (!args.forced) {
        throw new Error('Account has a balance; transfer it or categorize it before closing');
      }
    }
    db.update('accounts', { id: args.id, closed: 1 });
  });
}

export function reopenAccount(db: BudgetDb, id: string) {
  db.update('accounts', { id, closed: 0 });
}

export function deleteAccount(db: BudgetDb, id: string) {
  db.batch(() => {
    for (const t of db.all<{ id: string; transfer_id: string | null }>(
      'SELECT id, transfer_id FROM transactions WHERE account = ? AND tombstone = 0 AND is_child = 0',
      [id],
    )) {
      if (t.transfer_id) {
        // Keep the other side as a plain transaction.
        db.update('transactions', { id: t.transfer_id, transfer_id: null, payee: null });
        db.update('transactions', { id: t.id, transfer_id: null });
      }
      deleteTransaction(db, t.id);
    }
    const payee = getTransferPayee(db, id);
    if (payee) db.delete('payees', payee.id);
    db.delete('accounts', id);
  });
}

// ---------- reconciliation ----------

export function reconcileLock(db: BudgetDb, accountId: string) {
  db.batch(() => {
    for (const t of db.all<{ id: string }>(
      'SELECT id FROM transactions WHERE account = ? AND tombstone = 0 AND cleared = 1 AND reconciled = 0',
      [accountId],
    )) {
      db.update('transactions', { id: t.id, reconciled: 1 });
    }
    db.update('accounts', { id: accountId, last_reconciled: String(Date.now()) });
  });
}

/** Create a cleared adjustment so the cleared balance matches the statement balance. */
export function reconcileAdjust(db: BudgetDb, accountId: string, statementBalance: number): string | null {
  const cleared =
    db.first<{ b: number }>(
      'SELECT COALESCE(SUM(amount),0) b FROM transactions WHERE account = ? AND tombstone = 0 AND is_parent = 0 AND cleared = 1',
      [accountId],
    )?.b ?? 0;
  const diff = statementBalance - cleared;
  if (diff === 0) return null;
  return addTransaction(
    db,
    {
      account: accountId,
      date: today(),
      amount: diff,
      payee: findOrCreatePayee(db, 'Reconciliation Balance Adjustment'),
      notes: 'Reconciliation balance adjustment',
      cleared: true,
    },
    { runRules: false },
  );
}
