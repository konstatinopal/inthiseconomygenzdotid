import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SyncRequest } from '@envelope/crdt';
import type { ServerConfig } from './config';
import { Store, type FileRow, type UserRow } from './store';
import { OpenIdClient, OpenIdError, randomToken } from './openid';

const VERSION = '0.2.0';

const ok = (res: Response, data: unknown = null) => res.json({ status: 'ok', data });
const fail = (res: Response, code: number, reason: string, details?: string) => res.status(code).json({ status: 'error', reason, details });

/** How the caller relates to a file; null = no access. */
export type FileAccess = 'owner' | 'shared' | 'admin' | null;

export function publicUser(u: UserRow) {
  return {
    id: u.id,
    userName: u.user_name,
    displayName: u.display_name,
    picture: u.picture,
    role: u.role,
    enabled: !!u.enabled,
    lastLogin: u.last_login,
    createdAt: u.created_at,
    hasPassword: !!u.password_hash,
    google: !!u.oidc_sub,
    mustChangePassword: !!u.must_change_password,
  };
}

const MIN_PASSWORD = 8;
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);
const USERNAME = /^([^@\s]+@[^@\s]+\.[^@\s]+|[a-z0-9][a-z0-9._-]{2,63})$/i;

/** Brute-force guard: 5 failed passwords per account and address lock it for 5 minutes. */
class LoginLimiter {
  private fails = new Map<string, { n: number; until: number }>();
  blocked(key: string) {
    const f = this.fails.get(key);
    return !!f && f.until > Date.now();
  }
  fail(key: string) {
    const f = this.fails.get(key) ?? { n: 0, until: 0 };
    f.n++;
    if (f.n >= 5) {
      f.until = Date.now() + 5 * 60_000;
      f.n = 0;
    }
    this.fails.set(key, f);
  }
  reset(key: string) {
    this.fails.delete(key);
  }
}

