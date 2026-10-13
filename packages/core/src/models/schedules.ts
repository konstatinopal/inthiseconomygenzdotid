// Schedules are named recurring transactions backed by a rule whose
// conditions (payee, account, amount, recurring date) match the real
// transactions and whose `link-schedule` action ties them to the schedule.
import type { BudgetDb, Row } from '../db';
import { addDays, diffDays, fromDateInt, toDateInt, today } from '../util/dates';
import { describeRecurrence, getOccurrences, isRecurConfig, nextOccurrence, type RecurConfig } from '../util/recurrence';
import { createRule, toRule, type Condition } from './rules';
import { setScheduleLinkedHook } from './schedule-hooks';
import { addTransaction } from './transactions';

export type AmountOp = 'is' | 'isapprox' | 'isbetween';
export type ScheduleStatus = 'completed' | 'missed' | 'due' | 'upcoming' | 'paid' | 'scheduled';

export interface ScheduleInput {
  name?: string | null;
  payee?: string | null;
  account?: string | null;
  amount: number | { num1: number; num2: number };
  amountOp: AmountOp;
  date: RecurConfig | string;
  posts_transaction?: boolean;
  custom_upcoming_length?: number | null;
}

export interface ScheduleEntity {
  id: string;
  name: string | null;
  rule: string;
  next_date: string | null;
  completed: boolean;
  posts_transaction: boolean;
  custom_upcoming_length: number | null;
  payee: string | null;
  account: string | null;
  amount: number | { num1: number; num2: number };
  amountOp: AmountOp;
  date: RecurConfig | string;
  description: string;
  status: ScheduleStatus;
  lastPaid: string | null;
}

function scheduleAmount(s: Pick<ScheduleEntity, 'amount'>): number {
  return typeof s.amount === 'number' ? s.amount : Math.round((s.amount.num1 + s.amount.num2) / 2);
}

function buildConditions(input: ScheduleInput): Condition[] {
  const conds: Condition[] = [];
  if (input.payee) conds.push({ field: 'payee', op: 'is', value: input.payee });
  if (input.account) conds.push({ field: 'account', op: 'is', value: input.account });
  conds.push({ field: 'amount', op: input.amountOp, value: input.amount });
  conds.push({ field: 'date', op: isRecurConfig(input.date) ? 'isapprox' : 'is', value: input.date });
  return conds;
}

function firstNextDate(date: RecurConfig | string, from = today()): string | null {
  if (!isRecurConfig(date)) return date;
  return nextOccurrence(date, from < date.start ? date.start : from);
}

export function upcomingLength(db: BudgetDb): number {
  const r = db.first<{ value: string }>("SELECT value FROM preferences WHERE id = 'upcomingScheduledTransactionLength' AND tombstone = 0");
  const v = r ? Number(JSON.parse(r.value)) : 7;
  return isFinite(v) ? v : 7;
}

export function getSchedules(db: BudgetDb): ScheduleEntity[] {
  const rows = db.all<Row>(
    `SELECT s.*, r.conditions, r.actions,
       (SELECT MAX(t.date) FROM transactions t WHERE t.schedule = s.id AND t.tombstone = 0) AS last_paid
     FROM schedules s JOIN rules r ON r.id = s.rule
     WHERE s.tombstone = 0
     ORDER BY s.completed, s.next_date, s.name`,
  );
  const t = today();
  const window = upcomingLength(db);
  return rows.map(r => {
    const conds: Condition[] = JSON.parse(r.conditions);
    const get = (f: string) => conds.find(c => c.field === f);
    const amt = get('amount');
    const date = get('date')?.value ?? t;
    const next = r.next_date ? fromDateInt(r.next_date) : null;
    const lastPaid = r.last_paid ? fromDateInt(r.last_paid) : null;
    const days = r.custom_upcoming_length ?? window;
    let status: ScheduleStatus;
    if (r.completed || !next) status = 'completed';
    else if (next < t) status = r.posts_transaction ? 'due' : 'missed';
    else if (next === t) status = 'due';
    else if (lastPaid && diffDays(t, lastPaid) <= 7 && lastPaid <= t) status = 'paid';
    else if (diffDays(next, t) <= days) status = 'upcoming';
    else status = 'scheduled';
    return {
      id: r.id,
      name: r.name,
      rule: r.rule,
      next_date: next,
      completed: !!r.completed,
      posts_transaction: !!r.posts_transaction,
      custom_upcoming_length: r.custom_upcoming_length ?? null,
      payee: (get('payee')?.value as string) ?? null,
      account: (get('account')?.value as string) ?? null,
      amount: amt?.value ?? 0,
      amountOp: (amt?.op as AmountOp) ?? 'is',
      date,
      description: isRecurConfig(date) ? describeRecurrence(date) : `Once on ${date}`,
      status,
      lastPaid,
    };
  });
}

