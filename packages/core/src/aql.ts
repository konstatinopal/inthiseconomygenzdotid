// ActualQL-style query builder. Compiles to SQL over synced tables, hiding
// tombstoned rows and controlling how split transactions are expanded.
//
//   q('transactions').filter({ account: id, date: { $gte: 20260101 } })
//     .groupBy('category').select(['category', { total: { $sum: '$amount' } }])
import type { SqlValue } from 'sql.js';
import { SYNCED_SCHEMA } from './db/schema';
import type { BudgetDb, Row } from './db';

type Filter = Record<string, any>;
type SelectItem = string | Record<string, { $sum?: string; $count?: string; $min?: string; $max?: string }>;

export interface QueryState {
  table: string;
  filterExpressions: Filter[];
  selectExpressions: SelectItem[];
  groupExpressions: string[];
  orderExpressions: (string | Record<string, 'asc' | 'desc'>)[];
  limit: number | null;
  offset: number | null;
  splits: 'inline' | 'grouped' | 'all' | 'none';
  calculation: boolean;
}

export class Query {
  constructor(readonly state: QueryState) {}

  private with(patch: Partial<QueryState>) {
    return new Query({ ...this.state, ...patch });
  }

  filter(expr: Filter) {
    return this.with({ filterExpressions: [...this.state.filterExpressions, expr] });
  }
  select(exprs: SelectItem | SelectItem[] = '*') {
    return this.with({ selectExpressions: Array.isArray(exprs) ? exprs : [exprs] });
  }
  calculate(expr: SelectItem) {
    return this.with({ selectExpressions: [{ result: (expr as any) }], calculation: true });
  }
  groupBy(exprs: string | string[]) {
    return this.with({ groupExpressions: [...this.state.groupExpressions, ...(Array.isArray(exprs) ? exprs : [exprs])] });
  }
  orderBy(exprs: string | Record<string, 'asc' | 'desc'> | (string | Record<string, 'asc' | 'desc'>)[]) {
    return this.with({ orderExpressions: [...this.state.orderExpressions, ...(Array.isArray(exprs) ? exprs : [exprs])] });
  }
  limit(n: number) {
    return this.with({ limit: n });
  }
  offset(n: number) {
    return this.with({ offset: n });
  }
  options(opts: { splits?: QueryState['splits'] }) {
    return this.with({ splits: opts.splits ?? this.state.splits });
  }
  serialize() {
    return this.state;
  }
}

export function q(table: string) {
  return new Query({
    table,
    filterExpressions: [],
    selectExpressions: ['*'],
    groupExpressions: [],
    orderExpressions: [],
    limit: null,
    offset: null,
    splits: 'inline',
    calculation: false,
  });
}

function column(table: string, name: string): string {
  const cols = SYNCED_SCHEMA[table];
  if (name !== 'id' && !(name in cols)) throw new Error(`AQL: unknown field ${table}.${name}`);
  return name;
}

function ref(table: string, v: string) {
  return column(table, v.startsWith('$') ? v.slice(1) : v);
}

