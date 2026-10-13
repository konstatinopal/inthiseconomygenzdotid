import { beforeEach, describe, expect, it } from 'vitest';
import type { BudgetDb } from './db';
import { emptyDb } from './test-helpers';
import { createAccount, closeAccount, getAccounts, reconcileAdjust, reconcileLock } from './models/accounts';
import { createCategory, createGroup, deleteCategory } from './models/categories';
import { findOrCreatePayee, getTransferPayee, mergePayees } from './models/payees';
import { createRule, getRules } from './models/rules';
import { addTransaction, deleteTransaction, getTransaction, getTransactions, mergeTransactions, updateTransaction } from './models/transactions';
import {
  budgetActionForMonth,
  coverOverspending,
  getBudgetMonth,
  holdForNextMonth,
  setBudget,
  setBudgetType,
  setCarryover,
  transferBudget,
} from './models/budget';
import { runTemplates, parseTemplateLine } from './models/templates';
import { createSchedule, getSchedules, postTransactionForSchedule, skipNextDate } from './models/schedules';
import { reconcileTransactions } from './importers/pipeline';
import { parseCsv } from './importers/csv';
import { parseOfx } from './importers/ofx';
import { parseQif } from './importers/qif';
import { parseCamt } from './importers/camt';
import { q, runQuery } from './aql';
import { addMonths, currentMonth } from './util/dates';
import { formatAmount, parseAmount } from './util/amounts';
import { getOccurrences, nextOccurrence } from './util/recurrence';
import { cashFlow, customReport, netWorth } from './models/reports';

let db: BudgetDb;
let food: string;
let rent: string;
let salary: string;
let checking: string;
let savings: string;
let invest: string;
const m0 = '2026-01';
const m1 = '2026-02';

beforeEach(async () => {
  db = await emptyDb();
  const g = createGroup(db, { name: 'Expenses' });
  food = createCategory(db, { name: 'Food', group: g });
  rent = createCategory(db, { name: 'Rent', group: g });
  const inc = createGroup(db, { name: 'Income', is_income: true });
  salary = createCategory(db, { name: 'Salary', group: inc });
  checking = createAccount(db, { name: 'Checking' });
  savings = createAccount(db, { name: 'Savings' });
  invest = createAccount(db, { name: 'Brokerage', offbudget: true });
});

describe('amounts', () => {
  it('parses and formats integer cents', () => {
    expect(parseAmount('1,234.56')).toBe(123456);
    expect(parseAmount('1.234,56', ',')).toBe(123456);
    expect(parseAmount('(5.00)')).toBe(-500);
    expect(parseAmount('12.5+3')).toBe(1550);
    expect(parseAmount('abc')).toBeNull();
    expect(formatAmount(-123456)).toBe('-1,234.56');
    expect(formatAmount(123456, { numberFormat: 'dot-comma', currencySymbol: '€', symbolPosition: 'after', symbolSpace: true })).toBe('1.234,56 €');
    expect(formatAmount(123456, { hideFraction: true })).toBe('1,235');
  });
});

