import path from 'node:path';

export interface ServerConfig {
  port: number;
  hostname: string;
  dataDir: string;
  /** Directory of the built web app to serve, if present. */
  webRoot: string | null;
  /** 'multiuser' = per-user accounts (password and/or Google); 'openid' is accepted as an alias. */
  loginMethod: 'password' | 'header' | 'openid' | 'multiuser';
  /** Public base URL of this server; the OpenID redirect URI is publicUrl + /openid/callback. */
  publicUrl: string;
  openid: { issuer: string; clientId: string; clientSecret: string } | null;
  /** Only this email may become the first admin (OpenID mode). */
  adminEmail: string | null;
  /** Login name of the default admin created on first start (multi-user mode). */
  adminUser: string;
  /** Initial password for the default admin; generated and printed when unset. */
  adminPassword: string | null;
  /** Domains whose users may sign in without an invite. */
  allowedDomains: string[];
  /** App origins allowed as an OpenID returnUrl, besides publicUrl. */
  allowedOrigins: string[];
  /** Header carrying the authenticated user when loginMethod is "header". */
  authHeader: string;
  /** Proxies allowed to set the auth header (IP addresses). */
  trustedProxies: string[];
  uploadLimitMb: number;
  https: { key: string; cert: string } | null;
  tokenTtlDays: number;
}

function list(v: string | undefined) {
  return (v ?? '').split(',').map(s => s.trim()).filter(Boolean);
}

/** Config from environment variables, optionally overridden by a JSON file at ENVELOPE_CONFIG. */
export async function loadConfig(overrides: Partial<ServerConfig> = {}): Promise<ServerConfig> {
  const env = process.env;
  let file: Partial<ServerConfig> = {};
  if (env.ENVELOPE_CONFIG) {
    const fs = await import('node:fs/promises');
    file = JSON.parse(await fs.readFile(env.ENVELOPE_CONFIG, 'utf8'));
  }
  const dataDir = path.resolve(overrides.dataDir ?? file.dataDir ?? env.ENVELOPE_DATA_DIR ?? './data');
  const keyPath = env.ENVELOPE_HTTPS_KEY;
  const certPath = env.ENVELOPE_HTTPS_CERT;
  return {
    port: Number(env.ENVELOPE_PORT ?? env.PORT ?? 5006),
    hostname: env.ENVELOPE_HOSTNAME ?? '0.0.0.0',
    dataDir,
    webRoot: env.ENVELOPE_WEB_ROOT ?? path.resolve(import.meta.dirname, '../../web/dist'),
    loginMethod: (env.ENVELOPE_LOGIN_METHOD as ServerConfig['loginMethod']) ?? 'password',
    publicUrl: (env.ENVELOPE_PUBLIC_URL ?? `http://localhost:${env.ENVELOPE_PORT ?? env.PORT ?? 5006}`).replace(/\/+$/, ''),
    openid: env.ENVELOPE_OPENID_CLIENT_ID
      ? {
          issuer: env.ENVELOPE_OPENID_ISSUER ?? 'https://accounts.google.com',
          clientId: env.ENVELOPE_OPENID_CLIENT_ID,
          clientSecret: env.ENVELOPE_OPENID_CLIENT_SECRET ?? '',
        }
      : null,
    adminEmail: env.ENVELOPE_ADMIN_EMAIL?.trim().toLowerCase() || null,
    adminUser: (env.ENVELOPE_ADMIN_USER ?? env.ENVELOPE_ADMIN_EMAIL ?? 'admin').trim().toLowerCase(),
    adminPassword: env.ENVELOPE_ADMIN_PASSWORD || null,
    allowedDomains: list(env.ENVELOPE_ALLOWED_DOMAINS).map(d => d.toLowerCase()),
    allowedOrigins: list(env.ENVELOPE_ALLOWED_ORIGINS),
    authHeader: (env.ENVELOPE_AUTH_HEADER ?? 'x-actual-password').toLowerCase(),
    trustedProxies: list(env.ENVELOPE_TRUSTED_PROXIES ?? '127.0.0.1,::1,::ffff:127.0.0.1'),
    uploadLimitMb: Number(env.ENVELOPE_UPLOAD_LIMIT_MB ?? 50),
    https: keyPath && certPath ? { key: keyPath, cert: certPath } : null,
    tokenTtlDays: Number(env.ENVELOPE_TOKEN_TTL_DAYS ?? 90),
    ...file,
    ...overrides,
  };
}
