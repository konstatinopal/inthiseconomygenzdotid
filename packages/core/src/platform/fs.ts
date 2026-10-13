// Filesystem storage for Node (API / CLI): <dataDir>/<id>/db.sqlite + metadata.json.
import type { FileMeta, PlatformStorage } from './storage';

export async function createFsStorage(dataDir: string): Promise<PlatformStorage> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  await fs.mkdir(dataDir, { recursive: true });
  const kvPath = path.join(dataDir, 'global.json');
  const readJson = async (p: string) => {
    try {
      return JSON.parse(await fs.readFile(p, 'utf8'));
    } catch {
      return null;
    }
  };
  return {
    async listFiles() {
      const out: FileMeta[] = [];
      for (const d of await fs.readdir(dataDir, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const m = await readJson(path.join(dataDir, d.name, 'metadata.json'));
        if (m) out.push(m);
      }
      return out;
    },
    async getMeta(id) {
      return readJson(path.join(dataDir, id, 'metadata.json'));
    },
    async setMeta(meta) {
      await fs.mkdir(path.join(dataDir, meta.id), { recursive: true });
      await fs.writeFile(path.join(dataDir, meta.id, 'metadata.json'), JSON.stringify(meta, null, 2));
    },
    async readDb(id) {
      try {
        return new Uint8Array(await fs.readFile(path.join(dataDir, id, 'db.sqlite')));
      } catch {
        return null;
      }
    },
    async writeDb(id, data) {
      await fs.mkdir(path.join(dataDir, id), { recursive: true });
      const tmp = path.join(dataDir, id, 'db.sqlite.tmp');
      await fs.writeFile(tmp, data);
      await fs.rename(tmp, path.join(dataDir, id, 'db.sqlite'));
    },
    async deleteFile(id) {
      await fs.rm(path.join(dataDir, id), { recursive: true, force: true });
    },
    async getItem(key) {
      return ((await readJson(kvPath)) ?? {})[key] ?? null;
    },
    async setItem(key, value) {
      const kv = (await readJson(kvPath)) ?? {};
      if (value === null) delete kv[key];
      else kv[key] = value;
      await fs.writeFile(kvPath, JSON.stringify(kv, null, 2));
    },
  };
}
