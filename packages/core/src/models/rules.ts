// Rule engine: stage (pre / default / post) + all-or-any conditions + actions.
// Rules run on every new or imported transaction, and on demand.
import type { BudgetDb, Row } from '../db';
import { addDays, diffDays } from '../util/dates';
import { getOccurrences, isRecurConfig, type RecurConfig } from '../util/recurrence';

export type ConditionField =
  | 'account'
  | 'payee'
  | 'category'
  | 'date'
  | 'notes'
  | 'amount'
  | 'imported_payee'
  | 'cleared'
  | 'reconciled'
  | 'transfer'
  | 'saved';

export type ConditionOp =
  | 'is'
  | 'isNot'
  | 'oneOf'
  | 'notOneOf'
  | 'contains'
  | 'doesNotContain'
  | 'matches'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'isapprox'
  | 'isbetween'
  | 'hasTags'
  | 'onBudget'
  | 'offBudget';

export interface Condition {
  field: ConditionField;
  op: ConditionOp;
  value: any;
  options?: { inflow?: boolean; outflow?: boolean };
}

export type Action =
  | { op: 'set'; field: string; value: any }
  | { op: 'prepend-notes'; value: string }
  | { op: 'append-notes'; value: string }
  | { op: 'link-schedule'; value: string }
  | { op: 'delete-transaction'; value?: null };

export interface Rule {
  id: string;
  stage: 'pre' | null | 'post';
  conditionsOp: 'and' | 'or';
  conditions: Condition[];
  actions: Action[];
  description?: string | null;
}

/** The shape rules see: dates as strings, booleans for flags, plus context for budget ops. */
export interface RuleTxn {
  id?: string;
  account?: string | null;
  payee?: string | null;
  category?: string | null;
  date?: string;
  notes?: string | null;
  amount?: number;
  imported_payee?: string | null;
  cleared?: boolean;
  reconciled?: boolean;
  transfer_id?: string | null;
  schedule?: string | null;
  tombstone?: boolean;
  [key: string]: any;
}

export const FIELD_TYPES: Record<ConditionField, 'id' | 'string' | 'number' | 'date' | 'boolean'> = {
  account: 'id',
  payee: 'id',
  category: 'id',
  date: 'date',
  notes: 'string',
  amount: 'number',
  imported_payee: 'string',
  cleared: 'boolean',
  reconciled: 'boolean',
  transfer: 'boolean',
  saved: 'boolean',
};

export const OPS_BY_TYPE: Record<string, ConditionOp[]> = {
  id: ['is', 'isNot', 'oneOf', 'notOneOf'],
  string: ['is', 'isNot', 'contains', 'doesNotContain', 'oneOf', 'notOneOf', 'matches', 'hasTags'],
  number: ['is', 'isapprox', 'isbetween', 'gt', 'gte', 'lt', 'lte'],
  date: ['is', 'isapprox', 'gt', 'gte', 'lt', 'lte'],
  boolean: ['is'],
};

export function toRule(r: Row): Rule {
  return {
    id: r.id,
    stage: r.stage === 'pre' || r.stage === 'post' ? r.stage : null,
    conditionsOp: r.conditions_op === 'or' ? 'or' : 'and',
    conditions: JSON.parse(r.conditions || '[]'),
    actions: JSON.parse(r.actions || '[]'),
    description: r.description ?? null,
  };
}

function lower(v: unknown) {
  return typeof v === 'string' ? v.toLowerCase() : v == null ? '' : String(v).toLowerCase();
}

export interface MatchContext {
  accountOffbudget?: (id: string) => boolean;
}

