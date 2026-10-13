// Node API: the same core engine the UI uses, with filesystem storage.
//
//   const api = await init({ dataDir: './budgets', serverURL: 'http://localhost:5006', password: '…' });
//   await api.downloadBudget(cloudFileId);
//   await api.addTransactions(accountId, [{ date: '2026-10-01', amount: -1250, payee_name: 'Cafe' }]);
//   await api.shutdown();
import initSqlJs from 'sql.js';
import { Engine, q, type QueryState } from '@envelope/core';
import { createFsStorage } from '@envelope/core/src/platform/fs';

export { q };

export interface InitOptions {
  dataDir: string;
  serverURL?: string;
  /** Your username or email on a multi-user server; omit for a shared-password server. */
  userName?: string;
  password?: string;
}

export async function init(opts: InitOptions) {
  const engine = new Engine({ storage: await createFsStorage(opts.dataDir), sqlJs: await initSqlJs(), timers: false, syncDelay: 200 });
  await engine.init();
  if (opts.serverURL) {
    await engine.send('server-set-url', { url: opts.serverURL });
    if (opts.password) {
      const r = await engine.send('server-login', { userName: opts.userName, password: opts.password });
      if (r?.mustChangePassword) throw new Error('This account has a temporary password. Sign in to the web app once to choose your own.');
    }
  }
  const send = (name: string, args?: unknown) => engine.send(name, args);
  // Scripts must know when their changes did not reach the server.
  const sync = async () => {
    const status = await engine.sync();
    if (status.state === 'error' || status.state === 'offline') throw new Error(`Sync failed: ${status.error ?? status.state}`);
    return status;
  };
  /** Find an account, category or payee id by its name (case-insensitive). */
  const getIDByName = async (type: 'accounts' | 'categories' | 'payees', name: string): Promise<string> => {
    const list: { id: string; name: string }[] =
      type === 'accounts' ? await send('accounts-get') : type === 'payees' ? await send('payees-get') : (await send('categories-get')).flatMap((g: any) => g.categories);
    const hit = list.find(x => x.name.toLowerCase() === name.toLowerCase());
    if (!hit) throw new Error(`No ${type.replace(/ies$/, 'y').replace(/s$/, '')} named "${name}"`);
    return hit.id;
  };
  return {
    engine,
    send,
    // lifecycle
    getBudgets: () => send('files-list'),
    getCloudBudgets: () => send('cloud-files-list'),
    loadBudget: (id: string) => send('file-load', { id }),
    downloadBudget: (cloudFileId: string, password?: string) => send('cloud-file-download', { cloudFileId, password }),
    createBudget: (name: string) => send('file-create', { name }),
    uploadBudget: () => send('file-upload'),
    sync,
    getIDByName,
    shutdown: async () => {
      if (engine.isCloudFile()) await sync();
      await engine.closeFile();
    },
    // budget
    getBudgetMonth: (month: string) => send('budget-month', { month }),
    setBudgetAmount: (month: string, category: string, amount: number) => send('budget-set-amount', { month, category, amount }),
    setBudgetCarryover: (month: string, category: string, flag: boolean) => send('budget-set-carryover', { month, category, flag }),
    holdBudgetForNextMonth: (month: string, amount: number) => send('budget-hold', { month, amount }),
    resetBudgetHold: (month: string) => send('budget-reset-hold', { month }),
    // transactions
    addTransactions: (account: string, txns: any[]) => send('transactions-batch', { added: txns.map(t => ({ ...t, account })) }),
    importTransactions: (account: string, txns: any[], options: any = {}) => send('import-reconcile', { account, transactions: txns, options }),
    getTransactions: (account: string | null, startDate?: string, endDate?: string) => send('transactions-get', { account, startDate, endDate }),
    updateTransaction: (id: string, fields: any) => send('transaction-update', { id, ...fields }),
    deleteTransaction: (id: string) => send('transaction-delete', { id }),
    // entities
    getAccounts: () => send('accounts-get'),
    createAccount: (account: { name: string; offbudget?: boolean }, initialBalance = 0) => send('account-create', { ...account, balance: initialBalance }),
    closeAccount: (id: string, transferAccountId?: string, categoryId?: string) => send('account-close', { id, transferAccountId, categoryId }),
    getCategoryGroups: () => send('categories-get'),
    createCategory: (c: { name: string; group: string }) => send('category-create', c),
    getPayees: () => send('payees-get'),
    getRules: () => send('rules-get'),
    createRule: (rule: any) => send('rule-create', rule),
    getSchedules: () => send('schedules-get'),
    createSchedule: (s: any) => send('schedule-create', s),
    // query
    runQuery: (query: { serialize(): QueryState }) => send('query', { query: query.serialize() }),
  };
}
