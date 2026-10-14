// Envelope and tracking budget math. Derived values (spent, balance,
// carryover, To Budget) are computed for every month in one pass from
// grouped SQL aggregates and cached until a relevant table changes.
import type { BudgetDb, Row } from '../db';
import { addMonths, fromDateInt, fromMonthInt, monthRange, toMonthInt } from '../util/dates';
import { currentPeriod, normalizeStartDay, periodOf } from '../util/periods';

export type BudgetType = 'envelope' | 'tracking';

export interface CategoryBudget {
  budgeted: number;
  spent: number;
  balance: number;
  carryIn: number;
  carryover: boolean;
}

export interface GroupBudget {
  budgeted: number;
  spent: number;
  balance: number;
}

export interface MonthBudget {
  month: string;
  type: BudgetType;
  categories: Record<string, CategoryBudget>;
  groups: Record<string, GroupBudget>;
  // envelope summary
  income: number;
  fromLastMonth: number;
  availableFunds: number;
  lastMonthOverspent: number;
  totalBudgeted: number;
  buffered: number;
  toBudget: number;
  totalSpent: number;
  totalBalance: number;
  // tracking summary
  plannedIncome: number;
  plannedExpenses: number;
  saved: number;
}

const RELEVANT = new Set([
  'transactions',
  'zero_budgets',
  'reflect_budgets',
  'zero_budget_months',
  'categories',
  'category_groups',
  'accounts',
  'preferences',
]);

interface Sheet {
  months: Map<string, MonthBudget>;
  start: string;
  end: string;
}

const cache = new WeakMap<BudgetDb, Sheet | null>();
const subscribed = new WeakSet<BudgetDb>();

function ensureSubscribed(db: BudgetDb) {
  if (subscribed.has(db)) return;
  subscribed.add(db);
  db.onWrite(table => {
    if (RELEVANT.has(table)) cache.set(db, null);
  });
}

export function invalidateBudget(db: BudgetDb) {
  cache.set(db, null);
}

export function getBudgetType(db: BudgetDb): BudgetType {
  const r = db.first<{ value: string }>("SELECT value FROM preferences WHERE id = 'budgetType' AND tombstone = 0");
  return r && JSON.parse(r.value) === 'tracking' ? 'tracking' : 'envelope';
}

function budgetTable(type: BudgetType) {
  return type === 'tracking' ? 'reflect_budgets' : 'zero_budgets';
}

/** Day of the month budget periods start on (1 = calendar months). A synced preference. */
export function getMonthStartDay(db: BudgetDb): number {
  const r = db.first<{ value: string }>("SELECT value FROM preferences WHERE id = 'monthStartDay' AND tombstone = 0");
  try {
    return normalizeStartDay(r ? JSON.parse(r.value) : 1);
  } catch {
    return 1;
  }
}

export function getBudgetBounds(db: BudgetDb): { start: string; end: string } {
  const startDay = getMonthStartDay(db);
  const cur = currentPeriod(startDay);
  const t = db.first<{ lo: number | null; hi: number | null }>(
    'SELECT MIN(date) lo, MAX(date) hi FROM transactions WHERE tombstone = 0 AND date > 0',
  );
  const b = db.first<{ lo: number | null; hi: number | null }>(
    `SELECT MIN(month) lo, MAX(month) hi FROM (SELECT month FROM zero_budgets WHERE tombstone = 0 AND month > 0 UNION ALL SELECT month FROM reflect_budgets WHERE tombstone = 0 AND month > 0)`,
  );
  let start = cur;
  let end = addMonths(cur, 12);
  if (t?.lo) start = [start, periodOf(fromDateInt(t.lo), startDay)].sort()[0];
  if (b?.lo) start = [start, fromMonthInt(b.lo)].sort()[0];
  if (t?.hi) end = [end, periodOf(fromDateInt(t.hi), startDay)].sort()[1];
  if (b?.hi) end = [end, fromMonthInt(b.hi)].sort()[1];
  return { start, end };
}

