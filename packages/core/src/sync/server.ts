import { SyncError } from './codec';

export type FetchFn = typeof fetch;

/** Thin client for the sync server. Responses are `{status:'ok', data}` or `{status:'error', reason}`. */
export class ServerClient {
  private fetchFn: FetchFn;

  constructor(
    fetchFn: FetchFn,
    public url: string | null,
    public token: string | null,
  ) {
    // Browsers throw "Illegal invocation" when fetch is called unbound.
    this.fetchFn = (input, init) => fetchFn.call(globalThis, input, init);
  }

  private base() {
    if (!this.url) throw new SyncError('no-server', 'No sync server configured');
    return this.url.replace(/\/+$/, '');
  }

  async request<T = any>(
    path: string,
    opts: { method?: string; json?: unknown; bytes?: Uint8Array; headers?: Record<string, string>; raw?: boolean; auth?: boolean } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.auth !== false && this.token) headers['x-actual-token'] = this.token;
    let body: BodyInit | undefined;
    if (opts.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.json);
    } else if (opts.bytes) {
      headers['content-type'] = 'application/octet-stream';
      body = opts.bytes as BodyInit;
    }
    let res: Response;
    try {
      res = await this.fetchFn(this.base() + path, { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body });
    } catch {
      throw new SyncError('network-failure', 'Could not reach the sync server');
    }
    if (opts.raw) {
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let reason = 'server-error';
        try {
          reason = JSON.parse(text).reason ?? reason;
        } catch {}
        throw new SyncError(reason, `Server error (${res.status})`);
      }
      return new Uint8Array(await res.arrayBuffer()) as T;
    }
    let data: any;
    try {
      data = await res.json();
    } catch {
      throw new SyncError('server-error', `Unexpected response from server (${res.status})`);
    }
    if (data.status !== 'ok') throw new SyncError(data.reason ?? 'server-error', describeReason(data.reason, data.details));
    return data.data as T;
  }
}

export function describeReason(reason: string, details?: string): string {
  switch (reason) {
    case 'unauthorized':
    case 'token-expired':
      return 'You are logged out of the sync server';
    case 'invalid-password':
      return details || 'Invalid password';
    case 'file-has-reset':
      return 'This file was reset on another device; re-download it from the server';
    case 'file-not-found':
      return 'This file no longer exists on the server, or you no longer have access to it';
    case 'file-key-mismatch':
      return 'The encryption key changed on another device';
    case 'already-bootstrapped':
      return 'The server already has a password';
    case 'password-change-required':
      return 'Choose a new password to continue';
    case 'forbidden':
      return details || 'Only the file’s owner or an admin can do this';
    case 'openid-enabled':
      return 'This server uses Google sign-in';
    default:
      return details || reason || 'Server error';
  }
}