describe('accounts and transactions', () => {
  it('creates starting balances in the Starting Balances income category', () => {
    const id = createAccount(db, { name: 'Wallet', balance: 5000, date: '2026-01-01' });
    const [t] = getTransactions(db, { account: id });
    expect(t.amount).toBe(5000);
    expect(t.starting_balance_flag).toBe(true);
    expect(getBudgetMonth(db, m0).income).toBe(5000);
  });

  it('keeps transfer mirrors in sync and needs no category on-budget', () => {
    const to = getTransferPayee(db, savings)!.id;
    const id = addTransaction(db, { account: checking, date: '2026-01-05', amount: -10000, payee: to, category: food })!;
    let t = getTransaction(db, id)!;
    expect(t.category).toBeNull();
    const mirror = getTransaction(db, t.transfer_id!)!;
    expect(mirror.account).toBe(savings);
    expect(mirror.amount).toBe(10000);
    updateTransaction(db, { id, amount: -25000, date: '2026-01-06' });
    expect(getTransaction(db, mirror.id)!.amount).toBe(25000);
    expect(getTransaction(db, mirror.id)!.date).toBe('2026-01-06');
    // Editing from the other side propagates back.
    updateTransaction(db, { id: mirror.id, amount: 30000 });
    expect(getTransaction(db, id)!.amount).toBe(-30000);
    // Changing the payee away from a transfer removes the mirror.
    updateTransaction(db, { id, payee_name: 'Shop' });
    t = getTransaction(db, id)!;
    expect(t.transfer_id).toBeNull();
    expect(getTransaction(db, mirror.id)).toBeNull();
  });

  it('keeps the category on transfers to off-budget accounts', () => {
    const to = getTransferPayee(db, invest)!.id;
    const id = addTransaction(db, { account: checking, date: '2026-01-05', amount: -10000, payee: to, category: food })!;
    expect(getTransaction(db, id)!.category).toBe(food);
    deleteTransaction(db, id);
    expect(getTransactions(db, { account: invest })).toHaveLength(0);
  });

  it('handles split transactions', () => {
    const id = addTransaction(db, {
      account: checking,
      date: '2026-01-10',
      amount: -5000,
      payee_name: 'Market',
      subtransactions: [
        { amount: -3000, category: food },
        { amount: -2000, category: rent },
      ],
    })!;
    const t = getTransaction(db, id)!;
    expect(t.is_parent).toBe(true);
    expect(t.subtransactions).toHaveLength(2);
    const mb = getBudgetMonth(db, m0);
    expect(mb.categories[food].spent).toBe(-3000);
    expect(mb.categories[rent].spent).toBe(-2000);
    expect(getAccounts(db).find(a => a.id === checking)!.balance).toBe(-5000);
    // Unsplit.
    updateTransaction(db, { id, subtransactions: [], category: food });
    expect(getTransaction(db, id)!.is_parent).toBe(false);
    expect(getBudgetMonth(db, m0).categories[food].spent).toBe(-5000);
  });

  it('closes an account by transferring its balance', () => {
    addTransaction(db, { account: savings, date: '2026-01-01', amount: 7000, category: salary });
    closeAccount(db, { id: savings, transferAccountId: checking });
    const accts = getAccounts(db);
    expect(accts.find(a => a.id === savings)!.closed).toBe(true);
    expect(accts.find(a => a.id === savings)!.balance).toBe(0);
    expect(accts.find(a => a.id === checking)!.balance).toBe(7000);
  });

  it('reconciles', () => {
    addTransaction(db, { account: checking, date: '2026-01-01', amount: 10000, cleared: true });
    addTransaction(db, { account: checking, date: '2026-01-02', amount: -500 });
    reconcileAdjust(db, checking, 9000);
    reconcileLock(db, checking);
    const txns = getTransactions(db, { account: checking });
    expect(txns.filter(t => t.reconciled)).toHaveLength(2);
    expect(getAccounts(db).find(a => a.id === checking)!.cleared).toBe(9000);
  });

  it('merges a manual entry with its imported twin', () => {
    const manual = addTransaction(db, { account: checking, date: '2026-01-03', amount: -1200, payee_name: 'Cafe', category: food, notes: 'lunch' })!;
    const imported = addTransaction(db, { account: checking, date: '2026-01-04', amount: -1200, imported_id: 'X1', imported_payee: 'CAFE 123' })!;
    const kept = mergeTransactions(db, manual, imported);
    const t = getTransaction(db, kept)!;
    expect(t.date).toBe('2026-01-04');
    expect(t.imported_id).toBe('X1');
    expect(t.category).toBe(food);
    expect(t.notes).toBe('lunch');
    expect(getTransactions(db, { account: checking })).toHaveLength(1);
  });

  it('undoes and redoes a whole batch', () => {
    const id = addTransaction(db, { account: checking, date: '2026-01-03', amount: -1200, category: food })!;
    expect(getTransactions(db, { account: checking })).toHaveLength(1);
    db.undo();
    expect(getTransaction(db, id)).toBeNull();
    db.redo();
    expect(getTransaction(db, id)!.amount).toBe(-1200);
  });

  it('merges payees and deletes categories by reassigning history', () => {
    const a = findOrCreatePayee(db, 'Store A')!;
    const b = findOrCreatePayee(db, 'Store B')!;
    addTransaction(db, { account: checking, date: '2026-01-03', amount: -100, payee: b, category: rent });
    mergePayees(db, a, [b]);
    expect(getTransactions(db, { account: checking })[0].payee).toBe(a);
    setBudget(db, m0, rent, 500);
    setBudget(db, m0, food, 100);
    expect(() => deleteCategory(db, rent, null)).toThrow();
    deleteCategory(db, rent, food);
    expect(getTransactions(db, { account: checking })[0].category).toBe(food);
    expect(getBudgetMonth(db, m0).categories[food].budgeted).toBe(600);
  });
});

