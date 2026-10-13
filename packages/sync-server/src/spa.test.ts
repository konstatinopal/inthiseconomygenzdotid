import { afterAll, beforeAll, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from './app';
import { loadConfig } from './config';

let server: Server;
let base = '';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envelope-spa-'));

beforeAll(async () => {
  const webRoot = path.join(dir, 'web');
  fs.mkdirSync(webRoot);
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>app</title>');
  const { app } = createApp(await loadConfig({ dataDir: path.join(dir, 'data'), webRoot }));
  await new Promise<void>(r => (server = app.listen(0, '127.0.0.1', () => r())));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

it('serves the web app for deep links that share a prefix with API routes', async () => {
  for (const p of ['/accounts', '/accounts/abc', '/budget', '/settings', '/admin-tools', '/openid-cb?code=x', '/syncing']) {
    const res = await fetch(base + p);
    expect(res.status, p).toBe(200);
    expect(await res.text(), p).toContain('<title>app</title>');
  }
  // API routes are untouched.
  expect((await (await fetch(base + '/account/needs-bootstrap')).json()).status).toBe('ok');
  expect((await fetch(base + '/sync/list-user-files')).status).toBe(401);
});