export function getSchedule(db: BudgetDb, id: string): ScheduleEntity | null {
  return getSchedules(db).find(s => s.id === id) ?? null;
}

export function createSchedule(db: BudgetDb, input: ScheduleInput): string {
  return db.batch(() => {
    if (input.name) {
      const dup = db.first('SELECT 1 FROM schedules WHERE lower(name) = lower(?) AND tombstone = 0', [input.name]);
      if (dup) throw new Error('A schedule with this name already exists');
    }
    const id = globalThis.crypto.randomUUID();
    const ruleId = createRule(db, {
      stage: null,
      conditionsOp: 'and',
      conditions: buildConditions(input),
      actions: [{ op: 'link-schedule', value: id }],
    });
    const next = firstNextDate(input.date);
    db.insert('schedules', {
      id,
      name: input.name || null,
      rule: ruleId,
      next_date: next ? toDateInt(next) : null,
      completed: next ? 0 : 1,
      posts_transaction: input.posts_transaction ? 1 : 0,
      custom_upcoming_length: input.custom_upcoming_length ?? null,
    });
    return id;
  });
}

export function updateSchedule(db: BudgetDb, id: string, input: Partial<ScheduleInput>) {
  db.batch(() => {
    const cur = getSchedule(db, id);
    if (!cur) throw new Error('Schedule not found');
    const merged: ScheduleInput = {
      name: input.name !== undefined ? input.name : cur.name,
      payee: input.payee !== undefined ? input.payee : cur.payee,
      account: input.account !== undefined ? input.account : cur.account,
      amount: input.amount ?? cur.amount,
      amountOp: input.amountOp ?? cur.amountOp,
      date: input.date ?? cur.date,
      posts_transaction: input.posts_transaction ?? cur.posts_transaction,
      custom_upcoming_length: input.custom_upcoming_length !== undefined ? input.custom_upcoming_length : cur.custom_upcoming_length,
    };
    const rule = toRule(db.first<Row>('SELECT * FROM rules WHERE id = ?', [cur.rule])!);
    db.update('rules', { id: rule.id, conditions: JSON.stringify(buildConditions(merged)) });
    const fields: Row = {
      id,
      name: merged.name || null,
      posts_transaction: merged.posts_transaction ? 1 : 0,
      custom_upcoming_length: merged.custom_upcoming_length ?? null,
    };
    if (input.date) {
      const next = firstNextDate(merged.date);
      fields.next_date = next ? toDateInt(next) : null;
      fields.completed = next ? 0 : 1;
    }
    db.update('schedules', fields);
  });
}

export function deleteSchedule(db: BudgetDb, id: string) {
  db.batch(() => {
    const s = db.first<Row>('SELECT * FROM schedules WHERE id = ?', [id]);
    if (!s) return;
    for (const t of db.all<{ id: string }>('SELECT id FROM transactions WHERE schedule = ? AND tombstone = 0', [id])) {
      db.update('transactions', { id: t.id, schedule: null });
    }
    db.delete('rules', s.rule);
    db.delete('schedules', id);
  });
}

function advance(db: BudgetDb, s: ScheduleEntity, after: string) {
  const next = isRecurConfig(s.date) ? nextOccurrence(s.date, addDays(after, 1)) : null;
  db.update('schedules', { id: s.id, next_date: next ? toDateInt(next) : null, completed: next ? 0 : 1 });
}

setScheduleLinkedHook((db, scheduleId, date) => {
  const s = getSchedule(db, scheduleId);
  if (!s || s.completed || !s.next_date) return;
  // A payment a couple of days early still counts for the upcoming occurrence;
  // an old transaction (e.g. imported history) never moves next_date backwards.
  if (date < addDays(s.next_date, -7)) return;
  advance(db, s, date > s.next_date ? date : s.next_date);
});

export function skipNextDate(db: BudgetDb, id: string) {
  const s = getSchedule(db, id);
  if (!s?.next_date) return;
  advance(db, s, s.next_date);
}