export function conditionMatches(cond: Condition, txn: RuleTxn, ctx: MatchContext = {}): boolean {
  const { field, op, value } = cond;
  if (field === 'account' && (op === 'onBudget' || op === 'offBudget')) {
    if (!txn.account || !ctx.accountOffbudget) return false;
    const off = ctx.accountOffbudget(txn.account);
    return op === 'offBudget' ? off : !off;
  }
  let actual: any = field === 'transfer' ? !!txn.transfer_id : field === 'saved' ? !!txn.id : txn[field];
  const type = FIELD_TYPES[field];

  if (type === 'number' && typeof actual === 'number') {
    if (cond.options?.inflow) {
      if (actual <= 0) return false;
    } else if (cond.options?.outflow) {
      if (actual >= 0) return false;
      actual = -actual;
    }
  }

  switch (type) {
    case 'boolean':
      return !!actual === !!value;
    case 'number': {
      if (typeof actual !== 'number') return false;
      switch (op) {
        case 'is':
          return actual === value;
        case 'isapprox': {
          const v = Number(value);
          const tol = Math.round(Math.abs(v) * 0.075);
          return actual >= v - tol && actual <= v + tol;
        }
        case 'isbetween': {
          const lo = Math.min(value.num1, value.num2);
          const hi = Math.max(value.num1, value.num2);
          return actual >= lo && actual <= hi;
        }
        case 'gt':
          return actual > value;
        case 'gte':
          return actual >= value;
        case 'lt':
          return actual < value;
        case 'lte':
          return actual <= value;
      }
      return false;
    }
    case 'date': {
      if (!actual) return false;
      if (isRecurConfig(value)) {
        if (op !== 'isapprox' && op !== 'is') return false;
        const margin = op === 'isapprox' ? 2 : 0;
        return getOccurrences(value as RecurConfig, addDays(actual, -margin), addDays(actual, margin), 1).length > 0;
      }
      switch (op) {
        case 'is':
          return actual === value;
        case 'isapprox':
          return Math.abs(diffDays(actual, value)) <= 2;
        case 'gt':
          return actual > value;
        case 'gte':
          return actual >= value;
        case 'lt':
          return actual < value;
        case 'lte':
          return actual <= value;
      }
      return false;
    }
    case 'id': {
      switch (op) {
        case 'is':
          return (actual ?? null) === (value ?? null);
        case 'isNot':
          return (actual ?? null) !== (value ?? null);
        case 'oneOf':
          return Array.isArray(value) && value.includes(actual);
        case 'notOneOf':
          return !Array.isArray(value) || !value.includes(actual);
      }
      return false;
    }
    case 'string': {
      const a = lower(actual);
      switch (op) {
        case 'is':
          return a === lower(value);
        case 'isNot':
          return a !== lower(value);
        case 'contains':
          return a.includes(lower(value));
        case 'doesNotContain':
          return !a.includes(lower(value));
        case 'oneOf':
          return Array.isArray(value) && value.some(v => lower(v) === a);
        case 'notOneOf':
          return !Array.isArray(value) || !value.some(v => lower(v) === a);
        case 'matches':
          try {
            return new RegExp(String(value), 'i').test(String(actual ?? ''));
          } catch {
            return false;
          }
        case 'hasTags': {
          const wanted = String(value)
            .split(/\s+/)
            .filter(Boolean)
            .map(t => t.replace(/^#?/, '#').toLowerCase());
          const tags = extractTags(String(actual ?? ''));
          return wanted.every(t => tags.includes(t));
        }
      }
      return false;
    }
  }
}

export function extractTags(notes: string): string[] {
  return Array.from(notes.matchAll(/(^|\s)(#[\p{L}\p{N}_-]+)/gu), m => m[2].toLowerCase());
}

export function ruleMatches(rule: Pick<Rule, 'conditions' | 'conditionsOp'>, txn: RuleTxn, ctx?: MatchContext): boolean {
  if (rule.conditions.length === 0) return false;
  return rule.conditionsOp === 'or'
    ? rule.conditions.some(c => conditionMatches(c, txn, ctx))
    : rule.conditions.every(c => conditionMatches(c, txn, ctx));
}

export function applyActions(actions: Action[], txn: RuleTxn): RuleTxn {
  const out = { ...txn };
  for (const a of actions) {
    switch (a.op) {
      case 'set':
        if (a.field === 'date' && !a.value) break;
        out[a.field] = a.value;
        break;
      case 'prepend-notes':
        out.notes = out.notes ? `${a.value}${out.notes}` : a.value;
        break;
      case 'append-notes':
        out.notes = out.notes ? `${out.notes}${a.value}` : a.value;
        break;
      case 'link-schedule':
        out.schedule = a.value;
        break;
      case 'delete-transaction':
        out.tombstone = true;
        break;
    }
  }
  return out;
}

// More specific conditions rank higher, so `payee is X` beats `notes contains Y`.
const OP_SCORES: Partial<Record<ConditionOp, number>> = {
  is: 10,
  isNot: 1,
  oneOf: 9,
  notOneOf: 1,
  isapprox: 5,
  isbetween: 5,
  contains: 3,
  doesNotContain: 1,
  matches: 2,
  hasTags: 2,
  gt: 1,
  gte: 1,
  lt: 1,
  lte: 1,
};

function score(rule: Rule): number {
  const s = rule.conditions.reduce((sum, c) => sum + (OP_SCORES[c.op] ?? 0), 0);
  return rule.conditions.every(c => c.op === 'is' || c.op === 'isNot') ? s * 2 : s;
}

const STAGE_ORDER = { pre: 0, null: 1, post: 2 } as const;

export function rankRules(rules: Rule[]): Rule[] {
  return [...rules].sort((a, b) => {
    const sa = STAGE_ORDER[String(a.stage) as keyof typeof STAGE_ORDER];
    const sb = STAGE_ORDER[String(b.stage) as keyof typeof STAGE_ORDER];
    if (sa !== sb) return sa - sb;
    const d = score(a) - score(b);
    return d !== 0 ? d : a.id < b.id ? -1 : 1;
  });
}

/** Run every rule in rank order; later rules see earlier rules' changes. */
export function runRules(rules: Rule[], txn: RuleTxn, ctx?: MatchContext): RuleTxn {
  let current = { ...txn };
  for (const rule of rankRules(rules)) {
    if (ruleMatches(rule, current, ctx)) current = applyActions(rule.actions, current);
  }
  return current;
}

// ---------- persistence ----------

export function getRules(db: BudgetDb): Rule[] {
  return db.all('SELECT * FROM rules WHERE tombstone = 0').map(toRule);
}

export function getRule(db: BudgetDb, id: string): Rule | null {
  const r = db.first('SELECT * FROM rules WHERE id = ? AND tombstone = 0', [id]);
  return r ? toRule(r) : null;
}

export function validateRule(rule: Partial<Rule>): string[] {
  const errors: string[] = [];
  if (!rule.conditions?.length) errors.push('Add at least one condition');
  if (!rule.actions?.length) errors.push('Add at least one action');
  for (const c of rule.conditions ?? []) {
    const type = FIELD_TYPES[c.field];
    if (!type) errors.push(`Unknown field: ${c.field}`);
    else if (!(c.field === 'account' && (c.op === 'onBudget' || c.op === 'offBudget')) && !OPS_BY_TYPE[type].includes(c.op))
      errors.push(`"${c.op}" is not valid for ${c.field}`);
    if (c.op === 'matches') {
      try {
        new RegExp(String(c.value));
      } catch {
        errors.push(`Invalid regular expression: ${c.value}`);
      }
    }
    if ((c.op === 'oneOf' || c.op === 'notOneOf') && !Array.isArray(c.value)) errors.push(`${c.field}: "${c.op}" needs a list`);
  }
  return errors;
}

export function createRule(db: BudgetDb, rule: Omit<Rule, 'id'> & { id?: string }): string {
  const errors = validateRule(rule);
  if (errors.length) throw new Error(errors.join('; '));
  return db.insert('rules', {
    id: rule.id,
    stage: rule.stage,
    conditions_op: rule.conditionsOp,
    conditions: JSON.stringify(rule.conditions),
    actions: JSON.stringify(rule.actions),
    description: rule.description ?? null,
  });
}

export function updateRule(db: BudgetDb, rule: Rule) {
  const errors = validateRule(rule);
  if (errors.length) throw new Error(errors.join('; '));
  db.update('rules', {
    id: rule.id,
    stage: rule.stage,
    conditions_op: rule.conditionsOp,
    conditions: JSON.stringify(rule.conditions),
    actions: JSON.stringify(rule.actions),
    description: rule.description ?? null,
  });
}

export function deleteRules(db: BudgetDb, ids: string[]) {
  db.batch(() => {
    for (const id of ids) {
      if (db.first('SELECT 1 FROM schedules WHERE rule = ? AND tombstone = 0', [id])) continue;
      db.delete('rules', id);
    }
  });
}

/** The simple "payee is X → set category Y" rule the app learns from the user. */
export function findPayeeCategoryRule(db: BudgetDb, payeeId: string): Rule | null {
  return (
    getRules(db).find(
      r =>
        r.stage === null &&
        r.conditions.length === 1 &&
        r.conditions[0].field === 'payee' &&
        r.conditions[0].op === 'is' &&
        r.conditions[0].value === payeeId &&
        r.actions.length === 1 &&
        r.actions[0].op === 'set' &&
        r.actions[0].field === 'category',
    ) ?? null
  );
}

export function getPayeeRules(db: BudgetDb, payeeId: string): Rule[] {
  return getRules(db).filter(r =>
    r.conditions.some(c => c.field === 'payee' && (c.value === payeeId || (Array.isArray(c.value) && c.value.includes(payeeId)))),
  );
}
