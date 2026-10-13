import { useState } from 'react';
import { useAction } from '../lib/app';
import { useQuery } from '../lib/hooks';
import { useServerState, userLabel, type ServerUser } from '../lib/server';
import { Avatar } from '../components/Avatar';
import { Icon } from '../components/Icon';
import { Modal, confirmDialog } from '../components/ui';

export function UserDirectoryPage() {
  const act = useAction();
  const server = useServerState();
  const users = useQuery<ServerUser[]>(server.data?.user?.role === 'ADMIN' ? 'users-list' : null, {}, [], [server.data?.user?.id]);
  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState<ServerUser | null>(null);
  const me = server.data?.user;

  if (server.data && me?.role !== 'ADMIN')
    return <div className="page empty">Only admins can manage users. {!server.data.multiuser && 'Turn on multi-user mode on the server first (ENVELOPE_LOGIN_METHOD=multiuser).'}</div>;

  const update = async (u: ServerUser, patch: Partial<{ role: string; enabled: boolean; displayName: string }>) => {
    if ((await act('user-update', { id: u.id, ...patch })) !== undefined) users.reload();
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1>User directory</h1>
        <span className="muted small">People must be added here before they can sign in, with a password or with Google.</span>
        <div className="spacer" />
        <button className="primary" onClick={() => setAdding(true)}>
          <Icon name="plus" /> Add user
        </button>
      </div>
      <div className="card" style={{ overflowX: 'auto' }}>
        <table className="grid">
          <thead>
            <tr>
              <th>User</th>
              <th>Role</th>
              <th>Signs in with</th>
              <th>Enabled</th>
              <th>Last sign-in</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(users.data ?? []).map(u => (
              <tr key={u.id}>
                <td>
                  <div className="row">
                    <Avatar name={userLabel(u)} picture={u.picture} size={28} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>
                        {u.displayName || <span className="dim">No name yet</span>} {u.id === me?.id && <span className="badge">You</span>}
                      </div>
                      <div className="dim small">{u.userName}</div>
                    </div>
                  </div>
                </td>
                <td>
                  <select value={u.role} onChange={e => update(u, { role: e.target.value })} aria-label={`Role for ${u.userName}`}>
                    <option value="BASIC">Basic</option>
                    <option value="ADMIN">Admin</option>
                  </select>
                </td>
                <td>
                  <div className="row wrap" style={{ gap: 4 }}>
                    {u.hasPassword && <span className="badge">{u.mustChangePassword ? 'Temporary password' : 'Password'}</span>}
                    {u.google && <span className="badge accent">Google</span>}
                    {!u.hasPassword && !u.google && <span className="dim small">Google (on first sign-in)</span>}
                  </div>
                </td>
                <td>
                  <input type="checkbox" checked={u.enabled} onChange={e => update(u, { enabled: e.target.checked })} aria-label={`Enable ${u.userName}`} />
                </td>
                <td className="small muted">{u.lastLogin ? new Date(u.lastLogin).toLocaleString() : <span className="badge warn">Invited</span>}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="small ghost" onClick={() => setResetting(u)}>
                    {u.hasPassword ? 'Reset password' : 'Set password'}
                  </button>
                  <button
                    className="icon"
                    disabled={u.id === me?.id}
                    aria-label={`Delete ${u.userName}`}
                    title={u.id === me?.id ? 'You can’t delete yourself' : 'Delete user'}
                    onClick={async () => {
                      if (
                        await confirmDialog({
                          title: 'Delete user',
                          message: `Delete ${u.userName}? Budgets they own move to you, and they lose access to budgets shared with them.`,
                          danger: true,
                          confirmLabel: 'Delete',
                        })
                      ) {
                        if ((await act('users-delete', { ids: [u.id] }, 'User deleted')) !== undefined) users.reload();
                      }
                    }}
                  >
                    <Icon name="trash" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {users.data?.length === 0 && <div className="empty">No users yet.</div>}
      </div>
      {resetting && (
        <SetPasswordModal
          user={resetting}
          self={resetting.id === me?.id}
          onClose={() => setResetting(null)}
          onDone={() => {
            setResetting(null);
            users.reload();
          }}
        />
      )}
      {adding && (
        <AddUserModal
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            users.reload();
          }}
        />
      )}
    </div>
  );
}

function AddUserModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const act = useAction();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<'BASIC' | 'ADMIN'>('BASIC');
  const [password, setPassword] = useState('');
  const isEmail = email.includes('@');
  const submit = async () => {
    if (!isEmail && !password) return;
    const r = await act('user-create', { userName: email.trim(), displayName: name.trim() || null, role, password: password || undefined }, `${email.trim()} can now sign in`);
    if (r !== undefined) onAdded();
  };
  return (
    <Modal
      title="Add user"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={email.trim().length < 3 || (!isEmail && password.length < 8)} onClick={submit}>
            Add user
          </button>
        </>
      }
    >
      <label className="field">
        Email or username
        <input autoFocus value={email} onChange={e => setEmail(e.target.value)} placeholder="sam@gmail.com" autoCapitalize="none" onKeyDown={e => e.key === 'Enter' && submit()} />
      </label>
      <span className="dim small">Use their Google email so they can also sign in with Google.</span>
      <label className="field">
        Temporary password {isEmail ? '(optional)' : ''}
        <input type="text" value={password} onChange={e => setPassword(e.target.value)} placeholder={isEmail ? 'Leave empty for Google-only sign-in' : 'At least 8 characters'} autoComplete="off" />
      </label>
      {password && <span className="dim small">They’ll be asked to choose their own password the first time they sign in.</span>}
      <label className="field">
        Display name (optional)
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Taken from Google on first sign-in if empty" />
      </label>
      <label className="field">
        Role
        <select value={role} onChange={e => setRole(e.target.value as 'BASIC' | 'ADMIN')}>
          <option value="BASIC">Basic — uses budgets shared with them</option>
          <option value="ADMIN">Admin — also manages users and all budgets</option>
        </select>
      </label>
    </Modal>
  );
}

function SetPasswordModal({ user, self, onClose, onDone }: { user: ServerUser; self: boolean; onClose: () => void; onDone: () => void }) {
  const act = useAction();
  const [password, setPassword] = useState('');
  return (
    <Modal
      title={`${user.hasPassword ? 'Reset' : 'Set'} password for ${userLabel(user)}`}
      onClose={onClose}
      footer={
        <>
          {user.hasPassword && user.google && (
            <button
              className="ghost danger"
              onClick={async () => {
                if ((await act('user-set-password', { id: user.id, password: null }, 'Password removed; Google sign-in only')) !== undefined) onDone();
              }}
            >
              Remove password
            </button>
          )}
          <div className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            disabled={password.length < 8}
            onClick={async () => {
              if ((await act('user-set-password', { id: user.id, password }, 'Password set')) !== undefined) onDone();
            }}
          >
            Save
          </button>
        </>
      }
    >
      <label className="field">
        {self ? 'New password' : 'Temporary password'}
        <input autoFocus type="text" value={password} onChange={e => setPassword(e.target.value)} autoComplete="off" placeholder="At least 8 characters" />
      </label>
      {!self && <p className="muted small">{userLabel(user)} is signed out everywhere and must choose a new password at next sign-in.</p>}
    </Modal>
  );
}
