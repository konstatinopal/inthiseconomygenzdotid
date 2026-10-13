import type { BudgetDb, Row } from '../db';
import type { CategoryEntity, CategoryGroupEntity } from './types';
import { rewriteRuleRefs } from './payees';

export function toCategory(r: Row): CategoryEntity {
  return {
    id: r.id,
    name: r.name,
    group: r.cat_group,
    is_income: !!r.is_income,
    hidden: !!r.hidden,
    sort_order: r.sort_order,
  };
}

export function getCategoryGroups(db: BudgetDb): CategoryGroupEntity[] {
  const groups = db.all('SELECT * FROM category_groups WHERE tombstone = 0 ORDER BY is_income, sort_order, id');
  const cats = db.all('SELECT * FROM categories WHERE tombstone = 0 ORDER BY sort_order, id');
  return groups.map(g => ({
    id: g.id,
    name: g.name,
    is_income: !!g.is_income,
    hidden: !!g.hidden,
    sort_order: g.sort_order,
    categories: cats.filter(c => c.cat_group === g.id).map(toCategory),
  }));
}

export function getCategories(db: BudgetDb): CategoryEntity[] {
  return getCategoryGroups(db).flatMap(g => g.categories);
}

function nextSortOrder(db: BudgetDb, table: string, where = '1', params: any[] = []) {
  const r = db.first<{ m: number | null }>(`SELECT MAX(sort_order) m FROM ${table} WHERE tombstone = 0 AND ${where}`, params);
  return (r?.m ?? 0) + 16384;
}

export function createGroup(db: BudgetDb, g: { name: string; is_income?: boolean; hidden?: boolean }): string {
  return db.insert('category_groups', {
    name: g.name.trim(),
    is_income: g.is_income ? 1 : 0,
    hidden: g.hidden ? 1 : 0,
    sort_order: nextSortOrder(db, 'category_groups'),
  });
}

export function updateGroup(db: BudgetDb, g: { id: string; name?: string; hidden?: boolean }) {
  db.update('category_groups', {
    id: g.id,
    name: g.name?.trim(),
    hidden: g.hidden === undefined ? undefined : g.hidden ? 1 : 0,
  });
}

export function createCategory(
  db: BudgetDb,
  c: { name: string; group: string; is_income?: boolean; hidden?: boolean; id?: string },
): string {
  const group = db.first('SELECT * FROM category_groups WHERE id = ? AND tombstone = 0', [c.group]);
  if (!group) throw new Error('Category group not found');
  const exists = db.first(
    'SELECT id FROM categories WHERE lower(name) = lower(?) AND cat_group = ? AND tombstone = 0',
    [c.name.trim(), c.group],
  );
  if (exists) throw new Error('A category with that name already exists in this group');
  return db.insert('categories', {
    id: c.id,
    name: c.name.trim(),
    cat_group: c.group,
    is_income: group.is_income,
    hidden: c.hidden ? 1 : 0,
    sort_order: nextSortOrder(db, 'categories', 'cat_group = ?', [c.group]),
  });
}

export function updateCategory(db: BudgetDb, c: { id: string; name?: string; hidden?: boolean }) {
  db.update('categories', {
    id: c.id,
    name: c.name?.trim(),
    hidden: c.hidden === undefined ? undefined : c.hidden ? 1 : 0,
  });
}

/** Move a category before `targetId` (or to the end) of `groupId`. */
export function moveCategory(db: BudgetDb, id: string, groupId: string, targetId: string | null) {
  db.batch(() => {
    const cats = db.all<{ id: string; sort_order: number }>('SELECT id, sort_order FROM categories WHERE cat_group = ? AND tombstone = 0 AND id != ? ORDER BY sort_order', [groupId, id]);
    const group = db.first('SELECT is_income FROM category_groups WHERE id = ?', [groupId]);
    const sort = sortBefore(cats, targetId);
    db.update('categories', { id, cat_group: groupId, sort_order: sort, is_income: group?.is_income ?? 0 });
  });
}

export function moveGroup(db: BudgetDb, id: string, targetId: string | null) {
  const g = db.first('SELECT is_income FROM category_groups WHERE id = ?', [id]);
  const groups = db.all<{ id: string; sort_order: number }>('SELECT id, sort_order FROM category_groups WHERE tombstone = 0 AND id != ? AND is_income = ? ORDER BY sort_order', [id, g?.is_income ?? 0]);
  db.update('category_groups', { id, sort_order: sortBefore(groups, targetId) });
}

export function sortBefore(items: { id: string; sort_order: number }[], targetId: string | null): number {
  if (!targetId) return (items.at(-1)?.sort_order ?? 0) + 16384;
  const idx = items.findIndex(i => i.id === targetId);
  if (idx === -1) return (items.at(-1)?.sort_order ?? 0) + 16384;
  const after = items[idx].sort_order;
  const before = idx > 0 ? items[idx - 1].sort_order : after - 32768;
  return (before + after) / 2;
}

/**
 * Delete a category. Transactions and budgeted amounts move to `transferId`
 * (required when the category has transactions), merging its history.
 */
export function deleteCategory(db: BudgetDb, id: string, transferId: string | null) {
  db.batch(() => {
    const used = db.first('SELECT 1 FROM transactions WHERE category = ? AND tombstone = 0 LIMIT 1', [id]);
    if (used && !transferId) throw new Error('This category has transactions; choose a category to transfer them to');
    if (transferId) {
      for (const t of db.all<{ id: string }>('SELECT id FROM transactions WHERE category = ? AND tombstone = 0', [id])) {
        db.update('transactions', { id: t.id, category: transferId });
      }
      for (const b of db.all<Row>('SELECT * FROM zero_budgets WHERE category = ? AND tombstone = 0', [id])) {
        const targetKey = `${b.month}-${transferId}`;
        const target = db.first<Row>('SELECT amount FROM zero_budgets WHERE id = ? AND tombstone = 0', [targetKey]);
        db.upsert('zero_budgets', {
          id: targetKey,
          month: b.month,
          category: transferId,
          amount: (target?.amount ?? 0) + b.amount,
        });
        db.delete('zero_budgets', b.id);
      }
    }
    rewriteRuleRefs(db, 'category', new Set([id]), transferId);
    db.delete('categories', id);
  });
}

export function deleteGroup(db: BudgetDb, id: string, transferId: string | null) {
  db.batch(() => {
    for (const c of db.all<{ id: string }>('SELECT id FROM categories WHERE cat_group = ? AND tombstone = 0', [id])) {
      deleteCategory(db, c.id, transferId);
    }
    db.delete('category_groups', id);
  });
}

export function findCategoryByName(db: BudgetDb, name: string): string | null {
  return db.first<{ id: string }>('SELECT id FROM categories WHERE lower(name) = lower(?) AND tombstone = 0', [name.trim()])?.id ?? null;
}
