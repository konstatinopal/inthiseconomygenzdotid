import { Directory, File, Paths } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import type { FileMeta, PlatformStorage } from '@envelope/core';

/** Keys that hold secrets go to the iOS Keychain; everything else to a small JSON file. */
const isSecret = (key: string) => key === 'serverToken' || key.startsWith('key:');
// SecureStore keys may only use [A-Za-z0-9._-].
const secureKey = (key: string) => 'fin.' + key.replace(/[^A-Za-z0-9._-]/g, '_');

/**
 * Budget files live in the app's Documents folder:
 *   budgets/<id>/meta.json and budgets/<id>/db.sqlite
 */
export class DeviceStorage implements PlatformStorage {
  private root = new Directory(Paths.document, 'budgets');
  private kvFile = new File(Paths.document, 'settings.json');

  constructor() {
    if (!this.root.exists) this.root.create();
  }

  private dir(id: string) {
    return new Directory(this.root, id);
  }

  async listFiles(): Promise<FileMeta[]> {
    const out: FileMeta[] = [];
    for (const entry of this.root.list()) {
      if (!(entry instanceof Directory)) continue;
      const meta = new File(entry, 'meta.json');
      if (!meta.exists) continue;
      try {
        out.push(JSON.parse(meta.textSync()));
      } catch {
        /* skip a damaged entry */
      }
    }
    return out;
  }

  async getMeta(id: string): Promise<FileMeta | null> {
    const f = new File(this.dir(id), 'meta.json');
    return f.exists ? JSON.parse(f.textSync()) : null;
  }

  async setMeta(meta: FileMeta) {
    const d = this.dir(meta.id);
    if (!d.exists) d.create();
    new File(d, 'meta.json').write(JSON.stringify(meta));
  }

  async readDb(id: string): Promise<Uint8Array | null> {
    const f = new File(this.dir(id), 'db.sqlite');
    return f.exists ? f.bytesSync() : null;
  }

  async writeDb(id: string, data: Uint8Array) {
    const d = this.dir(id);
    if (!d.exists) d.create();
    new File(d, 'db.sqlite').write(data);
  }

  async deleteFile(id: string) {
    const d = this.dir(id);
    if (d.exists) d.delete();
  }

  private readKv(): Record<string, string> {
    try {
      return this.kvFile.exists ? JSON.parse(this.kvFile.textSync()) : {};
    } catch {
      return {};
    }
  }

  async getItem(key: string): Promise<string | null> {
    if (isSecret(key)) return SecureStore.getItemAsync(secureKey(key));
    return this.readKv()[key] ?? null;
  }

  async setItem(key: string, value: string | null) {
    if (isSecret(key)) {
      if (value === null) await SecureStore.deleteItemAsync(secureKey(key));
      else await SecureStore.setItemAsync(secureKey(key), value, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
      return;
    }
    const kv = this.readKv();
    if (value === null) delete kv[key];
    else kv[key] = value;
    this.kvFile.write(JSON.stringify(kv));
  }
}
