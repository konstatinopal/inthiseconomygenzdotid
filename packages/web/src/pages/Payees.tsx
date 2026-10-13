import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { PayeeEntity } from '@envelope/core';
import { useApp, useAction } from '../lib/app';
import { send } from '../lib/client';
import { useQuery } from '../lib/hooks';
import { Modal, confirmDialog } from '../components/ui';
import { Icon } from '../components/Icon';

type Payee = PayeeEntity & { ruleCount: number; txnCount: number };

export function PayeesPage() {
  const { prefs, setPref } = useApp();
  const act = useAction();
  const navigate = useNavigate();
  const payees = useQuery<Payee[]>('payees-get', {}, ['payees', 'transactions', 'rules', 'accounts']);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);
  const list = (payees.data ?? []).filter(p => !p.transfer_acct && (!search || p.name.toLowerCase().includes(search.toLowerCase())));
  const toggle = (id: string) => {
    const n = new Set(selected);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setSelected(n);
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1>Payees</h1>
        <div className="spacer" />
        <label className="check small">
          <input type="checkbox" checked={prefs.learnCategories !== false} onChange={e => setPref('learnCategories', e.target.checked)} /> Learn categories
        </label>
        <input placeholder="Search payees" value={search} onChange={e => setSearch(e.target.value)} aria-label="Search payees" />
        <button
          onClick={async () => {
            const ids = await send<string[]>('payees-orphaned');
            if (!ids.length) return void (await confirmDialog({ title: 'Unused payees', message: 'No unused payees found.', confirmLabel: 'OK' }));
            setSelected(new Set(ids));
          }}
        >
          Find unused
        </button>
        {selected.size > 1 && <button onClick={() => setMerging(true)}>Merge {selected.size}</button>}
        {selected.size > 0 && (
          <button
            className="danger"
            onClick={async () => {
              if (await confirmDialog({ title: 'Delete payees', message: `Delete ${selected.size} payee(s)? Their transactions keep everything except the payee.`, danger: true, confirmLabel: 'Delete' })) {
                await act('payees-delete', { ids: [...selected] });
                setSelected(new Set());
              }
            }}
          >
            Delete {selected.size}
          </button>
        )}
      </div>
      <div className="card">
        <table className="grid">
          <thead>
            <tr>
              <th style={{ width: 30 }}>
                <input type="checkbox" aria-label="Select all" checked={list.length > 0 && list.every(p => selected.has(p.id))} onChange={() => setSelected(list.every(p => selected.has(p.id)) ? new Set() : new Set(list.map(p => p.id)))} />
              </th>
              <th style={{ width: 30 }} />
              <th>Name</th>
              <th className="num">Transactions</th>
              <th className="num">Rules</th>
              <th>Learn categories</th>
            </tr>
          </thead>
          <tbody>
            {list.map(p => (
              <tr key={p.id} className={selected.has(p.id) ? 'selected' : ''}>
                <td>
                  <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} aria-label={`Select ${p.name}`} />
                </td>
                <td>
                  <button className="icon" title={p.favorite ? 'Unfavorite' : 'Favorite'} onClick={() => act('payee-update', { id: p.id, favorite: !p.favorite })} aria-pressed={p.favorite}>
                    <span style={{ color: p.favorite ? 'var(--warn)' : 'var(--text-3)' }}>{p.favorite ? '★' : '☆'}</span>
                  </button>
                </td>
                <td>
                  {renaming === p.id ? (
                    <input
                      autoFocus
                      defaultValue={p.name}
                      onBlur={async e => {
                        if (e.target.value.trim() && e.target.value !== p.name) await act('payee-update', { id: p.id, name: e.target.value });
                        setRenaming(null);
                      }}
                      onKeyDown={e => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                        if (e.key === 'Escape') setRenaming(null);
                      }}
                    />
                  ) : (
                    <span onClick={() => setRenaming(p.id)} style={{ cursor: 'text' }} title="Click to rename">
                      {p.name}
                    </span>
                  )}
                </td>
                <td className="num">
                  <button className="link" onClick={() => navigate(`/accounts?search=${encodeURIComponent(p.name)}`)}>
                    {p.txnCount}
                  </button>
                </td>
                <td className="num">{p.ruleCount > 0 ? <button className="link" onClick={() => navigate('/rules')}>{p.ruleCount}</button> : <span className="dim">0</span>}</td>
                <td>
                  <input type="checkbox" checked={p.learn_categories} onChange={e => act('payee-update', { id: p.id, learn_categories: e.target.checked })} aria-label="Learn categories" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.length === 0 && <div className="empty">No payees{search ? ' match' : ' yet. They are created when you type a new name on a transaction'}.</div>}
      </div>
      {merging && (
        <MergeModal
          payees={(payees.data ?? []).filter(p => selected.has(p.id))}
          onClose={() => setMerging(false)}
          onDone={() => {
            setMerging(false);
            setSelected(new Set());
          }}
        />
      )}
    </div>
  );
}

function MergeModal({ payees, onClose, onDone }: { payees: Payee[]; onClose: () => void; onDone: () => void }) {
  const act = useAction();
  const [target, setTarget] = useState(payees.sort((a, b) => b.txnCount - a.txnCount)[0]?.id);
  return (
    <Modal
      title="Merge payees"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            onClick={async () => {
              await act('payees-merge', { targetId: target, mergeIds: payees.map(p => p.id) }, 'Payees merged');
              onDone();
            }}
          >
            <Icon name="check" /> Merge
          </button>
        </>
      }
    >
      <p className="muted">Transactions and rules using the other payees will use the one you keep.</p>
      {payees.map(p => (
        <label key={p.id} className="check">
          <input type="radio" name="target" checked={target === p.id} onChange={() => setTarget(p.id)} /> Keep “{p.name}” <span className="dim small">({p.txnCount} transactions)</span>
        </label>
      ))}
    </Modal>
  );
}
