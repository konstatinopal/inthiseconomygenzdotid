import type { BudgetDb, Row } from '../db';
import { fromDateInt, toDateInt, today } from '../util/dates';
import { findOrCreatePayee, getPayee } from './payees';
import { findPayeeCategoryRule, getRules, runRules, ruleMatches, type Condition, type RuleTxn } from './rules';
import { onScheduleLinked } from './schedule-hooks';
import type { NewTransaction, TransactionEntity } from './types';

export function toTransaction(r: Row): TransactionEntity {
  return {
    id: r.id,
    account: r.account,
    date: r.date ? fromDateInt(r.date) : '',
    amount: r.amount ?? 0,
    payee: r.payee ?? null,
    category: r.category ?? null,
    notes: r.notes ?? null,
    cleared: !!r.cleared,
    reconciled: !!r.reconciled,
    parent_id: r.parent_id ?? null,
    is_parent: !!r.is_parent,
    is_child: !!r.is_child,
    transfer_id: r.transfer_id ?? null,
    schedule: r.schedule ?? null,
    imported_id: r.imported_id ?? null,
    imported_payee: r.imported_payee ?? null,
    starting_balance_flag: !!r.starting_balance_flag,
    sort_order: r.sort_order ?? 0,
  };
}

export function toRuleTxn(t: TransactionEntity | Row): RuleTxn {
  return {
    id: t.id,
    account: t.account,
    payee: t.payee,
    category: t.category,
    date: typeof t.date === 'number' ? fromDateInt(t.date) : t.date,
    notes: t.notes,
    amount: t.amount,
    imported_payee: t.imported_payee,
    cleared: !!t.cleared,
    reconciled: !!t.reconciled,
    transfer_id: t.transfer_id,
    schedule: t.schedule,
  };
}

export function getTransaction(db: BudgetDb, id: string): TransactionEntity | null {
  const r = db.first('SELECT * FROM transactions WHERE id = ? AND tombstone = 0', [id]);
  if (!r) return null;
  const t = toTransaction(r);
  if (t.is_parent) t.subtransactions = getChildren(db, id);
  return t;
}

function getChildren(db: BudgetDb, parentId: string): TransactionEntity[] {
  return db
    .all('SELECT * FROM transactions WHERE parent_id = ? AND tombstone = 0 ORDER BY sort_order, id', [parentId])
    .map(toTransaction);
}

let sortCounter = 0;
function nextSortOrder() {
  sortCounter = (sortCounter + 1) % 1000;
  return Date.now() + sortCounter / 1000;
}

function toRowFields(t: Partial<TransactionEntity>): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(t)) {
    if (k === 'subtransactions' || k === 'balance' || k === 'payee_name' || v === undefined) continue;
    if (k === 'date') out.date = v ? toDateInt(v as string) : undefined;
    else if (typeof v === 'boolean') out[k] = v ? 1 : 0;
    else out[k] = v;
  }
  return out;
}

function isOffbudget(db: BudgetDb, accountId: string) {
  return !!db.first<{ offbudget: number }>('SELECT offbudget FROM accounts WHERE id = ?', [accountId])?.offbudget;
}

export function accountCtx(db: BudgetDb) {
  const cache = new Map<string, boolean>();
  return {
    accountOffbudget: (id: string) => {
      if (!cache.has(id)) cache.set(id, isOffbudget(db, id));
      return cache.get(id)!;
    },
  };
}

// ---------- transfers ----------

/** Keep a transfer's mirror transaction in step with `id`. Creates, updates or removes the mirror. */
function syncTransfer(db: BudgetDb, id: string) {
  const t = db.first<Row>('SELECT * FROM transactions WHERE id = ?', [id]);
  if (!t || t.tombstone) return;
  const payee = t.payee ? db.first<Row>('SELECT * FROM payees WHERE id = ? AND tombstone = 0', [t.payee]) : null;
  const target: string | null = payee?.transfer_acct ?? null;
  if (target && target !== t.account && !t.is_parent && !t.is_child) {
    const fromPayee = db.first<Row>('SELECT id FROM payees WHERE transfer_acct = ? AND tombstone = 0', [t.account]);
    const bothOnBudget = !isOffbudget(db, t.account) && !isOffbudget(db, target);
    const mirror = t.transfer_id ? db.first<Row>('SELECT * FROM transactions WHERE id = ? AND tombstone = 0', [t.transfer_id]) : null;
    if (mirror) {
      db.update('transactions', {
        id: mirror.id,
        account: target,
        amount: -t.amount,
        date: t.date,
        notes: t.notes,
        payee: fromPayee?.id ?? null,
        category: bothOnBudget ? null : mirror.category,
      });
    } else {
      const mirrorId = db.insert('transactions', {
        account: target,
        amount: -t.amount,
        date: t.date,
        notes: t.notes,
        payee: fromPayee?.id ?? null,
        transfer_id: t.id,
        sort_order: nextSortOrder(),
      });
      db.update('transactions', { id: t.id, transfer_id: mirrorId });
    }
    if (bothOnBudget && t.category) db.update('transactions', { id: t.id, category: null });
  } else if (t.transfer_id) {
    const mirror = db.first<Row>('SELECT * FROM transactions WHERE id = ? AND tombstone = 0', [t.transfer_id]);
    if (mirror) db.delete('transactions', mirror.id);
    db.update('transactions', { id: t.id, transfer_id: null });
  }
}

