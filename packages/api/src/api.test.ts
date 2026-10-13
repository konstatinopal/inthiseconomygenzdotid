import { expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { init, q } from './index';

it('drives a budget from Node with filesystem storage', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envelope-api-'));
  const api = await init({ dataDir: dir });
  const meta: any = await api.createBudget('Scripted');
  const acct = await api.createAccount({ name: 'Wallet' }, 10000);
  await api.addTransactions(acct, [{ date: '2026-10-01', amount: -1250, payee_name: 'Cafe' }]);
  const { data } = await api.runQuery(q('transactions').filter({ account: acct }).calculate({ $sum: '$amount' } as any));
  expect(data).toBe(8750);
  await api.shutdown();
  expect(fs.existsSync(path.join(dir, meta.id, 'db.sqlite'))).toBe(true);
  // Reopen from disk.
  const api2 = await init({ dataDir: dir });
  await api2.loadBudget(meta.id);
  expect((await api2.getAccounts())[0].balance).toBe(8750);
  await api2.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

it('adds transactions to a budget on a multi-user server and syncs them', async () => {
  const { createApp } = await import('../../sync-server/src/app');
  const { loadConfig } = await import('../../sync-server/src/config');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'envelope-api-srv-'));
  const { app } = createApp(await loadConfig({ dataDir: path.join(root, 'srv'), webRoot: null, loginMethod: 'multiuser', openid: null, adminUser: 'admin', adminPassword: 'admin-pass-1' }));
  const server = await new Promise<import('node:http').Server>(r => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  const serverURL = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  try {
    // A device with the budget uploads it.
    const owner = await init({ dataDir: path.join(root, 'a'), serverURL, userName: 'admin', password: 'admin-pass-1' });
    await owner.engine.send('file-create', { name: 'Household', demo: true });
    await owner.uploadBudget();
    await owner.shutdown();

    // The script, exactly as in examples/add-transactions.ts.
    const api = await init({ dataDir: path.join(root, 'b'), serverURL, userName: 'admin', password: 'admin-pass-1' });
    const file = (await api.getCloudBudgets()).find((f: any) => f.name === 'Household');
    await api.downloadBudget(file.fileId);
    const checking = await api.getIDByName('accounts', 'checking');
    const groceries = await api.getIDByName('categories', 'Groceries');
    const { added } = await api.addTransactions(checking, [
      { date: '2026-10-13', amount: -4520, payee_name: 'API Shop', category: groceries, notes: 'from script' },
      { date: '2026-10-13', amount: -9000, payee_name: 'API Mart', subtransactions: [{ amount: -6000, category: groceries }, { amount: -3000, category: groceries }] },
    ]);
    expect(added).toHaveLength(2);
    // importTransactions dedupes: the same bank row twice adds it once.
    const row = { date: '2026-10-12', amount: -1234, payee_name: 'Bank Row', imported_id: 'BANK-1' };
    expect((await api.importTransactions(checking, [row])).added).toHaveLength(1);
    expect((await api.importTransactions(checking, [row])).added).toHaveLength(0);
    await api.sync();
    await api.shutdown();
    await expect(api.getIDByName('accounts', 'Nope')).rejects.toThrow();

    // A fresh device sees them.
    const viewer = await init({ dataDir: path.join(root, 'c'), serverURL, userName: 'admin', password: 'admin-pass-1' });
    await viewer.downloadBudget(file.fileId);
    const txns = await viewer.getTransactions(await viewer.getIDByName('accounts', 'Checking'));
    const ours = txns.filter((t: any) => ['from script', null].includes(t.notes) && t.date === '2026-10-13');
    expect(ours.map((t: any) => t.amount).sort((a: number, b: number) => a - b)).toEqual([-9000, -4520]);
    expect(ours.find((t: any) => t.amount === -9000).subtransactions).toHaveLength(2);
    expect(txns.filter((t: any) => t.imported_id === 'BANK-1')).toHaveLength(1);
    await viewer.shutdown();

    // Wrong credentials fail loudly.
    await expect(init({ dataDir: path.join(root, 'd'), serverURL, userName: 'admin', password: 'wrong-pass' })).rejects.toThrow(/Wrong username or password/);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
