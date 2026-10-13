import type { BudgetDb, Row } from '../db';
import type { Condition } from './rules';

// ---------- notes (Markdown, keyed by entity id; month notes use "budget-YYYY-MM") ----------

export function getNote(db: BudgetDb, id: string): string | null {
  return db.first<{ note: string }>('SELECT note FROM notes WHERE id = ? AND tombstone = 0', [id])?.note ?? null;
}

export function setNote(db: BudgetDb, id: string, note: string) {
  db.upsert('notes', { id, note });
}

export function getNotesMap(db: BudgetDb): Record<string, string> {
  return Object.fromEntries(db.all<Row>("SELECT id, note FROM notes WHERE tombstone = 0 AND note IS NOT NULL AND note != ''").map(r => [r.id, r.note]));
}

// ---------- synced preferences ----------

export function getPrefs(db: BudgetDb): Record<string, any> {
  const out: Record<string, any> = {};
  for (const r of db.all<Row>('SELECT id, value FROM preferences WHERE tombstone = 0')) {
    try {
      out[r.id] = JSON.parse(r.value);
    } catch {
      out[r.id] = r.value;
    }
  }
  return out;
}

export function setPref(db: BudgetDb, id: string, value: unknown) {
  db.upsert('preferences', { id, value: JSON.stringify(value) });
}

// ---------- saved filters ----------

export interface SavedFilter {
  id: string;
  name: string;
  conditionsOp: 'and' | 'or';
  conditions: Condition[];
}

export function getFilters(db: BudgetDb): SavedFilter[] {
  return db
    .all<Row>('SELECT * FROM transaction_filters WHERE tombstone = 0 ORDER BY name')
    .map(r => ({ id: r.id, name: r.name, conditionsOp: r.conditions_op === 'or' ? 'or' : 'and', conditions: JSON.parse(r.conditions) }));
}

export function saveFilter(db: BudgetDb, f: Omit<SavedFilter, 'id'> & { id?: string }): string {
  if (f.id) {
    db.update('transaction_filters', { id: f.id, name: f.name, conditions_op: f.conditionsOp, conditions: JSON.stringify(f.conditions) });
    return f.id;
  }
  return db.insert('transaction_filters', { name: f.name, conditions_op: f.conditionsOp, conditions: JSON.stringify(f.conditions) });
}

export function deleteFilter(db: BudgetDb, id: string) {
  db.delete('transaction_filters', id);
}

// ---------- tags (derived from #tags in notes) ----------

export function getTags(db: BudgetDb): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of db.all<{ notes: string }>("SELECT notes FROM transactions WHERE tombstone = 0 AND notes LIKE '%#%'")) {
    for (const m of r.notes.matchAll(/(^|\s)(#[\p{L}\p{N}_-]+)/gu)) {
      const t = m[2].toLowerCase();
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count);
}

// ---------- maintenance ----------

/** Fix split parents whose amount doesn't equal the sum of their children. */
export function repairSplits(db: BudgetDb): number {
  let fixed = 0;
  db.batch(() => {
    for (const p of db.all<Row>(
      `SELECT p.id, p.amount, COALESCE(SUM(c.amount), 0) total, COUNT(c.id) n FROM transactions p
       LEFT JOIN transactions c ON c.parent_id = p.id AND c.tombstone = 0
       WHERE p.is_parent = 1 AND p.tombstone = 0 GROUP BY p.id`,
    )) {
      if (p.n === 0) {
        db.update('transactions', { id: p.id, is_parent: 0 });
        fixed++;
      } else if (p.total !== p.amount) {
        db.insert('transactions', {
          account: db.first<Row>('SELECT account FROM transactions WHERE id = ?', [p.id])!.account,
          date: db.first<Row>('SELECT date FROM transactions WHERE id = ?', [p.id])!.date,
          amount: p.amount - p.total,
          parent_id: p.id,
          is_child: 1,
          notes: 'Split remainder (repaired)',
          sort_order: Date.now(),
        });
        fixed++;
      }
    }
    // Orphaned children whose parent was deleted.
    for (const c of db.all<Row>(
      `SELECT c.id FROM transactions c LEFT JOIN transactions p ON p.id = c.parent_id
       WHERE c.is_child = 1 AND c.tombstone = 0 AND (p.id IS NULL OR p.tombstone = 1)`,
    )) {
      db.delete('transactions', c.id);
      fixed++;
    }
  });
  return fixed;
}
