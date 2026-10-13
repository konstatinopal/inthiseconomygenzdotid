import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AccountEntity, CategoryGroupEntity, FileMeta, PayeeEntity, SyncStatus } from '@envelope/core';
import { formatAmount, type NumberFormat } from '@envelope/core';
import { listen, send } from './client';
import { useLocalStorage, useQuery } from './hooks';

export type Theme = 'light' | 'dark' | 'midnight' | 'system';

export interface Toast {
  id: number;
  level: 'info' | 'error' | 'success';
  message: string;
  action?: { label: string; run: () => void };
}

export interface Prefs {
  numberFormat?: NumberFormat;
  hideFraction?: boolean;
  currencySymbol?: string;
  symbolPosition?: 'before' | 'after';
  symbolSpace?: boolean;
  dateFormat?: string;
  firstDayOfWeek?: number;
  budgetType?: 'envelope' | 'tracking';
  upcomingScheduledTransactionLength?: number;
  learnCategories?: boolean;
  [key: string]: any;
}

interface AppState {
  file: FileMeta | null;
  fileLoading: boolean;
  sync: SyncStatus;
  prefs: Prefs;
  setPref: (id: string, value: unknown) => Promise<void>;
  theme: Theme;
  setTheme: (t: Theme) => void;
  privacy: boolean;
  setPrivacy: (v: boolean) => void;
  toasts: Toast[];
  notify: (level: Toast['level'], message: string, action?: Toast['action']) => void;
  dismiss: (id: number) => void;
  fmt: (cents: number, opts?: { sign?: boolean }) => string;
  fmtDate: (date: string) => string;
  accounts: AccountEntity[];
  groups: CategoryGroupEntity[];
  payees: PayeeEntity[];
  categoryName: (id: string | null | undefined) => string;
  payeeName: (id: string | null | undefined) => string;
  accountName: (id: string | null | undefined) => string;
}

const Ctx = createContext<AppState | null>(null);

export function useApp() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside provider');
  return v;
}

let toastId = 0;

export function formatDateWith(date: string, fmt = 'MM/dd/yyyy') {
  if (!date) return '';
  const [y, m, d] = date.split('-');
  return fmt.replace('yyyy', y).replace('MM', m).replace('dd', d);
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [file, setFile] = useState<FileMeta | null>(null);
  const [fileLoading, setFileLoading] = useState(true);
  const [sync, setSync] = useState<SyncStatus>({ state: 'disabled' });
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [theme, setTheme] = useLocalStorage<Theme>('theme', 'system');
  const [privacy, setPrivacy] = useLocalStorage<boolean>('privacy', false);

  const notify = useCallback((level: Toast['level'], message: string, action?: Toast['action']) => {
    const id = ++toastId;
    setToasts(t => [...t.slice(-4), { id, level, message, action }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), level === 'error' ? 8000 : 4000);
  }, []);
  const dismiss = useCallback((id: number) => setToasts(t => t.filter(x => x.id !== id)), []);

  useEffect(() => {
    const off = listen(e => {
      if (e.type === 'file-changed') setFile(e.meta);
      else if (e.type === 'sync-status') setSync(e.status);
      else if (e.type === 'notification') notify(e.level, e.message);
    });
    // Reopen the last budget on startup.
    (async () => {
      try {
        const cur = await send<FileMeta | null>('file-current');
        if (cur) setFile(cur);
        else {
          const last = localStorage.getItem('lastFile');
          if (last) {
            try {
              setFile(await send('file-load', { id: last }));
            } catch {
              localStorage.removeItem('lastFile');
            }
          }
        }
      } finally {
        setFileLoading(false);
      }
    })();
    return off;
  }, [notify]);

  useEffect(() => {
    try {
      if (file) localStorage.setItem('lastFile', file.id);
    } catch {
      /* ignore */
    }
  }, [file]);

  useEffect(() => {
    const apply = () => {
      const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const t = theme === 'system' ? (dark ? 'dark' : 'light') : theme;
      document.documentElement.dataset.theme = t;
    };
    apply();
    const m = window.matchMedia('(prefers-color-scheme: dark)');
    m.addEventListener('change', apply);
    return () => m.removeEventListener('change', apply);
  }, [theme]);

  useEffect(() => {
    document.documentElement.classList.toggle('privacy', privacy);
  }, [privacy]);

  const fileKey = file?.id ?? null;
  const prefsQ = useQuery<Prefs>(fileKey ? 'prefs-get' : null, {}, ['preferences'], [fileKey]);
  const accountsQ = useQuery<AccountEntity[]>(fileKey ? 'accounts-get' : null, {}, ['accounts', 'transactions'], [fileKey]);
  const groupsQ = useQuery<CategoryGroupEntity[]>(fileKey ? 'categories-get' : null, {}, ['categories', 'category_groups'], [fileKey]);
  const payeesQ = useQuery<PayeeEntity[]>(fileKey ? 'payees-get' : null, {}, ['payees', 'accounts', 'rules'], [fileKey]);

  const prefs = prefsQ.data ?? {};
  const setPref = useCallback(async (id: string, value: unknown) => {
    await send('pref-set', { id, value });
  }, []);

  const fmt = useCallback(
    (cents: number, opts: { sign?: boolean } = {}) => {
      const s = formatAmount(cents, {
        numberFormat: prefs.numberFormat,
        hideFraction: prefs.hideFraction,
        currencySymbol: prefs.currencySymbol,
        symbolPosition: prefs.symbolPosition,
        symbolSpace: prefs.symbolSpace,
      });
      return opts.sign && cents > 0 ? `+${s}` : s;
    },
    [prefs.numberFormat, prefs.hideFraction, prefs.currencySymbol, prefs.symbolPosition, prefs.symbolSpace],
  );
  const fmtDate = useCallback((d: string) => formatDateWith(d, prefs.dateFormat), [prefs.dateFormat]);

  const lookups = useMemo(() => {
    const cats = new Map<string, string>();
    for (const g of groupsQ.data ?? []) for (const c of g.categories) cats.set(c.id, c.name);
    const accts = new Map((accountsQ.data ?? []).map(a => [a.id, a.name]));
    const pays = new Map(
      (payeesQ.data ?? []).map(p => [p.id, p.transfer_acct ? `Transfer: ${accts.get(p.transfer_acct) ?? 'Account'}` : p.name]),
    );
    return {
      categoryName: (id: string | null | undefined) => (id ? cats.get(id) ?? '' : ''),
      payeeName: (id: string | null | undefined) => (id ? pays.get(id) ?? '' : ''),
      accountName: (id: string | null | undefined) => (id ? accts.get(id) ?? '' : ''),
    };
  }, [groupsQ.data, accountsQ.data, payeesQ.data]);

  const value: AppState = {
    file,
    fileLoading,
    sync,
    prefs,
    setPref,
    theme,
    setTheme,
    privacy,
    setPrivacy,
    toasts,
    notify,
    dismiss,
    fmt,
    fmtDate,
    accounts: accountsQ.data ?? [],
    groups: groupsQ.data ?? [],
    payees: payeesQ.data ?? [],
    ...lookups,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Run an engine call, surfacing failures as a toast. Returns undefined on error. */
export function useAction() {
  const { notify } = useApp();
  return useCallback(
    async <T,>(name: string, args?: unknown, success?: string): Promise<T | undefined> => {
      try {
        const r = await send<T>(name, args);
        if (success) notify('success', success);
        return r;
      } catch (e: any) {
        notify('error', e.message ?? String(e));
        return undefined;
      }
    },
    [notify],
  );
}
