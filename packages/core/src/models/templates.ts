// Budget templates: declarative lines in category notes that fill a month's budget.
//   #template 50                      fixed amount
//   #template 50 up to 300            fixed amount, capped balance
//   #template up to 150               refill balance to a cap
//   #template 500 by 2026-12 [spend from 2026-11] [repeat every year]
//   #template 10 repeat every 2 weeks starting 2026-01-04
//   #template 10% of Paycheck | of all income | of available funds | of previous Paycheck
//   #template schedule [full] Internet [increase 5%]
//   #template average 3 months [increase 20%]
//   #template copy from 12 months ago
//   #template remainder [weight]
//   #template-2 ...                   priority level (lower runs first)
//   #goal 500                         long-term balance goal (no budgeting)
//   #cleanup source | sink [weight]   end-of-month sweep
import type { BudgetDb, Row } from '../db';
import { addMonths, monthOf, monthRange, firstDay, lastDay } from '../util/dates';
import { getOccurrences, nextOccurrence, type RecurConfig } from '../util/recurrence';
import { getBudgetMonth, getBudgetType, writeBudgetCell, type MonthBudget } from './budget';

export type Template =
  | { type: 'simple'; priority: number; amount: number | null; limit: number | null; line: string }
  | { type: 'by'; priority: number; amount: number; month: string; from: string | null; repeat: { n: number; unit: 'month' | 'year' } | null; line: string }
  | { type: 'periodic'; priority: number; amount: number; n: number; unit: 'day' | 'week' | 'month' | 'year'; start: string; limit: number | null; line: string }
  | { type: 'percentage'; priority: number; percent: number; of: string; previous: boolean; line: string }
  | { type: 'schedule'; priority: number; name: string; full: boolean; increase: number; line: string }
  | { type: 'average'; priority: number; months: number; adjust: number; line: string }
  | { type: 'copy'; priority: number; monthsAgo: number; line: string }
  | { type: 'remainder'; priority: number; weight: number; line: string }
  | { type: 'goal'; priority: number; amount: number; line: string };

export interface Cleanup {
  role: 'source' | 'sink';
  weight: number;
}

const AMOUNT = String.raw`[-+]?[^\d\s-]?\s?\d[\d,]*(?:\.\d+)?`;

function parseAmountToken(s: string): number {
  return Math.round(parseFloat(s.replace(/[^\d.\-]/g, '')) * 100);
}

