import path from 'node:path';
import { init } from '@envelope/api';
import { createHttpApi } from './app';

const env = process.env;
const apiKeys = (env.ENVELOPE_API_KEYS ?? '').split(',').map(s => s.trim()).filter(Boolean);
if (!apiKeys.length) {
  console.error('Set ENVELOPE_API_KEYS to one or more secret keys (comma-separated). Generate one with: openssl rand -hex 32');
  process.exit(1);
}
if (apiKeys.some(k => k.length < 24)) {
  console.error('API keys must be at least 24 characters. Generate one with: openssl rand -hex 32');
  process.exit(1);
}
const api = await init({
  dataDir: path.resolve(env.ENVELOPE_API_DATA_DIR ?? './data/http-api'),
  serverURL: env.ENVELOPE_URL ?? 'http://localhost:5006',
  userName: env.ENVELOPE_USER,
  password: env.ENVELOPE_PASSWORD,
});
const app = createHttpApi({ api, apiKeys, keyPassword: env.ENVELOPE_KEY_PASSWORD });
// Loopback by default: the service holds decrypted budget data. Expose it deliberately, behind HTTPS.
const host = env.ENVELOPE_API_HOST ?? '127.0.0.1';
const port = Number(env.ENVELOPE_API_PORT ?? 5007);
app.listen(port, host, () => console.log(`inthiseconomygenz.id HTTP API on http://${host}:${port} (sync server ${env.ENVELOPE_URL ?? 'http://localhost:5006'})`));
