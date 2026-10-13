import { useState } from 'react';
import { dates } from '@envelope/core';
import { useAction } from '../lib/app';
import { AmountInput, Modal } from './ui';

export function AddAccountModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState('');
  const [balance, setBalance] = useState<number | null>(0);
  const [offbudget, setOffbudget] = useState(false);
  const [date, setDate] = useState(dates.today());
  const act = useAction();
  const submit = async () => {
    if (!name.trim()) return;
    const id = await act<string>('account-create', { name, balance: balance ?? 0, offbudget, date });
    if (id) onCreated(id);
  };
  return (
    <Modal
      title="Add account"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!name.trim()} onClick={submit}>
            Create account
          </button>
        </>
      }
    >
      <p className="muted small">
        Bank sync providers can be linked later from the account menu once a sync server is configured. Accounts work fully offline.
      </p>
      <label className="field">
        Name
        <input autoFocus value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()} placeholder="e.g. Checking" />
      </label>
      <div className="row">
        <label className="field grow">
          Current balance
          <AmountInput value={balance} onCommit={setBalance} />
        </label>
        <label className="field">
          As of
          <input type="date" value={date} onChange={e => setDate(e.target.value)} />
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={offbudget} onChange={e => setOffbudget(e.target.checked)} />
        <span>
          Off budget <span className="dim small">— investments, loans and assets. Tracked for net worth, not budgeted.</span>
        </span>
      </label>
    </Modal>
  );
}
