import { useState } from 'react';
import { send } from '../lib/client';
import { serverChanged } from '../lib/server';

/** New-password form, used for the forced first-login change and from the account menu. */
export function ChangePasswordForm({
  currentPassword,
  needsCurrent,
  submitLabel = 'Change password',
  onDone,
}: {
  currentPassword?: string;
  needsCurrent: boolean;
  submitLabel?: string;
  onDone: (user: { displayName?: string | null; userName: string } | null) => void;
}) {
  const [current, setCurrent] = useState(currentPassword ?? '');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mismatch = confirm.length > 0 && next !== confirm;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (next.length < 8) return setError('Use at least 8 characters');
    if (next !== confirm) return setError('The passwords don’t match');
    setBusy(true);
    setError(null);
    try {
      const user = await send('server-change-password', { currentPassword: current || undefined, password: next });
      serverChanged();
      onDone(user);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="col" onSubmit={submit}>
      {needsCurrent && !currentPassword && (
        <label className="field">
          Current password
          <input type="password" autoComplete="current-password" value={current} onChange={e => setCurrent(e.target.value)} autoFocus required />
        </label>
      )}
      <label className="field">
        New password
        <input type="password" autoComplete="new-password" value={next} onChange={e => setNext(e.target.value)} autoFocus={!needsCurrent || !!currentPassword} required minLength={8} />
      </label>
      <label className="field">
        Confirm new password
        <input type="password" autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} required aria-invalid={mismatch} />
      </label>
      <span className="dim small">At least 8 characters.</span>
      {(error || mismatch) && <div className="err">{error ?? 'The passwords don’t match'}</div>}
      <button className="primary" type="submit" disabled={busy}>
        {busy ? 'Saving…' : submitLabel}
      </button>
    </form>
  );
}