function computeSheet(db: BudgetDb): Sheet {
  const type = getBudgetType(db);
  const { start, end } = getBudgetBounds(db);
  const months = monthRange(start, end);
  const cats = db.all<Row>(
    `SELECT c.id, c.cat_group, c.is_income FROM categories c JOIN category_groups g ON g.id = c.cat_group
     WHERE c.tombstone = 0 AND g.tombstone = 0`,
  );

  // Spending per (period, category). Grouping by calendar month and by whether
  // the day is on/after the start day is enough to place every row in its period.
  const startDay = getMonthStartDay(db);
  const spent = new Map<string, number>();
  for (const r of db.all<Row>(
    `SELECT t.category, t.date / 100 AS m, (t.date % 100) >= ? AS late, SUM(t.amount) AS s
     FROM transactions t JOIN accounts a ON a.id = t.account
     WHERE t.tombstone = 0 AND t.is_parent = 0 AND a.tombstone = 0 AND a.offbudget = 0 AND t.category IS NOT NULL
     GROUP BY t.category, m, late`,
    [startDay],
  )) {
    const day = startDay === 1 || r.late ? String(Math.max(startDay, 1)).padStart(2, '0') : '01';
    const period = toMonthInt(periodOf(`${fromMonthInt(r.m)}-${day}`, startDay));
    const key = `${period}:${r.category}`;
    spent.set(key, (spent.get(key) ?? 0) + r.s);
  }

  const budgets = new Map<string, { amount: number; carryover: number }>();
  for (const r of db.all<Row>(`SELECT month, category, amount, carryover FROM ${budgetTable(type)} WHERE tombstone = 0`)) {
    budgets.set(`${r.month}:${r.category}`, { amount: r.amount ?? 0, carryover: r.carryover ?? 0 });
  }
  const buffered = new Map<number, number>();
  if (type === 'envelope') {
    for (const r of db.all<Row>('SELECT id, buffered FROM zero_budget_months WHERE tombstone = 0')) {
      buffered.set(toMonthInt(r.id), r.buffered ?? 0);
    }
  }

  const out = new Map<string, MonthBudget>();
  let prev: MonthBudget | null = null;
  for (const month of months) {
    const mi = toMonthInt(month);
    const mb: MonthBudget = {
      month,
      type,
      categories: {},
      groups: {},
      income: 0,
      fromLastMonth: 0,
      availableFunds: 0,
      lastMonthOverspent: 0,
      totalBudgeted: 0,
      buffered: buffered.get(mi) ?? 0,
      toBudget: 0,
      totalSpent: 0,
      totalBalance: 0,
      plannedIncome: 0,
      plannedExpenses: 0,
      saved: 0,
    };
    for (const c of cats) {
      const key = `${mi}:${c.id}`;
      const s = spent.get(key) ?? 0;
      const b = budgets.get(key);
      const prevCat = prev?.categories[c.id];
      // Carryover flags inherit from the previous month until set explicitly.
      const carryover = b ? !!b.carryover : !!prevCat?.carryover;
      const budgeted = b?.amount ?? 0;
      let carryIn = 0;
      if (c.is_income) {
        mb.income += s;
        mb.plannedIncome += budgeted;
        const cb: CategoryBudget = { budgeted, spent: s, balance: type === 'tracking' ? s - budgeted : s, carryIn: 0, carryover };
        mb.categories[c.id] = cb;
      } else {
        if (prevCat) {
          if (type === 'envelope') {
            if (prevCat.balance < 0 && !prevCat.carryover) mb.lastMonthOverspent += prevCat.balance;
            else carryIn = prevCat.balance;
          } else if (prevCat.carryover) {
            carryIn = prevCat.balance;
          }
        }
        const balance = carryIn + budgeted + s;
        mb.categories[c.id] = { budgeted, spent: s, balance, carryIn, carryover };
        mb.totalBudgeted += budgeted;
        mb.plannedExpenses += budgeted;
        mb.totalSpent += s;
        mb.totalBalance += balance;
      }
      const g = (mb.groups[c.cat_group] ??= { budgeted: 0, spent: 0, balance: 0 });
      g.budgeted += budgeted;
      g.spent += s;
      g.balance += mb.categories[c.id].balance;
    }
    if (type === 'envelope') {
      mb.fromLastMonth = prev ? prev.toBudget + prev.buffered : 0;
      mb.availableFunds = mb.income + mb.fromLastMonth;
      mb.toBudget = mb.availableFunds + mb.lastMonthOverspent - mb.totalBudgeted - mb.buffered;
    } else {
      mb.saved = mb.income + mb.totalSpent;
    }
    out.set(month, mb);
    prev = mb;
  }
  return { months: out, start, end };
}