export function createApp(config: ServerConfig, deps: { fetch?: typeof fetch } = {}) {
  const store = new Store(config.dataDir);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustedProxies);
  app.use(cors({ exposedHeaders: ['x-actual-group-id'] }));
  const metrics = { requests: 0, syncs: 0, startedAt: Date.now() };
  app.use((_req, _res, next) => {
    metrics.requests++;
    next();
  });

  const multiuser = config.loginMethod === 'multiuser' || config.loginMethod === 'openid';
  const limiter = new LoginLimiter();
  const openid =
    multiuser && config.openid
      ? new OpenIdClient({ ...config.openid, redirectUri: `${config.publicUrl}/openid/callback` }, deps.fetch ?? fetch)
      : null;
  // Multi-user mode: the shared-password account's sessions stop working, and
  // a default admin exists from the first start (no "first sign-in wins" race).
  let bootstrap: { adminUser: string; generatedPassword: string | null } | null = null;
  if (multiuser) {
    store.db.prepare("DELETE FROM sessions WHERE user_id = 'owner'").run();
    if (store.countEnabledAdmins() === 0) {
      const generated = config.adminPassword ? null : randomToken(12);
      const existing = store.getUserByEmail(config.adminUser);
      const hash = bcrypt.hashSync(config.adminPassword ?? generated!, 12);
      const admin = existing
        ? (store.updateUser(existing.id, { role: 'ADMIN', enabled: 1, password_hash: hash, must_change_password: generated ? 1 : 0 }), store.getUser(existing.id)!)
        : store.createUser({ userName: config.adminUser, displayName: null, role: 'ADMIN', passwordHash: hash, mustChangePassword: !!generated });
      store.adoptLegacyFiles(admin.id);
      bootstrap = { adminUser: admin.user_name, generatedPassword: generated };
      console.log(`Created default admin "${admin.user_name}".`);
      if (generated) console.log(`  Temporary password: ${generated}\n  You will be asked to change it at first login. Set ENVELOPE_ADMIN_PASSWORD to choose it yourself.`);
    }
  }

  const json = express.json({ limit: `${config.uploadLimitMb}mb` });
  const raw = express.raw({ type: '*/*', limit: `${config.uploadLimitMb}mb` });

  const userOf = (req: Request) => (req as any).user as UserRow;

  // Until a temporary password is replaced, only these routes work.
  const PASSWORD_CHANGE_ROUTES = new Set(['/account/validate', '/account/change-password', '/account/logout']);

  function requireAuth(req: Request, res: Response, next: NextFunction) {
    const token = (req.headers['x-actual-token'] as string) ?? '';
    const session = token ? store.getSession(token) : null;
    if (!session) return fail(res, 401, 'unauthorized');
    const user = store.getUser(session.user_id);
    if (!user || !user.enabled) return fail(res, 401, 'unauthorized');
    if (user.must_change_password && !PASSWORD_CHANGE_ROUTES.has(req.path)) return fail(res, 403, 'password-change-required', 'Choose a new password first');
    (req as any).user = user;
    next();
  }

  function requireAdmin(req: Request, res: Response, next: NextFunction) {
    if (userOf(req).role !== 'ADMIN') return fail(res, 403, 'forbidden', 'Only admins can do this');
    next();
  }

  // One place decides file permissions (see the PRD's permission matrix).
  function accessOf(user: UserRow, file: FileRow): FileAccess {
    const owner = file.owner ?? 'owner';
    if (owner === user.id) return 'owner';
    if (store.hasAccess(file.id, user.id)) return 'shared';
    if (user.role === 'ADMIN') return 'admin';
    return null;
  }

  /** Load a file the caller may use; `manage` = owner or admin only. Replies and returns null otherwise. */
  function fileFor(req: Request, res: Response, fileId: string | undefined, opts: { manage?: boolean } = {}) {
    const file = fileId ? store.getFile(fileId) : null;
    if (!file || file.deleted) {
      fail(res, 400, 'file-not-found');
      return null;
    }
    const access = accessOf(userOf(req), file);
    if (!access || (opts.manage && access === 'shared')) {
      // Outsiders get the same answer as for a missing file.
      if (!access) fail(res, 400, 'file-not-found');
      else fail(res, 403, 'forbidden', 'Only the owner can do this');
      return null;
    }
    return { file, access };
  }

  const issueToken = (userId: string) => {
    const token = crypto.randomUUID();
    store.createSession(token, userId, config.tokenTtlDays);
    return token;
  };

  // ---------- health / info ----------

  app.get('/health', (_req, res) => res.json({ status: 'UP' }));
  app.get('/info', (_req, res) => ok(res, { build: { name: 'inthiseconomygenz-sync-server', version: VERSION }, loginMethod: config.loginMethod }));
  app.get('/metrics', (_req, res) =>
    res.json({ uptime: (Date.now() - metrics.startedAt) / 1000, requests: metrics.requests, syncs: metrics.syncs, memory: process.memoryUsage().rss }),
  );

  // ---------- account ----------

  app.get('/account/needs-bootstrap', (_req, res) =>
    ok(res, {
      bootstrapped: multiuser ? true : !!store.getPasswordHash(),
      loginMethod: multiuser ? 'multiuser' : config.loginMethod,
      availableLoginMethods: multiuser ? ['password', ...(openid ? ['openid'] : [])] : [config.loginMethod],
      multiuser,
      googleLogin: !!openid,
    }),
  );

  app.post('/account/bootstrap', json, (req, res) => {
    if (multiuser) return fail(res, 400, 'already-bootstrapped', 'This server already has an admin account');
    if (store.getPasswordHash()) return fail(res, 400, 'already-bootstrapped');
    const password = req.body?.password;
    if (typeof password !== 'string' || password.length < 1) return fail(res, 400, 'invalid-password');
    store.setPasswordHash(bcrypt.hashSync(password, 12));
    ok(res, { token: issueToken('owner') });
  });

  app.post('/account/login', json, (req, res) => {
    if (multiuser) {
      const userName = String(req.body?.userName ?? '').trim().toLowerCase();
      const password = String(req.body?.password ?? '');
      const key = `${userName}|${req.ip}`;
      if (limiter.blocked(key)) return fail(res, 429, 'too-many-attempts', 'Too many failed attempts. Try again in 5 minutes.');
      const user = userName ? store.getUserByEmail(userName) : null;
      // Always run bcrypt so response time doesn't reveal which usernames exist.
      const okPassword = bcrypt.compareSync(password, user?.password_hash ?? DUMMY_HASH);
      if (!user || !user.password_hash || !okPassword) {
        limiter.fail(key);
        return fail(res, 400, 'invalid-password', 'Wrong username or password');
      }
      if (!user.enabled) return fail(res, 400, 'user-disabled', 'This account is disabled');
      limiter.reset(key);
      store.updateUser(user.id, { last_login: Date.now() });
      return ok(res, { token: issueToken(user.id), mustChangePassword: !!user.must_change_password, user: publicUser(user) });
    }
    const hash = store.getPasswordHash();
    if (!hash) return fail(res, 400, 'not-bootstrapped');
    let password: string | undefined = req.body?.password;
    if (config.loginMethod === 'header') {
      // Only honour the header when the request came through a trusted proxy.
      const ip = req.socket.remoteAddress ?? '';
      if (!config.trustedProxies.includes(ip)) return fail(res, 401, 'untrusted-proxy');
      password = (req.headers[config.authHeader] as string) ?? password;
    }
    if (typeof password !== 'string' || !bcrypt.compareSync(password, hash)) return fail(res, 400, 'invalid-password');
    ok(res, { token: issueToken('owner') });
  });

  app.get('/account/validate', requireAuth, (req, res) => {
    const u = userOf(req);
    ok(res, { validated: true, userId: u.id, ...publicUser(u), loginMethod: config.loginMethod });
  });

  app.post('/account/logout', json, requireAuth, (req, res) => {
    store.deleteSession(req.headers['x-actual-token'] as string);
    ok(res);
  });

  app.post('/account/change-password', json, requireAuth, (req, res) => {
    if (multiuser) {
      const me = userOf(req);
      const password = String(req.body?.password ?? '');
      if (me.password_hash && !bcrypt.compareSync(String(req.body?.currentPassword ?? ''), me.password_hash))
        return fail(res, 400, 'invalid-password', 'Your current password is wrong');
      if (password.length < MIN_PASSWORD) return fail(res, 400, 'weak-password', `Use at least ${MIN_PASSWORD} characters`);
      if (me.password_hash && bcrypt.compareSync(password, me.password_hash)) return fail(res, 400, 'weak-password', 'Choose a password you haven’t used here');
      store.updateUser(me.id, { password_hash: bcrypt.hashSync(password, 12), must_change_password: 0 });
      // Sign out every other session of this user.
      const token = req.headers['x-actual-token'] as string;
      store.deleteUserSessions(me.id, token);
      return ok(res, { token, user: publicUser(store.getUser(me.id)!) });
    }
    const password = req.body?.password;
    if (typeof password !== 'string' || !password) return fail(res, 400, 'invalid-password');
    store.setPasswordHash(bcrypt.hashSync(password, 12));
    store.deleteAllSessions();
    ok(res, { token: issueToken('owner') });
  });

  // ---------- OpenID Connect (Google) ----------

  const allowedReturn = (url: string) => {
    try {
      const origin = new URL(url).origin;
      return [config.publicUrl, ...config.allowedOrigins].some(o => new URL(o).origin === origin);
    } catch {
      return false;
    }
  };

  app.get('/openid/login', async (req, res) => {
    if (!openid) return fail(res, 400, 'openid-not-configured', 'Google sign-in is not configured on this server');
    const returnUrl = String(req.query.returnUrl ?? config.publicUrl);
    if (!allowedReturn(returnUrl)) return fail(res, 400, 'invalid-return-url', 'This app address is not allowed to sign in to this server');
    const state = randomToken();
    const nonce = randomToken();
    const codeVerifier = randomToken(48);
    store.savePending({ state, nonce, codeVerifier, returnUrl });
    try {
      ok(res, { url: await openid.authorizationUrl({ state, nonce, codeVerifier }) });
    } catch (e: any) {
      fail(res, 502, 'openid-unreachable', e.message);
    }
  });

  const decideUser = (claims: { sub: string; email: string; name?: string; picture?: string }): UserRow | string => {
    const email = claims.email.toLowerCase();
    let user = store.getUserBySub(claims.sub);
    if (!user) {
      // First sign-in: match an invitation by email, or bootstrap the first admin.
      const invited = store.getUserByEmail(email);
      if (invited && invited.oidc_sub && invited.oidc_sub !== claims.sub) return 'account-mismatch';
      if (invited) {
        store.updateUser(invited.id, { oidc_sub: claims.sub });
        user = store.getUser(invited.id)!;
      } else if (config.allowedDomains.includes(email.split('@')[1] ?? '')) {
        user = store.createUser({ userName: email, displayName: claims.name, role: 'BASIC', sub: claims.sub, picture: claims.picture });
      } else {
        return 'not-invited';
      }
    }
    if (!user.enabled) return 'user-disabled';
    // A pending temporary password is moot once the user proves who they are with Google.
    if (user.must_change_password) store.updateUser(user.id, { password_hash: null, must_change_password: 0 });
    store.updateUser(user.id, {
      last_login: Date.now(),
      picture: claims.picture ?? user.picture,
      display_name: user.display_name ?? claims.name ?? null,
      user_name: email,
    });
    return store.getUser(user.id)!;
  };

  app.get('/openid/callback', async (req, res) => {
    const state = String(req.query.state ?? '');
    const pending = state ? store.takePending(state) : null;
    if (!pending) return res.status(400).send('This sign-in link has expired. Go back to inthiseconomygenz.id and try again.');
    const back = (params: Record<string, string>) => {
      const u = new URL('/openid-cb', pending.return_url);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      res.redirect(302, u.toString());
    };
    if (req.query.error) return back({ error: String(req.query.error) });
    if (!openid) return back({ error: 'openid-not-configured' });
    try {
      const claims = await openid.exchange(String(req.query.code ?? ''), pending.code_verifier, pending.nonce);
      const user = decideUser(claims);
      if (typeof user === 'string') return back({ error: user });
      back({ code: store.createLoginCode(user.id) });
    } catch (e: any) {
      back({ error: e instanceof OpenIdError ? e.reason : 'openid-failed' });
    }
  });

  app.post('/openid/exchange', json, (req, res) => {
    const userId = store.takeLoginCode(String(req.body?.code ?? ''));
    const user = userId ? store.getUser(userId) : null;
    if (!user || !user.enabled) return fail(res, 400, 'invalid-login-code', 'Sign-in expired; try again');
    ok(res, { token: issueToken(user.id), user: publicUser(user) });
  });

  // ---------- user directory (admin) ----------

  app.get('/admin/users', requireAuth, requireAdmin, (_req, res) => ok(res, store.listUsers().map(publicUser)));

  app.get('/admin/directory', requireAuth, (_req, res) =>
    ok(
      res,
      store
        .listUsers()
        .filter(u => u.enabled)
        .map(u => ({ id: u.id, userName: u.user_name, displayName: u.display_name, picture: u.picture })),
    ),
  );

  app.post('/admin/users', json, requireAuth, requireAdmin, (req, res) => {
    const { userName, displayName, role, enabled, password } = req.body ?? {};
    if (typeof userName !== 'string' || !USERNAME.test(userName.trim()))
      return fail(res, 400, 'invalid-username', 'Use an email address (needed for Google sign-in) or a username of 3+ letters, digits, dots or dashes');
    if (store.getUserByEmail(userName.trim())) return fail(res, 400, 'user-exists', 'A user with this name already exists');
    if (password && String(password).length < MIN_PASSWORD) return fail(res, 400, 'weak-password', `Use at least ${MIN_PASSWORD} characters`);
    const u = store.createUser({
      userName: userName.trim(),
      displayName: displayName || null,
      role: role === 'ADMIN' ? 'ADMIN' : 'BASIC',
      enabled: enabled !== false,
      // An admin-set password is temporary: the user picks their own at first login.
      passwordHash: password ? bcrypt.hashSync(String(password), 12) : null,
      mustChangePassword: !!password,
    });
    ok(res, publicUser(u));
  });

  app.post('/admin/users/set-password', json, requireAuth, requireAdmin, (req, res) => {
    const u = store.getUser(req.body?.id);
    if (!u || u.id === 'owner') return fail(res, 400, 'user-not-found');
    const password = req.body?.password;
    if (password === null) {
      if (!u.oidc_sub) return fail(res, 400, 'no-login-left', 'This user has no Google sign-in; removing the password would lock them out');
      store.updateUser(u.id, { password_hash: null, must_change_password: 0 });
    } else {
      if (typeof password !== 'string' || password.length < MIN_PASSWORD) return fail(res, 400, 'weak-password', `Use at least ${MIN_PASSWORD} characters`);
      const self = u.id === userOf(req).id;
      store.updateUser(u.id, { password_hash: bcrypt.hashSync(password, 12), must_change_password: self ? 0 : 1 });
      if (!self) store.deleteUserSessions(u.id);
    }
    ok(res, publicUser(store.getUser(u.id)!));
  });

  app.post('/admin/users/update', json, requireAuth, requireAdmin, (req, res) => {
    const { id, displayName, role, enabled } = req.body ?? {};
    const u = store.getUser(id);
    if (!u || u.id === 'owner') return fail(res, 400, 'user-not-found');
    const demoting = (role !== undefined && role !== 'ADMIN') || enabled === false;
    if (demoting && u.role === 'ADMIN' && u.enabled && store.countEnabledAdmins() <= 1) return fail(res, 400, 'last-admin', 'The server needs at least one enabled admin');
    store.updateUser(id, {
      display_name: displayName === undefined ? undefined : displayName || null,
      role: role === undefined ? undefined : role === 'ADMIN' ? 'ADMIN' : 'BASIC',
      enabled: enabled === undefined ? undefined : enabled ? 1 : 0,
    });
    ok(res, publicUser(store.getUser(id)!));
  });

  app.post('/admin/users/delete', json, requireAuth, requireAdmin, (req, res) => {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const me = userOf(req);
    if (ids.includes(me.id)) return fail(res, 400, 'cannot-delete-self', 'You cannot delete your own account');
    const admins = ids.map(id => store.getUser(id)).filter(u => u?.role === 'ADMIN' && u.enabled).length;
    if (admins && store.countEnabledAdmins() - admins < 1) return fail(res, 400, 'last-admin', 'The server needs at least one enabled admin');
    for (const id of ids) if (store.getUser(id) && id !== 'owner') store.deleteUser(id, me.id);
    ok(res);
  });

  // ---------- file access ----------

  app.get('/admin/access', requireAuth, (req, res) => {
    const f = fileFor(req, res, String(req.query.fileId ?? ''), { manage: true });
    if (!f) return;
    const owner = store.getUser(f.file.owner ?? 'owner');
    ok(res, { owner: owner ? publicUser(owner) : null, users: store.fileCollaborators(f.file.id).map(publicUser) });
  });

  app.post('/admin/access/grant', json, requireAuth, (req, res) => {
    const f = fileFor(req, res, req.body?.fileId, { manage: true });
    if (!f) return;
    const target = store.getUser(req.body?.userId);
    if (!target || !target.enabled) return fail(res, 400, 'user-not-found');
    if ((f.file.owner ?? 'owner') !== target.id) store.grantAccess(f.file.id, target.id);
    ok(res);
  });

  app.post('/admin/access/revoke', json, requireAuth, (req, res) => {
    const f = fileFor(req, res, req.body?.fileId, { manage: true });
    if (!f) return;
    store.revokeAccess(f.file.id, req.body?.userId);
    ok(res);
  });

  app.post('/admin/access/transfer', json, requireAuth, (req, res) => {
    const f = fileFor(req, res, req.body?.fileId, { manage: true });
    if (!f) return;
    const target = store.getUser(req.body?.newUserId);
    if (!target || !target.enabled) return fail(res, 400, 'user-not-found');
    const prev = f.file.owner ?? 'owner';
    store.upsertFile({ id: f.file.id, owner: target.id });
    store.revokeAccess(f.file.id, target.id);
    if (prev !== target.id && store.getUser(prev)) store.grantAccess(f.file.id, prev);
    ok(res);
  });

  // ---------- sync ----------

  app.post('/sync/sync', json, requireAuth, (req, res) => {
    const body = req.body as SyncRequest;
    if (!body?.fileId || !body.groupId || !Array.isArray(body.messages)) return fail(res, 400, 'invalid-request');
    const f = fileFor(req, res, body.fileId);
    if (!f) return;
    if (f.file.group_id !== body.groupId) return fail(res, 400, 'file-has-reset');
    if ((f.file.encrypt_keyid ?? null) !== (body.keyId ?? null)) return fail(res, 400, 'file-key-mismatch');
    metrics.syncs++;
    ok(res, store.sync(body.groupId, body.since ?? '', body.messages));
  });

  app.get('/sync/list-user-files', requireAuth, (req, res) => {
    const me = userOf(req);
    const names = new Map(store.listUsers().map(u => [u.id, u.display_name || u.user_name]));
    ok(
      res,
      store
        .listFiles()
        .map(f => ({ f, access: accessOf(me, f) }))
        .filter(x => x.access)
        .map(({ f, access }) => ({
          fileId: f.id,
          groupId: f.group_id,
          name: f.name,
          encryptKeyId: f.encrypt_keyid,
          deleted: !!f.deleted,
          updatedAt: f.updated_at,
          owner: f.owner ?? 'owner',
          ownerName: names.get(f.owner ?? 'owner') ?? null,
          access,
        })),
    );
  });

  app.get('/sync/get-user-file-info', requireAuth, (req, res) => {
    const f = fileFor(req, res, req.headers['x-actual-file-id'] as string);
    if (!f) return;
    ok(res, { fileId: f.file.id, groupId: f.file.group_id, name: f.file.name, encryptKeyId: f.file.encrypt_keyid, access: f.access, owner: f.file.owner });
  });

  app.post('/sync/upload-user-file', raw, requireAuth, (req, res) => {
    const fileId = req.headers['x-actual-file-id'] as string;
    const name = decodeURIComponent((req.headers['x-actual-name'] as string) ?? 'Budget');
    if (!fileId || !/^[\w-]+$/.test(fileId)) return fail(res, 400, 'invalid-file-id');
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return fail(res, 400, 'empty-file');
    let encryptMeta: { keyId?: string } | null = null;
    try {
      encryptMeta = req.headers['x-actual-encrypt-meta'] ? JSON.parse(req.headers['x-actual-encrypt-meta'] as string) : null;
    } catch {
      return fail(res, 400, 'invalid-encrypt-meta');
    }
    const cur = store.getFile(fileId);
    // Replacing an existing file resets sync for everyone: owner or admin only.
    if (cur && !cur.deleted && !fileFor(req, res, fileId, { manage: true })) return;
    if (cur && cur.deleted && cur.owner && cur.owner !== userOf(req).id && userOf(req).role !== 'ADMIN') return fail(res, 403, 'forbidden');
    if (cur && !cur.deleted && (cur.encrypt_keyid ?? null) !== (encryptMeta?.keyId ?? null)) return fail(res, 400, 'file-key-mismatch');
    // Every upload starts a new sync group: other devices must re-download.
    if (cur?.group_id) store.deleteGroup(cur.group_id);
    const groupId = crypto.randomUUID();
    store.writeSnapshot(fileId, req.body);
    store.upsertFile({ id: fileId, group_id: groupId, name, deleted: 0, owner: cur && !cur.deleted ? cur.owner ?? 'owner' : userOf(req).id });
    res.setHeader('x-actual-group-id', groupId);
    ok(res, { groupId });
  });

  app.get('/sync/download-user-file', requireAuth, (req, res) => {
    const fileId = req.headers['x-actual-file-id'] as string;
    const f = fileFor(req, res, fileId);
    if (!f) return;
    const data = store.readSnapshot(fileId);
    if (!data) return fail(res, 404, 'file-not-found');
    res.setHeader('content-type', 'application/octet-stream');
    res.send(data);
  });

  app.post('/sync/update-user-filename', json, requireAuth, (req, res) => {
    const f = fileFor(req, res, req.body?.fileId, { manage: true });
    if (!f) return;
    store.upsertFile({ id: f.file.id, name: String(req.body.name ?? f.file.name) });
    ok(res);
  });

  app.post('/sync/delete-user-file', json, requireAuth, (req, res) => {
    const f = fileFor(req, res, req.body?.fileId, { manage: true });
    if (!f) return;
    if (f.file.group_id) store.deleteGroup(f.file.group_id);
    store.upsertFile({ id: f.file.id, deleted: 1, group_id: null });
    ok(res);
  });

  app.post('/sync/user-create-key', json, requireAuth, (req, res) => {
    const { fileId, keyId, keySalt, testContent } = req.body ?? {};
    const f = fileFor(req, res, fileId, { manage: true });
    if (!f) return;
    if (!keyId || !keySalt || !testContent) return fail(res, 400, 'invalid-request');
    store.upsertFile({ id: fileId, encrypt_keyid: keyId, encrypt_salt: keySalt, encrypt_test: testContent });
    ok(res);
  });

  app.post('/sync/user-get-key', json, requireAuth, (req, res) => {
    const f = fileFor(req, res, req.body?.fileId);
    if (!f) return;
    if (!f.file.encrypt_keyid) return fail(res, 400, 'file-not-found');
    ok(res, { id: f.file.encrypt_keyid, salt: f.file.encrypt_salt, test: f.file.encrypt_test });
  });

  // ---------- CORS proxy (browser bank-sync and update checks) ----------

  app.get('/cors-proxy', requireAuth, async (req, res) => {
    const url = String(req.query.url ?? '');
    if (!/^https:\/\//.test(url)) return fail(res, 400, 'invalid-url');
    try {
      const r = await fetch(url);
      res.status(r.status).setHeader('content-type', r.headers.get('content-type') ?? 'text/plain');
      res.send(Buffer.from(await r.arrayBuffer()));
    } catch {
      fail(res, 502, 'proxy-failure');
    }
  });

  // ---------- web app ----------

  if (config.webRoot && fs.existsSync(path.join(config.webRoot, 'index.html'))) {
    const root = config.webRoot;
    app.use(express.static(root, { index: false, maxAge: '1h' }));
    // Every other GET is an app route (e.g. /accounts/123): serve the SPA. API prefixes match whole segments only.
    app.get(/^\/(?!(?:sync|account|admin|cors-proxy)(?:\/|$)|openid\/(?:login|callback|exchange)(?:\/|$|\?)).*/, (_req, res) =>
      res.sendFile(path.join(root, 'index.html')),
    );
  }

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err?.type === 'entity.too.large') return fail(res, 413, 'file-too-large');
    console.error(err);
    fail(res, 500, 'internal-error');
  });

  return { app, store, bootstrap };
}
