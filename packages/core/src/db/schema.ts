// Every synced table has a string `id` primary key and a `tombstone` flag:
// rows are never hard-deleted, so CRDT messages can always be applied.

type ColumnType = 'TEXT' | 'INTEGER' | 'REAL';
interface ColumnDef {
  type: ColumnType;
  default?: string | number | null;
}

export const SYNCED_SCHEMA: Record<string, Record<string, ColumnDef>> = {
  accounts: {
    name: { type: 'TEXT', default: '' },
    offbudget: { type: 'INTEGER', default: 0 },
    closed: { type: 'INTEGER', default: 0 },
    sort_order: { type: 'REAL', default: 0 },
    last_reconciled: { type: 'TEXT' },
    tombstone: { type: 'INTEGER', default: 0 },
  },
  payees: {
    name: { type: 'TEXT', default: '' },
    transfer_acct: { type: 'TEXT' },
    favorite: { type: 'INTEGER', default: 0 },
    learn_categories: { type: 'INTEGER', default: 1 },
    tombstone: { type: 'INTEGER', default: 0 },
  },
  category_groups: {
    name: { type: 'TEXT', default: '' },
    is_income: { type: 'INTEGER', default: 0 },
    sort_order: { type: 'REAL', default: 0 },
    hidden: { type: 'INTEGER', default: 0 },
    tombstone: { type: 'INTEGER', default: 0 },
  },
  categories: {
    name: { type: 'TEXT', default: '' },
    cat_group: { type: 'TEXT' },
    is_income: { type: 'INTEGER', default: 0 },
    sort_order: { type: 'REAL', default: 0 },
    hidden: { type: 'INTEGER', default: 0 },
    tombstone: { type: 'INTEGER', default: 0 },
  },
  transactions: {
    account: { type: 'TEXT' },
    date: { type: 'INTEGER', default: 0 },
    amount: { type: 'INTEGER', default: 0 },
    payee: { type: 'TEXT' },
    category: { type: 'TEXT' },
    notes: { type: 'TEXT' },
    cleared: { type: 'INTEGER', default: 0 },
    reconciled: { type: 'INTEGER', default: 0 },
    parent_id: { type: 'TEXT' },
    is_parent: { type: 'INTEGER', default: 0 },
    is_child: { type: 'INTEGER', default: 0 },
    transfer_id: { type: 'TEXT' },
    schedule: { type: 'TEXT' },
    imported_id: { type: 'TEXT' },
    imported_payee: { type: 'TEXT' },
    starting_balance_flag: { type: 'INTEGER', default: 0 },
    sort_order: { type: 'REAL', default: 0 },
    tombstone: { type: 'INTEGER', default: 0 },
  },
  zero_budgets: {
    month: { type: 'INTEGER', default: 0 },
    category: { type: 'TEXT' },
    amount: { type: 'INTEGER', default: 0 },
    carryover: { type: 'INTEGER', default: 0 },
    tombstone: { type: 'INTEGER', default: 0 },
  },
  reflect_budgets: {
    month: { type: 'INTEGER', default: 0 },
    category: { type: 'TEXT' },
    amount: { type: 'INTEGER', default: 0 },
    carryover: { type: 'INTEGER', default: 0 },
    tombstone: { type: 'INTEGER', default: 0 },
  },
  zero_budget_months: {
    buffered: { type: 'INTEGER', default: 0 },
    tombstone: { type: 'INTEGER', default: 0 },
  },
  rules: {
    stage: { type: 'TEXT' },
    conditions_op: { type: 'TEXT', default: 'and' },
    conditions: { type: 'TEXT', default: '[]' },
    actions: { type: 'TEXT', default: '[]' },
    description: { type: 'TEXT' },
    tombstone: { type: 'INTEGER', default: 0 },
  },
  schedules: {
    name: { type: 'TEXT' },
    rule: { type: 'TEXT' },
    next_date: { type: 'INTEGER' },
    completed: { type: 'INTEGER', default: 0 },
    posts_transaction: { type: 'INTEGER', default: 0 },
    custom_upcoming_length: { type: 'INTEGER' },
    tombstone: { type: 'INTEGER', default: 0 },
  },
  notes: {
    note: { type: 'TEXT' },
    tombstone: { type: 'INTEGER', default: 0 },
  },
  preferences: {
    value: { type: 'TEXT' },
    tombstone: { type: 'INTEGER', default: 0 },
  },
  transaction_filters: {
    name: { type: 'TEXT' },
    conditions_op: { type: 'TEXT', default: 'and' },
    conditions: { type: 'TEXT', default: '[]' },
    tombstone: { type: 'INTEGER', default: 0 },
  },
};

export type SyncedTable = keyof typeof SYNCED_SCHEMA;

function columnSql(name: string, def: ColumnDef) {
  let s = `${name} ${def.type}`;
  if (def.default !== undefined && def.default !== null) {
    s += ` DEFAULT ${typeof def.default === 'string' ? `'${def.default}'` : def.default}`;
  }
  return s;
}

function createSynced(): string[] {
  return Object.entries(SYNCED_SCHEMA).map(
    ([table, cols]) =>
      `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, ${Object.entries(cols)
        .map(([c, d]) => columnSql(c, d))
        .join(', ')})`,
  );
}

// Ordered, idempotent migrations. Each runs once and is recorded in __migrations__.
export const MIGRATIONS: { id: number; sql: string[] }[] = [
  {
    id: 1,
    sql: [
      ...createSynced(),
      `CREATE TABLE IF NOT EXISTS messages_crdt (timestamp TEXT PRIMARY KEY, dataset TEXT NOT NULL, row TEXT NOT NULL, column TEXT NOT NULL, value TEXT)`,
      `CREATE INDEX IF NOT EXISTS messages_crdt_cell ON messages_crdt (dataset, row, column, timestamp)`,
      `CREATE TABLE IF NOT EXISTS messages_clock (id INTEGER PRIMARY KEY, clock TEXT)`,
      `CREATE TABLE IF NOT EXISTS kvcache (key TEXT PRIMARY KEY, value TEXT)`,
      `CREATE INDEX IF NOT EXISTS trans_account_date ON transactions (account, date)`,
      `CREATE INDEX IF NOT EXISTS trans_category_date ON transactions (category, date)`,
      `CREATE INDEX IF NOT EXISTS trans_parent ON transactions (parent_id)`,
      `CREATE INDEX IF NOT EXISTS trans_imported ON transactions (imported_id)`,
      `CREATE INDEX IF NOT EXISTS zero_budgets_month ON zero_budgets (month)`,
      `CREATE INDEX IF NOT EXISTS reflect_budgets_month ON reflect_budgets (month)`,
    ],
  },
];