// ---------- category learning ----------

export function learnCategory(db: BudgetDb, payeeId: string | null, categoryId: string | null) {
  if (!payeeId || !categoryId) return;
  const global = db.first<{ value: string }>("SELECT value FROM preferences WHERE id = 'learnCategories' AND tombstone = 0");
  if (global && JSON.parse(global.value) === false) return;
  const payee = getPayee(db, payeeId);
  if (!payee || payee.transfer_acct || !payee.learn_categories) return;
  const recent = db.all<{ category: string }>(
    `SELECT category FROM transactions WHERE payee = ? AND category IS NOT NULL AND tombstone = 0 AND is_parent = 0
     ORDER BY date DESC, sort_order DESC LIMIT 5`,
    [payeeId],
  );
  const counts = new Map<string, number>();
  for (const r of recent) counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!best || best[0] !== categoryId) return;
  const existing = findPayeeCategoryRule(db, payeeId);
  if (existing) {
    if (existing.actions[0].op === 'set' && existing.actions[0].value !== categoryId) {
      db.update('rules', {
        id: existing.id,
        actions: JSON.stringify([{ op: 'set', field: 'category', value: categoryId }]),
      });
    }
  } else {
    db.insert('rules', {
      stage: null,
      conditions_op: 'and',
      conditions: JSON.stringify([{ field: 'payee', op: 'is', value: payeeId }]),
      actions: JSON.stringify([{ op: 'set', field: 'category', value: categoryId }]),
    });
  }
}

// ---------- mutations ----------

export interface AddOptions {
  runRules?: boolean;
  learn?: boolean;
}

/** Insert a transaction (with optional subtransactions). Runs rules first. Returns the id, or null if a rule deleted it. */
export function addTransaction(db: BudgetDb, input: NewTransaction, opts: AddOptions = {}): string | null {
  return db.batch(() => {
    let payee = input.payee ?? null;
    if (!payee && input.payee_name) payee = findOrCreatePayee(db, input.payee_name);
    let txn: RuleTxn = {
      account: input.account,
      payee,
      category: input.category ?? null,
      date: input.date || today(),
      notes: input.notes ?? null,
      amount: input.amount ?? 0,
      imported_payee: input.imported_payee ?? null,
      cleared: input.cleared ?? false,
      reconciled: input.reconciled ?? false,
      schedule: input.schedule ?? null,
    };
    if (opts.runRules !== false) {
      txn = runRules(getRules(db), txn, accountCtx(db));
      if (txn.tombstone) return null;
    }
    const subs = input.subtransactions ?? [];
    const id = db.insert('transactions', {
      id: input.id,
      account: txn.account,
      date: toDateInt(txn.date!),
      amount: txn.amount,
      payee: txn.payee,
      category: subs.length ? null : txn.category,
      notes: txn.notes,
      cleared: txn.cleared ? 1 : 0,
      reconciled: txn.reconciled ? 1 : 0,
      imported_id: input.imported_id ?? null,
      imported_payee: txn.imported_payee,
      schedule: txn.schedule,
      starting_balance_flag: input.starting_balance_flag ? 1 : 0,
      is_parent: subs.length ? 1 : 0,
      sort_order: input.sort_order ?? nextSortOrder(),
    });
    for (const s of subs) addChild(db, id, s);
    syncTransfer(db, id);
    if (txn.schedule) onScheduleLinked(db, txn.schedule, txn.date!);
    if (opts.learn && txn.category) learnCategory(db, txn.payee ?? null, txn.category);
    return id;
  });
}

