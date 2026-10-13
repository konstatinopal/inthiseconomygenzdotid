import { useCallback, useEffect, useRef, useState } from 'react';
import { listen, send } from './client';

/**
 * Run an engine query and re-run it whenever one of `tables` changes
 * (locally, from undo, or from sync). Pass `tables: '*'` for any change.
 */
export function useQuery<T>(name: string | null, args: unknown, tables: string[] | '*', deps: unknown[] = []) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const argsKey = JSON.stringify(args);

  const run = useCallback(() => {
    if (!name) return;
    const my = ++seq.current;
    send<T>(name, args)
      .then(r => {
        if (my === seq.current) {
          setData(r);
          setError(null);
          setLoading(false);
        }
      })
      .catch(e => {
        if (my === seq.current) {
          setError(e);
          setLoading(false);
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, argsKey, ...deps]);

  useEffect(() => {
    run();
    return listen(e => {
      if (e.type !== 'changed') return;
      if (tables === '*' || e.tables.some(t => tables.includes(t))) run();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);

  return { data, error, loading, reload: run };
}

export function useLocalStorage<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        localStorage.setItem(key, JSON.stringify(v));
      } catch {
        /* storage unavailable */
      }
    },
    [key],
  );
  return [value, set];
}

export function useMediaQuery(q: string) {
  const [match, setMatch] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const fn = () => setMatch(m.matches);
    m.addEventListener('change', fn);
    return () => m.removeEventListener('change', fn);
  }, [q]);
  return match;
}
