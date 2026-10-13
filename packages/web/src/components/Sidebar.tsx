import { useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import type { AccountEntity } from '@envelope/core';
import { useApp } from '../lib/app';
import { send } from '../lib/client';
import { Icon } from './Icon';
import { Amount } from './ui';
import { AddAccountModal } from './AddAccount';

export function Sidebar({ open }: { open: boolean }) {
  const { accounts, file, notify } = useApp();
  const [adding, setAdding] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const viewActive = (v: string) => location.pathname === '/accounts' && new URLSearchParams(location.search).get('view') === v;
  const on = accounts.filter(a => !a.offbudget && !a.closed);
  const off = accounts.filter(a => a.offbudget && !a.closed);
  const closed = accounts.filter(a => a.closed);
  const sum = (list: AccountEntity[]) => list.reduce((s, a) => s + a.balance, 0);

  const drop = async (targetId: string | null) => {
    if (dragId && dragId !== targetId) {
      try {
        await send('account-move', { id: dragId, targetId });
      } catch (e: any) {
        notify('error', e.message);
      }
    }
    setDragId(null);
    setOverId(null);
  };

  const acctLink = (a: AccountEntity) => (
    <NavLink
      key={a.id}
      to={`/accounts/${a.id}`}
      className={({ isActive }) => `acct ${isActive ? 'active' : ''} ${dragId === a.id ? 'dragging' : ''} ${overId === a.id ? 'drop-before' : ''}`}
      draggable
      onDragStart={() => setDragId(a.id)}
      onDragOver={e => {
        e.preventDefault();
        setOverId(a.id);
      }}
      onDragLeave={() => setOverId(null)}
      onDrop={e => {
        e.preventDefault();
        void drop(a.id);
      }}
      onDragEnd={() => {
        setDragId(null);
        setOverId(null);
      }}
    >
      <span className="ellipsis">{a.name}</span>
      <Amount value={a.balance} className={a.balance < 0 ? 'neg' : ''} />
    </NavLink>
  );

  return (
    <aside className={`sidebar ${open ? 'open' : ''}`} aria-label="Sidebar">
      <div className="brand">
        <img src="/icon.svg" width={26} height={26} alt="" />
        <span className="ellipsis">{file?.name ?? 'inthiseconomygenz.id'}</span>
      </div>
      <div className="mobile-links">
      <nav>
        <NavLink to="/budget">
          <Icon name="budget" /> Budget
        </NavLink>
        <NavLink to="/reports">
          <Icon name="reports" /> Reports
        </NavLink>
        <NavLink to="/schedules">
          <Icon name="calendar" /> Schedules
        </NavLink>
        <NavLink to="/payees">
          <Icon name="payees" /> Payees
        </NavLink>
        <NavLink to="/rules">
          <Icon name="rules" /> Rules
        </NavLink>
        <NavLink to="/tags">
          <Icon name="tag" /> Tags
        </NavLink>
        <NavLink to="/settings">
          <Icon name="settings" /> Settings
        </NavLink>
      </nav>
      </div>
      <div className="section">
        <span>Accounts</span>
      </div>
      <NavLink to="/accounts" end className={() => `acct group ${location.pathname === '/accounts' && !location.search.includes('view=') ? 'active' : ''}`}>
        <span>All accounts</span>
        <Amount value={sum(accounts)} />
      </NavLink>
      <NavLink to="/accounts?view=onbudget" className={() => `acct group ${viewActive('onbudget') ? 'active' : ''}`}>
        <span>On budget</span>
        <Amount value={sum(on)} />
      </NavLink>
      {on.map(acctLink)}
      <NavLink to="/accounts?view=offbudget" className={() => `acct group ${viewActive('offbudget') ? 'active' : ''}`}>
        <span>Off budget</span>
        <Amount value={sum(off)} />
      </NavLink>
      {off.map(acctLink)}
      {closed.length > 0 && (
        <>
          <button className="navbtn acct group" onClick={() => setShowClosed(!showClosed)} style={{ justifyContent: 'space-between' }}>
            <span>Closed accounts ({closed.length})</span>
            <Icon name={showClosed ? 'down' : 'right'} size={14} />
          </button>
          {showClosed && closed.map(acctLink)}
        </>
      )}
      <div className="footer">
        <button onClick={() => setAdding(true)}>
          <Icon name="plus" /> Add account
        </button>
      </div>
      {adding && (
        <AddAccountModal
          onClose={() => setAdding(false)}
          onCreated={id => {
            setAdding(false);
            navigate(`/accounts/${id}`);
          }}
        />
      )}
    </aside>
  );
}