function addChild(db: BudgetDb, parentId: string, s: Partial<TransactionEntity> & { payee_name?: string }) {
  const parent = db.first<Row>('SELECT * FROM transactions WHERE id = ?', [parentId])!;
  let payee = s.payee !== undefined ? s.payee : parent.payee;
  if (s.payee_name) payee = findOrCreatePayee(db, s.payee_name);
  return db.insert('transactions', {
    id: s.id,
    account: parent.account,
    date: parent.date,
    cleared: parent.cleared,
    reconciled: parent.reconciled,
    amount: s.amount ?? 0,
    payee,
    category: s.category ?? null,
    notes: s.notes ?? null,
    parent_id: parentId,
    is_child: 1,
    sort_order: s.sort_order ?? nextSortOrder(),
  });
}

export type TransactionPatch = Partial<TransactionEntity> & {
  id: string;
  payee_name?: string;
  subtransactions?: (Partial<TransactionEntity> & { payee_name?: string })[];
};

export function updateTransaction(db: BudgetDb, patch: TransactionPatch, opts: { learn?: boolean } = {}) {
  db.batch(() => {
    const before = db.first<Row>('SELECT * FROM transactions WHERE id = ? AND tombstone = 0', [patch.id]);
    if (!before) throw new Error('Transaction not found');
    const p: TransactionPatch = { ...patch };
    if (p.payee_name !== undefined) p.payee = p.payee_name ? findOrCreatePayee(db, p.payee_name) : null;
    const fields = toRowFields(p);
    delete fields.is_parent;
    delete fields.is_child;
    delete fields.parent_id;
    db.update('transactions', fields);

    if (p.subtransactions) {
      const existing = new Set(db.all<{ id: string }>('SELECT id FROM transactions WHERE parent_id = ? AND tombstone = 0', [p.id]).map(r => r.id));
      for (const s of p.subtransactions) {
        if (s.id && existing.has(s.id)) {
          const sf = toRowFields({ ...s, payee: s.payee_name ? findOrCreatePayee(db, s.payee_name) : s.payee });
          delete sf.account;
          delete sf.date;
          db.update('transactions', sf);
          existing.delete(s.id);
        } else {
          addChild(db, p.id, s);
        }
      }
      for (const id of existing) db.delete('transactions', id);
      const isSplit = p.subtransactions.length > 0;
      db.update('transactions', { id: p.id, is_parent: isSplit ? 1 : 0, ...(isSplit ? { category: null } : {}) });
    }

    const after = db.first<Row>('SELECT * FROM transactions WHERE id = ?', [p.id])!;
    if (after.is_parent) {
      for (const c of db.all<{ id: string }>('SELECT id FROM transactions WHERE parent_id = ? AND tombstone = 0', [p.id])) {
        db.update('transactions', { id: c.id, account: after.account, date: after.date, cleared: after.cleared, reconciled: after.reconciled });
      }
    }
    if (
      before.payee !== after.payee ||
      before.amount !== after.amount ||
      before.date !== after.date ||
      before.notes !== after.notes ||
      before.account !== after.account ||
      before.category !== after.category
    ) {
      syncTransfer(db, p.id);
    }
    if (after.schedule && after.schedule !== before.schedule) onScheduleLinked(db, after.schedule, fromDateInt(after.date));
    if (opts.learn !== false && p.category && before.category !== p.category) learnCategory(db, after.payee, p.category);
  });
}

export function deleteTransaction(db: BudgetDb, id: string) {
  db.batch(() => {
    const t = db.first<Row>('SELECT * FROM transactions WHERE id = ? AND tombstone = 0', [id]);
    if (!t) return;
    for (const c of db.all<{ id: string }>('SELECT id FROM transactions WHERE parent_id = ? AND tombstone = 0', [id])) {
      db.delete('transactions', c.id);
    }
    if (t.transfer_id) {
      const mirror = db.first<Row>('SELECT id FROM transactions WHERE id = ? AND tombstone = 0', [t.transfer_id]);
      if (mirror) db.delete('transactions', mirror.id);
    }
    db.delete('transactions', id);
    if (t.is_child && t.parent_id) {
      const remaining = db.first<{ c: number }>('SELECT COUNT(*) c FROM transactions WHERE parent_id = ? AND tombstone = 0', [t.parent_id]);
      if (remaining?.c === 0) db.update('transactions', { id: t.parent_id, is_parent: 0 });
    }
  });
}