function sheet(db: BudgetDb): Sheet {
  ensureSubscribed(db);
  let s = cache.get(db);
  if (!s) {
    s = computeSheet(db);
    cache.set(db, s);
  }
  return s;
}

export function getBudgetMonth(db: BudgetDb, month: string): MonthBudget {
  const s = sheet(db);
  const found = s.months.get(month);
  if (found) return found;
  // Outside the bounds: nothing budgeted or spent. Before the start everything
  // is zero; after the end, positive (or rolled-over) balances carry forward.
  const ref = s.months.get(month < s.start ? s.start : s.end)!;
  const after = month > s.end;
  const empty: MonthBudget = {
    ...ref,
    month,
    categories: {},
    groups: {},
    income: 0,
    fromLastMonth: after ? ref.toBudget + ref.buffered : 0,
    availableFunds: after ? ref.toBudget + ref.buffered : 0,
    lastMonthOverspent: 0,
    totalBudgeted: 0,
    buffered: 0,
    toBudget: after ? ref.toBudget + ref.buffered : 0,
    totalSpent: 0,
    totalBalance: 0,
    plannedIncome: 0,
    plannedExpenses: 0,
    saved: 0,
  };
  for (const [id, c] of Object.entries(ref.categories)) {
    const carry = after && (c.balance > 0 || c.carryover) ? c.balance : 0;
    empty.categories[id] = { budgeted: 0, spent: 0, balance: carry, carryIn: carry, carryover: c.carryover };
    empty.totalBalance += carry;
  }
  for (const id of Object.keys(ref.groups)) empty.groups[id] = { budgeted: 0, spent: 0, balance: 0 };
  return empty;
}

export function getBudgetMonths(db: BudgetDb): string[] {
  return [...sheet(db).months.keys()];
}

// ---------- mutations ----------

function cellId(month: string, category: string) {
  return `${toMonthInt(month)}-${category}`;
}

export function setBudget(db: BudgetDb, month: string, category: string, amount: number) {
  const inherited = getBudgetMonth(db, month).categories[category]?.carryover ?? false;
  writeBudgetCell(db, month, category, amount, inherited);
}

/** Write one budget cell; `inheritedCarryover` is used only when the cell doesn't exist yet. */
export function writeBudgetCell(db: BudgetDb, month: string, category: string, amount: number, inheritedCarryover: boolean) {
  const table = budgetTable(getBudgetType(db));
  const id = cellId(month, category);
  const existing = db.first(`SELECT id FROM ${table} WHERE id = ? AND tombstone = 0`, [id]);
  if (existing) db.update(table, { id, amount: Math.round(amount) });
  else db.insert(table, { id, month: toMonthInt(month), category, amount: Math.round(amount), carryover: inheritedCarryover ? 1 : 0 });
}

/** Set the rollover flag for this month and every later month. */
export function setCarryover(db: BudgetDb, month: string, category: string, flag: boolean) {
  db.batch(() => {
    const type = getBudgetType(db);
    const table = budgetTable(type);
    const id = cellId(month, category);
    const cur = db.first<Row>(`SELECT * FROM ${table} WHERE id = ? AND tombstone = 0`, [id]);
    if (cur) db.update(table, { id, carryover: flag ? 1 : 0 });
    else db.insert(table, { id, month: toMonthInt(month), category, amount: 0, carryover: flag ? 1 : 0 });
    for (const r of db.all<Row>(`SELECT id FROM ${table} WHERE category = ? AND month > ? AND tombstone = 0`, [category, toMonthInt(month)])) {
      db.update(table, { id: r.id, carryover: flag ? 1 : 0 });
    }
  });
}

