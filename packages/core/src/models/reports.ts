import type { BudgetDb, Row } from '../db';
import { addDays, addMonths, daysInMonth, diffDays, fromDateInt, monthRange, toDateInt } from '../util/dates';
import { ruleMatches, type Condition } from './rules';
import { accountCtx, toRuleTxn } from './transactions';

const monthInt = (m: string) => parseInt(m.replace('-', ''), 10);

/** Assets, debts and net worth at each month end. */
export function netWorth(db: BudgetDb, args: { start: string; end: string; accounts?: string[] }) {
  const accounts = db.all<Row>('SELECT id, name FROM accounts WHERE tombstone = 0');
  const ids = new Set(args.accounts?.length ? args.accounts : accounts.map(a => a.id));
  const startInt = toDateInt(`${args.start}-01`);
  const balances = new Map<string, number>();
  for (const r of db.all<Row>(
    'SELECT account, SUM(amount) s FROM transactions WHERE tombstone = 0 AND is_parent = 0 AND date < ? GROUP BY account',
    [startInt],
  )) {
    balances.set(r.account, r.s);
  }
  const monthly = new Map<string, number>();
  for (const r of db.all<Row>(
    'SELECT account, date / 100 m, SUM(amount) s FROM transactions WHERE tombstone = 0 AND is_parent = 0 AND date >= ? GROUP BY account, m',
    [startInt],
  )) {
    monthly.set(`${r.account}:${r.m}`, r.s);
  }
  return monthRange(args.start, args.end).map(month => {
    let assets = 0;
    let debts = 0;
    for (const a of accounts) {
      if (!ids.has(a.id)) continue;
      const b = (balances.get(a.id) ?? 0) + (monthly.get(`${a.id}:${monthInt(month)}`) ?? 0);
      balances.set(a.id, b);
      if (b >= 0) assets += b;
      else debts += b;
    }
    return { month, assets, debts, networth: assets + debts };
  });
}

/** Income vs expenses per month for on-budget accounts, with a running balance. */
export function cashFlow(db: BudgetDb, args: { start: string; end: string; includeTransfers?: boolean }) {
  const rows = db.all<Row>(
    `SELECT t.date / 100 m, t.amount, t.transfer_id, ta.offbudget AS other_off
     FROM transactions t JOIN accounts a ON a.id = t.account
     LEFT JOIN transactions tt ON tt.id = t.transfer_id LEFT JOIN accounts ta ON ta.id = tt.account
     WHERE t.tombstone = 0 AND t.is_parent = 0 AND a.offbudget = 0 AND a.tombstone = 0 AND t.date BETWEEN ? AND ?`,
    [toDateInt(`${args.start}-01`), toDateInt(`${args.end}-31`)],
  );
  const start = db.first<{ s: number }>(
    `SELECT COALESCE(SUM(t.amount),0) s FROM transactions t JOIN accounts a ON a.id = t.account
     WHERE t.tombstone = 0 AND t.is_parent = 0 AND a.offbudget = 0 AND a.tombstone = 0 AND t.date < ?`,
    [toDateInt(`${args.start}-01`)],
  )?.s ?? 0;
  const by = new Map<number, { income: number; expenses: number; transfers: number }>();
  for (const r of rows) {
    const e = by.get(r.m) ?? { income: 0, expenses: 0, transfers: 0 };
    const isInternal = r.transfer_id && r.other_off === 0;
    if (r.transfer_id && (isInternal || !args.includeTransfers)) {
      e.transfers += r.amount;
    } else if (r.amount > 0) e.income += r.amount;
    else e.expenses += r.amount;
    by.set(r.m, e);
  }
  let balance = start;
  return monthRange(args.start, args.end).map(month => {
    const e = by.get(monthInt(month)) ?? { income: 0, expenses: 0, transfers: 0 };
    balance += e.income + e.expenses + e.transfers;
    return { month, income: e.income, expenses: e.expenses, net: e.income + e.expenses, balance };
  });
}

export type GroupBy = 'category' | 'group' | 'payee' | 'account' | 'interval';
export type Interval = 'total' | 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface CustomReportArgs {
  start: string; // YYYY-MM-DD
  end: string;
  groupBy: GroupBy;
  interval: Interval;
  type: 'expense' | 'income' | 'net';
  filter?: { conditionsOp: 'and' | 'or'; conditions: Condition[] };
  showHidden?: boolean;
  showOffbudget?: boolean;
  showUncategorized?: boolean;
  showEmpty?: boolean;
  excludeCategories?: string[];
}

function periodKey(date: number, interval: Interval): string {
  const d = fromDateInt(date);
  switch (interval) {
    case 'daily':
      return d;
    case 'weekly': {
      const dt = new Date(d + 'T00:00:00Z');
      return addDays(d, -dt.getUTCDay());
    }
    case 'monthly':
      return d.slice(0, 7);
    case 'yearly':
      return d.slice(0, 4);
    default:
      return 'total';
  }
}

