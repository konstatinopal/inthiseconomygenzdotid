/// <reference lib="webworker" />
// Hosts the core engine off the main thread. The UI talks to it only through
// named RPC messages, and receives change / sync events back.
import initSqlJs from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { Engine } from '@envelope/core';
import { IndexedDbStorage } from '@envelope/core/src/platform/indexeddb';

declare const self: DedicatedWorkerGlobalScope;

const ready = (async () => {
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });
  const engine = new Engine({ storage: new IndexedDbStorage(), sqlJs: SQL });
  await engine.init();
  engine.on(event => self.postMessage({ type: 'event', event }));
  return engine;
})();

self.onmessage = async (e: MessageEvent) => {
  const { id, name, args } = e.data;
  try {
    const engine = await ready;
    if (name === '__flush') {
      await engine.flush();
      self.postMessage({ type: 'reply', id, result: null });
      return;
    }
    const result = await engine.send(name, args);
    self.postMessage({ type: 'reply', id, result });
  } catch (err: any) {
    self.postMessage({ type: 'reply', id, error: { message: err?.message ?? String(err), reason: err?.reason } });
  }
};
