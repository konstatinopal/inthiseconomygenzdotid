import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from './app';
import { loadConfig } from './config';

let server: Server;
let base = '';
let dataDir = '';
let generated = '';

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'envelope-pw-'));
  const config = await loadConfig({ dataDir, webRoot: null, loginMethod: 'multiuser', openid: null, adminUser: 'admin', adminPassword: null });
  const created = createApp(config);
  generated = created.bootstrap!.generatedPassword!;
  await new Promise<void>(r => (server = created.app.listen(0, '127.0.0.1', () => r())));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function api(p: string, opts: { token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token) headers['x-actual-token'] = opts.token;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + p, { method: opts.body !== undefined ? 'POST' : 'GET', headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  return res.json() as Promise<any>;
}

describe('username and password accounts', () => {
  let admin = '';

  it('creates a default admin with a temporary password', async () => {
    expect(generated.length).toBeGreaterThanOrEqual(16);
    const r = await api('/account/needs-bootstrap');
    expect(r.data).toMatchObject({ loginMethod: 'multiuser', bootstrapped: true, googleLogin: false });
    const login = await api('/account/login', { body: { userName: 'Admin', password: generated } });
    expect(login.data).toMatchObject({ mustChangePassword: true, user: { userName: 'admin', role: 'ADMIN' } });
    admin = login.data.token;
  });

  it('blocks everything until the temporary password is changed', async () => {
    expect((await api('/sync/list-user-files', { token: admin })).reason).toBe('password-change-required');
    expect((await api('/account/validate', { token: admin })).data.mustChangePassword).toBe(true);
    expect((await api('/account/change-password', { token: admin, body: { currentPassword: 'nope', password: 'brand-new-pw' } })).reason).toBe('invalid-password');
    expect((await api('/account/change-password', { token: admin, body: { currentPassword: generated, password: 'short' } })).reason).toBe('weak-password');
    const ch = await api('/account/change-password', { token: admin, body: { currentPassword: generated, password: 'brand-new-pw' } });
    expect(ch.status).toBe('ok');
    expect((await api('/sync/list-user-files', { token: admin })).status).toBe('ok');
    expect((await api('/account/login', { body: { userName: 'admin', password: generated } })).reason).toBe('invalid-password');
  });

  it('admins create users with temporary passwords and can reset them', async () => {
    const add = await api('/admin/users', { token: admin, body: { userName: 'sam', password: 'temp-pass-1', role: 'BASIC' } });
    expect(add.data).toMatchObject({ userName: 'sam', hasPassword: true, mustChangePassword: true });
    expect((await api('/admin/users', { token: admin, body: { userName: 'x' } })).reason).toBe('invalid-username');
    const sam = await api('/account/login', { body: { userName: 'sam', password: 'temp-pass-1' } });
    expect(sam.data.mustChangePassword).toBe(true);
    await api('/account/change-password', { token: sam.data.token, body: { currentPassword: 'temp-pass-1', password: 'sams-own-pw' } });
    // Reset: Sam's sessions end and the new password is temporary again.
    await api('/admin/users/set-password', { token: admin, body: { id: add.data.id, password: 'reset-pass-2' } });
    expect((await api('/account/validate', { token: sam.data.token })).reason).toBe('unauthorized');
    expect((await api('/account/login', { body: { userName: 'sam', password: 'reset-pass-2' } })).data.mustChangePassword).toBe(true);
    // Removing the only way to sign in is refused.
    expect((await api('/admin/users/set-password', { token: admin, body: { id: add.data.id, password: null } })).reason).toBe('no-login-left');
  });

  it('gives the same answer for unknown users and wrong passwords, then locks out', async () => {
    const unknown = await api('/account/login', { body: { userName: 'ghost', password: 'whatever1' } });
    const wrong = await api('/account/login', { body: { userName: 'admin', password: 'whatever1' } });
    expect(unknown.details).toBe(wrong.details);
    for (let i = 0; i < 4; i++) await api('/account/login', { body: { userName: 'admin', password: 'whatever1' } });
    expect((await api('/account/login', { body: { userName: 'admin', password: 'brand-new-pw' } })).reason).toBe('too-many-attempts');
  });
});
