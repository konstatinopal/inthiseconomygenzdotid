import { useCallback, useEffect, useState } from 'react';
import { send } from './client';

export interface ServerUser {
  id: string;
  userName: string;
  displayName: string | null;
  picture: string | null;
  role: 'ADMIN' | 'BASIC';
  enabled: boolean;
  lastLogin?: number | null;
  hasPassword?: boolean;
  google?: boolean;
  mustChangePassword?: boolean;
}

export interface ServerState {
  url: string | null;
  loggedIn: boolean;
  reachable: boolean;
  loginMethod: 'password' | 'header' | 'openid' | 'multiuser' | null;
  multiuser?: boolean;
  googleLogin?: boolean;
  bootstrapped?: boolean;
  user: ServerUser | null;
}

// Every screen that shows sign-in state shares one source and refreshes together.
const listeners = new Set<() => void>();
export function serverChanged() {
  for (const l of listeners) l();
}

export function useServerState() {
  const [data, setData] = useState<ServerState | undefined>(undefined);
  const load = useCallback(() => {
    send<ServerState>('server-get')
      .then(setData)
      .catch(() => {});
  }, []);
  useEffect(() => {
    load();
    listeners.add(load);
    return () => {
      listeners.delete(load);
    };
  }, [load]);
  return { data, reload: serverChanged };
}

const ERRORS: Record<string, string> = {
  'not-invited': 'Your Google account hasn’t been invited to this server. Ask an admin to add your email.',
  'user-disabled': 'Your account on this server is disabled. Ask an admin to enable it.',
  'account-mismatch': 'That email belongs to a different Google account on this server.',
  'email-unverified': 'Verify your Google email address, then try again.',
  'invalid-token': 'Google’s response couldn’t be verified. Try again.',
  access_denied: 'Sign-in was cancelled.',
  'openid-not-configured': 'Google sign-in isn’t configured on this server.',
  'token-exchange-failed': 'Google rejected the sign-in. Check the server’s OAuth client settings.',
  'invalid-login-code': 'Sign-in expired. Try again.',
};

export function describeSignInError(code: string) {
  return ERRORS[code] ?? `Sign-in failed (${code})`;
}

/** Leave the app for Google's consent page; it comes back to /openid-cb. */
export async function startGoogleSignIn() {
  const { url } = await send<{ url: string }>('server-openid-start', { returnUrl: window.location.origin });
  window.location.assign(url);
}

export function userLabel(u: { displayName?: string | null; userName: string }) {
  return u.displayName || u.userName;
}

export function isMultiUser(s?: ServerState | null) {
  return !!s && (s.multiuser || s.loginMethod === 'multiuser' || s.loginMethod === 'openid');
}

export const LOGIN_SKIPPED = 'loginSkipped';
