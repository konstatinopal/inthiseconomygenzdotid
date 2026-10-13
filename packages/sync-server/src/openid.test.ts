import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { createApp } from './app';
import { loadConfig } from './config';

// A fake Google: discovery, an authorize endpoint that "consents" as whoever
// the test chose, a token endpoint that signs ID tokens, and a JWKS.
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const evilKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
const kid = 'test-key';
let idp: Server;
let idpUrl = '';
let server: Server;
let base = '';
let dataDir = '';
let nextIdentity: Record<string, any> = {};
let tamper: 'none' | 'signature' | 'audience' | 'nonce' = 'none';
const codes = new Map<string, { nonce: string; identity: Record<string, any>; challenge: string }>();

function sign(claims: object, key = privateKey) {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${enc({ alg: 'RS256', kid, typ: 'JWT' })}.${enc(claims)}`;
  return `${data}.${crypto.sign('RSA-SHA256', Buffer.from(data), key).toString('base64url')}`;
}

beforeAll(async () => {
  const fake = express();
  fake.get('/.well-known/openid-configuration', (_req, res) =>
    res.json({ issuer: idpUrl, authorization_endpoint: `${idpUrl}/auth`, token_endpoint: `${idpUrl}/token`, jwks_uri: `${idpUrl}/jwks` }),
  );
  fake.get('/jwks', (_req, res) => res.json({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }] }));
  fake.get('/auth', (req, res) => {
    const code = crypto.randomUUID();
    codes.set(code, { nonce: String(req.query.nonce), identity: nextIdentity, challenge: String(req.query.code_challenge) });
    const u = new URL(String(req.query.redirect_uri));
    u.searchParams.set('code', code);
    u.searchParams.set('state', String(req.query.state));
    res.redirect(u.toString());
  });
  fake.post('/token', express.urlencoded({ extended: false }), (req, res) => {
    const c = codes.get(req.body.code);
    const challenge = crypto.createHash('sha256').update(req.body.code_verifier ?? '').digest('base64url');
    if (!c || challenge !== c.challenge || req.body.client_secret !== 'shh') return res.status(400).json({ error: 'invalid_grant' });
    codes.delete(req.body.code);
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: idpUrl,
      aud: tamper === 'audience' ? 'someone-else' : 'client-123',
      exp: now + 3600,
      iat: now,
      nonce: tamper === 'nonce' ? 'wrong' : c.nonce,
      email_verified: true,
      ...c.identity,
    };
    res.json({ id_token: sign(claims, tamper === 'signature' ? evilKey : privateKey), access_token: 'x' });
  });
  await new Promise<void>(r => (idp = fake.listen(0, '127.0.0.1', () => r())));
  idpUrl = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'envelope-oidc-'));
  // Reserve a port so the redirect URI can name it.
  const probe = express().listen(0, '127.0.0.1');
  await new Promise(r => probe.once('listening', r));
  const port = (probe.address() as AddressInfo).port;
  probe.close();
  base = `http://127.0.0.1:${port}`;
  const config = await loadConfig({
    dataDir,
    webRoot: null,
    loginMethod: 'openid',
    publicUrl: base,
    openid: { issuer: idpUrl, clientId: 'client-123', clientSecret: 'shh' },
    adminEmail: 'alex@example.com',
    adminUser: 'alex@example.com',
    adminPassword: 'alex-start-pw',
    allowedDomains: [],
    allowedOrigins: ['http://localhost:3001'],
  });
  const { app } = createApp(config);
  await new Promise<void>(r => (server = app.listen(port, '127.0.0.1', () => r())));
});

