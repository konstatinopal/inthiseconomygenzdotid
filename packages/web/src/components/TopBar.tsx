import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useApp, useAction } from '../lib/app';
import { send } from '../lib/client';
import { Icon } from './Icon';
import { MenuButton, promptDialog } from './ui';
import { Avatar } from './Avatar';
import { isMultiUser, useServerState, userLabel } from '../lib/server';

function timeAgo(ms?: number) {
  if (!ms) return 'never';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return new Date(ms).toLocaleTimeString();
}

export function TopBar({ onMenu, onCommand, onHelp }: { onMenu: () => void; onCommand: () => void; onHelp: () => void }) {
  const { file, sync, privacy, setPrivacy, notify } = useApp();
  const act = useAction();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const server = useServerState();
  const me = isMultiUser(server.data) ? server.data!.user : null;

  const syncLabel =
    sync.state === 'disabled'
      ? 'Local only'
      : sync.state === 'syncing'
        ? 'Syncing…'
        : sync.state === 'error'
          ? 'Sync error'
          : sync.state === 'offline'
            ? 'Offline'
            : `Synced ${timeAgo(sync.lastSync)}`;

  return (
    <header className="topbar">
      <button className="icon mobile-only" onClick={onMenu} aria-label="Open menu">
        <Icon name="menu" size={20} />
      </button>
      <nav className="pill-nav" aria-label="Sections">
        <NavLink to="/budget">
          <Icon name="budget" /> Budget
        </NavLink>
        <NavLink to="/accounts">
          <Icon name="wallet" /> Accounts
        </NavLink>
        <NavLink to="/reports">
          <Icon name="reports" /> Reports
        </NavLink>
      </nav>
      <button className="circle pill hidden-sm" onClick={onCommand} title="Search (Ctrl+K)" aria-label="Search">
        <Icon name="search" />
      </button>
      <div className="spacer" />
      <MenuButton
        className="pill"
        title="Budget file"
        items={[
          {
            label: 'Rename budget',
            onClick: async () => {
              const name = await promptDialog({ title: 'Rename budget', label: 'Name', initial: file?.name });
              if (name) await act('file-rename', { id: file!.id, name });
            },
          },
          { label: 'Settings', onClick: () => navigate('/settings') },
          { divider: true, label: '' },
          {
            label: 'Close file',
            onClick: async () => {
              try {
                localStorage.removeItem('lastFile');
              } catch {}
              await send('file-close');
              navigate('/');
            },
          },
        ]}
      >
        <Icon name="file" />
        <span className="ellipsis" style={{ maxWidth: 200 }}>
          {file?.name}
        </span>
        <Icon name="down" size={14} />
      </MenuButton>
      <button
        className="pill"
        title={sync.error ?? syncLabel}
        disabled={busy}
        onClick={async () => {
          if (sync.state === 'disabled') {
            navigate('/settings#sync');
            return;
          }
          setBusy(true);
          const s: any = await act('sync-now');
          setBusy(false);
          if (s?.state === 'error') notify('error', s.error);
        }}
      >
        <span className={`sync-dot ${sync.state}`} />
        <span className="hidden-sm">{syncLabel}</span>
      </button>
      <div className="spacer" />
      <button className="circle pill" onClick={() => setPrivacy(!privacy)} title={privacy ? 'Show amounts' : 'Hide amounts (privacy filter)'} aria-pressed={privacy}>
        <Icon name={privacy ? 'eyeoff' : 'eye'} />
      </button>
      <button className="circle pill hidden-sm" title="Undo (Ctrl+Z)" onClick={() => act('undo')}>
        <Icon name="undo" />
      </button>
      <button className="circle pill hidden-sm" title="Redo (Ctrl+Shift+Z)" onClick={() => act('redo')}>
        <Icon name="redo" />
      </button>
      <button className="circle pill hidden-sm" onClick={onHelp} title="Keyboard shortcuts (?)">
        <Icon name="help" />
      </button>
      {me && (
        <MenuButton
          className="pill"
          title="Account"
          align="right"
          items={[
            { header: true, label: me.userName },
            ...(me.role === 'ADMIN' ? [{ label: 'User directory', onClick: () => navigate('/user-directory') }] : []),
            { label: 'Account & sync settings', onClick: () => navigate('/settings#sync') },
            { divider: true, label: '' },
            {
              label: 'Sign out',
              onClick: async () => {
                await act('server-logout');
                server.reload();
              },
            },
          ]}
        >
          <Avatar name={userLabel(me)} picture={me.picture} size={28} />
          <span className="hidden-sm ellipsis" style={{ maxWidth: 140 }}>
            {userLabel(me)}
          </span>
        </MenuButton>
      )}
    </header>
  );
}
