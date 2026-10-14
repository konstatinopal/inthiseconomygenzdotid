import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { currentPeriod, dates, formatAmount, MAX_START_DAY, normalizeStartDay, periodRange, type NumberFormat } from '@envelope/core';
import { useApp, useAction, type Theme } from '../lib/app';
import { send } from '../lib/client';
import { useQuery } from '../lib/hooks';
import { ServerSettings } from '../components/ServerSettings';
import { downloadText } from './Account';
import { ManageAccessModal } from '../components/ManageAccess';
import { isMultiUser, useServerState } from '../lib/server';
import { confirmDialog, promptDialog } from '../components/ui';

function Section({ title, children, id }: { title: string; children: React.ReactNode; id?: string }) {
  return (
    <section className="card pad col" id={id}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export function SettingsPage() {
  const { prefs, setPref, theme, setTheme, file, sync, notify } = useApp();
  const act = useAction();
  const navigate = useNavigate();
  const server = useServerState();
  const cloud = useQuery<{ access: 'owner' | 'shared' | 'admin'; owner: string } | null>(file?.cloudFileId && server.data?.loggedIn ? 'file-cloud-info' : null, {}, [], [file?.cloudFileId, server.data?.loggedIn]);
  const [sharing, setSharing] = useState(false);
  const multiuser = isMultiUser(server.data);
  const canManage = !cloud.data || cloud.data.access !== 'shared';
  const ownerOnly = canManage ? undefined : 'Only the owner can do this';
  const enc = useQuery<{ enabled: boolean; unlocked: boolean }>('encryption-status', {}, []);
  const [busy, setBusy] = useState(false);
  const sample = formatAmount(-123456, { numberFormat: prefs.numberFormat, hideFraction: prefs.hideFraction, currencySymbol: prefs.currencySymbol, symbolPosition: prefs.symbolPosition, symbolSpace: prefs.symbolSpace });

  const exportFile = async () => {
    const r = await act<{ name: string; data: string }>('file-export');
    if (!r) return;
    const bin = atob(r.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/x-sqlite3' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${r.name}-${new Date().toISOString().slice(0, 10)}.sqlite`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
      enc.reload();
    }
  };

  return (
    <div className="page col" style={{ maxWidth: 820, gap: 16 }}>
      <h1>Settings</h1>

      <Section title="Appearance">
        <div className="segmented" role="group" aria-label="Theme">
          {(['light', 'dark', 'midnight', 'system'] as Theme[]).map(t => (
            <button key={t} className={theme === t ? 'on' : ''} onClick={() => setTheme(t)}>
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </Section>

      <Section title="Formatting">
        <div className="row wrap">
          <label className="field">
            Number format
            <select value={prefs.numberFormat ?? 'comma-dot'} onChange={e => setPref('numberFormat', e.target.value as NumberFormat)}>
              <option value="comma-dot">1,000.33</option>
              <option value="dot-comma">1.000,33</option>
              <option value="space-comma">1 000,33</option>
              <option value="apostrophe-dot">1’000.33</option>
              <option value="comma-dot-in">1,00,000.33</option>
            </select>
          </label>
          <label className="field">
            Date format
            <select value={prefs.dateFormat ?? 'MM/dd/yyyy'} onChange={e => setPref('dateFormat', e.target.value)}>
              <option value="MM/dd/yyyy">MM/DD/YYYY</option>
              <option value="dd/MM/yyyy">DD/MM/YYYY</option>
              <option value="yyyy-MM-dd">YYYY-MM-DD</option>
              <option value="dd.MM.yyyy">DD.MM.YYYY</option>
              <option value="MM.dd.yyyy">MM.DD.YYYY</option>
            </select>
          </label>
          <label className="field">
            Currency symbol
            <input value={prefs.currencySymbol ?? ''} onChange={e => setPref('currencySymbol', e.target.value)} placeholder="e.g. $ or €" style={{ width: 90 }} />
          </label>
          <label className="field">
            Symbol position
            <select value={prefs.symbolPosition ?? 'before'} onChange={e => setPref('symbolPosition', e.target.value)}>
              <option value="before">Before</option>
              <option value="after">After</option>
            </select>
          </label>
        </div>
        <div className="row wrap">
          <label className="check">
            <input type="checkbox" checked={!!prefs.hideFraction} onChange={e => setPref('hideFraction', e.target.checked)} /> Hide decimal places
          </label>
          <label className="check">
            <input type="checkbox" checked={!!prefs.symbolSpace} onChange={e => setPref('symbolSpace', e.target.checked)} /> Space between symbol and amount
          </label>
          <span className="muted">
            Preview: <strong>{sample}</strong>
          </span>
        </div>
      </Section>

      <Section title="Budget">
        <p className="muted small">
          <strong>Envelope</strong> budgeting gives every dollar a job: income goes to “To Budget” and is assigned to categories. <strong>Tracking</strong> compares planned against actual
          income and expenses. Switching keeps both sets of budget amounts.
        </p>
        <div className="segmented" role="group" aria-label="Budget type">
          {(['envelope', 'tracking'] as const).map(t => (
            <button key={t} className={(prefs.budgetType ?? 'envelope') === t ? 'on' : ''} onClick={() => act('budget-set-type', { type: t })}>
              {t === 'envelope' ? 'Envelope budget' : 'Tracking budget'}
            </button>
          ))}
        </div>
      </Section>

      <MonthStartSection />

      <ServerSettings onChange={() => server.reload()} />

      {server.data?.loggedIn && (
        <Section title="Sync this budget" id="sync-file">
          {file?.cloudFileId ? (
            <>
              <div className="row">
                <span className={`sync-dot ${sync.state}`} />
                <span className="grow">
                  {sync.state === 'error' ? sync.error : sync.state === 'syncing' ? 'Syncing…' : sync.lastSync ? `Last synced ${new Date(sync.lastSync).toLocaleString()}` : 'Synced'}
                </span>
                <button disabled={busy} onClick={() => run(() => act('sync-now'))}>
                  Sync now
                </button>
              </div>
              {sync.reason === 'file-has-reset' && (
                <p className="warn small">This file was reset on another device. Close it and download it again from the file list.</p>
              )}
              {multiuser && (
                <div className="row">
                  <span className="grow muted small">
                    {cloud.data?.access === 'shared' ? 'Shared with you. ' : cloud.data?.access === 'admin' ? 'You manage this budget as an admin. ' : 'You own this budget. '}
                  </span>
                  <button disabled={!canManage} title={ownerOnly} onClick={() => setSharing(true)}>
                    Manage access
                  </button>
                </div>
              )}
              <div className="row wrap">
                <button
                  disabled={busy || !canManage}
                  title={ownerOnly}
                  onClick={async () => {
                    if (await confirmDialog({ title: 'Reset sync', message: 'Upload this device’s copy as the new version? Other devices must download the file again. Unsynced changes on other devices are lost.', danger: true, confirmLabel: 'Reset sync' }))
                      await run(() => act('sync-reset'));
                  }}
                >
                  Reset sync
                </button>
                <button disabled={busy} onClick={() => run(() => act('sync-repair', undefined, 'Sync repaired'))}>
                  Repair sync
                </button>
              </div>
            </>
          ) : (
            <div className="row">
              <span className="grow muted">This budget is only on this device.</span>
              <button className="primary" disabled={busy} onClick={() => run(() => act('file-upload', undefined, 'Budget uploaded. Open it on other devices from the file list.'))}>
                Upload to server
              </button>
            </div>
          )}
        </Section>
      )}

      {server.data?.loggedIn && file?.cloudFileId && (
        <Section title="End-to-end encryption">
          {enc.data?.enabled ? (
            <>
              <div className="row">
                <span className="badge pos">Encrypted</span>
                <span className="muted small grow">The server only stores ciphertext. Other devices need the password to open this budget.</span>
              </div>
              {!enc.data.unlocked && (
                <button
                  onClick={async () => {
                    const password = await promptDialog({ title: 'Unlock encryption', label: 'Encryption password', type: 'password' });
                    if (password) await run(() => act('encryption-unlock', { password }, 'Unlocked'));
                  }}
                >
                  Enter password
                </button>
              )}
              <div>
                <button
                  disabled={busy || !canManage}
                  title={ownerOnly}
                  onClick={async () => {
                    const password = await promptDialog({ title: 'Change encryption password', label: 'New password', type: 'password' });
                    if (password) await run(() => act('encryption-enable', { password }, 'Key changed. Other devices must re-download.'));
                  }}
                >
                  Change password
                </button>
              </div>
            </>
          ) : (
            <>
              {!window.isSecureContext && (
                <p className="warn small">End-to-end encryption needs a secure connection. Open the app over HTTPS (or on localhost) to turn it on.</p>
              )}
              <p className="muted small">
                Encrypt everything before it leaves this device (AES-256-GCM, key derived from your password). If you lose the password, the server copy can’t be recovered — your local copy is unaffected.
              </p>
              <div>
                <button
                  className="primary"
                  disabled={busy || !canManage || !window.isSecureContext}
                  title={ownerOnly}
                  onClick={async () => {
                    const password = await promptDialog({ title: 'Enable encryption', label: 'Choose an encryption password', type: 'password' });
                    if (password) await run(() => act('encryption-enable', { password }, 'Encryption enabled'));
                  }}
                >
                  Enable encryption
                </button>
              </div>
            </>
          )}
        </Section>
      )}

      {sharing && file && <ManageAccessModal fileName={file.name} meId={server.data?.user?.id ?? null} onClose={() => setSharing(false)} />}

      <Section title="Data">
        <div className="row wrap">
          <button onClick={exportFile}>Export budget file</button>
          <button
            onClick={async () => {
              const csv = await act<string>('transactions-export-csv', {});
              if (csv) downloadText(`${file?.name ?? 'budget'}-transactions.csv`, csv);
            }}
          >
            Export all transactions (CSV)
          </button>
        </div>
        <p className="dim small">Budget ID: {file?.id}</p>
      </Section>

      <Section title="Advanced">
        <div className="row wrap">
          <button onClick={() => act('reset-cache', undefined, 'Budget cache reset')}>Reset budget cache</button>
          <button
            onClick={async () => {
              const n = await act<number>('repair-splits');
              if (n !== undefined) notify('success', n ? `Repaired ${n} split transaction(s)` : 'All split transactions are consistent');
            }}
          >
            Repair split transactions
          </button>
          <button
            className="danger"
            onClick={async () => {
              if (await confirmDialog({ title: 'Close budget', message: 'Close this budget and return to the file list?', confirmLabel: 'Close' })) {
                try {
                  localStorage.removeItem('lastFile');
                } catch {}
                await send('file-close');
                navigate('/');
              }
            }}
          >
            Close budget
          </button>
        </div>
      </Section>
    </div>
  );
}

function ordinal(n: number) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

const fmtDay = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const monthName = (m: string) => new Date(m + '-01T00:00:00Z').toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Day the budget month starts on, e.g. the 25th when salary arrives on the 25th. */
function MonthStartSection() {
  const { prefs, setPref, notify } = useApp();
  const startDay = normalizeStartDay(prefs.monthStartDay ?? 1);
  const cur = currentPeriod(startDay);
  const preview = [cur, dates.addMonths(cur, 1)].map(p => ({ p, ...periodRange(p, startDay) }));
  return (
    <Section title="Budget month">
      <p className="muted small">
        Choose the day your budget month begins, usually your payday. Spending, To Budget, templates and monthly reports all follow it. A period is
        named after the month most of its days fall in, so with the 25th, Oct 25 – Nov 24 is November: the month that salary pays for.
      </p>
      <label className="field" style={{ maxWidth: 260 }}>
        Month starts on
        <select
          value={startDay}
          onChange={async e => {
            const v = Number(e.target.value);
            await setPref('monthStartDay', v);
            notify('success', v === 1 ? 'Budget months follow the calendar' : `Budget months now start on the ${ordinal(v)}`);
          }}
          aria-label="Month starts on day"
        >
          {Array.from({ length: MAX_START_DAY }, (_, i) => i + 1).map(d => (
            <option key={d} value={d}>
              {d === 1 ? '1st (calendar month)' : `the ${ordinal(d)}`}
            </option>
          ))}
        </select>
      </label>
      <div className="col" style={{ gap: 6 }}>
        {preview.map((x, i) => (
          <div key={x.p} className="row small">
            <span className="badge" style={{ minWidth: 64, justifyContent: 'center' }}>
              {i === 0 ? 'Current' : 'Next'}
            </span>
            <strong style={{ minWidth: 130 }}>{monthName(x.p)}</strong>
            <span className="muted">
              {fmtDay(x.start)} – {fmtDay(x.end)}
            </span>
          </div>
        ))}
      </div>
      <p className="dim small">Days 29–31 aren’t offered because some months don’t have them. Changing this re-groups past transactions; budgeted amounts stay with their month.</p>
    </Section>
  );
}
