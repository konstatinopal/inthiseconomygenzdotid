// HTTP API for scripts and tools that can only make web requests (curl,
// Zapier, phone shortcuts). It signs in to the sync server as one account,
// keeps local copies of that account's budgets, and turns each request into
// the same engine calls the app makes: sync before reads, sync after writes.
import express, { type NextFunction, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import { currentPeriod, dates, normalizeStartDay, parseAmount, periodRange } from '@envelope/core';
import type { init } from '@envelope/api';

type Api = Awaited<ReturnType<typeof init>>;

export interface HttpApiOptions {
  api: Api;
  /** Bearer tokens accepted from callers. */
  apiKeys: string[];
  /** Encryption password for end-to-end encrypted budgets, if any. */
  keyPassword?: string;
  /** Re-sync before a read when the last sync is older than this (ms). */
  freshness?: number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const MAX_BATCH = 1000;

/** Requests share one engine, so they run one at a time. */
function serial() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
}

const sha = (s: string) => crypto.createHash('sha256').update(s).digest();

export function createHttpApi(opts: HttpApiOptions) {
  if (!opts.apiKeys.length) throw new Error('At least one API key is required (ENVELOPE_API_KEYS)');
  const { api } = opts;
  const keyHashes = opts.apiKeys.map(sha);
  const queue = serial();
  const freshness = opts.freshness ?? 2000;
  let lastSync = 0;
  let cloudCache: { at: number; files: any[] } | null = null;

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  // ---------- auth ----------

  function requireKey(req: Request, res: Response, next: NextFunction) {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : String(req.headers['x-api-key'] ?? '');
    const h = sha(token);
    // Constant-time comparison against every key.
    const ok = token && keyHashes.some(k => crypto.timingSafeEqual(k, h));
    if (!ok) return res.status(401).json({ error: { code: 'unauthorized', message: 'Send a valid API key: Authorization: Bearer <key>' } });
    next();
  }

  // ---------- budget selection ----------

  async function cloudFiles(force = false) {
    if (!force && cloudCache && Date.now() - cloudCache.at < 30_000) return cloudCache.files;
    const files = await api.getCloudBudgets();
    cloudCache = { at: Date.now(), files };
    return files;
  }

  /** Open the budget named or identified in the URL, downloading it the first time. */
  async function openBudget(ref: string, forRead: boolean) {
    let files = await cloudFiles();
    const match = (list: any[]) => list.find(f => f.fileId === ref) ?? list.filter(f => f.name.toLowerCase() === ref.toLowerCase());
    let hit = match(files);
    if (Array.isArray(hit) && hit.length === 0) {
      files = await cloudFiles(true);
      hit = match(files);
    }
    if (Array.isArray(hit)) {
      if (hit.length === 0) throw new HttpError(404, 'budget-not-found', `No budget "${ref}" is available to this API's account`);
      if (hit.length > 1) throw new HttpError(409, 'ambiguous-budget', `Several budgets are named "${ref}"; use its id: ${hit.map(f => f.fileId).join(', ')}`);
      hit = hit[0];
    }
    const engine = api.engine;
    if (engine.meta?.cloudFileId === hit.fileId) {
      if (forRead && Date.now() - lastSync > freshness) await syncNow();
      return hit;
    }
    const local = (await api.getBudgets()).find((m: any) => m.cloudFileId === hit.fileId && m.groupId === hit.groupId);
    if (local) {
      await api.loadBudget(local.id);
      await syncNow();
    } else {
      try {
        await api.downloadBudget(hit.fileId, opts.keyPassword);
      } catch (e: any) {
        if (e.reason === 'missing-key') throw new HttpError(423, 'budget-encrypted', 'This budget is end-to-end encrypted; set ENVELOPE_KEY_PASSWORD for the API service');
        throw e;
      }
      lastSync = Date.now();
    }
    return hit;
  }

  async function syncNow() {
    try {
      await api.sync();
      lastSync = Date.now();
      return true;
    } catch (e: any) {
      // A reset on another device means our copy is stale: download it again.
      if (/reset|re-download/i.test(e.message)) {
        const meta = api.engine.meta;
        if (meta?.cloudFileId) {
          await api.send('file-delete', { id: meta.id });
          await api.downloadBudget(meta.cloudFileId, opts.keyPassword);
          lastSync = Date.now();
          return true;
        }
      }
      throw new HttpError(502, 'sync-failed', e.message);
    }
  }

  /** Writes are applied locally first; a failed upload is retried on the next request. */
  async function syncAfterWrite() {
    try {
      return await syncNow();
    } catch {
      return false;
    }
  }

  // ---------- name / id resolution ----------

  async function lookups() {
    const [accounts, groups, payees] = await Promise.all([api.send('accounts-get'), api.send('categories-get'), api.send('payees-get')]);
    const categories = groups.flatMap((g: any) => g.categories.map((c: any) => ({ ...c, group_name: g.name })));
    return { accounts, categories, payees };
  }

  function resolve(kind: string, list: { id: string; name: string }[], value: unknown, required: boolean): string | null {
    if (value === undefined || value === null || value === '') {
      if (required) throw new HttpError(400, 'invalid-request', `"${kind}" is required`);
      return null;
    }
    const v = String(value);
    const byId = list.find(x => x.id === v);
    if (byId) return byId.id;
    const byName = list.filter(x => x.name.toLowerCase() === v.toLowerCase());
    if (byName.length === 1) return byName[0].id;
    if (byName.length > 1) throw new HttpError(400, 'ambiguous-name', `Several ${kind}s are named "${v}"; use an id: ${byName.map(x => x.id).join(', ')}`);
    throw new HttpError(404, `${kind}-not-found`, `No ${kind} "${v}". GET /v1/budgets/<budget>/${kind === 'category' ? 'categories' : kind + 's'} lists them`);
  }

  function toCents(value: unknown, field: string): number {
    if (typeof value === 'number') {
      if (!Number.isInteger(value)) throw new HttpError(400, 'invalid-amount', `"${field}" as a number is integer cents (e.g. -4520); send a string for decimals ("-45.20")`);
      return value;
    }
    if (typeof value === 'string') {
      const c = parseAmount(value);
      if (c === null) throw new HttpError(400, 'invalid-amount', `"${field}" is not an amount: ${value}`);
      return c;
    }
    throw new HttpError(400, 'invalid-amount', `"${field}" is required: integer cents (-4520) or a decimal string ("-45.20")`);
  }

  function checkDate(d: unknown, field = 'date'): string {
    if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d) || isNaN(Date.parse(d + 'T00:00:00Z')) || new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) !== d)
      throw new HttpError(400, 'invalid-date', `"${field}" must be a date like 2026-10-13`);
    return d;
  }

  type L = Awaited<ReturnType<typeof lookups>>;

  /** Request body → engine transaction. Accepts names or ids for account, payee and category. */
  function toEngineTxn(t: any, l: L, defaultAccount: string | null, i: number) {
    if (!t || typeof t !== 'object') throw new HttpError(400, 'invalid-request', `transactions[${i}] must be an object`);
    const account = resolve('account', l.accounts, t.account ?? defaultAccount, true)!;
    const out: any = {
      account,
      date: checkDate(t.date ?? new Date().toISOString().slice(0, 10), `transactions[${i}].date`),
      amount: toCents(t.amount, `transactions[${i}].amount`),
      notes: t.notes ?? null,
      cleared: t.cleared === undefined ? undefined : !!t.cleared,
      imported_id: t.imported_id ?? undefined,
      imported_payee: t.imported_payee ?? undefined,
    };
    if (t.payee !== undefined && t.payee !== null) {
      const existing = l.payees.find((p: any) => p.id === t.payee);
      if (existing) out.payee = existing.id;
      else out.payee_name = String(t.payee);
    }
    if (t.category !== undefined && t.category !== null) out.category = resolve('category', l.categories, t.category, false);
    if (Array.isArray(t.subtransactions) && t.subtransactions.length) {
      out.subtransactions = t.subtransactions.map((s: any, j: number) => ({
        amount: toCents(s.amount, `transactions[${i}].subtransactions[${j}].amount`),
        category: resolve('category', l.categories, s.category, false),
        notes: s.notes ?? null,
        ...(s.payee ? { payee_name: String(s.payee) } : {}),
      }));
      const sum = out.subtransactions.reduce((a: number, s: any) => a + s.amount, 0);
      if (sum !== out.amount) throw new HttpError(400, 'split-mismatch', `transactions[${i}]: split amounts add up to ${sum}, not ${out.amount}`);
    }
    return out;
  }

  function present(t: any, l: L) {
    const name = (list: any[], id: string | null) => (id ? list.find(x => x.id === id)?.name ?? null : null);
    const payeeName = (id: string | null) => {
      const p = id ? l.payees.find((x: any) => x.id === id) : null;
      if (!p) return null;
      return p.transfer_acct ? `Transfer: ${name(l.accounts, p.transfer_acct)}` : p.name;
    };
    return {
      id: t.id,
      date: t.date,
      amount: t.amount,
      account: t.account,
      account_name: name(l.accounts, t.account),
      payee: t.payee,
      payee_name: payeeName(t.payee),
      category: t.category,
      category_name: name(l.categories, t.category),
      notes: t.notes,
      cleared: t.cleared,
      reconciled: t.reconciled,
      imported_id: t.imported_id,
      transfer_id: t.transfer_id,
      ...(t.subtransactions
        ? { subtransactions: t.subtransactions.map((s: any) => ({ id: s.id, amount: s.amount, category: s.category, category_name: name(l.categories, s.category), notes: s.notes })) }
        : {}),
    };
  }

  // ---------- routes ----------

  const route =
    (fn: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response) =>
      queue(() => fn(req, res)).catch((e: any) => {
        const status = e instanceof HttpError ? e.status : 500;
        if (status === 500) console.error(e);
        if (!res.headersSent)
          res.status(status).json({ error: { code: e instanceof HttpError ? e.code : 'internal-error', message: e.message ?? String(e) } });
      });

  app.get('/health', (_req, res) => res.json({ status: 'UP' }));

  app.use('/v1', requireKey);

  app.get(
    '/v1/budgets',
    route(async (_req, res) => {
      const files = await cloudFiles(true);
      res.json({ data: files.map((f: any) => ({ id: f.fileId, name: f.name, encrypted: !!f.encryptKeyId, access: f.access ?? 'owner' })) });
    }),
  );

  app.get(
    '/v1/budgets/:budget/accounts',
    route(async (req, res) => {
      await openBudget(String(req.params.budget), true);
      const accounts = await api.send('accounts-get');
      res.json({
        data: accounts.map((a: any) => ({ id: a.id, name: a.name, offbudget: a.offbudget, closed: a.closed, balance: a.balance, cleared: a.cleared, uncleared: a.uncleared })),
      });
    }),
  );

  app.get(
    '/v1/budgets/:budget/categories',
    route(async (req, res) => {
      await openBudget(String(req.params.budget), true);
      const groups = await api.send('categories-get');
      res.json({
        data: groups.map((g: any) => ({ id: g.id, name: g.name, is_income: g.is_income, hidden: g.hidden, categories: g.categories.map((c: any) => ({ id: c.id, name: c.name, hidden: c.hidden })) })),
      });
    }),
  );

  app.get(
    '/v1/budgets/:budget/payees',
    route(async (req, res) => {
      await openBudget(String(req.params.budget), true);
      const payees = await api.send('payees-get');
      res.json({ data: payees.filter((p: any) => !p.transfer_acct).map((p: any) => ({ id: p.id, name: p.name, favorite: p.favorite })) });
    }),
  );

  app.get(
    '/v1/budgets/:budget/transactions',
    route(async (req, res) => {
      await openBudget(String(req.params.budget), true);
      const l = await lookups();
      const q = req.query;
      const account = q.account ? resolve('account', l.accounts, q.account, false) : null;
      const category = q.category ? resolve('category', l.categories, q.category, false) : undefined;
      const limit = Math.min(Math.max(1, Number(q.limit ?? 100) || 100), 5000);
      const txns = await api.send('transactions-get', {
        account,
        category,
        startDate: q.since ? checkDate(q.since, 'since') : undefined,
        endDate: q.until ? checkDate(q.until, 'until') : undefined,
        search: q.search ? String(q.search) : undefined,
      });
      res.json({ data: txns.slice(0, limit).map((t: any) => present(t, l)), total: txns.length });
    }),
  );

  app.get(
    '/v1/budgets/:budget/transactions/:id',
    route(async (req, res) => {
      await openBudget(String(req.params.budget), true);
      const t = await api.send('transaction-get', { id: String(req.params.id) });
      if (!t) throw new HttpError(404, 'transaction-not-found', 'No such transaction');
      res.json({ data: present(t, await lookups()) });
    }),
  );

  app.post(
    '/v1/budgets/:budget/transactions',
    route(async (req, res) => {
      await openBudget(String(req.params.budget), false);
      const body = req.body ?? {};
      const list: any[] = Array.isArray(body.transactions) ? body.transactions : Array.isArray(body) ? body : [body];
      if (!list.length) throw new HttpError(400, 'invalid-request', 'Send a transaction, or {"transactions": [...]}');
      if (list.length > MAX_BATCH) throw new HttpError(413, 'too-many', `At most ${MAX_BATCH} transactions per request`);
      const l = await lookups();
      const defaultAccount = body.account ?? null;
      const txns = list.map((t, i) => toEngineTxn(t, l, defaultAccount, i));
      const dedupe = body.dedupe === true || req.query.dedupe === 'true';
      let added: string[];
      let matched: string[] = [];
      if (dedupe) {
        // The import pipeline: rules, then match by imported_id or amount ±7 days.
        added = [];
        const byAccount = new Map<string, any[]>();
        for (const t of txns) byAccount.set(t.account, [...(byAccount.get(t.account) ?? []), t]);
        for (const [account, rows] of byAccount) {
          const r = await api.send('import-reconcile', {
            account,
            transactions: rows.map(t => ({ date: t.date, amount: t.amount, payee_name: t.payee_name ?? null, notes: t.notes, imported_id: t.imported_id ?? null, imported_payee: t.imported_payee ?? t.payee_name ?? null })),
            options: {},
          });
          // The import pipeline only takes flat bank rows; give new rows the
          // category, payee id and splits the caller sent.
          const fresh = r.preview.filter((p: any) => p.status === 'new');
          if (fresh.length === r.added.length) {
            for (let k = 0; k < fresh.length; k++) {
              const src = rows[fresh[k].index];
              const fix: any = { id: r.added[k] };
              if (src.payee) fix.payee = src.payee;
              if (src.category && !src.subtransactions) fix.category = src.category;
              if (src.subtransactions) fix.subtransactions = src.subtransactions;
              if (src.cleared !== undefined) fix.cleared = src.cleared;
              if (Object.keys(fix).length > 1) await api.send('transaction-update', fix);
            }
          }
          added.push(...r.added);
          matched.push(...r.updated);
        }
      } else {
        const r = await api.send('transactions-batch', { added: txns });
        added = r.added.filter(Boolean);
      }
      const synced = await syncAfterWrite();
      const created = await api.send('transactions-get', { ids: added });
      // Re-read names: the request may have created payees.
      const fresh = await lookups();
      res.status(201).json({ data: created.map((t: any) => present(t, fresh)), added: added.length, matched: matched.length, synced });
    }),
  );

  app.patch(
    '/v1/budgets/:budget/transactions/:id',
    route(async (req, res) => {
      await openBudget(String(req.params.budget), false);
      const id = String(req.params.id);
      const cur = await api.send('transaction-get', { id });
      if (!cur) throw new HttpError(404, 'transaction-not-found', 'No such transaction');
      const l = await lookups();
      const b = req.body ?? {};
      const patch: any = { id };
      if (b.date !== undefined) patch.date = checkDate(b.date);
      if (b.amount !== undefined) patch.amount = toCents(b.amount, 'amount');
      if (b.notes !== undefined) patch.notes = b.notes;
      if (b.cleared !== undefined) patch.cleared = !!b.cleared;
      if (b.account !== undefined) patch.account = resolve('account', l.accounts, b.account, true);
      if (b.category !== undefined) patch.category = b.category === null ? null : resolve('category', l.categories, b.category, false);
      if (b.payee !== undefined) {
        const existing = l.payees.find((p: any) => p.id === b.payee);
        if (b.payee === null) patch.payee = null;
        else if (existing) patch.payee = existing.id;
        else patch.payee_name = String(b.payee);
      }
      await api.send('transaction-update', patch);
      const synced = await syncAfterWrite();
      res.json({ data: present(await api.send('transaction-get', { id }), await lookups()), synced });
    }),
  );

  app.delete(
    '/v1/budgets/:budget/transactions/:id',
    route(async (req, res) => {
      await openBudget(String(req.params.budget), false);
      const id = String(req.params.id);
      if (!(await api.send('transaction-get', { id }))) throw new HttpError(404, 'transaction-not-found', 'No such transaction');
      await api.send('transaction-delete', { id });
      const synced = await syncAfterWrite();
      res.json({ deleted: id, synced });
    }),
  );

  app.get(
    '/v1/budgets/:budget/months/:month',
    route(async (req, res) => {
      const month = String(req.params.month);
      if (!/^\d{4}-\d{2}$/.test(month)) throw new HttpError(400, 'invalid-month', 'Month must look like 2026-10');
      await openBudget(String(req.params.budget), true);
      const l = await lookups();
      const m = await api.send('budget-month', { month });
      const prefs = await api.send('prefs-get');
      const { start, end } = periodRange(month, normalizeStartDay(prefs.monthStartDay ?? 1));
      res.json({
        data: {
          month,
          start,
          end,
          to_budget: m.toBudget,
          income: m.income,
          budgeted: m.totalBudgeted,
          spent: m.totalSpent,
          balance: m.totalBalance,
          categories: l.categories.map((c: any) => ({ id: c.id, name: c.name, group: c.group_name, ...(m.categories[c.id] ?? {}) })),
        },
      });
    }),
  );

  // One call with everything an assistant needs to reason about a period:
  // names to map free text onto, where the money went, and recent activity.
  // Amounts here are in currency units (e.g. 25000 for Rp25.000), not cents.
  app.get(
    '/v1/budgets/:budget/summary',
    route(async (req, res) => {
      await openBudget(String(req.params.budget), true);
      const prefs = await api.send('prefs-get');
      const startDay = normalizeStartDay(prefs.monthStartDay ?? 1);
      const month = req.query.month ? String(req.query.month) : currentPeriod(startDay);
      if (!/^\d{4}-\d{2}$/.test(month)) throw new HttpError(400, 'invalid-month', 'month must look like 2026-10');
      const { start, end } = periodRange(month, startDay);
      const prev = dates.addMonths(month, -1);
      const units = (c: number) => Math.round(c) / 100;
      const [l, m, pm, txns, groups] = await Promise.all([
        lookups(),
        api.send('budget-month', { month }),
        api.send('budget-month', { month: prev }),
        api.send('transactions-get', { startDate: start, endDate: end }),
        api.send('categories-get'),
      ]);
      const name = (list: any[], id: string | null) => (id ? list.find(x => x.id === id)?.name ?? null : null);
      // Spending by payee, splits included, transfers excluded.
      const byPayee = new Map<string, number>();
      for (const t of txns) {
        if (t.transfer_id) continue;
        const parts = t.subtransactions?.length ? t.subtransactions.map((s: any) => ({ ...s, payee: s.payee ?? t.payee })) : [t];
        for (const p of parts) {
          if (p.amount >= 0) continue;
          const n = name(l.payees, p.payee) ?? 'No payee';
          byPayee.set(n, (byPayee.get(n) ?? 0) - p.amount);
        }
      }
      const payeeName = (id: string | null) => {
        const p = id ? l.payees.find((x: any) => x.id === id) : null;
        return p ? (p.transfer_acct ? `Transfer: ${name(l.accounts, p.transfer_acct)}` : p.name) : null;
      };
      res.json({
        data: {
          month,
          start,
          end,
          today: dates.today(),
          month_start_day: startDay,
          amounts_in: 'currency units (not cents)',
          currency_symbol: prefs.currencySymbol ?? null,
          budget_type: prefs.budgetType ?? 'envelope',
          totals: {
            to_budget: units(m.toBudget),
            income: units(m.income),
            budgeted: units(m.totalBudgeted),
            spent: units(-m.totalSpent),
            available_in_categories: units(m.totalBalance),
          },
          previous_period: { month: prev, income: units(pm.income), spent: units(-pm.totalSpent) },
          accounts: l.accounts
            .filter((a: any) => !a.closed)
            .map((a: any) => ({ name: a.name, type: a.offbudget ? 'off-budget' : 'on-budget', balance: units(a.balance) })),
          categories: groups.flatMap((g: any) =>
            g.categories
              .filter((c: any) => !c.hidden && !g.hidden)
              .map((c: any) => {
                const v = m.categories[c.id] ?? { budgeted: 0, spent: 0, balance: 0 };
                return g.is_income
                  ? { group: g.name, name: c.name, income: true, received: units(v.spent) }
                  : { group: g.name, name: c.name, budgeted: units(v.budgeted), spent: units(-v.spent), balance: units(v.balance), overspent: v.balance < 0 };
              }),
          ),
          top_payees: [...byPayee.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([payee, spent]) => ({ payee, spent: units(spent) })),
          recent_transactions: txns.slice(0, 20).map((t: any) => ({
            date: t.date,
            account: name(l.accounts, t.account),
            payee: payeeName(t.payee),
            category: t.subtransactions?.length ? 'Split' : name(l.categories, t.category),
            amount: units(t.amount),
            notes: t.notes,
          })),
          transaction_count: txns.length,
        },
      });
    }),
  );

  app.use((_req, res) => res.status(404).json({ error: { code: 'not-found', message: 'Unknown endpoint; see GET /v1/budgets' } }));
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'invalid-json', message: 'Body is not valid JSON' } });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: { code: 'too-large', message: 'Body too large' } });
    console.error(err);
    res.status(500).json({ error: { code: 'internal-error', message: 'Internal error' } });
  });

  return app;
}