export function postTransactionForSchedule(db: BudgetDb, id: string, date?: string): string | null {
  return db.batch(() => {
    const s = getSchedule(db, id);
    if (!s) throw new Error('Schedule not found');
    if (!s.account) throw new Error('This schedule has no account');
    return addTransaction(db, {
      account: s.account,
      payee: s.payee,
      amount: scheduleAmount(s),
      date: date ?? s.next_date ?? today(),
      schedule: s.id,
      notes: null,
    });
  });
}

export function setScheduleCompleted(db: BudgetDb, id: string, completed: boolean) {
  db.batch(() => {
    if (completed) {
      db.update('schedules', { id, completed: 1 });
    } else {
      const s = getSchedule(db, id);
      if (!s) return;
      const next = firstNextDate(s.date);
      db.update('schedules', { id, completed: next ? 0 : 1, next_date: next ? toDateInt(next) : null });
    }
  });
}

/** Post every auto-add schedule that has come due. Returns how many transactions were created. */
export function autoPostSchedules(db: BudgetDb): number {
  let posted = 0;
  const t = today();
  db.batch(() => {
    for (const s of getSchedules(db)) {
      if (!s.posts_transaction || s.completed || !s.account) continue;
      let guard = 0;
      let cur: ScheduleEntity | null = s;
      while (cur && !cur.completed && cur.next_date && cur.next_date <= t && guard++ < 100) {
        const before: string = cur.next_date;
        postTransactionForSchedule(db, cur.id, before);
        posted++;
        cur = getSchedule(db, s.id);
        if (cur?.next_date === before) break;
      }
    }
  });
  return posted;
}

/** Preview transactions for schedules due within the look-ahead window (shown atop the register). */
export function getUpcomingPreview(db: BudgetDb, accountId?: string | null) {
  const t = today();
  const window = upcomingLength(db);
  const out: Row[] = [];
  for (const s of getSchedules(db)) {
    if (s.completed || !s.next_date || !s.account) continue;
    if (accountId && accountId !== 'onbudget' && accountId !== 'offbudget' && s.account !== accountId) continue;
    const limit = addDays(t, s.custom_upcoming_length ?? window);
    const dates = isRecurConfig(s.date) ? getOccurrences(s.date, s.next_date, limit, 10) : s.next_date <= limit ? [s.next_date] : [];
    if (s.next_date < t && !dates.includes(s.next_date)) dates.unshift(s.next_date);
    for (const d of dates) {
      out.push({
        id: `preview/${s.id}/${d}`,
        account: s.account,
        payee: s.payee,
        amount: scheduleAmount(s),
        date: d,
        schedule: s.id,
        scheduleName: s.name,
        status: d < t ? 'missed' : d === t ? 'due' : 'upcoming',
        is_preview: true,
      });
    }
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : -1));
}

/** Suggest schedules from monthly-recurring payee + amount pairs that aren't scheduled yet. */
export function discoverSchedules(db: BudgetDb) {
  const since = toDateInt(addDays(today(), -200));
  const rows = db.all<Row>(
    `SELECT t.payee, t.account, t.amount, t.date FROM transactions t JOIN payees p ON p.id = t.payee
     WHERE t.tombstone = 0 AND t.is_child = 0 AND t.schedule IS NULL AND t.date >= ? AND p.transfer_acct IS NULL
     ORDER BY t.date`,
    [since],
  );
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const k = `${r.payee}|${r.account}|${r.amount}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const out: { payee: string; account: string; amount: number; date: RecurConfig; occurrences: number }[] = [];
  for (const list of groups.values()) {
    if (list.length < 3) continue;
    const days = list.map(r => parseInt(String(r.date).slice(6, 8), 10));
    const spread = Math.max(...days) - Math.min(...days);
    const months = new Set(list.map(r => String(r.date).slice(0, 6)));
    if (spread > 4 || months.size !== list.length) continue;
    const last = fromDateInt(list.at(-1)!.date);
    out.push({
      payee: list[0].payee,
      account: list[0].account,
      amount: list[0].amount,
      date: { start: last, interval: 1, frequency: 'monthly', endMode: 'never' },
      occurrences: list.length,
    });
  }
  return out;
}

/** Turn a future-dated transaction into a one-off schedule. */
export function scheduleFromTransaction(db: BudgetDb, txnId: string): string {
  return db.batch(() => {
    const t = db.first<Row>('SELECT * FROM transactions WHERE id = ? AND tombstone = 0', [txnId]);
    if (!t) throw new Error('Transaction not found');
    const id = createSchedule(db, {
      payee: t.payee,
      account: t.account,
      amount: t.amount,
      amountOp: 'is',
      date: fromDateInt(t.date),
    });
    db.delete('transactions', t.id);
    return id;
  });
}
