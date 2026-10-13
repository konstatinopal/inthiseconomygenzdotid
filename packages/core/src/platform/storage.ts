// Platform adapter for persistence. The engine never touches IndexedDB or the
// filesystem directly, so it runs unchanged in a Web Worker, Electron or Node.

export interface FileMeta {
  id: string;
  name: string;
  cloudFileId?: string | null;
  groupId?: string | null;
  encryptKeyId?: string | null;
  lastOpened?: number;
  createdAt?: number;
}

export interface PlatformStorage {
  listFiles(): Promise<FileMeta[]>;
  getMeta(id: string): Promise<FileMeta | null>;
  setMeta(meta: FileMeta): Promise<void>;
  readDb(id: string): Promise<Uint8Array | null>;
  writeDb(id: string, data: Uint8Array): Promise<void>;
  deleteFile(id: string): Promise<void>;
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string | null): Promise<void>;
}

export class MemoryStorage implements PlatformStorage {
  metas = new Map<string, FileMeta>();
  dbs = new Map<string, Uint8Array>();
  items = new Map<string, string>();
  async listFiles() {
    return [...this.metas.values()];
  }
  async getMeta(id: string) {
    return this.metas.get(id) ?? null;
  }
  async setMeta(meta: FileMeta) {
    this.metas.set(meta.id, { ...meta });
  }
  async readDb(id: string) {
    return this.dbs.get(id) ?? null;
  }
  async writeDb(id: string, data: Uint8Array) {
    this.dbs.set(id, data);
  }
  async deleteFile(id: string) {
    this.metas.delete(id);
    this.dbs.delete(id);
  }
  async getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  async setItem(key: string, value: string | null) {
    if (value === null) this.items.delete(key);
    else this.items.set(key, value);
  }
}