export function periods(start: string, end: string, interval: Interval): string[] {
  if (interval === 'total') return ['total'];
  if (interval === 'monthly') return monthRange(start.slice(0, 7), end.slice(0, 7));
  if (interval === 'yearly') {
    const out = [];
    for (let y = +start.slice(0, 4); y <= +end.slice(0, 4); y++) out.push(String(y));
    return out;
  }
  const out: string[] = [];
  const step = interval === 'weekly' ? 7 : 1;
  let d = interval === 'weekly' ? periodKey(toDateInt(start), 'weekly') : start;
  for (let i = 0; d <= end && i < 1000; i++, d = addDays(d, step)) out.push(d);
  return out;
}

function reportRows(db: BudgetDb, args: CustomReportArgs) {
  const rows = db.all<Row>(
    `SELECT t.*, a.offbudget, a.name AS account_name, c.name AS category_name, c.hidden AS category_hidden, c.is_income,
       g.id AS group_id, g.name AS group_name, g.hidden AS group_hidden, p.name AS payee_name, p.transfer_acct
     FROM transactions t JOIN accounts a ON a.id = t.account
     LEFT JOIN categories c ON c.id = t.category LEFT JOIN category_groups g ON g.id = c.cat_group
     LEFT JOIN payees p ON p.id = t.payee
     WHERE t.tombstone = 0 AND t.is_parent = 0 AND a.tombstone = 0 AND t.date BETWEEN ? AND ?`,
    [toDateInt(args.start), toDateInt(args.end)],
  );
  const ctx = accountCtx(db);
  const excluded = new Set(args.excludeCategories ?? []);
  return rows.filter(r => {
    if (!args.showOffbudget && r.offbudget) return false;
    // Transfers between on-budget accounts aren't income or spending.
    if (r.transfer_id && !r.category) return false;
    if (!r.category && !args.showUncategorized) return false;
    if (!args.showHidden && (r.category_hidden || r.group_hidden)) return false;
    if (r.category && excluded.has(r.category)) return false;
    if (args.type === 'expense' && (r.amount >= 0 || r.is_income)) return false;
    if (args.type === 'income' && r.amount <= 0 && !r.is_income) return false;
    if (args.filter?.conditions.length && !ruleMatches(args.filter, toRuleTxn(r), ctx)) return false;
    return true;
  });
}

function groupKey(r: Row, groupBy: GroupBy): [string, string] {
  switch (groupBy) {
    case 'category':
      return [r.category ?? 'uncategorized', r.category_name ?? (r.offbudget ? 'Off budget' : 'Uncategorized')];
    case 'group':
      return [r.group_id ?? 'uncategorized', r.group_name ?? 'Uncategorized'];
    case 'payee':
      return [r.payee ?? 'none', r.payee_name || (r.transfer_acct ? 'Transfer' : 'No payee')];
    case 'account':
      return [r.account, r.account_name];
    case 'interval':
      return ['all', 'All'];
  }
}

export function customReport(db: BudgetDb, args: CustomReportArgs) {
  const ps = periods(args.start, args.end, args.interval);
  const groups = new Map<string, { id: string; name: string; total: number; values: Record<string, number> }>();
  const totals: Record<string, number> = Object.fromEntries(ps.map(p => [p, 0]));
  for (const r of reportRows(db, args)) {
    const [id, name] = groupKey(r, args.groupBy);
    const g = groups.get(id) ?? { id, name, total: 0, values: Object.fromEntries(ps.map(p => [p, 0])) };
    const p = periodKey(r.date, args.interval);
    const amount = args.type === 'expense' ? -r.amount : r.amount;
    g.values[p] = (g.values[p] ?? 0) + amount;
    g.total += amount;
    totals[p] = (totals[p] ?? 0) + amount;
    groups.set(id, g);
  }
  if (args.showEmpty && args.groupBy === 'category') {
    for (const c of db.all<Row>('SELECT id, name, hidden FROM categories WHERE tombstone = 0 AND is_income = ?', [args.type === 'income' ? 1 : 0])) {
      if (!groups.has(c.id) && (args.showHidden || !c.hidden))
        groups.set(c.id, { id: c.id, name: c.name, total: 0, values: Object.fromEntries(ps.map(p => [p, 0])) });
    }
  }
  const rows = [...groups.values()].sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
  const grand = rows.reduce((s, r) => s + r.total, 0);
  return { periods: ps, rows, totals, total: grand, average: ps.length ? Math.round(grand / ps.length) : 0 };
}

