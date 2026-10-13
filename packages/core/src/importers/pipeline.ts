// One reconciliation pipeline for every source of transactions:
// parse → map fields → dedupe → insert or merge (rules run on insert,
// which also links schedules).
import type { BudgetDb, Row } from '../db';
import { addDays, toDateInt } from '../util/dates';
import { findCategoryByName } from '../models/categories';
import { findOrCreatePayee } from '../models/payees';
import { addTransaction, updateTransaction } from '../models/transactions';
import type { ParsedTransaction } from './types';

export type ImportStatus = 'new' | 'matched' | 'skipped';

export interface ImportPreviewRow {
  index: number;
  status: ImportStatus;
  reason?: string;
  matchedId?: string;
  transaction: ParsedTransaction;
}

export interface ImportOptions {
  dryRun?: boolean;
  /** Fuzzy-match against existing transactions (default on). */
  merge?: boolean;
  reimportDeleted?: boolean;
  /** Indices to import; others are skipped. Defaults to all. */
  selected?: number[];
}

function norm(s: string | null | undefined) {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function payeeSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 3;
  if (x.includes(y) || y.includes(x)) return 2;
  return x.slice(0, 4) === y.slice(0, 4) ? 1 : 0;
}

export function reconcileTransactions(db: BudgetDb, accountId: string, parsed: ParsedTransaction[], opts: ImportOptions = {}) {
  const merge = opts.merge !== false;
  const selected = opts.selected ? new Set(opts.selected) : null;
  const claimed = new Set<string>();
  const preview: ImportPreviewRow[] = [];

  parsed.forEach((t, index) => {
    if (selected && !selected.has(index)) {
      preview.push({ index, status: 'skipped', reason: 'Not selected', transaction: t });
      return;
    }
    // 1. Exact imported_id match.
    if (t.imported_id) {
      const existing = db.first<Row>(
        'SELECT id, tombstone FROM transactions WHERE account = ? AND imported_id = ? AND is_child = 0 ORDER BY tombstone',
        [accountId, t.imported_id],
      );
      if (existing && !claimed.has(existing.id)) {
        if (existing.tombstone && !opts.reimportDeleted) {
          preview.push({ index, status: 'skipped', reason: 'Previously deleted', transaction: t });
          return;
        }
        if (!existing.tombstone) {
          claimed.add(existing.id);
          preview.push({ index, status: 'matched', matchedId: existing.id, transaction: t });
          return;
        }
      }
    }
    // 2. Fuzzy: same account and amount within ±7 days, preferring similar payee then nearest date.
    if (merge) {
      const candidates = db.all<Row>(
        `SELECT t.id, t.date, t.tombstone, t.imported_id, t.imported_payee, p.name AS payee_name
         FROM transactions t LEFT JOIN payees p ON p.id = t.payee
         WHERE t.account = ? AND t.amount = ? AND t.is_child = 0 AND t.date BETWEEN ? AND ?`,
        [accountId, t.amount, toDateInt(addDays(t.date, -7)), toDateInt(addDays(t.date, 7))],
      ).filter(c => !claimed.has(c.id) && (!c.imported_id || !t.imported_id || c.imported_id === t.imported_id));
      const target = toDateInt(t.date);
      candidates.sort((a, b) => {
        const s =
          Math.max(payeeSimilarity(b.payee_name, t.payee_name), payeeSimilarity(b.imported_payee, t.imported_payee)) -
          Math.max(payeeSimilarity(a.payee_name, t.payee_name), payeeSimilarity(a.imported_payee, t.imported_payee));
        return s !== 0 ? s : Math.abs(a.date - target) - Math.abs(b.date - target);
      });
      const live = candidates.find(c => !c.tombstone);
      if (live) {
        claimed.add(live.id);
        preview.push({ index, status: 'matched', matchedId: live.id, transaction: t });
        return;
      }
      // 4. Deleted transactions only come back when "reimport deleted" is on.
      if (candidates.some(c => c.tombstone) && !opts.reimportDeleted && t.imported_id) {
        preview.push({ index, status: 'skipped', reason: 'Previously deleted', transaction: t });
        return;
      }
    }
    preview.push({ index, status: 'new', transaction: t });
  });

  if (opts.dryRun) return { preview, added: [] as string[], updated: [] as string[] };

  const added: string[] = [];
  const updated: string[] = [];
  db.batch(() => {
    for (const row of preview) {
      const t = row.transaction;
      if (row.status === 'new') {
        const id = addTransaction(db, {
          account: accountId,
          date: t.date,
          amount: t.amount,
          payee: t.payee_name ? findOrCreatePayee(db, t.payee_name) : null,
          imported_payee: t.imported_payee ?? t.payee_name ?? null,
          notes: t.notes ?? null,
          category: t.category_name ? findCategoryByName(db, t.category_name) : null,
          imported_id: t.imported_id ?? null,
          cleared: true,
        });
        if (id) added.push(id);
      } else if (row.status === 'matched' && row.matchedId) {
        // 3. Imported data wins on date and imported fields; the user's payee, category and notes stay.
        const cur = db.first<Row>('SELECT * FROM transactions WHERE id = ?', [row.matchedId])!;
        updateTransaction(
          db,
          {
            id: row.matchedId,
            date: t.date,
            imported_id: t.imported_id ?? cur.imported_id ?? undefined,
            imported_payee: t.imported_payee ?? cur.imported_payee ?? undefined,
            cleared: true,
            notes: cur.notes ? undefined : t.notes ?? undefined,
            payee: cur.payee ? undefined : t.payee_name ? findOrCreatePayee(db, t.payee_name) : undefined,
          },
          { learn: false },
        );
        updated.push(row.matchedId);
      }
    }
  });
  return { preview, added, updated };
}
