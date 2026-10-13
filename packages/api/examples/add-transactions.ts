// Add transactions to a budget on your sync server from a script.
//
//   ENVELOPE_URL=http://localhost:5006 ENVELOPE_USER=admin ENVELOPE_PASSWORD=... \
//   ENVELOPE_BUDGET="Demo Budget" npx tsx packages/api/examples/add-transactions.ts
import { init } from '../src/index';

const api = await init({
  dataDir: './.envelope-cache', // local copy of downloaded budgets
  serverURL: process.env.ENVELOPE_URL ?? 'http://localhost:5006',
  userName: process.env.ENVELOPE_USER, // omit on a shared-password server
  password: process.env.ENVELOPE_PASSWORD,
});

try {
  // 1. Download the budget from the server (by name here; ids are fine too).
  const budgetName = process.env.ENVELOPE_BUDGET ?? 'Demo Budget';
  const cloud = await api.getCloudBudgets();
  const file = cloud.find((f: any) => f.name === budgetName);
  if (!file) throw new Error(`No budget named "${budgetName}" on the server`);
  await api.downloadBudget(file.fileId, process.env.ENVELOPE_KEY_PASSWORD); // key password only for encrypted budgets

  // 2. Look up ids by name.
  const checking = await api.getIDByName('accounts', 'Checking');
  const groceries = await api.getIDByName('categories', 'Groceries');

  // 3. Add transactions. Amounts are integer cents; negative = payment, positive = deposit.
  //    Rules run on each one, payees are created from payee_name, and splits work too.
  const { added } = await api.addTransactions(checking, [
    { date: '2026-10-13', amount: -4520, payee_name: 'Fresh Market', category: groceries, notes: 'Weekly shop #food' },
    {
      date: '2026-10-13',
      amount: -9000,
      payee_name: 'MegaMart',
      subtransactions: [
        { amount: -6000, category: groceries },
        { amount: -3000, category: await api.getIDByName('categories', 'Gifts'), notes: 'Birthday card' },
      ],
    },
  ]);
  console.log(`Added ${added.length} transactions`);

  // Bank-style data instead? importTransactions dedupes (re-running adds nothing new):
  //   await api.importTransactions(checking, [{ date, amount, payee_name, imported_id: 'BANK-123' }]);

  // 4. Push the changes; other devices see them on their next sync.
  await api.sync();
  console.log('Synced to the server');
} finally {
  await api.shutdown();
}