/** Transactions behind one bar / cell of a custom report. */
export function reportDrilldown(db: BudgetDb, args: CustomReportArgs & { groupId?: string; period?: string }) {
  return reportRows(db, args)
    .filter(r => (args.groupId ? groupKey(r, args.groupBy)[0] === args.groupId : true))
    .filter(r => (args.period && args.period !== 'total' ? periodKey(r.date, args.interval) === args.period : true))
    .map(r => r.id as string);
}

/** Cumulative spending by day: this month vs last month and the 3-month average, plus the budgeted total. */
export function spendingAnalysis(db: BudgetDb, month: string) {
  const dayTotals = (m: string) => {
    const arr = new Array(31).fill(0);
    for (const r of db.all<Row>(
      `SELECT t.date % 100 d, SUM(t.amount) s FROM transactions t JOIN accounts a ON a.id = t.account
       LEFT JOIN categories c ON c.id = t.category
       WHERE t.tombstone = 0 AND t.is_parent = 0 AND a.offbudget = 0 AND t.category IS NOT NULL AND c.is_income = 0
       AND t.date / 100 = ? GROUP BY d`,
      [monthInt(m)],
    ))
      arr[r.d - 1] = -r.s;
    let run = 0;
    return arr.map(v => (run += v));
  };
  const cur = dayTotals(month);
  const last = dayTotals(addMonths(month, -1));
  const avgParts = [1, 2, 3].map(i => dayTotals(addMonths(month, -i)));
  const days = daysInMonth(month);
  const budgeted =
    db.first<{ s: number }>('SELECT COALESCE(SUM(b.amount),0) s FROM zero_budgets b JOIN categories c ON c.id = b.category WHERE b.month = ? AND b.tombstone = 0 AND c.is_income = 0 AND c.tombstone = 0', [
      monthInt(month),
    ])?.s ?? 0;
  const todayStr = new Date().toISOString().slice(0, 10);
  return Array.from({ length: days }, (_, i) => {
    const date = `${month}-${String(i + 1).padStart(2, '0')}`;
    return {
      day: i + 1,
      current: date <= todayStr ? cur[i] : null,
      lastMonth: last[i],
      average: Math.round(avgParts.reduce((s, a) => s + a[i], 0) / 3),
      budgeted,
    };
  });
}

/** Daily income and expenses for a month. */
export function calendar(db: BudgetDb, month: string) {
  const out = Array.from({ length: daysInMonth(month) }, (_, i) => ({ date: `${month}-${String(i + 1).padStart(2, '0')}`, income: 0, expenses: 0 }));
  for (const r of db.all<Row>(
    `SELECT t.date % 100 d, t.amount FROM transactions t JOIN accounts a ON a.id = t.account
     LEFT JOIN transactions tt ON tt.id = t.transfer_id LEFT JOIN accounts ta ON ta.id = tt.account
     WHERE t.tombstone = 0 AND t.is_parent = 0 AND a.offbudget = 0 AND t.date / 100 = ? AND (t.transfer_id IS NULL OR ta.offbudget = 1)`,
    [monthInt(month)],
  )) {
    if (r.amount > 0) out[r.d - 1].income += r.amount;
    else out[r.d - 1].expenses += r.amount;
  }
  return out;
}

/**
 * Age of money: spend inflows first-in first-out; each outflow's age is how
 * many days old the money it consumed was. Reported per month as the average
 * over that month's last 10 outflows.
 */
export function ageOfMoney(db: BudgetDb, args: { start: string; end: string }) {
  const rows = db.all<Row>(
    `SELECT t.date, t.amount FROM transactions t JOIN accounts a ON a.id = t.account
     LEFT JOIN transactions tt ON tt.id = t.transfer_id LEFT JOIN accounts ta ON ta.id = tt.account
     WHERE t.tombstone = 0 AND t.is_parent = 0 AND a.offbudget = 0 AND a.tombstone = 0
     AND (t.transfer_id IS NULL OR ta.offbudget = 1)
     ORDER BY t.date, t.amount DESC`,
  );
  const queue: { date: string; left: number }[] = [];
  const ages: { date: string; age: number }[] = [];
  for (const r of rows) {
    const date = fromDateInt(r.date);
    if (r.amount > 0) {
      queue.push({ date, left: r.amount });
      continue;
    }
    let need = -r.amount;
    let weighted = 0;
    let used = 0;
    while (need > 0 && queue.length) {
      const head = queue[0];
      const take = Math.min(head.left, need);
      weighted += take * diffDays(date, head.date);
      used += take;
      head.left -= take;
      need -= take;
      if (head.left === 0) queue.shift();
    }
    if (used > 0) ages.push({ date, age: weighted / used });
  }
  return monthRange(args.start, args.end).map(month => {
    const until = `${month}-31`;
    const last = ages.filter(a => a.date <= until).slice(-10);
    return { month, age: last.length ? Math.round(last.reduce((s, a) => s + a.age, 0) / last.length) : null };
  });
}
