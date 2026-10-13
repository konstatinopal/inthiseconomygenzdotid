import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAction, useApp } from '../lib/app';
import { isMultiUser, useServerState, userLabel } from '../lib/server';
import { Avatar } from './Avatar';
import { Modal } from './ui';
import { ChangePasswordForm } from './ChangePassword';

/** The optional sync server: its address, who is signed in, and a way to the login page. */
export function ServerSettings({ onChange }: { onChange?: () => void }) {
  const act = useAction();
  const { notify } = useApp();
  const navigate = useNavigate();
  const server = useServerState();
  const [url, setUrl] = useState('');
  const [changing, setChanging] = useState(false);

  useEffect(() => setUrl(server.data?.url ?? ''), [server.data?.url]);

  const refresh = () => {
    server.reload();
    onChange?.();
  };

  const s = server.data;
  const multi = isMultiUser(s);
  return (
    <div className="card pad col" id="sync">
      <h2>Sync server</h2>
      <p className="muted small">
        Optional. A self-hosted server relays changes between your devices and the people you share budgets with; with end-to-end encryption it only ever
        sees ciphertext. Without one, everything still works on this device.
      </p>
      <div className="row wrap">
        <input className="grow" placeholder="https://budget.example.com" value={url} onChange={e => setUrl(e.target.value)} aria-label="Server URL" />
        <button
          onClick={async () => {
            if ((await act('server-set-url', { url: url || null }, url ? 'Server saved' : 'Server removed')) !== undefined) refresh();
          }}
        >
          {s?.url ? 'Change' : 'Connect'}
        </button>
        {s?.url && (
          <button
            className="ghost"
            onClick={async () => {
              await act('server-set-url', { url: null });
              refresh();
            }}
          >
            Disconnect
          </button>
        )}
      </div>
      {s?.url && !s.reachable && !s.loggedIn && <p className="warn small">Can’t reach the server right now.</p>}
      {s?.url && s.reachable && !s.loggedIn && (
        <div className="row">
          <span className="grow muted small">Not signed in.</span>
          <button className="primary" onClick={() => navigate('/login')}>
            Sign in
          </button>
        </div>
      )}
      {s?.url && s.loggedIn && (
        <div className="row wrap">
          {s.user && multi ? (
            <>
              <Avatar name={userLabel(s.user)} picture={s.user.picture} size={28} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="ellipsis" style={{ fontWeight: 600 }}>
                  {userLabel(s.user)} {s.user.role === 'ADMIN' && <span className="badge accent">Admin</span>}
                </div>
                <div className="dim small ellipsis">{s.user.userName}</div>
              </div>
              <button className="small" onClick={() => setChanging(true)}>
                {s.user.hasPassword ? 'Change password' : 'Set a password'}
              </button>
            </>
          ) : (
            <>
              <span className="badge pos">Logged in</span>
              <span className="muted small grow ellipsis">{s.url}</span>
            </>
          )}
          <button
            className="small"
            onClick={async () => {
              await act('server-logout');
              refresh();
            }}
          >
            Sign out
          </button>
        </div>
      )}
      {changing && s?.user && (
        <Modal title={s.user.hasPassword ? 'Change password' : 'Set a password'} onClose={() => setChanging(false)}>
          {!s.user.hasPassword && <p className="muted small">You sign in with Google today. A password lets you sign in without it too.</p>}
          <ChangePasswordForm
            needsCurrent={!!s.user.hasPassword}
            onDone={() => {
              setChanging(false);
              notify('success', 'Password saved');
            }}
          />
        </Modal>
      )}
    </div>
  );
}
