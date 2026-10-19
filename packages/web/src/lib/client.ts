import type { EngineEvent } from '@envelope/core';

const worker = new Worker(new URL('../worker.ts', import.meta.url), { type: 'module' });

let nextId = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
const listeners = new Set<(e: EngineEvent) => void>();

export class EngineError extends Error {
  constructor(
    message: string,
    readonly reason?: string,
  ) {
    super(message);
  }
}

worker.onmessage = e => {
  const msg = e.data;
  if (msg.type === 'event') {
    for (const l of listeners) l(msg.event);
    return;
  }
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.error) p.reject(new EngineError(msg.error.message, msg.error.reason));
  else p.resolve(msg.result);
};

/** Call a core engine handler. */
export function send<T = any>(name: string, args?: unknown): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, name, args });
  });
}

export function listen(fn: (e: EngineEvent) => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// Persist pending writes when the tab is hidden or closed; pull changes from
// other devices (e.g. the iPhone app) as soon as it is shown again.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') void send('__flush');
  else void send('sync-now').catch(() => {});
});
