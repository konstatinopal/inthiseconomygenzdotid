import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../lib/app';
import { send } from '../lib/client';
import { LOGIN_SKIPPED, isMultiUser, serverChanged, useServerState, userLabel } from '../lib/server';
import { GoogleButton } from '../components/GoogleButton';
import { ChangePasswordForm } from '../components/ChangePassword';

/** Full-page sign-in: server address, username + password, Google, and the forced first-login password change. */
export function LoginPage() {
  const { notify } = useApp();
  const navigate = useNavigate();
  const server = useServerState();
  const s = server.data;
  const [editingUrl, setEditingUrl] = useState(false);
  const [url, setUrl] = useState('');
  const [userName, setUserName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [changeStep, setChangeStep] = useState<{ currentPassword?: string } | null>(null);

  useEffect(() => {
    if (s && !url) setUrl(s.url ?? window.location.origin);
    // A session that still owes a password change lands straight on that step.
    if (s?.loggedIn && s.user?.mustChangePassword && !changeStep) setChangeStep({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s]);

  const finish = (name?: string) => {
    try {
      sessionStorage.removeItem(LOGIN_SKIPPED);
    } catch {}
    serverChanged();
    if (name) notify('success', `Signed in as ${name}`);
    navigate('/', { replace: true });
  };

  const skip = () => {
    try {
      sessionStorage.setItem(LOGIN_SKIPPED, '1');
    } catch {}
    serverChanged();
    navigate('/', { replace: true });
  };

  const saveUrl = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await send('server-set-url', { url: url.trim() || null });
      setEditingUrl(false);
      serverChanged();
    } catch (err: any) {
      setError(err.message ?? 'Could not reach that server');
    } finally {
      setBusy(false);
    }
  };

  const signIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (isMultiUser(s)) {
        const r = await send<{ mustChangePassword: boolean; user: any }>('server-login', { userName: userName.trim(), password });
        if (r.mustChangePassword) setChangeStep({ currentPassword: password });
        else finish(r.user ? userLabel(r.user) : undefined);
      } else if (s?.bootstrapped === false) {
        await send('server-bootstrap', { password });
        finish();
      } else {
        await send('server-login', { password });
        finish();
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const host = s?.url ? s.url.replace(/^https?:\/\//, '') : null;
  const showUrlForm = !s?.url || editingUrl;

  return (
    <div className="login-page">
      <div className="login-card card">
        <div className="row" style={{ gap: 12, marginBottom: 4 }}>
          <img src="/icon.svg" width={40} height={40} alt="" />
          <div>
            <h1>{changeStep ? 'Choose a new password' : 'Sign in'}</h1>
            <div className="muted small">{changeStep ? 'Your password was set by an admin. Pick your own to continue.' : 'to your inthiseconomygenz.id budget server'}</div>
          </div>
        </div>

        {!window.isSecureContext && (
          <div className="insecure-note" role="note">
            <strong>Not a secure connection.</strong> This page is served over plain HTTP, so your password travels unencrypted and end-to-end
            encryption is unavailable. Serve the app over HTTPS before using it across a network.
          </div>
        )}

        {!s ? (
          <div className="muted">Loading…</div>
        ) : changeStep ? (
          <ChangePasswordForm
            needsCurrent={!!s.user?.hasPassword || !!changeStep.currentPassword}
            currentPassword={changeStep.currentPassword}
            submitLabel="Save and continue"
            onDone={u => finish(u ? userLabel(u) : s.user ? userLabel(s.user) : undefined)}
          />
        ) : showUrlForm ? (
          <form className="col" onSubmit={saveUrl}>
            <label className="field">
              Server address
              <input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://budget.example.com" autoFocus required inputMode="url" />
            </label>
            {error && <div className="err">{error}</div>}
            <button className="primary" type="submit" disabled={busy}>
              {busy ? 'Connecting…' : 'Continue'}
            </button>
            {s.url && (
              <button type="button" className="ghost" onClick={() => setEditingUrl(false)}>
                Cancel
              </button>
            )}
          </form>
        ) : (
          <>
            <div className="row small login-server">
              <span className={`sync-dot ${s.reachable ? 'idle' : 'offline'}`} />
              <span className="grow ellipsis">{host}</span>
              <button className="link small" onClick={() => setEditingUrl(true)}>
                Change
              </button>
            </div>
            {!s.reachable ? (
              <p className="warn small">Can’t reach this server. Check the address or your connection.</p>
            ) : (
              <>
                <form className="col" onSubmit={signIn}>
                  {isMultiUser(s) && (
                    <label className="field">
                      Username or email
                      <input value={userName} onChange={e => setUserName(e.target.value)} autoComplete="username" autoFocus required autoCapitalize="none" spellCheck={false} />
                    </label>
                  )}
                  <label className="field">
                    {isMultiUser(s) ? 'Password' : s.bootstrapped === false ? 'Choose a server password' : 'Server password'}
                    <input
                      type="password"
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      autoComplete={s.bootstrapped === false ? 'new-password' : 'current-password'}
                      autoFocus={!isMultiUser(s)}
                      required
                    />
                  </label>
                  {error && (
                    <div className="err" role="alert">
                      {error}
                    </div>
                  )}
                  <button className="primary" type="submit" disabled={busy}>
                    {busy ? 'Signing in…' : s.bootstrapped === false && !isMultiUser(s) ? 'Set password' : 'Sign in'}
                  </button>
                </form>
                {s.googleLogin && (
                  <>
                    <div className="login-divider">
                      <span>or</span>
                    </div>
                    <div className="row" style={{ justifyContent: 'center' }}>
                      <GoogleButton />
                    </div>
                  </>
                )}
                {isMultiUser(s) && <p className="dim small" style={{ textAlign: 'center', margin: 0 }}>No account yet? Ask your server’s admin to add you.</p>}
              </>
            )}
          </>
        )}

        {!changeStep && (
          <button className="link small" style={{ alignSelf: 'center' }} onClick={skip}>
            Continue without signing in (this device only)
          </button>
        )}
        {changeStep && (
          <button
            className="link small"
            style={{ alignSelf: 'center' }}
            onClick={async () => {
              await send('server-logout');
              setChangeStep(null);
              serverChanged();
            }}
          >
            Sign out instead
          </button>
        )}
      </div>
    </div>
  );
}