function compileFilter(table: string, f: Filter, params: SqlValue[]): string {
  const parts: string[] = [];
  for (const [key, cond] of Object.entries(f)) {
    if (key === '$and' || key === '$or') {
      const subs = (cond as Filter[]).map(c => `(${compileFilter(table, c, params)})`);
      if (subs.length) parts.push(`(${subs.join(key === '$and' ? ' AND ' : ' OR ')})`);
      continue;
    }
    const col = column(table, key);
    const ops: Record<string, any> =
      cond !== null && typeof cond === 'object' && !Array.isArray(cond) ? cond : { $eq: cond };
    for (const [op, val] of Object.entries(ops)) {
      switch (op) {
        case '$eq':
          if (val === null) parts.push(`${col} IS NULL`);
          else {
            parts.push(`${col} = ?`);
            params.push(val);
          }
          break;
        case '$ne':
          if (val === null) parts.push(`${col} IS NOT NULL`);
          else {
            parts.push(`(${col} IS NULL OR ${col} != ?)`);
            params.push(val);
          }
          break;
        case '$gt':
        case '$gte':
        case '$lt':
        case '$lte': {
          const sym = { $gt: '>', $gte: '>=', $lt: '<', $lte: '<=' }[op];
          parts.push(`${col} ${sym} ?`);
          params.push(val);
          break;
        }
        case '$like':
          parts.push(`lower(${col}) LIKE lower(?)`);
          params.push(val);
          break;
        case '$notlike':
          parts.push(`(${col} IS NULL OR lower(${col}) NOT LIKE lower(?))`);
          params.push(val);
          break;
        case '$oneof':
        case '$notoneof': {
          const arr = val as SqlValue[];
          if (arr.length === 0) {
            parts.push(op === '$oneof' ? '0' : '1');
            break;
          }
          parts.push(`${col} ${op === '$oneof' ? 'IN' : 'NOT IN'} (${arr.map(() => '?').join(', ')})`);
          params.push(...arr);
          break;
        }
        default:
          throw new Error(`AQL: unknown operator ${op}`);
      }
    }
  }
  return parts.length ? parts.join(' AND ') : '1';
}

export function compile(query: Query): { sql: string; params: SqlValue[] } {
  const s = query.state;
  if (!SYNCED_SCHEMA[s.table]) throw new Error(`AQL: unknown table ${s.table}`);
  const params: SqlValue[] = [];
  const where = ['tombstone = 0'];
  if (s.table === 'transactions') {
    if (s.splits === 'inline') where.push('is_parent = 0');
    else if (s.splits === 'none' || s.splits === 'grouped') where.push('is_child = 0');
  }
  for (const f of s.filterExpressions) where.push(`(${compileFilter(s.table, f, params)})`);

  const select = s.selectExpressions
    .map(e => {
      if (typeof e === 'string') return e === '*' ? '*' : ref(s.table, e);
      return Object.entries(e)
        .map(([alias, agg]) => {
          const [fn, arg] = Object.entries(agg)[0];
          const sqlFn = { $sum: 'SUM', $count: 'COUNT', $min: 'MIN', $max: 'MAX' }[fn];
          if (!sqlFn) throw new Error(`AQL: unknown aggregate ${fn}`);
          const a = arg === '*' ? '*' : ref(s.table, arg!);
          return `${sqlFn === 'SUM' ? `COALESCE(SUM(${a}), 0)` : `${sqlFn}(${a})`} AS ${alias.replace(/\W/g, '')}`;
        })
        .join(', ');
    })
    .join(', ');

  let sql = `SELECT ${select} FROM ${s.table} WHERE ${where.join(' AND ')}`;
  if (s.groupExpressions.length) sql += ` GROUP BY ${s.groupExpressions.map(g => ref(s.table, g)).join(', ')}`;
  if (s.orderExpressions.length) {
    sql +=
      ' ORDER BY ' +
      s.orderExpressions
        .map(o => (typeof o === 'string' ? ref(s.table, o) : Object.entries(o).map(([k, d]) => `${ref(s.table, k)} ${d === 'desc' ? 'DESC' : 'ASC'}`).join(', ')))
        .join(', ');
  }
  if (s.limit != null) sql += ` LIMIT ${Math.floor(s.limit)}`;
  if (s.offset != null) sql += ` OFFSET ${Math.floor(s.offset)}`;
  return { sql, params };
}

export function runQuery(db: BudgetDb, query: Query | QueryState): { data: any } {
  const qq = query instanceof Query ? query : new Query(query);
  const { sql, params } = compile(qq);
  const rows = db.all<Row>(sql, params);
  if (qq.state.calculation) return { data: rows[0]?.result ?? 0 };
  return { data: rows };
}
