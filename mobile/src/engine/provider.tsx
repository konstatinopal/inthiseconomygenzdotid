import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import type { FileMeta, SyncStatus } from '@envelope/core';
import { engine, send, startEngine, storage } from './index';

interface EngineState {
  ready: boolean;
  file: FileMeta | null;
  sync: SyncStatus;
  prefs: Record<string, any>;
  /** Bumped on every data change. */
  version: number;
  /** Per table: the version of its last change ('*' = a new file, everything changed). */
  tableVersions: Record<string, number>;
}

const initial: EngineState = { ready: false, file: null, sync: { state: 'disabled' }, prefs: {}, version: 0, tableVersions: {} };
const Ctx = createContext<EngineState>(initial);

// Record which tables changed, so no change is lost when several events arrive before a render.
const bump = (s: EngineState, tables: string[]): EngineState => {
  const version = s.version + 1;
  const tableVersions = { ...s.tableVersions };
  for (const t of tables) tableVersions[t] = version;
  return { ...s, version, tableVersions };
};

export function EngineProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<EngineState>(initial);

  useEffect(() => {
    // Synced preferences (currency, budget month start day, ...).
    const loadPrefs = () => {
      if (engine.db) void send('prefs-get').then(prefs => setState(s => ({ ...s, prefs })));
      else setState(s => ({ ...s, prefs: {} }));
    };
    const off = engine.on(e => {
      if (e.type === 'changed') {
        setState(s => bump(s, e.tables));
        if (e.tables.includes('preferences')) loadPrefs();
      } else if (e.type === 'file-changed') {
        setState(s => ({ ...bump(s, ['*']), file: e.meta }));
        void storage.setItem('lastFile', e.meta?.id ?? null);
        loadPrefs();
      } else if (e.type === 'sync-status') setState(s => ({ ...s, sync: e.status }));
    });
    startEngine().then(() => {
      setState(s => ({ ...s, ready: true, file: engine.meta, sync: engine.syncStatus }));
      loadPrefs();
    });
    return () => {
      off();
    };
  }, []);

  useAutoSync(!!state.file?.cloudFileId);

  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

/** How often to pull changes from the server while the app is on screen. */
const PULL_EVERY_MS = 15_000;

/**
 * Two-way auto sync. Local edits are pushed by the engine ~1.5 s after they happen;
 * this pulls server changes (web app, WhatsApp, other devices) when the app comes
 * to the foreground and every 15 s while it stays open. Going to the background
 * saves to disk and pushes anything pending.
 */
function useAutoSync(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      void engine.sync();
      timer ??= setInterval(() => void engine.sync(), PULL_EVERY_MS);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    if (AppState.currentState === 'active') start();
    const sub = AppState.addEventListener('change', s => {
      if (s === 'active') start();
      else if (s === 'background') {
        stop();
        void engine.flush().then(() => engine.sync());
      }
    });
    return () => {
      stop();
      sub.remove();
    };
  }, [enabled]);
}

/** Pull-to-refresh: sync now. */
export function useSyncRefresh() {
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await engine.sync();
    } finally {
      setRefreshing(false);
    }
  };
  return { refreshing, onRefresh };
}

export const useEngineState = () => useContext(Ctx);

/**
 * Run an engine handler and re-run it when one of `tables` changes
 * (a local edit, undo, or a sync from another device).
 */
export function useEngineQuery<T>(name: string | null, args: unknown, tables: string[]) {
  const { tableVersions, file } = useEngineState();
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | null>(null);
  const seq = useRef(0);
  const key = JSON.stringify(args);
  // Re-run when one of our tables (or everything) changed since the last run.
  const trigger = Math.max(tableVersions['*'] ?? 0, ...tables.map(t => tableVersions[t] ?? 0));

  const run = useCallback(() => {
    if (!name || !file) return;
    const my = ++seq.current;
    send<T>(name, args)
      .then(r => my === seq.current && (setData(r), setError(null)))
      .catch(e => my === seq.current && setError(e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, key, file?.id]);

  useEffect(() => {
    run();
  }, [run, trigger]);

  return { data, error, reload: run };
}