afterAll(() => {
  server?.close();
  idp?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function api(pathname: string, opts: { token?: string; body?: unknown; method?: string; headers?: Record<string, string>; raw?: Buffer } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) headers['x-actual-token'] = opts.token;
  let body: any;
  if (opts.raw) body = opts.raw;
  else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(base + pathname, { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body });
  return res.json() as Promise<any>;
}

/** Walk the redirects a browser would follow; returns the final /openid-cb query. */
async function signIn(identity: Record<string, any>, returnUrl = base) {
  nextIdentity = identity;
  const start = await api(`/openid/login?returnUrl=${encodeURIComponent(returnUrl)}`);
  expect(start.status).toBe('ok');
  const toCallback = await fetch(start.data.url, { redirect: 'manual' });
  const back = await fetch(toCallback.headers.get('location')!, { redirect: 'manual' });
  const final = new URL(back.headers.get('location')!);
  expect(final.pathname).toBe('/openid-cb');
  const code = final.searchParams.get('code');
  if (!code) return { error: final.searchParams.get('error') };
  const ex = await api('/openid/exchange', { body: { code } });
  return { token: ex.data?.token as string, user: ex.data?.user, code };
}

describe('Google sign-in and multi-user access', () => {
  let alex: { token: string; user: any };
  let sam: { token: string; user: any };

  it('reports multi-user mode with both sign-in methods', async () => {
    const r = await api('/account/needs-bootstrap');
    expect(r.data).toMatchObject({ loginMethod: 'multiuser', multiuser: true, googleLogin: true, availableLoginMethods: ['password', 'openid'] });
    const pw = await api('/account/login', { body: { userName: 'alex@example.com', password: 'alex-start-pw' } });
    expect(pw.data).toMatchObject({ mustChangePassword: false, user: { role: 'ADMIN' } });
  });

  it('rejects return URLs outside the allow list', async () => {
    expect((await api(`/openid/login?returnUrl=${encodeURIComponent('https://evil.example')}`)).reason).toBe('invalid-return-url');
    expect((await api(`/openid/login?returnUrl=${encodeURIComponent('http://localhost:3001')}`)).status).toBe('ok');
  });

  it('lets the default admin also sign in with Google', async () => {
    const r: any = await signIn({ sub: 'g-alex', email: 'Alex@Example.com', name: 'Alex', picture: 'https://pic/alex' });
    alex = r;
    expect(r.user).toMatchObject({ userName: 'alex@example.com', role: 'ADMIN', displayName: 'Alex' });
    const me = await api('/account/validate', { token: r.token });
    expect(me.data).toMatchObject({ role: 'ADMIN', userName: 'alex@example.com' });
  });

  it('login codes are single use', async () => {
    const r: any = await signIn({ sub: 'g-alex', email: 'alex@example.com' });
    expect((await api('/openid/exchange', { body: { code: r.code } })).reason).toBe('invalid-login-code');
  });

  it('refuses uninvited users, then admits them once invited', async () => {
    expect((await signIn({ sub: 'g-sam', email: 'sam@example.com', name: 'Sam' })).error).toBe('not-invited');
    const add = await api('/admin/users', { token: alex.token, body: { userName: 'sam@example.com', role: 'BASIC' } });
    expect(add.status).toBe('ok');
    sam = (await signIn({ sub: 'g-sam', email: 'sam@example.com', name: 'Sam' })) as any;
    expect(sam.user).toMatchObject({ role: 'BASIC', displayName: 'Sam' });
    expect((await api('/admin/users', { token: sam.token })).reason).toBe('forbidden');
  });

  it('rejects tampered, misaddressed and replayed ID tokens', async () => {
    for (const t of ['signature', 'audience', 'nonce'] as const) {
      tamper = t;
      expect((await signIn({ sub: 'g-alex', email: 'alex@example.com' })).error).toBe('invalid-token');
    }
    tamper = 'none';
    expect((await signIn({ sub: 'g-alex', email: 'alex@example.com', email_verified: false })).error).toBe('email-unverified');
    // Replaying a used state is refused at the callback.
    nextIdentity = { sub: 'g-alex', email: 'alex@example.com' };
    const start = await api(`/openid/login?returnUrl=${encodeURIComponent(base)}`);
    const toCallback = await fetch(start.data.url, { redirect: 'manual' });
    const cb = toCallback.headers.get('location')!;
    await fetch(cb, { redirect: 'manual' });
    expect((await fetch(cb, { redirect: 'manual' })).status).toBe(400);
  });

  it('enforces the per-file permission matrix', async () => {
    const up = (token: string, id: string) =>
      api('/sync/upload-user-file', { token, raw: Buffer.from('snapshot'), headers: { 'x-actual-file-id': id, 'x-actual-name': 'Budget', 'content-type': 'application/octet-stream' } });
    expect((await up(sam.token, 'sams-budget')).status).toBe('ok');
    const alexOwn = await up(alex.token, 'alex-private');
    expect(alexOwn.status).toBe('ok');
    // Sam sees only Sam's file; the admin sees both.
    expect((await api('/sync/list-user-files', { token: sam.token })).data.map((f: any) => f.fileId)).toEqual(['sams-budget']);
    const adminView = (await api('/sync/list-user-files', { token: alex.token })).data;
    expect(adminView.find((f: any) => f.fileId === 'sams-budget')).toMatchObject({ access: 'admin', ownerName: 'Sam' });
    // An outsider gets "not found", not "forbidden".
    const sync = (token: string, fileId: string, groupId: string) => api('/sync/sync', { token, body: { fileId, groupId, keyId: null, since: '', messages: [] } });
    expect((await sync(sam.token, 'alex-private', alexOwn.data.groupId)).reason).toBe('file-not-found');
    // Share it: Sam can sync and download but not delete, rename or re-share.
    expect((await api('/admin/access/grant', { token: alex.token, body: { fileId: 'alex-private', userId: sam.user.id } })).status).toBe('ok');
    expect((await sync(sam.token, 'alex-private', alexOwn.data.groupId)).status).toBe('ok');
    const dl = await fetch(base + '/sync/download-user-file', { headers: { 'x-actual-token': sam.token, 'x-actual-file-id': 'alex-private' } });
    expect(await dl.text()).toBe('snapshot');
    expect((await api('/sync/delete-user-file', { token: sam.token, body: { fileId: 'alex-private' } })).reason).toBe('forbidden');
    expect((await api('/sync/update-user-filename', { token: sam.token, body: { fileId: 'alex-private', name: 'x' } })).reason).toBe('forbidden');
    expect((await api('/admin/access/grant', { token: sam.token, body: { fileId: 'alex-private', userId: sam.user.id } })).reason).toBe('forbidden');
    expect((await up(sam.token, 'alex-private')).reason).toBe('forbidden');
    const listed = (await api('/sync/list-user-files', { token: sam.token })).data.find((f: any) => f.fileId === 'alex-private');
    expect(listed).toMatchObject({ access: 'shared', ownerName: 'Alex' });
    // Access list, revoke, and the next sync is refused.
    const acc = await api('/admin/access?fileId=alex-private', { token: alex.token });
    expect(acc.data.users.map((u: any) => u.userName)).toEqual(['sam@example.com']);
    await api('/admin/access/revoke', { token: alex.token, body: { fileId: 'alex-private', userId: sam.user.id } });
    expect((await sync(sam.token, 'alex-private', alexOwn.data.groupId)).reason).toBe('file-not-found');
    // Transfer: Sam becomes owner, Alex stays as a collaborator.
    await api('/admin/access/transfer', { token: alex.token, body: { fileId: 'alex-private', newUserId: sam.user.id } });
    const after = await api('/admin/access?fileId=alex-private', { token: sam.token });
    expect(after.data.owner.userName).toBe('sam@example.com');
    expect(after.data.users.map((u: any) => u.userName)).toEqual(['alex@example.com']);
  });

  it('protects the last admin and signs disabled users out', async () => {
    expect((await api('/admin/users/update', { token: alex.token, body: { id: alex.user.id, role: 'BASIC' } })).reason).toBe('last-admin');
    expect((await api('/admin/users/delete', { token: alex.token, body: { ids: [alex.user.id] } })).reason).toBe('cannot-delete-self');
    await api('/admin/users/update', { token: alex.token, body: { id: sam.user.id, enabled: false } });
    expect((await api('/account/validate', { token: sam.token })).reason).toBe('unauthorized');
    expect((await signIn({ sub: 'g-sam', email: 'sam@example.com' })).error).toBe('user-disabled');
    // Deleting Sam hands Sam's files to the admin.
    await api('/admin/users/delete', { token: alex.token, body: { ids: [sam.user.id] } });
    const files = (await api('/sync/list-user-files', { token: alex.token })).data;
    expect(files.every((f: any) => f.access === 'owner')).toBe(true);
  });

  it('matches returning users by Google subject, not email', async () => {
    // Someone else with Alex's email but a different Google account can't take over.
    expect((await signIn({ sub: 'g-impostor', email: 'alex@example.com' })).error).toBe('account-mismatch');
  });
});
