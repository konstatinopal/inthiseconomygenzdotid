import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { init } from '@envelope/api';
import { createApp } from '../../sync-server/src/app';
import { loadConfig } from '../../sync-server/src/config';
import { createHttpApi } from './app';

const KEY = 'test-key-0123456789abcdefghij';
let root = '';
let syncServer: Server;
let httpServer: Server;
let base = '';
let owner: Awaited<ReturnType<typeof init>>;
let budgetId = '';

const listen = (app: any) =>
  new Promise<{ server: Server; url: string }>(r => {
    const s = app.listen(0, '127.0.0.1', () => r({ server: s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` }));
  });

async function call(method: string, p: string, body?: unknown, key: string | null = KEY) {
  const headers: Record<string, string> = {};
  if (key) headers.authorization = `Bearer ${key}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'envelope-http-'));
  const { app } = createApp(await loadConfig({ dataDir: path.join(root, 'srv'), webRoot: null, loginMethod: 'multiuser', openid: null, adminUser: 'admin', adminPassword: 'admin-pass-1' }));
  const s = await listen(app);
  syncServer = s.server;
  // The household's own device uploads the budget.
  owner = await init({ dataDir: path.join(root, 'owner'), serverURL: s.url, userName: 'admin', password: 'admin-pass-1' });
  await owner.engine.send('file-create', { name: 'Household', demo: true });
  const meta = await owner.uploadBudget();
  budgetId = meta.cloudFileId;
  // The HTTP API service signs in as the same account.
  const api = await init({ dataDir: path.join(root, 'http'), serverURL: s.url, userName: 'admin', password: 'admin-pass-1' });
  const h = await listen(createHttpApi({ api, apiKeys: [KEY], freshness: 0 }));
  httpServer = h.server;
  base = h.url;
}, 60_000);

afterAll(async () => {
  httpServer?.close();
  syncServer?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('HTTP API', () => {
  it('requires an API key', async () => {
    expect((await call('GET', '/v1/budgets', undefined, null)).status).toBe(401);
    expect((await call('GET', '/v1/budgets', undefined, 'wrong-key-wrong-key-wrong')).status).toBe(401);
    expect((await call('GET', '/health', undefined, null)).status).toBe(200);
  });

  it('lists budgets, accounts and categories', async () => {
    const b = await call('GET', '/v1/budgets');
    expect(b.body.data).toEqual([expect.objectContaining({ id: budgetId, name: 'Household', encrypted: false })]);
    const a = await call('GET', '/v1/budgets/Household/accounts');
    expect(a.body.data.map((x: any) => x.name)).toContain('Checking');
    const c = await call('GET', `/v1/budgets/${budgetId}/categories`);
    expect(c.body.data.flatMap((g: any) => g.categories.map((x: any) => x.name))).toContain('Groceries');
    expect((await call('GET', '/v1/budgets/Nope/accounts')).status).toBe(404);
  }, 30_000);

  it('adds a transaction by names, with a decimal amount, and syncs it', async () => {
    const r = await call('POST', '/v1/budgets/household/transactions', { account: 'Checking', date: '2026-10-13', amount: '-45.20', payee: 'Corner Bakery', category: 'groceries', notes: 'via curl' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ added: 1, synced: true });
    expect(r.body.data[0]).toMatchObject({ amount: -4520, payee_name: 'Corner Bakery', category_name: 'Groceries', account_name: 'Checking' });
    // The household's device receives it.
    await owner.sync();
    const ownerTxns = await owner.getTransactions(await owner.getIDByName('accounts', 'Checking'));
    expect(ownerTxns.find((t: any) => t.notes === 'via curl')?.amount).toBe(-4520);
  }, 30_000);

  it('sees changes made on other devices', async () => {
    const checking = await owner.getIDByName('accounts', 'Checking');
    await owner.addTransactions(checking, [{ date: '2026-10-12', amount: -777, payee_name: 'From the app', notes: 'owner-side' }]);
    await owner.sync();
    const r = await call('GET', '/v1/budgets/Household/transactions?account=Checking&search=owner-side');
    expect(r.body.data.map((t: any) => t.amount)).toEqual([-777]);
  }, 30_000);

  it('adds batches and splits; dedupe makes re-imports a no-op', async () => {
    const batch = {
      account: 'Credit Card',
      transactions: [
        { date: '2026-10-10', amount: -1200, payee: 'Bus', imported_id: 'BANK-1' },
        { date: '2026-10-11', amount: -9000, payee: 'MegaMart', subtransactions: [{ amount: -6000, category: 'Groceries' }, { amount: '-30.00', category: 'Gifts' }] },
      ],
      dedupe: true,
    };
    const first = await call('POST', '/v1/budgets/Household/transactions', batch);
    expect(first.body).toMatchObject({ added: 2, matched: 0 });
    const again = await call('POST', '/v1/budgets/Household/transactions', batch);
    expect(again.body).toMatchObject({ added: 0, matched: 2 });
    const split = first.body.data.find((t: any) => t.amount === -9000);
    expect(split.subtransactions.map((s: any) => s.category_name)).toEqual(['Groceries', 'Gifts']);
  }, 30_000);

  it('validates input with helpful errors', async () => {
    const post = (b: unknown) => call('POST', '/v1/budgets/Household/transactions', b);
    expect((await post({ account: 'Nope', amount: -1 })).body.error).toMatchObject({ code: 'account-not-found' });
    expect((await post({ account: 'Checking', amount: -12.5 })).body.error.code).toBe('invalid-amount');
    expect((await post({ account: 'Checking', amount: -100, date: '2026-02-30' })).body.error.code).toBe('invalid-date');
    expect((await post({ account: 'Checking', amount: -100, subtransactions: [{ amount: -10 }] })).body.error.code).toBe('split-mismatch');
    expect((await post({ account: 'Checking', amount: -100, category: 'Unknown' })).status).toBe(404);
    const bad = await call('POST', '/v1/budgets/Household/transactions', '{not json');
    expect(bad).toMatchObject({ status: 400, body: { error: { code: 'invalid-json' } } });
    // Nothing partial was written by the failed requests.
    const r = await call('GET', '/v1/budgets/Household/transactions?search=-1.00');
    expect(r.body.total).toBe(0);
  }, 30_000);

  it('updates and deletes', async () => {
    const created = (await call('POST', '/v1/budgets/Household/transactions', { account: 'Checking', amount: -500, payee: 'Edit Me' })).body.data[0];
    const upd = await call('PATCH', `/v1/budgets/Household/transactions/${created.id}`, { amount: '-6.25', category: 'Coffee', notes: 'changed' });
    expect(upd.body.data).toMatchObject({ amount: -625, category_name: 'Coffee', notes: 'changed' });
    expect((await call('DELETE', `/v1/budgets/Household/transactions/${created.id}`)).body).toMatchObject({ deleted: created.id, synced: true });
    expect((await call('GET', `/v1/budgets/Household/transactions/${created.id}`)).status).toBe(404);
  }, 30_000);

  it('handles concurrent requests without losing any', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => call('POST', '/v1/budgets/Household/transactions', { account: 'Savings', amount: -(i + 1) * 100, payee: 'Parallel', notes: `p${i}` })),
    );
    expect(results.every(r => r.status === 201)).toBe(true);
    const list = await call('GET', '/v1/budgets/Household/transactions?account=Savings&search=Parallel');
    expect(list.body.total).toBe(6);
  }, 30_000);

  it('reports a budget month', async () => {
    const m = await call('GET', '/v1/budgets/Household/months/2026-10');
    expect(m.body.data).toHaveProperty('to_budget');
    expect(m.body.data).toMatchObject({ start: '2026-10-01', end: '2026-10-31' });
    expect(m.body.data.categories.find((c: any) => c.name === 'Groceries')).toHaveProperty('spent');
    expect((await call('GET', '/v1/budgets/Household/months/oct')).status).toBe(400);
  }, 30_000);
});