export function batchUpdateTransactions(
  db: BudgetDb,
  changes: { added?: NewTransaction[]; updated?: TransactionPatch[]; deleted?: string[] },
  opts: { learn?: boolean } = {},
) {
  return db.batch(() => {
    const added = (changes.added ?? []).map(t => addTransaction(db, t, { learn: opts.learn }));
    for (const u of changes.updated ?? []) updateTransaction(db, u, opts);
    for (const id of changes.deleted ?? []) deleteTransaction(db, id);
    return { added };
  });
}

export function duplicateTransactions(db: BudgetDb, ids: string[]) {
  db.batch(() => {
    for (const id of ids) {
      const t = getTransaction(db, id);
      if (!t || t.is_child) continue;
      addTransaction(
        db,
        {
          account: t.account,
          date: t.date,
          amount: t.amount,
          payee: t.payee,
          category: t.category,
          notes: t.notes,
          subtransactions: t.subtransactions?.map(s => ({ amount: s.amount, payee: s.payee, category: s.category, notes: s.notes })),
        },
        { runRules: false },
      );
    }
  });
}

/** Distribute a split's unassigned remainder across children, evenly. */
export function distributeSplitRemainder(t: { amount: number; subtransactions: { amount: number }[] }) {
  const subs = t.subtransactions;
  if (!subs.length) return subs;
  const remainder = t.amount - subs.reduce((s, c) => s + c.amount, 0);
  const share = Math.trunc(remainder / subs.length);
  let leftover = remainder - share * subs.length;
  return subs.map(s => {
    const extra = leftover !== 0 ? Math.sign(leftover) : 0;
    leftover -= extra;
    return { ...s, amount: s.amount + share + extra };
  });
}

/** Turn two existing opposite transactions in different accounts into a linked transfer. */
export function makeTransfer(db: BudgetDb, idA: string, idB: string) {
  db.batch(() => {
    const a = db.first<Row>('SELECT * FROM transactions WHERE id = ? AND tombstone = 0', [idA]);
    const b = db.first<Row>('SELECT * FROM transactions WHERE id = ? AND tombstone = 0', [idB]);
    if (!a || !b) throw new Error('Transaction not found');
    if (a.account === b.account) throw new Error('Transfers need two different accounts');
    if (a.amount !== -b.amount) throw new Error('Amounts must be opposite');
    if (a.is_parent || b.is_parent || a.is_child || b.is_child) throw new Error('Split transactions cannot be transfers');
    const payA = db.first<Row>('SELECT id FROM payees WHERE transfer_acct = ? AND tombstone = 0', [b.account]);
    const payB = db.first<Row>('SELECT id FROM payees WHERE transfer_acct = ? AND tombstone = 0', [a.account]);
    const bothOn = !isOffbudget(db, a.account) && !isOffbudget(db, b.account);
    db.update('transactions', { id: a.id, payee: payA?.id, transfer_id: b.id, ...(bothOn ? { category: null } : {}) });
    db.update('transactions', { id: b.id, payee: payB?.id, transfer_id: a.id, ...(bothOn ? { category: null } : {}) });
  });
}

/**
 * Merge two transactions (e.g. a manual entry and its bank-imported twin).
 * The imported side wins on date and imported fields; the user's payee,
 * category and notes are kept. Returns the surviving id.
 */
export function mergeTransactions(db: BudgetDb, idA: string, idB: string): string {
  return db.batch(() => {
    const a = db.first<Row>('SELECT * FROM transactions WHERE id = ? AND tombstone = 0', [idA]);
    const b = db.first<Row>('SELECT * FROM transactions WHERE id = ? AND tombstone = 0', [idB]);
    if (!a || !b) throw new Error('Transaction not found');
    if (a.amount !== b.amount) throw new Error('Only transactions with the same amount can be merged');
    const [imported, manual] = b.imported_id && !a.imported_id ? [b, a] : [a, b];
    const keep = manual;
    db.update('transactions', {
      id: keep.id,
      date: imported.date,
      imported_id: imported.imported_id ?? keep.imported_id,
      imported_payee: imported.imported_payee ?? keep.imported_payee,
      payee: manual.payee ?? imported.payee,
      category: manual.category ?? imported.category,
      notes: manual.notes || imported.notes,
      cleared: manual.cleared || imported.cleared ? 1 : 0,
      schedule: manual.schedule ?? imported.schedule,
    });
    deleteTransaction(db, imported.id === keep.id ? manual.id : imported.id);
    return keep.id;
  });
}

// ---------- queries ----------