export function parseTemplateLine(line: string): Template | { error: string } | null {
  const trimmed = line.trim();
  const goal = trimmed.match(new RegExp(`^#goal\\s+(${AMOUNT})\\s*$`, 'i'));
  if (goal) return { type: 'goal', priority: 0, amount: parseAmountToken(goal[1]), line: trimmed };
  const m = trimmed.match(/^#template(?:-(\d+))?\s+(.*)$/i);
  if (!m) return trimmed.toLowerCase().startsWith('#template') ? { error: `Cannot parse: ${trimmed}` } : null;
  const priority = m[1] ? parseInt(m[1], 10) : 0;
  const body = m[2].trim();
  let r: RegExpMatchArray | null;

  if ((r = body.match(/^remainder(?:\s+(\d+(?:\.\d+)?))?$/i)))
    return { type: 'remainder', priority: Infinity, weight: r[1] ? parseFloat(r[1]) : 1, line: trimmed };
  if ((r = body.match(/^average\s+(\d+)\s+months?(?:\s+(increase|decrease)\s+(\d+(?:\.\d+)?)%)?$/i)))
    return {
      type: 'average',
      priority,
      months: parseInt(r[1], 10),
      adjust: r[2] ? (r[2].toLowerCase() === 'increase' ? 1 : -1) * parseFloat(r[3]) : 0,
      line: trimmed,
    };
  if ((r = body.match(/^copy from\s+(\d+)\s+months?\s+ago$/i)))
    return { type: 'copy', priority, monthsAgo: parseInt(r[1], 10), line: trimmed };
  if ((r = body.match(/^schedule\s+(full\s+)?(.+?)(?:\s+increase\s+(\d+(?:\.\d+)?)%)?$/i)))
    return { type: 'schedule', priority, full: !!r[1], name: r[2].trim(), increase: r[3] ? parseFloat(r[3]) : 0, line: trimmed };
  if ((r = body.match(/^(\d+(?:\.\d+)?)%\s+of\s+(previous\s+)?(.+)$/i)))
    return { type: 'percentage', priority, percent: parseFloat(r[1]), previous: !!r[2], of: r[3].trim(), line: trimmed };
  if ((r = body.match(new RegExp(`^up to\\s+(${AMOUNT})$`, 'i'))))
    return { type: 'simple', priority, amount: null, limit: parseAmountToken(r[1]), line: trimmed };
  if (
    (r = body.match(
      new RegExp(`^(${AMOUNT})\\s+by\\s+(\\d{4}-\\d{2})(?:\\s+spend from\\s+(\\d{4}-\\d{2}))?(?:\\s+repeat every\\s+(?:(\\d+)\\s+)?(months?|years?))?$`, 'i'),
    ))
  )
    return {
      type: 'by',
      priority,
      amount: parseAmountToken(r[1]),
      month: r[2],
      from: r[3] ?? null,
      repeat: r[5] ? { n: r[4] ? parseInt(r[4], 10) : 1, unit: r[5].toLowerCase().startsWith('year') ? 'year' : 'month' } : null,
      line: trimmed,
    };
  if (
    (r = body.match(
      new RegExp(`^(${AMOUNT})\\s+repeat every\\s+(?:(\\d+)\\s+)?(days?|weeks?|months?|years?)\\s+starting\\s+(\\d{4}-\\d{2}-\\d{2})(?:\\s+up to\\s+(${AMOUNT}))?$`, 'i'),
    ))
  )
    return {
      type: 'periodic',
      priority,
      amount: parseAmountToken(r[1]),
      n: r[2] ? parseInt(r[2], 10) : 1,
      unit: r[3].toLowerCase().replace(/s$/, '') as 'day',
      start: r[4],
      limit: r[5] ? parseAmountToken(r[5]) : null,
      line: trimmed,
    };
  if ((r = body.match(new RegExp(`^(${AMOUNT})(?:\\s+up to\\s+(${AMOUNT}))?$`, 'i'))))
    return { type: 'simple', priority, amount: parseAmountToken(r[1]), limit: r[2] ? parseAmountToken(r[2]) : null, line: trimmed };
  return { error: `Cannot parse: ${trimmed}` };
}

export function parseNotes(notes: string | null | undefined) {
  const templates: Template[] = [];
  const errors: string[] = [];
  let cleanup: Cleanup | null = null;
  for (const line of (notes ?? '').split('\n')) {
    const t = line.trim();
    const c = t.match(/^#cleanup\s+(source|sink)(?:\s+(\d+(?:\.\d+)?))?\s*$/i);
    if (c) {
      cleanup = { role: c[1].toLowerCase() as 'source' | 'sink', weight: c[2] ? parseFloat(c[2]) : 1 };
      continue;
    }
    if (t.toLowerCase().startsWith('#cleanup')) {
      errors.push(`Cannot parse: ${t}`);
      continue;
    }
    const parsed = parseTemplateLine(t);
    if (!parsed) continue;
    if ('error' in parsed) errors.push(parsed.error);
    else templates.push(parsed);
  }
  return { templates, errors, cleanup };
}

function categoryNotes(db: BudgetDb) {
  return db.all<Row>(
    `SELECT c.id, c.name, c.is_income, n.note FROM categories c LEFT JOIN notes n ON n.id = c.id AND n.tombstone = 0
     WHERE c.tombstone = 0`,
  );
}

export function checkTemplates(db: BudgetDb): { category: string; name: string; errors: string[] }[] {
  return categoryNotes(db)
    .map(c => ({ category: c.id, name: c.name, errors: parseNotes(c.note).errors }))
    .filter(r => r.errors.length);
}

function monthsBetween(a: string, b: string) {
  const [ay, am] = a.split('-').map(Number);
  const [by, bm] = b.split('-').map(Number);
  return (by - ay) * 12 + (bm - am);
}

interface Ctx {
  db: BudgetDb;
  month: string;
  mb: MonthBudget;
  categoriesByName: Map<string, Row>;
  available: number;
}

/** Amount (cents) a single template asks for, given the category's state this month. */
function desired(t: Template, catId: string, ctx: Ctx): number {
  const { db, month, mb } = ctx;
  const cat = mb.categories[catId];
  const carryIn = cat?.carryIn ?? 0;
  switch (t.type) {
    case 'simple': {
      if (t.amount === null) return Math.max(0, (t.limit ?? 0) - carryIn);
      return t.limit !== null ? Math.max(0, Math.min(t.amount, t.limit - carryIn)) : t.amount;
    }
    case 'by': {
      let target = t.month;
      if (t.repeat) {
        const step = t.repeat.unit === 'year' ? 12 * t.repeat.n : t.repeat.n;
        while (target < month) target = addMonths(target, step);
      }
      if (target < month) return 0;
      const remaining = monthsBetween(month, target) + 1;
      return Math.max(0, Math.ceil((t.amount - carryIn) / remaining));
    }
    case 'periodic': {
      const cfg: RecurConfig = {
        start: t.start,
        interval: t.n,
        frequency: ({ day: 'daily', week: 'weekly', month: 'monthly', year: 'yearly' } as const)[t.unit],
      };
      const n = getOccurrences(cfg, firstDay(month), lastDay(month)).length;
      const amt = t.amount * n;
      return t.limit !== null ? Math.max(0, Math.min(amt, t.limit - carryIn)) : amt;
    }
    case 'percentage': {
      const of = t.of.toLowerCase();
      if (of === 'available funds') return Math.round((Math.max(0, ctx.available) * t.percent) / 100);
      const src = t.previous ? getBudgetMonth(db, addMonths(month, -1)) : mb;
      if (of === 'all income') return Math.round((Math.max(0, src.income) * t.percent) / 100);
      const c = ctx.categoriesByName.get(of);
      if (!c) throw new Error(`Category not found: ${t.of}`);
      return Math.round((Math.max(0, src.categories[c.id]?.spent ?? 0) * t.percent) / 100);
    }
    case 'schedule': {
      const s = db.first<Row>(
        `SELECT s.*, r.conditions FROM schedules s JOIN rules r ON r.id = s.rule WHERE lower(s.name) = lower(?) AND s.tombstone = 0 AND s.completed = 0`,
        [t.name],
      );
      if (!s) throw new Error(`Schedule not found: ${t.name}`);
      const conds = JSON.parse(s.conditions);
      const amtCond = conds.find((c: any) => c.field === 'amount');
      const dateCond = conds.find((c: any) => c.field === 'date');
      let amount = amtCond ? (typeof amtCond.value === 'number' ? amtCond.value : Math.round((amtCond.value.num1 + amtCond.value.num2) / 2)) : 0;
      amount = Math.round(-amount * (1 + t.increase / 100));
      if (amount <= 0) return 0;
      const cfg = dateCond?.value as RecurConfig;
      if (t.full) {
        const n = typeof cfg === 'object' ? getOccurrences(cfg, firstDay(month), lastDay(month)).length : monthOf(String(cfg)) === month ? 1 : 0;
        return amount * n;
      }
      const next = typeof cfg === 'object' ? nextOccurrence(cfg, firstDay(month)) : String(cfg);
      if (!next) return 0;
      const remaining = monthsBetween(month, monthOf(next)) + 1;
      return Math.max(0, Math.ceil((amount - carryIn) / Math.max(1, remaining)));
    }
    case 'average': {
      let total = 0;
      for (let i = 1; i <= t.months; i++) total += getBudgetMonth(db, addMonths(month, -i)).categories[catId]?.spent ?? 0;
      const avg = -total / t.months;
      return Math.max(0, Math.round(avg * (1 + t.adjust / 100)));
    }
    case 'copy':
      return getBudgetMonth(db, addMonths(month, -t.monthsAgo)).categories[catId]?.budgeted ?? 0;
    case 'remainder':
    case 'goal':
      return 0;
  }
}

export interface TemplateResult {
  amounts: Record<string, number>;
  goals: Record<string, { target: number | null; longGoal: number | null }>;
  errors: string[];
}

/** Compute (and unless dryRun, apply) template amounts for a month. */
export function runTemplates(db: BudgetDb, month: string, opts: { dryRun?: boolean; category?: string } = {}): TemplateResult {
  const mb = getBudgetMonth(db, month);
  const rows = categoryNotes(db);
  const categoriesByName = new Map(rows.map(r => [String(r.name).toLowerCase(), r]));
  const parsed = rows
    .filter(r => !r.is_income)
    .map(r => ({ id: r.id, ...parseNotes(r.note) }))
    .filter(r => r.templates.length && (!opts.category || r.id === opts.category));

  const errors: string[] = [];
  const goals: TemplateResult['goals'] = {};
  const amounts: Record<string, number> = {};

  // Funds available for templated categories: To Budget plus what they already hold this month.
  let available = mb.toBudget;
  for (const p of parsed) {
    if (p.templates.some(t => t.type !== 'goal')) available += mb.categories[p.id]?.budgeted ?? 0;
  }
  const ctx: Ctx = { db, month, mb, categoriesByName, available };

  const priorities = Array.from(new Set(parsed.flatMap(p => p.templates.filter(t => t.type !== 'goal' && t.type !== 'remainder').map(t => t.priority)))).sort(
    (a, b) => a - b,
  );
  for (const p of parsed) {
    const longGoal = p.templates.find(t => t.type === 'goal') as Extract<Template, { type: 'goal' }> | undefined;
    goals[p.id] = { target: null, longGoal: longGoal?.amount ?? null };
    if (p.templates.some(t => t.type !== 'goal')) amounts[p.id] = 0;
  }

  for (const prio of priorities) {
    const asks: { id: string; amount: number }[] = [];
    for (const p of parsed) {
      for (const t of p.templates.filter(t => t.priority === prio && t.type !== 'goal' && t.type !== 'remainder')) {
        try {
          asks.push({ id: p.id, amount: desired(t, p.id, { ...ctx, available }) });
        } catch (e: any) {
          errors.push(`${rows.find(r => r.id === p.id)?.name}: ${e.message}`);
        }
      }
    }
    const total = asks.reduce((s, a) => s + a.amount, 0);
    const scale = total > available && total > 0 ? Math.max(0, available) / total : 1;
    for (const a of asks) {
      const got = Math.floor(a.amount * scale);
      amounts[a.id] = (amounts[a.id] ?? 0) + got;
      goals[a.id].target = (goals[a.id].target ?? 0) + a.amount;
      available -= got;
    }
  }

  const remainders = parsed.flatMap(p =>
    p.templates.filter((t): t is Extract<Template, { type: 'remainder' }> => t.type === 'remainder').map(t => ({ id: p.id, weight: t.weight })),
  );
  const totalWeight = remainders.reduce((s, r) => s + r.weight, 0);
  if (available > 0 && totalWeight > 0) {
    let left = available;
    remainders.forEach((r, i) => {
      const share = i === remainders.length - 1 ? left : Math.floor((available * r.weight) / totalWeight);
      amounts[r.id] = (amounts[r.id] ?? 0) + share;
      left -= share;
    });
    available = 0;
  }

  if (!opts.dryRun) {
    db.batch(() => {
      for (const [id, amt] of Object.entries(amounts)) {
        if ((mb.categories[id]?.budgeted ?? 0) !== amt) writeBudgetCell(db, month, id, amt, mb.categories[id]?.carryover ?? false);
      }
    });
  }
  return { amounts, goals, errors };
}

/** End-of-month cleanup: sweep positive balances out of sources, then share To Budget across sinks by weight. */
export function runCleanup(db: BudgetDb, month: string) {
  if (getBudgetType(db) !== 'envelope') return;
  db.batch(() => {
    const mb = getBudgetMonth(db, month);
    const rows = categoryNotes(db).filter(r => !r.is_income);
    const roles = rows.map(r => ({ id: r.id, cleanup: parseNotes(r.note).cleanup })).filter(r => r.cleanup);
    let pool = mb.toBudget;
    const newBudget: Record<string, number> = {};
    for (const r of roles.filter(r => r.cleanup!.role === 'source')) {
      const bal = mb.categories[r.id]?.balance ?? 0;
      if (bal > 0) {
        newBudget[r.id] = (mb.categories[r.id]?.budgeted ?? 0) - bal;
        pool += bal;
      }
    }
    const sinks = roles.filter(r => r.cleanup!.role === 'sink');
    const totalWeight = sinks.reduce((s, r) => s + r.cleanup!.weight, 0);
    if (pool > 0 && totalWeight > 0) {
      let left = pool;
      sinks.forEach((r, i) => {
        const share = i === sinks.length - 1 ? left : Math.floor((pool * r.cleanup!.weight) / totalWeight);
        newBudget[r.id] = (newBudget[r.id] ?? mb.categories[r.id]?.budgeted ?? 0) + share;
        left -= share;
      });
    }
    for (const [id, amt] of Object.entries(newBudget)) writeBudgetCell(db, month, id, amt, mb.categories[id]?.carryover ?? false);
  });
}

export function goalStatus(balance: number, budgeted: number, goal: { target: number | null; longGoal: number | null } | undefined) {
  if (!goal) return null;
  if (balance < 0) return 'overspent';
  if (goal.longGoal !== null) return balance >= goal.longGoal ? 'funded' : 'underfunded';
  if (goal.target !== null) return budgeted >= goal.target ? 'funded' : 'underfunded';
  return null;
}

export { monthRange };
