import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from './engine';
import { MemoryStorage } from './platform/storage';
import { SYNCED_SCHEMA } from './db/schema';
import { sqlJs } from './test-helpers';
import { createApp } from '../../sync-server/src/app';
import { loadConfig } from '../../sync-server/src/config';

let server: Server;
let url: string;
let dataDir: string;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'envelope-sync-'));
  const { app } = createApp(await loadConfig({ dataDir, webRoot: null }));
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function device() {
  const e = new Engine({ storage: new MemoryStorage(), sqlJs: await sqlJs(), timers: false, persistDelay: 5, syncDelay: 1e9 });
  await e.init();
  await e.send('server-set-url', { url });
  return e;
}

function snapshot(e: Engine) {
  const db = e.requireDb();
  const out: Record<string, unknown[]> = {};
  for (const t of Object.keys(SYNCED_SCHEMA)) out[t] = db.all(`SELECT * FROM ${t} ORDER BY id`);
  return out;
}

async function syncAll(devices: Engine[]) {
  for (let round = 0; round < 2; round++) for (const d of devices) await d.sync();
}

describe('sync', () => {
  let a: Engine;
  let b: Engine;
  let c: Engine;

  it('bootstraps, uploads and downloads a file', async () => {
    a = await device();
    expect((await a.send('server-needs-bootstrap')).bootstrapped).toBe(false);
    await a.send('server-bootstrap', { password: 'hunter2' });
    await a.send('file-create', { name: 'Shared', demo: true });
    await a.send('file-upload');
    b = await device();
    await expect(b.send('server-login', { password: 'wrong' })).rejects.toThrow(/Invalid password/);
    await b.send('server-login', { password: 'hunter2' });
    const files = await b.send('cloud-files-list');
    expect(files).toHaveLength(1);
    await b.send('cloud-file-download', { cloudFileId: files[0].fileId });
    expect(snapshot(b)).toEqual(snapshot(a));
  });

  it('converges after concurrent random edits on three devices', async () => {
    c = await device();
    await c.send('server-login', { password: 'hunter2' });
    const [file] = await c.send('cloud-files-list');
    await c.send('cloud-file-download', { cloudFileId: file.fileId });

    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const devices = [a, b, c];
    for (let round = 0; round < 4; round++) {
      for (const d of devices) {
        const accounts = await d.send('accounts-get');
        const cats = (await d.send('categories-get')).flatMap((g: any) => g.categories);
        for (let i = 0; i < 6; i++) {
          const r = rand();
          const acct = accounts[Math.floor(rand() * accounts.length)];
          const txns = await d.send('transactions-get', { account: acct.id });
          if (r < 0.4 || !txns.length) {
            await d.send('transaction-add', {
              account: acct.id,
              date: `2026-0${1 + Math.floor(rand() * 9)}-1${Math.floor(rand() * 9)}`,
              amount: -Math.floor(rand() * 10000),
              category: cats[Math.floor(rand() * cats.length)].id,
              payee_name: `Payee ${Math.floor(rand() * 5)}`,
            });
          } else if (r < 0.7) {
            const t = txns[Math.floor(rand() * txns.length)];
            await d.send('transaction-update', { id: t.id, amount: -Math.floor(rand() * 10000), notes: `edit ${round}` });
          } else if (r < 0.85) {
            await d.send('transaction-delete', { id: txns[Math.floor(rand() * txns.length)].id });
          } else {
            await d.send('budget-set-amount', { month: '2026-03', category: cats[Math.floor(rand() * cats.length)].id, amount: Math.floor(rand() * 50000) });
          }
        }
        // Sync only some devices each round so histories interleave.
        if (rand() < 0.5) await d.sync();
      }
    }
    await syncAll(devices);
    for (const d of devices) expect(d.syncStatus.state).toBe('idle');
    const sa = snapshot(a);
    expect(snapshot(b)).toEqual(sa);
    expect(snapshot(c)).toEqual(sa);
    // Derived budget values agree too.
    const ma = await a.send('budget-month', { month: '2026-03' });
    const mc = await c.send('budget-month', { month: '2026-03' });
    expect(mc.toBudget).toBe(ma.toBudget);
  });

  it('same-cell conflicts resolve last-writer-wins', async () => {
    const [acct] = await a.send('accounts-get');
    await a.send('account-update', { id: acct.id, name: 'From A' });
    await new Promise(r => setTimeout(r, 5));
    await b.send('account-update', { id: acct.id, name: 'From B' });
    await syncAll([a, b]);
    expect((await a.send('accounts-get'))[0].name).toBe('From B');
    expect((await b.send('accounts-get'))[0].name).toBe('From B');
  });

  it('end-to-end encrypts and forces other devices to re-download', async () => {
    await a.send('encryption-enable', { password: 'secret-key' });
    await b.sync();
    expect(b.syncStatus.reason).toBe('file-has-reset');
    const [file] = await b.send('cloud-files-list');
    expect(file.encryptKeyId).toBeTruthy();
    await expect(b.send('cloud-file-download', { cloudFileId: file.fileId, password: 'nope' })).rejects.toThrow(/Wrong encryption password/);
    await b.send('cloud-file-download', { cloudFileId: file.fileId, password: 'secret-key' });
    await a.send('transaction-add', { account: (await a.send('accounts-get'))[0].id, date: '2026-05-05', amount: -4242, notes: 'secret note' });
    await syncAll([a, b]);
    expect(snapshot(b)).toEqual(snapshot(a));
    // The server only ever sees ciphertext.
    const Database = (await import('better-sqlite3')).default;
    const sdb = new Database(path.join(dataDir, 'server.sqlite'), { readonly: true });
    const rows = sdb.prepare('SELECT content, is_encrypted FROM messages').all() as { content: string; is_encrypted: number }[];
    sdb.close();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(r => r.is_encrypted === 1)).toBe(true);
    expect(rows.some(r => Buffer.from(r.content, 'base64').toString().includes('secret note'))).toBe(false);
  });
});