describe('envelope budget', () => {
  it('computes To Budget, balances, overspending and carryover', () => {
    addTransaction(db, { account: checking, date: '2026-01-01', amount: 300000, category: salary });
    setBudget(db, m0, food, 50000);
    setBudget(db, m0, rent, 100000);
    addTransaction(db, { account: checking, date: '2026-01-10', amount: -60000, category: food });
    let jan = getBudgetMonth(db, m0);
    expect(jan.income).toBe(300000);
    expect(jan.totalBudgeted).toBe(150000);
    expect(jan.toBudget).toBe(150000);
    expect(jan.categories[food].balance).toBe(-10000);
    let feb = getBudgetMonth(db, m1);
    // Overspending resets to 0 and comes out of next month's To Budget.
    expect(feb.categories[food].carryIn).toBe(0);
    expect(feb.lastMonthOverspent).toBe(-10000);
    expect(feb.fromLastMonth).toBe(150000);
    expect(feb.toBudget).toBe(140000);
    expect(feb.categories[rent].balance).toBe(100000);
    // With rollover on, the negative balance carries instead.
    setCarryover(db, m0, food, true);
    feb = getBudgetMonth(db, m1);
    expect(feb.categories[food].carryIn).toBe(-10000);
    expect(feb.toBudget).toBe(150000);
    // Cover overspending from To Budget.
    coverOverspending(db, m0, food, null);
    jan = getBudgetMonth(db, m0);
    expect(jan.categories[food].balance).toBe(0);
    expect(jan.toBudget).toBe(140000);
  });

  it('moves money and holds funds for next month', () => {
    addTransaction(db, { account: checking, date: '2026-01-01', amount: 100000, category: salary });
    transferBudget(db, m0, null, food, 30000);
    transferBudget(db, m0, food, rent, 10000);
    let jan = getBudgetMonth(db, m0);
    expect(jan.categories[food].budgeted).toBe(20000);
    expect(jan.categories[rent].budgeted).toBe(10000);
    holdForNextMonth(db, m0, 50000);
    jan = getBudgetMonth(db, m0);
    expect(jan.toBudget).toBe(20000);
    expect(getBudgetMonth(db, m1).toBudget).toBe(70000);
    // Holds are capped at what's available.
    holdForNextMonth(db, m0, 999999);
    expect(getBudgetMonth(db, m0).toBudget).toBe(0);
  });

  it('copies last month and computes averages', () => {
    setBudget(db, m0, food, 12345);
    budgetActionForMonth(db, m1, 'copy-last');
    expect(getBudgetMonth(db, m1).categories[food].budgeted).toBe(12345);
    addTransaction(db, { account: checking, date: '2026-01-10', amount: -9000, category: food });
    budgetActionForMonth(db, m1, 'avg-3');
    expect(getBudgetMonth(db, m1).categories[food].budgeted).toBe(3000);
  });

  it('switches to a tracking budget with separate data', () => {
    setBudget(db, m0, food, 5000);
    setBudgetType(db, 'tracking');
    expect(getBudgetMonth(db, m0).categories[food].budgeted).toBe(0);
    setBudget(db, m0, salary, 200000);
    setBudget(db, m0, food, 7000);
    addTransaction(db, { account: checking, date: '2026-01-01', amount: 210000, category: salary });
    addTransaction(db, { account: checking, date: '2026-01-02', amount: -6000, category: food });
    const mb = getBudgetMonth(db, m0);
    expect(mb.plannedIncome).toBe(200000);
    expect(mb.saved).toBe(204000);
    setBudgetType(db, 'envelope');
    expect(getBudgetMonth(db, m0).categories[food].budgeted).toBe(5000);
  });
});