/** Move money between categories; a null side means To Budget. */
export function transferBudget(db: BudgetDb, month: string, from: string | null, to: string | null, amount: number) {
  db.batch(() => {
    const mb = getBudgetMonth(db, month);
    if (from) setBudget(db, month, from, (mb.categories[from]?.budgeted ?? 0) - amount);
    if (to) setBudget(db, month, to, (mb.categories[to]?.budgeted ?? 0) + amount);
  });
}

export function coverOverspending(db: BudgetDb, month: string, to: string, from: string | null) {
  const bal = getBudgetMonth(db, month).categories[to]?.balance ?? 0;
  if (bal >= 0) return;
  transferBudget(db, month, from, to, -bal);
}

export function holdForNextMonth(db: BudgetDb, month: string, amount: number) {
  const mb = getBudgetMonth(db, month);
  const max = Math.max(0, mb.toBudget + mb.buffered);
  const value = Math.max(0, Math.min(amount, max));
  db.upsert('zero_budget_months', { id: month, buffered: value });
}

export function resetHold(db: BudgetDb, month: string) {
  db.upsert('zero_budget_months', { id: month, buffered: 0 });
}

function expenseCategories(db: BudgetDb): string[] {
  return db
    .all<{ id: string }>('SELECT c.id FROM categories c WHERE c.tombstone = 0 AND c.is_income = 0')
    .map(r => r.id);
}

function averageSpent(db: BudgetDb, month: string, category: string, n: number) {
  let total = 0;
  for (let i = 1; i <= n; i++) total += getBudgetMonth(db, addMonths(month, -i)).categories[category]?.spent ?? 0;
  return Math.round(-total / n);
}

export type CategoryBudgetAction = 'copy-last' | 'set-zero' | 'avg-3' | 'avg-6' | 'avg-12';

export function budgetActionForCategory(db: BudgetDb, month: string, category: string, action: CategoryBudgetAction) {
  switch (action) {
    case 'copy-last':
      return setBudget(db, month, category, getBudgetMonth(db, addMonths(month, -1)).categories[category]?.budgeted ?? 0);
    case 'set-zero':
      return setBudget(db, month, category, 0);
    case 'avg-3':
      return setBudget(db, month, category, averageSpent(db, month, category, 3));
    case 'avg-6':
      return setBudget(db, month, category, averageSpent(db, month, category, 6));
    case 'avg-12':
      return setBudget(db, month, category, averageSpent(db, month, category, 12));
  }
}

export function budgetActionForMonth(db: BudgetDb, month: string, action: CategoryBudgetAction) {
  db.batch(() => {
    // Read every value before writing: each write invalidates the cached sheet.
    const prev = getBudgetMonth(db, addMonths(month, -1));
    const values = expenseCategories(db).map(c => {
      switch (action) {
        case 'copy-last':
          return [c, prev.categories[c]?.budgeted ?? 0] as const;
        case 'set-zero':
          return [c, 0] as const;
        default:
          return [c, averageSpent(db, month, c, parseInt(action.split('-')[1], 10))] as const;
      }
    });
    const current = getBudgetMonth(db, month);
    const carry = Object.fromEntries(values.map(([c]) => [c, current.categories[c]?.carryover ?? false]));
    for (const [c, v] of values) {
      if ((current.categories[c]?.budgeted ?? 0) !== v) writeBudgetCell(db, month, c, v, carry[c]);
    }
  });
}

export function setBudgetType(db: BudgetDb, type: BudgetType) {
  db.upsert('preferences', { id: 'budgetType', value: JSON.stringify(type) });
}
