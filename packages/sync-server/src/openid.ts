// Minimal OpenID Connect relying party (authorization code flow + PKCE).
// Works with Google and any compliant issuer; no third-party OAuth library.
import crypto from 'node:crypto';

export interface OpenIdConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

export interface IdClaims {
  sub: string;
  email: string;
  email_verified?: boolean | string;
  name?: string;
  picture?: string;
  iss: string;
  aud: string | string[];
  exp: number;
  iat?: number;
  nonce?: string;
}

export class OpenIdError extends Error {
  constructor(
    readonly reason: string,
    message = reason,
  ) {
    super(message);
  }
}

const b64url = (buf: Buffer) => buf.toString('base64url');

export function randomToken(bytes = 32) {
  return b64url(crypto.randomBytes(bytes));
}

export function pkceChallenge(verifier: string) {
  return b64url(crypto.createHash('sha256').update(verifier).digest());
}

export class OpenIdClient {
  private discovery: Discovery | null = null;
  private jwks: { keys: any[]; fetchedAt: number } | null = null;

  constructor(
    readonly cfg: OpenIdConfig,
    private fetchFn: typeof fetch = fetch,
  ) {}

  async discover(): Promise<Discovery> {
    if (this.discovery) return this.discovery;
    const url = this.cfg.issuer.replace(/\/+$/, '') + '/.well-known/openid-configuration';
    const res = await this.fetchFn(url);
    if (!res.ok) throw new OpenIdError('discovery-failed', `OpenID discovery failed (${res.status})`);
    this.discovery = (await res.json()) as Discovery;
    return this.discovery;
  }

  async authorizationUrl(args: { state: string; nonce: string; codeVerifier: string; loginHint?: string }) {
    const d = await this.discover();
    const u = new URL(d.authorization_endpoint);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', this.cfg.clientId);
    u.searchParams.set('redirect_uri', this.cfg.redirectUri);
    u.searchParams.set('scope', 'openid email profile');
    u.searchParams.set('state', args.state);
    u.searchParams.set('nonce', args.nonce);
    u.searchParams.set('code_challenge', pkceChallenge(args.codeVerifier));
    u.searchParams.set('code_challenge_method', 'S256');
    u.searchParams.set('prompt', 'select_account');
    if (args.loginHint) u.searchParams.set('login_hint', args.loginHint);
    return u.toString();
  }

  /** Exchange the authorization code and return verified ID-token claims. */
  async exchange(code: string, codeVerifier: string, nonce: string): Promise<IdClaims> {
    const d = await this.discover();
    const res = await this.fetchFn(d.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.cfg.redirectUri,
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        code_verifier: codeVerifier,
      }),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok || !body.id_token) throw new OpenIdError('token-exchange-failed', body.error_description ?? body.error ?? `Token exchange failed (${res.status})`);
    return this.verifyIdToken(body.id_token, nonce);
  }

  private async keys(force = false) {
    if (!force && this.jwks && Date.now() - this.jwks.fetchedAt < 3600_000) return this.jwks.keys;
    const d = await this.discover();
    const res = await this.fetchFn(d.jwks_uri);
    if (!res.ok) throw new OpenIdError('jwks-failed');
    this.jwks = { keys: ((await res.json()) as any).keys ?? [], fetchedAt: Date.now() };
    return this.jwks.keys;
  }

  async verifyIdToken(jwt: string, nonce: string): Promise<IdClaims> {
    const parts = jwt.split('.');
    if (parts.length !== 3) throw new OpenIdError('invalid-token', 'Malformed ID token');
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    if (header.alg !== 'RS256') throw new OpenIdError('invalid-token', `Unsupported ID token algorithm ${header.alg}`);
    let jwk = (await this.keys()).find(k => k.kid === header.kid);
    // Keys rotate: refetch once before giving up.
    if (!jwk) jwk = (await this.keys(true)).find(k => k.kid === header.kid);
    if (!jwk) throw new OpenIdError('invalid-token', 'Unknown ID token signing key');
    const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
    if (!ok) throw new OpenIdError('invalid-token', 'ID token signature is invalid');
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as IdClaims;
    const d = await this.discover();
    const now = Math.floor(Date.now() / 1000);
    // Google issues tokens as either form of its issuer.
    const issuers = new Set([d.issuer, d.issuer.replace(/^https:\/\//, '')]);
    if (!issuers.has(claims.iss)) throw new OpenIdError('invalid-token', 'ID token issuer mismatch');
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(this.cfg.clientId)) throw new OpenIdError('invalid-token', 'ID token audience mismatch');
    if (typeof claims.exp !== 'number' || claims.exp + 60 < now) throw new OpenIdError('invalid-token', 'ID token expired');
    if (claims.nonce !== nonce) throw new OpenIdError('invalid-token', 'ID token nonce mismatch');
    if (!claims.email) throw new OpenIdError('no-email', 'The identity provider did not return an email');
    if (claims.email_verified === false || claims.email_verified === 'false') throw new OpenIdError('email-unverified', 'Your email address is not verified');
    return claims;
  }
}