describe('templates', () => {
  it('parses template lines', () => {
    expect(parseTemplateLine('#template 50')).toMatchObject({ type: 'simple', amount: 5000 });
    expect(parseTemplateLine('#template-2 50 up to 300')).toMatchObject({ priority: 2, amount: 5000, limit: 30000 });
    expect(parseTemplateLine('#template 500 by 2026-12 repeat every year')).toMatchObject({ type: 'by', repeat: { n: 1, unit: 'year' } });
    expect(parseTemplateLine('#template 10% of all income')).toMatchObject({ type: 'percentage', percent: 10 });
    expect(parseTemplateLine('#template schedule full Internet increase 5%')).toMatchObject({ type: 'schedule', full: true, name: 'Internet', increase: 5 });
    expect(parseTemplateLine('#template average 3 months')).toMatchObject({ type: 'average', months: 3 });
    expect(parseTemplateLine('#template 10 repeat every 2 weeks starting 2026-01-04')).toMatchObject({ type: 'periodic', n: 2, unit: 'week' });
    expect(parseTemplateLine('#template nonsense here')).toHaveProperty('error');
    expect(parseTemplateLine('just a note')).toBeNull();
  });

  it('applies templates by priority with limited funds', () => {
    addTransaction(db, { account: checking, date: '2026-01-01', amount: 100000, category: salary });
    db.upsert('notes', { id: rent, note: '#template-1 800' });
    db.upsert('notes', { id: food, note: '#template-2 500' });
    runTemplates(db, m0);
    const jan = getBudgetMonth(db, m0);
    expect(jan.categories[rent].budgeted).toBe(80000);
    expect(jan.categories[food].budgeted).toBe(20000);
    expect(jan.toBudget).toBe(0);
  });

  it('refills up to a cap', () => {
    addTransaction(db, { account: checking, date: '2026-01-01', amount: 100000, category: salary });
    setBudget(db, m0, food, 20000);
    db.upsert('notes', { id: food, note: '#template up to 300' });
    runTemplates(db, m1);
    expect(getBudgetMonth(db, m1).categories[food].budgeted).toBe(10000);
  });
});

describe('rules', () => {
  it('runs on new transactions by stage and specificity', () => {
    const payee = findOrCreatePayee(db, 'Coffee Shop')!;
    createRule(db, {
      stage: 'pre',
      conditionsOp: 'and',
      conditions: [{ field: 'imported_payee', op: 'contains', value: 'COFFEE' }],
      actions: [{ op: 'set', field: 'payee', value: payee }],
    });
    createRule(db, {
      stage: null,
      conditionsOp: 'and',
      conditions: [{ field: 'payee', op: 'is', value: payee }],
      actions: [{ op: 'set', field: 'category', value: food }, { op: 'append-notes', value: ' #coffee' }],
    });
    const id = addTransaction(db, { account: checking, date: '2026-01-01', amount: -450, imported_payee: 'SQ *COFFEE SHOP 42', notes: 'latte' })!;
    const t = getTransaction(db, id)!;
    expect(t.payee).toBe(payee);
    expect(t.category).toBe(food);
    expect(t.notes).toBe('latte #coffee');
  });

  it('learns payee categories', () => {
    const id = addTransaction(db, { account: checking, date: '2026-01-01', amount: -450, payee_name: 'Bakery' })!;
    updateTransaction(db, { id, category: food });
    const learned = getRules(db).find(r => r.actions[0].op === 'set' && (r.actions[0] as any).value === food);
    expect(learned).toBeTruthy();
    const id2 = addTransaction(db, { account: checking, date: '2026-01-02', amount: -300, payee_name: 'Bakery' })!;
    expect(getTransaction(db, id2)!.category).toBe(food);
  });

  it('filters the register with rule conditions', () => {
    addTransaction(db, { account: checking, date: '2026-01-01', amount: -450, notes: 'hello #trip' });
    addTransaction(db, { account: checking, date: '2026-01-02', amount: -50000 });
    expect(getTransactions(db, { filter: { conditionsOp: 'and', conditions: [{ field: 'notes', op: 'hasTags', value: '#trip' }] } })).toHaveLength(1);
    expect(getTransactions(db, { filter: { conditionsOp: 'and', conditions: [{ field: 'amount', op: 'gt', value: 1000, options: { outflow: true } }] } })).toHaveLength(1);
    expect(getTransactions(db, { search: 'hello' })).toHaveLength(1);
  });
});

