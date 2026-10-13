import type { FileMeta, PlatformStorage } from './storage';

const DB_NAME = 'envelope';
const VERSION = 1;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** IndexedDB storage for the browser build: one store for metadata, one for SQLite images, one key-value store. */
export class IndexedDbStorage implements PlatformStorage {
  private dbp: Promise<IDBDatabase>;

  constructor() {
    this.dbp = new Promise((resolve, reject) => {
      const open = indexedDB.open(DB_NAME, VERSION);
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
  }

  private async store(name: string, mode: IDBTransactionMode = 'readonly') {
    const db = await this.dbp;
    return db.transaction(name, mode).objectStore(name);
  }

  async listFiles(): Promise<FileMeta[]> {
    return req((await this.store('meta')).getAll());
  }
  async getMeta(id: string): Promise<FileMeta | null> {
    return (await req((await this.store('meta')).get(id))) ?? null;
  }
  async setMeta(meta: FileMeta) {
    await req((await this.store('meta', 'readwrite')).put(meta));
  }
  async readDb(id: string): Promise<Uint8Array | null> {
    const v = await req((await this.store('files')).get(id));
    return v ? new Uint8Array(v) : null;
  }
  async writeDb(id: string, data: Uint8Array) {
    await req((await this.store('files', 'readwrite')).put(data, id));
  }
  async deleteFile(id: string) {
    await req((await this.store('meta', 'readwrite')).delete(id));
    await req((await this.store('files', 'readwrite')).delete(id));
  }
  async getItem(key: string): Promise<string | null> {
    return (await req((await this.store('kv')).get(key))) ?? null;
  }
  async setItem(key: string, value: string | null) {
    const s = await this.store('kv', 'readwrite');
    if (value === null) await req(s.delete(key));
    else await req(s.put(value, key));
  }
}
