// Populates a new budget with realistic sample data: accounts, categories,
// six months of transactions, budgets, rules, schedules and templates.
import type { BudgetDb } from './db';
import { addDays, addMonths, currentMonth, daysInMonth, today } from './util/dates';
import { createAccount, getStartingBalanceCategory } from './models/accounts';
import { createCategory, createGroup } from './models/categories';
import { findOrCreatePayee, getTransferPayee } from './models/payees';
import { createRule } from './models/rules';
import { createSchedule } from './models/schedules';
import { addTransaction } from './models/transactions';
import { setBudget } from './models/budget';
import { setNote } from './models/misc';

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

export function createDefaultCategories(db: BudgetDb) {
  const groups: Record<string, string[]> = {
    'Usual Expenses': ['Food', 'General', 'Bills', 'Savings'],
  };
  for (const [g, cats] of Object.entries(groups)) {
    const gid = createGroup(db, { name: g });
    for (const c of cats) createCategory(db, { name: c, group: gid });
  }
  const income = createGroup(db, { name: 'Income', is_income: true });
  createCategory(db, { name: 'Income', group: income });
  getStartingBalanceCategory(db);
}

export function createDemoBudget(db: BudgetDb) {
  const rand = rng(42);
  const amt = (lo: number, hi: number) => -Math.round((lo + rand() * (hi - lo)) * 100);
  const now = today();
  const start = addMonths(currentMonth(), -5);

  db.batch(() => {
    const groups: Record<string, string[]> = {
      Bills: ['Rent', 'Electricity', 'Internet', 'Phone'],
      Frequent: ['Groceries', 'Restaurants', 'Transport', 'Coffee'],
      Lifestyle: ['Entertainment', 'Clothing', 'Gifts', 'Health'],
      'Savings Goals': ['Emergency Fund', 'Vacation'],
    };
    const cat: Record<string, string> = {};
    for (const [g, names] of Object.entries(groups)) {
      const gid = createGroup(db, { name: g });
      for (const n of names) cat[n] = createCategory(db, { name: n, group: gid });
    }
    const incomeGroup = createGroup(db, { name: 'Income', is_income: true });
    cat.Paycheck = createCategory(db, { name: 'Paycheck', group: incomeGroup });
    cat['Other Income'] = createCategory(db, { name: 'Other Income', group: incomeGroup });
    getStartingBalanceCategory(db);

    const startDate = `${start}-01`;
    const checking = createAccount(db, { name: 'Checking', balance: 180000, date: startDate });
    const savings = createAccount(db, { name: 'Savings', balance: 650000, date: startDate });
    const card = createAccount(db, { name: 'Credit Card', balance: -32000, date: startDate });
    createAccount(db, { name: 'Investments', offbudget: true, balance: 2450000, date: startDate });
    const mortgage = createAccount(db, { name: 'Car Loan', offbudget: true, balance: -1280000, date: startDate });

    const payee = (n: string) => findOrCreatePayee(db, n);
    const add = (account: string, date: string, amount: number, payeeName: string, category: string | null, notes?: string) => {
      if (date > now) return;
      addTransaction(
        db,
        { account, date, amount, payee: payee(payeeName), category, notes: notes ?? null, cleared: date < addDays(now, -3) },
        { runRules: false },
      );
    };

    const grocers = ['Fresh Market', 'Green Grocer', 'Corner Store'];
    const restaurants = ['Noodle House', 'Taco Stand', 'Pizza Place', 'Sushi Bar'];
    for (let i = 0; i < 6; i++) {
      const m = addMonths(start, i);
      const dim = daysInMonth(m);
      const d = (day: number) => `${m}-${String(Math.min(day, dim)).padStart(2, '0')}`;
      add(checking, d(1), 260000, 'Acme Corp', cat.Paycheck, 'Salary');
      add(checking, d(15), 260000, 'Acme Corp', cat.Paycheck, 'Salary');
      add(checking, d(1), -145000, 'Property Management', cat.Rent);
      add(checking, d(8), amt(60, 110), 'City Power', cat.Electricity);
      add(card, d(12), -5999, 'FiberNet', cat.Internet);
      add(card, d(20), -3500, 'Mobile Co', cat.Phone);
      for (let w = 0; w < 5; w++) {
        add(card, d(3 + w * 6), amt(45, 140), grocers[Math.floor(rand() * grocers.length)], cat.Groceries, w === 2 ? '#weekly-shop' : undefined);
        add(card, d(5 + w * 6), amt(15, 65), restaurants[Math.floor(rand() * restaurants.length)], cat.Restaurants);
        add(card, d(2 + w * 6), amt(3, 6), 'Bean There', cat.Coffee);
        add(checking, d(4 + w * 6), amt(20, 50), 'Metro Transit', cat.Transport);
      }
      if (rand() > 0.4) add(card, d(18), amt(20, 90), 'Cinema City', cat.Entertainment, '#fun');
      if (rand() > 0.5) add(card, d(22), amt(30, 150), 'Style Outlet', cat.Clothing);
      if (rand() > 0.7) add(card, d(10), amt(25, 80), 'Pharmacy Plus', cat.Health);
      if (i === 3) add(checking, d(19), 25000, 'Tax Office', cat['Other Income'], 'Tax refund');
      // Pay the card from checking and save from checking.
      const cardPayee = getTransferPayee(db, card)!.id;
      const savingsPayee = getTransferPayee(db, savings)!.id;
      const loanPayee = getTransferPayee(db, mortgage)!.id;
      if (d(25) <= now) {
        addTransaction(db, { account: checking, date: d(25), amount: -110000, payee: cardPayee, cleared: true }, { runRules: false });
        addTransaction(db, { account: checking, date: d(26), amount: -40000, payee: savingsPayee, cleared: true }, { runRules: false });
        addTransaction(db, { account: checking, date: d(5), amount: -32000, payee: loanPayee, category: cat.Transport, notes: 'Car loan payment', cleared: true }, { runRules: false });
      }

      const budget: Record<string, number> = {
        Rent: 145000,
        Electricity: 9000,
        Internet: 6000,
        Phone: 3500,
        Groceries: 45000,
        Restaurants: 18000,
        Transport: 52000,
        Coffee: 2500,
        Entertainment: 6000,
        Clothing: 8000,
        Gifts: 5000,
        Health: 5000,
        'Emergency Fund': 40000,
        Vacation: 20000,
      };
      if (i === 0) budget['Emergency Fund'] += 150000;
      for (const [name, v] of Object.entries(budget)) setBudget(db, m, cat[name], v);
    }

    // A split transaction.
    const splitDate = addDays(now, -6);
    addTransaction(
      db,
      {
        account: card,
        date: splitDate,
        amount: -12850,
        payee: payee('MegaMart'),
        notes: 'Weekend run',
        subtransactions: [
          { amount: -8350, category: cat.Groceries },
          { amount: -4500, category: cat.Gifts, notes: 'Birthday present' },
        ],
      },
      { runRules: false },
    );

    createRule(db, {
      stage: null,
      conditionsOp: 'and',
      conditions: [{ field: 'imported_payee', op: 'contains', value: 'fresh market' }],
      actions: [
        { op: 'set', field: 'payee', value: payee('Fresh Market') },
        { op: 'set', field: 'category', value: cat.Groceries },
      ],
    });
    createRule(db, {
      stage: null,
      conditionsOp: 'or',
      conditions: [
        { field: 'payee', op: 'oneOf', value: restaurants.map(payee) },
        { field: 'notes', op: 'contains', value: 'dinner' },
      ],
      actions: [{ op: 'set', field: 'category', value: cat.Restaurants }],
    });

    createSchedule(db, {
      name: 'Rent',
      payee: payee('Property Management'),
      account: checking,
      amount: -145000,
      amountOp: 'is',
      date: { start: `${start}-01`, interval: 1, frequency: 'monthly', endMode: 'never' },
      posts_transaction: false,
    });
    createSchedule(db, {
      name: 'Internet',
      payee: payee('FiberNet'),
      account: card,
      amount: -5999,
      amountOp: 'isapprox',
      date: { start: `${start}-12`, interval: 1, frequency: 'monthly', endMode: 'never' },
    });
    createSchedule(db, {
      name: 'Paycheck',
      payee: payee('Acme Corp'),
      account: checking,
      amount: 260000,
      amountOp: 'is',
      date: { start: `${start}-01`, interval: 1, frequency: 'monthly', patterns: [{ type: 'day', value: 1 }, { type: 'day', value: 15 }], endMode: 'never' },
    });

    setNote(db, cat.Rent, '#template schedule Rent');
    setNote(db, cat.Internet, '#template schedule Internet');
    setNote(db, cat.Groceries, 'Weekly shop plus top-ups.\n#template average 3 months');
    setNote(db, cat.Coffee, '#template 25 up to 60');
    setNote(db, cat.Vacation, '#template 1500 by ' + addMonths(currentMonth(), 8) + '\n#goal 1500');
    setNote(db, cat['Emergency Fund'], '#goal 10000\n#template-2 remainder');
  });
  db.undoStack = [];
  db.redoStack = [];
}