describe('schedules', () => {
  it('computes recurrences with patterns, weekends and end conditions', () => {
    expect(getOccurrences({ start: '2026-01-31', interval: 1, frequency: 'monthly' }, '2026-01-01', '2026-04-30')).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
    ]);
    expect(
      getOccurrences({ start: '2026-01-01', interval: 1, frequency: 'monthly', patterns: [{ type: 'day', value: 15 }, { type: 'day', value: -1 }] }, '2026-01-01', '2026-02-28'),
    ).toEqual(['2026-01-15', '2026-01-31', '2026-02-15', '2026-02-28']);
    expect(getOccurrences({ start: '2026-01-01', interval: 1, frequency: 'monthly', patterns: [{ type: 'FR', value: 2 }] }, '2026-01-01', '2026-02-28')).toEqual([
      '2026-01-09',
      '2026-02-13',
    ]);
    // 2026-02-01 is a Sunday.
    expect(getOccurrences({ start: '2026-02-01', interval: 1, frequency: 'monthly', skipWeekend: true, weekendSolveMode: 'after' }, '2026-01-01', '2026-02-28')).toEqual([
      '2026-02-02',
    ]);
    expect(getOccurrences({ start: '2026-01-01', interval: 2, frequency: 'weekly', endMode: 'after_n_occurrences', endOccurrences: 3 }, '2026-01-01', '2026-12-31')).toEqual([
      '2026-01-01',
      '2026-01-15',
      '2026-01-29',
    ]);
    expect(nextOccurrence({ start: '2026-01-01', interval: 1, frequency: 'yearly', endMode: 'on_date', endDate: '2026-06-01' }, '2026-01-02')).toBeNull();
  });

  it('matches transactions to schedules and advances the next date', () => {
    const payee = findOrCreatePayee(db, 'Landlord')!;
    const future = addMonths(currentMonth(), 1);
    const id = createSchedule(db, {
      name: 'Rent',
      payee,
      account: checking,
      amount: -100000,
      amountOp: 'isapprox',
      date: { start: `${future}-01`, interval: 1, frequency: 'monthly' },
    });
    let s = getSchedules(db).find(x => x.id === id)!;
    expect(s.next_date).toBe(`${future}-01`);
    const t = addTransaction(db, { account: checking, date: `${future}-02`, amount: -101000, payee })!;
    expect(getTransaction(db, t)!.schedule).toBe(id);
    s = getSchedules(db).find(x => x.id === id)!;
    expect(s.next_date).toBe(`${addMonths(future, 1)}-01`);
    skipNextDate(db, id);
    expect(getSchedules(db).find(x => x.id === id)!.next_date).toBe(`${addMonths(future, 2)}-01`);
    const posted = postTransactionForSchedule(db, id)!;
    expect(getTransaction(db, posted)!.amount).toBe(-100000);
    expect(getSchedules(db).find(x => x.id === id)!.next_date).toBe(`${addMonths(future, 3)}-01`);
  });
});

