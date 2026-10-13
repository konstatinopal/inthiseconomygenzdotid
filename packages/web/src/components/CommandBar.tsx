import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../lib/app';
import { Modal } from './ui';
import { REPORTS } from '../pages/reports/catalog';

interface Cmd {
  label: string;
  hint: string;
  run: () => void;
}

export function CommandBar({ onClose }: { onClose: () => void }) {
  const { accounts, groups, setPrivacy, privacy } = useApp();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [hl, setHl] = useState(0);
  const go = (path: string) => () => navigate(path);

  const all: Cmd[] = useMemo(
    () => [
      { label: 'Budget', hint: 'Page', run: go('/budget') },
      { label: 'All accounts', hint: 'Page', run: go('/accounts') },
      { label: 'Reports', hint: 'Page', run: go('/reports') },
      { label: 'Schedules', hint: 'Page', run: go('/schedules') },
      { label: 'Payees', hint: 'Page', run: go('/payees') },
      { label: 'Rules', hint: 'Page', run: go('/rules') },
      { label: 'Tags', hint: 'Page', run: go('/tags') },
      { label: 'Settings', hint: 'Page', run: go('/settings') },
      { label: privacy ? 'Show amounts' : 'Hide amounts', hint: 'Action', run: () => setPrivacy(!privacy) },
      ...accounts.map(a => ({ label: a.name, hint: a.closed ? 'Closed account' : 'Account', run: go(`/accounts/${a.id}`) })),
      ...groups.flatMap(g => g.categories.map(c => ({ label: c.name, hint: `Category · ${g.name}`, run: go(`/categories/${c.id}`) }))),
      ...REPORTS.map(r => ({ label: r.title, hint: 'Report', run: go(`/reports/${r.id}`) })),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accounts, groups, privacy],
  );
  const list = all.filter(c => c.label.toLowerCase().includes(q.toLowerCase())).slice(0, 12);
  const run = (c?: Cmd) => {
    if (!c) return;
    onClose();
    c.run();
  };

  return (
    <div className="overlay" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal cmdk" role="dialog" aria-label="Command bar">
        <input
          autoFocus
          placeholder="Jump to a page, account, category or report…"
          value={q}
          onChange={e => {
            setQ(e.target.value);
            setHl(0);
          }}
          onKeyDown={e => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setHl(h => Math.min(h + 1, list.length - 1));
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setHl(h => Math.max(h - 1, 0));
            }
            if (e.key === 'Enter') run(list[hl]);
          }}
        />
        <div style={{ padding: 4, maxHeight: 400, overflowY: 'auto' }} role="listbox">
          {list.map((c, i) => (
            <div key={c.label + c.hint} role="option" aria-selected={i === hl} className={`ac-item ${i === hl ? 'hl' : ''}`} onMouseEnter={() => setHl(i)} onClick={() => run(c)}>
              <span>{c.label}</span>
              <span className="dim small">{c.hint}</span>
            </div>
          ))}
          {!list.length && <div className="empty">No matches</div>}
        </div>
      </div>
    </div>
  );
}

const SHORTCUTS: [string, string][] = [
  ['Ctrl/Cmd + K', 'Open the command bar'],
  ['Ctrl/Cmd + Z', 'Undo'],
  ['Ctrl/Cmd + Shift + Z', 'Redo'],
  ['?', 'Show this help'],
  ['g then b / a / r / s / p / u', 'Go to Budget, Accounts, Reports, Schedules, Payees, Rules'],
  ['t', 'Register: add a transaction'],
  ['/', 'Register: focus search'],
  ['Tab / Shift + Tab', 'Register: move between fields'],
  ['Enter', 'Register: save the row (and start a new one when adding)'],
  ['Escape', 'Register: cancel editing'],
  ['↑ / ↓', 'Register: move the selection; Enter edits it'],
  ['Space', 'Register: select the focused row'],
  ['c', 'Register: toggle cleared on selected rows'],
  ['Delete', 'Register: delete selected rows'],
  ['Enter / Tab', 'Budget: save the amount and move to the next category'],
];

export function ShortcutsModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose}>
      <table className="grid">
        <tbody>
          {SHORTCUTS.map(([k, v]) => (
            <tr key={k}>
              <td style={{ width: 220 }}>
                <span className="kbd">{k}</span>
              </td>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