export interface TransactionQuery {
  account?: string | 'onbudget' | 'offbudget' | null;
  category?: string;
  search?: string;
  filter?: { conditionsOp: 'and' | 'or'; conditions: Condition[] };
  startDate?: string;
  endDate?: string;
  ids?: string[];
}

/** Top-level transactions (parents with `subtransactions`), newest first, with a running balance. */
export function getTransactions(db: BudgetDb, query: TransactionQuery = {}): TransactionEntity[] {
  const where = ['t.tombstone = 0', 'a.tombstone = 0'];
  const params: any[] = [];
  if (query.account === 'onbudget') where.push('a.offbudget = 0');
  else if (query.account === 'offbudget') where.push('a.offbudget = 1');
  else if (query.account) {
    where.push('t.account = ?');
    params.push(query.account);
  }
  if (query.startDate) {
    where.push('t.date >= ?');
    params.push(toDateInt(query.startDate));
  }
  if (query.endDate) {
    where.push('t.date <= ?');
    params.push(toDateInt(query.endDate));
  }
  const rows = db.all<Row>(
    `SELECT t.*, p.name AS payee_name, c.name AS category_name, a.name AS account_name
     FROM transactions t JOIN accounts a ON a.id = t.account
     LEFT JOIN payees p ON p.id = t.payee LEFT JOIN categories c ON c.id = t.category
     WHERE ${where.join(' AND ')}
     ORDER BY t.date DESC, t.starting_balance_flag ASC, t.sort_order DESC, t.id`,
    params,
  );

  const children = new Map<string, Row[]>();
  const top: Row[] = [];
  for (const r of rows) {
    if (r.is_child) {
      const list = children.get(r.parent_id) ?? [];
      list.push(r);
      children.set(r.parent_id, list);
    } else top.push(r);
  }
  for (const list of children.values()) list.sort((x, y) => x.sort_order - y.sort_order);

  // Running balance in chronological order over the unfiltered set.
  const balances = new Map<string, number>();
  let running = 0;
  for (let i = top.length - 1; i >= 0; i--) {
    running += top[i].amount;
    balances.set(top[i].id, running);
  }

  const ctx = accountCtx(db);
  const search = query.search?.trim().toLowerCase();
  const ids = query.ids ? new Set(query.ids) : null;
  const rowMatches = (r: Row) => {
    if (query.category && r.category !== query.category) return false;
    if (search) {
      const amt = (Math.abs(r.amount) / 100).toFixed(2);
      const hay = [r.payee_name, r.notes, r.category_name, r.account_name, r.imported_payee, amt, fromDateInt(r.date)]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!hay.includes(search)) return false;
    }
    if (query.filter?.conditions.length && !ruleMatches(query.filter, toRuleTxn(r), ctx)) return false;
    return true;
  };

  const out: TransactionEntity[] = [];
  for (const r of top) {
    if (ids && !ids.has(r.id)) continue;
    const kids = children.get(r.id) ?? [];
    const hasFilter = query.category || search || query.filter?.conditions.length;
    if (hasFilter) {
      const selfMatch = r.is_parent ? !query.category && rowMatches(r) : rowMatches(r);
      if (!selfMatch && !kids.some(rowMatches)) continue;
    }
    const t = toTransaction(r);
    t.balance = balances.get(r.id);
    if (r.is_parent) t.subtransactions = kids.map(toTransaction);
    out.push(t);
  }
  return out;
}

export function transactionsToCsv(db: BudgetDb, txns: TransactionEntity[]): string {
  const names = (table: string) =>
    new Map(db.all<{ id: string; name: string }>(`SELECT id, name FROM ${table}`).map(r => [r.id, r.name]));
  const accounts = names('accounts');
  const payees = names('payees');
  const categories = names('categories');
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [['Account', 'Date', 'Payee', 'Notes', 'Category', 'Amount', 'Split_Amount', 'Cleared'].join(',')];
  for (const t of txns) {
    const rows = t.subtransactions?.length ? t.subtransactions : [t];
    for (const r of rows) {
      lines.push(
        [
          accounts.get(t.account),
          t.date,
          payees.get(r.payee ?? '') ?? '',
          r.notes,
          categories.get(r.category ?? '') ?? '',
          (t.amount / 100).toFixed(2),
          t.subtransactions?.length ? (r.amount / 100).toFixed(2) : '0',
          t.reconciled ? 'Reconciled' : t.cleared ? 'Cleared' : 'Not cleared',
        ]
          .map(esc)
          .join(','),
      );
    }
  }
  return lines.join('\n');
}