describe('import', () => {
  const ofx = `OFXHEADER:100
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260105120000<TRNAMT>-12.34<FITID>A1<NAME>GROCERY &amp; CO<MEMO>card 1234</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260106<TRNAMT>1000.00<FITID>A2<NAME>EMPLOYER</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

  it('parses OFX, QIF, CSV and CAMT', () => {
    const o = parseOfx(ofx).transactions;
    expect(o).toHaveLength(2);
    expect(o[0]).toMatchObject({ date: '2026-01-05', amount: -1234, payee_name: 'GROCERY & CO', imported_id: 'A1' });
    const qif = parseQif('!Type:Bank\nD01/05/2026\nT-12.34\nPGrocery\nMweekly\n^\nD01/06/2026\nT1,000.00\nPEmployer\n^\n').transactions;
    expect(qif[1]).toMatchObject({ date: '2026-01-06', amount: 100000 });
    const csv = parseCsv('Date,Description,Debit,Credit\n05/01/2026,Shop,12.34,\n06/01/2026,Pay,,1000\n', { dateFormat: 'dd-mm-yyyy' }).transactions;
    expect(csv).toEqual([
      expect.objectContaining({ date: '2026-01-05', amount: -1234, payee_name: 'Shop' }),
      expect.objectContaining({ date: '2026-01-06', amount: 100000 }),
    ]);
    const camt = parseCamt(
      `<Document><BkToCstmrStmt><Stmt><Ntry><Amt Ccy="EUR">12.34</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>2026-01-05</Dt></BookgDt><AcctSvcrRef>R1</AcctSvcrRef>
      <NtryDtls><TxDtls><RltdPties><Cdtr><Nm>Bakery</Nm></Cdtr></RltdPties><RmtInf><Ustrd>Bread</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry></Stmt></BkToCstmrStmt></Document>`,
    ).transactions;
    expect(camt[0]).toMatchObject({ date: '2026-01-05', amount: -1234, payee_name: 'Bakery', notes: 'Bread', imported_id: 'R1' });
  });

  it('never duplicates when the same file is imported twice', () => {
    const parsed = parseOfx(ofx).transactions;
    const first = reconcileTransactions(db, checking, parsed);
    expect(first.added).toHaveLength(2);
    const second = reconcileTransactions(db, checking, parsed);
    expect(second.added).toHaveLength(0);
    expect(second.preview.every(p => p.status === 'matched')).toBe(true);
    expect(getTransactions(db, { account: checking })).toHaveLength(2);
  });

  it('fuzzy-matches manual entries and keeps the user category', () => {
    const manual = addTransaction(db, { account: checking, date: '2026-01-03', amount: -1234, payee_name: 'Grocery', category: food })!;
    const res = reconcileTransactions(db, checking, parseOfx(ofx).transactions);
    expect(res.preview[0]).toMatchObject({ status: 'matched', matchedId: manual });
    const t = getTransaction(db, manual)!;
    expect(t).toMatchObject({ date: '2026-01-05', category: food, imported_id: 'A1', cleared: true });
  });

  it('skips previously deleted imports unless asked', () => {
    const parsed = parseOfx(ofx).transactions;
    const first = reconcileTransactions(db, checking, parsed);
    deleteTransaction(db, first.added[0]);
    expect(reconcileTransactions(db, checking, parsed, { dryRun: true }).preview[0].status).toBe('skipped');
    expect(reconcileTransactions(db, checking, parsed, { dryRun: true, reimportDeleted: true }).preview[0].status).toBe('new');
  });
});

describe('AQL and reports', () => {
  it('queries with filters and aggregates', () => {
    addTransaction(db, { account: checking, date: '2026-01-01', amount: -100, category: food });
    addTransaction(db, { account: checking, date: '2026-01-02', amount: -200, category: food });
    addTransaction(db, { account: checking, date: '2026-01-03', amount: -300, category: rent });
    const { data } = runQuery(
      db,
      q('transactions').filter({ category: food, date: { $gte: 20260101 } }).groupBy('category').select(['category', { total: { $sum: '$amount' } }]),
    );
    expect(data).toEqual([{ category: food, total: -300 }]);
    expect(runQuery(db, q('transactions').filter({ $or: [{ amount: -100 }, { amount: -300 }] }).calculate({ $count: '*' } as any)).data).toBe(2);
  });

  it('builds net worth, cash flow and custom reports', () => {
    addTransaction(db, { account: checking, date: '2026-01-01', amount: 100000, category: salary });
    addTransaction(db, { account: checking, date: '2026-01-05', amount: -30000, category: rent });
    addTransaction(db, { account: invest, date: '2026-02-01', amount: 500000 });
    const nw = netWorth(db, { start: m0, end: m1 });
    expect(nw.map(r => r.networth)).toEqual([70000, 570000]);
    const cf = cashFlow(db, { start: m0, end: m0 });
    expect(cf[0]).toMatchObject({ income: 100000, expenses: -30000, balance: 70000 });
    const rep = customReport(db, { start: '2026-01-01', end: '2026-02-28', groupBy: 'category', interval: 'monthly', type: 'expense' });
    expect(rep.rows[0]).toMatchObject({ id: rent, total: 30000 });
    expect(rep.rows[0].values['2026-01']).toBe(30000);
  });
});

describe('ids', () => {
  it('makes valid v4 UUIDs without crypto.randomUUID (insecure browser contexts)', async () => {
    const { uuid } = await import('./util/id');
    const original = globalThis.crypto.randomUUID;
    Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true });
    try {
      const ids = new Set(Array.from({ length: 2000 }, () => uuid()));
      expect(ids.size).toBe(2000);
      for (const id of [...ids].slice(0, 50)) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      // The whole write path still works.
      const db = await emptyDb();
      const g = createGroup(db, { name: 'G' });
      const acct = createAccount(db, { name: 'A', balance: 100 });
      createCategory(db, { name: 'C', group: g });
      expect(getAccounts(db).find(a => a.id === acct)?.balance).toBe(100);
    } finally {
      Object.defineProperty(globalThis.crypto, 'randomUUID', { value: original, configurable: true });
    }
  });
});
