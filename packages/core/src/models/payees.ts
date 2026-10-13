import type { BudgetDb, Row } from '../db';
import type { PayeeEntity } from './types';

export function toPayee(r: Row): PayeeEntity {
  return {
    id: r.id,
    name: r.name,
    transfer_acct: r.transfer_acct ?? null,
    favorite: !!r.favorite,
    learn_categories: r.learn_categories !== 0,
  };
}

export function getPayees(db: BudgetDb): (PayeeEntity & { ruleCount?: number; txnCount?: number })[] {
  const rows = db.all(
    `SELECT p.*, (SELECT COUNT(*) FROM transactions t WHERE t.payee = p.id AND t.tombstone = 0) AS txn_count
     FROM payees p LEFT JOIN accounts a ON a.id = p.transfer_acct
     WHERE p.tombstone = 0 AND (p.transfer_acct IS NULL OR a.tombstone = 0)
     ORDER BY p.transfer_acct IS NOT NULL, lower(p.name)`,
  );
  const rules = db.all<{ conditions: string; actions: string }>('SELECT conditions, actions FROM rules WHERE tombstone = 0');
  const ruleCounts = new Map<string, number>();
  for (const r of rules) {
    const ids = new Set<string>();
    for (const c of [...JSON.parse(r.conditions), ...JSON.parse(r.actions)]) {
      if (c.field === 'payee') {
        for (const v of Array.isArray(c.value) ? c.value : [c.value]) if (typeof v === 'string') ids.add(v);
      }
    }
    for (const id of ids) ruleCounts.set(id, (ruleCounts.get(id) ?? 0) + 1);
  }
  return rows.map(r => ({ ...toPayee(r), ruleCount: ruleCounts.get(r.id) ?? 0, txnCount: r.txn_count }));
}

export function getPayee(db: BudgetDb, id: string): PayeeEntity | null {
  const r = db.first('SELECT * FROM payees WHERE id = ? AND tombstone = 0', [id]);
  return r ? toPayee(r) : null;
}

export function getTransferPayee(db: BudgetDb, accountId: string): PayeeEntity | null {
  const r = db.first('SELECT * FROM payees WHERE transfer_acct = ? AND tombstone = 0', [accountId]);
  return r ? toPayee(r) : null;
}

export function createPayee(db: BudgetDb, p: { name: string; transfer_acct?: string | null }): string {
  return db.insert('payees', { name: p.name.trim(), transfer_acct: p.transfer_acct ?? null });
}

export function findOrCreatePayee(db: BudgetDb, name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const existing = db.first<{ id: string }>(
    'SELECT id FROM payees WHERE lower(name) = lower(?) AND tombstone = 0 AND transfer_acct IS NULL',
    [trimmed],
  );
  return existing ? existing.id : createPayee(db, { name: trimmed });
}

export function updatePayee(db: BudgetDb, p: Partial<PayeeEntity> & { id: string }) {
  const fields: Row = { id: p.id };
  if (p.name !== undefined) fields.name = p.name.trim();
  if (p.favorite !== undefined) fields.favorite = p.favorite ? 1 : 0;
  if (p.learn_categories !== undefined) fields.learn_categories = p.learn_categories ? 1 : 0;
  db.update('payees', fields);
}

function rewriteRuleRefs(db: BudgetDb, field: string, from: Set<string>, to: string | null) {
  for (const r of db.all<Row>('SELECT * FROM rules WHERE tombstone = 0')) {
    let changed = false;
    const fix = (items: any[]) =>
      items.map(c => {
        if (c.field !== field) return c;
        if (Array.isArray(c.value)) {
          const next = Array.from(new Set(c.value.map((v: string) => (from.has(v) ? to : v)).filter(Boolean)));
          if (next.length !== c.value.length || next.some((v, i) => v !== c.value[i])) changed = true;
          return { ...c, value: next };
        }
        if (from.has(c.value)) {
          changed = true;
          return { ...c, value: to };
        }
        return c;
      });
    const conditions = fix(JSON.parse(r.conditions));
    const actions = fix(JSON.parse(r.actions));
    if (changed) db.update('rules', { id: r.id, conditions: JSON.stringify(conditions), actions: JSON.stringify(actions) });
  }
}

export { rewriteRuleRefs };

/** Merge payees into `targetId`: rewrites transactions and rules, then deletes the merged payees. */
export function mergePayees(db: BudgetDb, targetId: string, mergeIds: string[]) {
  const ids = mergeIds.filter(id => id !== targetId);
  if (!ids.length) return;
  db.batch(() => {
    const placeholders = ids.map(() => '?').join(',');
    for (const t of db.all<{ id: string }>(
      `SELECT id FROM transactions WHERE payee IN (${placeholders}) AND tombstone = 0`,
      ids,
    )) {
      db.update('transactions', { id: t.id, payee: targetId });
    }
    rewriteRuleRefs(db, 'payee', new Set(ids), targetId);
    for (const id of ids) db.delete('payees', id);
  });
}

export function deletePayees(db: BudgetDb, ids: string[]) {
  db.batch(() => {
    for (const id of ids) {
      const p = getPayee(db, id);
      if (!p || p.transfer_acct) continue;
      for (const t of db.all<{ id: string }>('SELECT id FROM transactions WHERE payee = ? AND tombstone = 0', [id])) {
        db.update('transactions', { id: t.id, payee: null });
      }
      rewriteRuleRefs(db, 'payee', new Set([id]), null);
      db.delete('payees', id);
    }
  });
}

/** Payees used by no transaction and no rule. */
export function getOrphanedPayees(db: BudgetDb): string[] {
  return getPayees(db)
    .filter(p => !p.transfer_acct && p.txnCount === 0 && p.ruleCount === 0)
    .map(p => p.id);
}

/** Favorites first, then the most-used payees over the last few months. */
export function getCommonPayees(db: BudgetDb, limit = 10): string[] {
  return db
    .all<{ payee: string }>(
      `SELECT t.payee, COUNT(*) c FROM transactions t JOIN payees p ON p.id = t.payee
       WHERE t.tombstone = 0 AND p.tombstone = 0 AND p.transfer_acct IS NULL
       GROUP BY t.payee ORDER BY p.favorite DESC, c DESC LIMIT ?`,
      [limit],
    )
    .map(r => r.payee);
}
