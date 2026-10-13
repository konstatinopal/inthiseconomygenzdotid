import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { dates, type Condition, type TransactionEntity } from '@envelope/core';
import { useApp, useAction } from '../lib/app';
import { send } from '../lib/client';
import { useQuery } from '../lib/hooks';
import { Autocomplete, accountItems, categoryItems, payeeItems } from './Autocomplete';
import { Amount, AmountInput, NotesText, confirmDialog } from './ui';
import { Icon } from './Icon';

const ROW = 36;
const TXN_TABLES = ['transactions', 'payees', 'categories', 'accounts', 'schedules', 'rules'];

export interface RegisterColumns {
  notes: boolean;
  balance: boolean;
  account: boolean;
}

export interface RegisterProps {
  account?: string | 'onbudget' | 'offbudget' | null;
  category?: string;
  search?: string;
  filter?: { conditionsOp: 'and' | 'or'; conditions: Condition[] };
  startDate?: string;
  endDate?: string;
  columns: RegisterColumns;
  adding: boolean;
  onAddingChange: (v: boolean) => void;
  selected: Set<string>;
  onSelectedChange: (s: Set<string>) => void;
  onTag?: (tag: string) => void;
  onLoaded?: (txns: TransactionEntity[]) => void;
}

type Item =
  | { kind: 'preview'; p: any }
  | { kind: 'txn'; t: TransactionEntity }
  | { kind: 'child'; t: TransactionEntity; parent: TransactionEntity };

export function Register(props: RegisterProps) {
  const { account, category, search, filter, startDate, endDate, columns, adding, onAddingChange, selected, onSelectedChange } = props;
  const { accounts, fmtDate, categoryName, payeeName, accountName, payees } = useApp();
  const act = useAction();
  const single = account && account !== 'onbudget' && account !== 'offbudget' ? account : null;
  const query = { account: account ?? null, category, search, filter, startDate, endDate };
  const txns = useQuery<TransactionEntity[]>('transactions-get', query, TXN_TABLES);
  const previews = useQuery<any[]>(category ? null : 'schedules-upcoming', { account: account ?? null }, ['schedules', 'transactions', 'rules', 'preferences']);
  const [editing, setEditing] = useState<string | null>(null);
  const [focus, setFocus] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastClicked = useRef<number | null>(null);

  useEffect(() => {
    if (txns.data) props.onLoaded?.(txns.data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txns.data]);

  const items: Item[] = useMemo(() => {
    const out: Item[] = [];
    if (!search && !filter?.conditions.length) for (const p of previews.data ?? []) out.push({ kind: 'preview', p });
    for (const t of txns.data ?? []) {
      out.push({ kind: 'txn', t });
      for (const c of t.subtransactions ?? []) out.push({ kind: 'child', t: c, parent: t });
    }
    return out;
  }, [txns.data, previews.data, search, filter]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const cols = [
    '34px',
    '108px',
    columns.account ? 'minmax(100px, 0.9fr)' : null,
    'minmax(120px, 1.3fr)',
    columns.notes ? 'minmax(100px, 1.5fr)' : null,
    'minmax(110px, 1.1fr)',
    '110px',
    '110px',
    columns.balance && single ? '120px' : null,
    '40px',
  ]
    .filter(Boolean)
    .join(' ');

  const txnIds = items.filter(i => i.kind === 'txn').map(i => (i as any).t.id as string);

  const toggleSelect = (id: string, index: number, shift: boolean) => {
    const next = new Set(selected);
    if (shift && lastClicked.current !== null) {
      const [a, b] = [Math.min(lastClicked.current, index), Math.max(lastClicked.current, index)];
      for (let i = a; i <= b; i++) {
        const it = items[i];
        if (it?.kind === 'txn') next.add(it.t.id);
      }
    } else if (next.has(id)) next.delete(id);
    else next.add(id);
    lastClicked.current = index;
    onSelectedChange(next);
  };

  const startEdit = useCallback(
    async (t: TransactionEntity) => {
      if (t.reconciled) {
        const ok = await confirmDialog({ title: 'Edit reconciled transaction?', message: 'This transaction is reconciled with a bank statement. Editing it may make your reconciled balance wrong.', confirmLabel: 'Edit anyway' });
        if (!ok) return;
      }
      setEditing(t.id);
      onAddingChange(false);
    },
    [onAddingChange],
  );

  const toggleCleared = async (t: TransactionEntity) => {
    if (t.reconciled) {
      const ok = await confirmDialog({ title: 'Unlock reconciled transaction?', message: 'This transaction is reconciled. Unlock it and mark it uncleared?', confirmLabel: 'Unlock' });
      if (!ok) return;
      await act('transaction-update', { id: t.id, reconciled: false, cleared: false });
      return;
    }
    await act('transaction-update', { id: t.id, cleared: !t.cleared });
  };

  const onKeyDown = async (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement) !== e.currentTarget) return;
    const it = items[focus];
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocus(f => Math.min(f + 1, items.length - 1));
      ensureVisible(focus + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocus(f => Math.max(f - 1, 0));
      ensureVisible(focus - 1);
    } else if (e.key === 'Enter' && it) {
      e.preventDefault();
      if (it.kind === 'txn') void startEdit(it.t);
      else if (it.kind === 'child') void startEdit(it.parent);
    } else if (e.key === ' ' && it?.kind === 'txn') {
      e.preventDefault();
      toggleSelect(it.t.id, focus, e.shiftKey);
    } else if (e.key === 'c') {
      const targets = selected.size ? [...selected] : it?.kind === 'txn' ? [it.t.id] : [];
      const all = (txns.data ?? []).filter(t => targets.includes(t.id));
      const value = !all.every(t => t.cleared);
      await act('transactions-batch', { updated: all.filter(t => !t.reconciled).map(t => ({ id: t.id, cleared: value })) });
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && selected.size) {
      if (await confirmDialog({ title: 'Delete transactions', message: `Delete ${selected.size} transaction${selected.size === 1 ? '' : 's'}?`, danger: true, confirmLabel: 'Delete' })) {
        await act('transactions-batch', { deleted: [...selected] });
        onSelectedChange(new Set());
      }
    }
  };

  const ensureVisible = (index: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const top = index * ROW;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW * 2 > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW * 2 - el.clientHeight;
  };

  const first = Math.max(0, Math.floor(scrollTop / ROW) - 10);
  const last = Math.min(items.length, Math.ceil((scrollTop + height) / ROW) + 10);
  const allSelected = txnIds.length > 0 && txnIds.every(id => selected.has(id));
  const isTransferPayee = (id: string | null) => !!payees.find(p => p.id === id)?.transfer_acct;

  return (
    <div className="register card" style={{ ['--reg-cols' as any]: cols, overflow: 'hidden' }}>
      <div className="reg-head" role="row">
        <div>
          <input
            type="checkbox"
            aria-label="Select all"
            checked={allSelected}
            onChange={() => onSelectedChange(allSelected ? new Set() : new Set(txnIds))}
          />
        </div>
        <div>Date</div>
        {columns.account && <div>Account</div>}
        <div>Payee</div>
        {columns.notes && <div>Notes</div>}
        <div>Category</div>
        <div className="num">Payment</div>
        <div className="num">Deposit</div>
        {columns.balance && single && <div className="num">Balance</div>}
        <div title="Cleared">✓</div>
      </div>
      <div
        className="reg-scroll"
        ref={scrollRef}
        tabIndex={0}
        role="grid"
        aria-label="Transactions"
        aria-rowcount={items.length}
        onKeyDown={onKeyDown}
        onScroll={e => setScrollTop(e.currentTarget.scrollTop)}
      >
        {adding && (
          <TxnEditor
            key="new"
            isNew
            defaultAccount={single ?? accounts.find(a => !a.closed && (account !== 'offbudget' ? !a.offbudget : a.offbudget))?.id ?? accounts[0]?.id}
            showAccount={columns.account || !single}
            columns={columns}
            single={single}
            onDone={() => onAddingChange(false)}
          />
        )}
        {txns.loading && !txns.data && <div className="empty">Loading…</div>}
        {!txns.loading && items.length === 0 && !adding && (
          <div className="empty">
            {search || filter?.conditions.length ? 'No transactions match.' : 'No transactions yet. Press “t” or “Add transaction” to add one, or import a file.'}
          </div>
        )}
        <div style={{ height: first * ROW }} />
        {items.slice(first, last).map((it, k) => {
          const index = first + k;
          const focused = index === focus;
          if (it.kind === 'preview') {
            const p = it.p;
            return (
              <div key={p.id} className="reg-row preview" role="row" style={focused ? { boxShadow: 'inset 3px 0 0 var(--accent)' } : undefined}>
                <div />
                <div>{fmtDate(p.date)}</div>
                {columns.account && <div className="ellipsis">{accountName(p.account)}</div>}
                <div className="ellipsis">
                  {payeeName(p.payee) || p.scheduleName || 'Scheduled'} <span className={`badge ${p.status === 'missed' ? 'neg' : p.status === 'due' ? 'warn' : ''}`}>{p.status}</span>
                </div>
                {columns.notes && (
                  <div className="row" style={{ gap: 4 }}>
                    <button className="small" onClick={() => act('schedule-post', { id: p.schedule, date: p.date })}>
                      Post
                    </button>
                    <button className="small ghost" onClick={() => act('schedule-skip', { id: p.schedule })}>
                      Skip
                    </button>
                  </div>
                )}
                <div className="dim">{p.scheduleName}</div>
                <div className="num">{p.amount < 0 && <Amount value={-p.amount} />}</div>
                <div className="num">{p.amount > 0 && <Amount value={p.amount} />}</div>
                {columns.balance && single && <div />}
                <div>
                  <Icon name="calendar" size={14} />
                </div>
              </div>
            );
          }
          const t = it.t;
          if (it.kind === 'txn' && editing === t.id) {
            return (
              <TxnEditor
                key={t.id}
                txn={t}
                defaultAccount={t.account}
                showAccount={columns.account}
                columns={columns}
                single={single}
                onDone={() => {
                  setEditing(null);
                  scrollRef.current?.focus();
                }}
              />
            );
          }
          if (it.kind === 'child' && editing === it.parent.id) return null;
          const isChild = it.kind === 'child';
          const sel = !isChild && selected.has(t.id);
          const transfer = !isChild && isTransferPayee(t.payee);
          const catLabel = t.is_parent ? <span className="dim">Split</span> : transfer && !t.category ? <span className="dim">Transfer</span> : categoryName(t.category) || <span className="warn small">Uncategorized</span>;
          return (
            <div
              key={t.id}
              className={`reg-row ${isChild ? 'child' : ''} ${sel ? 'selected' : ''}`}
              role="row"
              aria-selected={sel}
              style={focused ? { boxShadow: 'inset 3px 0 0 var(--accent)' } : undefined}
              onClick={e => {
                setFocus(index);
                if ((e.target as HTMLElement).closest('button, input, .tag')) return;
                void startEdit(isChild ? it.parent : t);
              }}
            >
              <div>
                {!isChild && (
                  <input
                    type="checkbox"
                    checked={sel}
                    aria-label="Select transaction"
                    onClick={e => {
                      e.stopPropagation();
                      toggleSelect(t.id, index, e.shiftKey);
                    }}
                    onChange={() => {}}
                  />
                )}
              </div>
              <div>{!isChild && fmtDate(t.date)}</div>
              {columns.account && <div className="ellipsis">{!isChild && accountName(t.account)}</div>}
              <div className="ellipsis" title={t.imported_payee ?? undefined}>
                {t.schedule && !isChild && (
                  <span title="Linked to a schedule">
                    <Icon name="calendar" size={12} />{' '}
                  </span>
                )}
                {payeeName(t.payee) || (t.starting_balance_flag ? 'Starting balance' : <span className="dim">{t.imported_payee ?? ''}</span>)}
              </div>
              {columns.notes && (
                <div className="ellipsis" title={t.notes ?? undefined}>
                  <NotesText text={t.notes} onTag={props.onTag} />
                </div>
              )}
              <div className="ellipsis">{catLabel}</div>
              <div className="num">{t.amount < 0 && <Amount value={-t.amount} />}</div>
              <div className="num">{t.amount > 0 && <Amount value={t.amount} />}</div>
              {columns.balance && single && <div className="num">{!isChild && t.balance !== undefined && <Amount value={t.balance} className={t.balance < 0 ? 'neg' : ''} />}</div>}
              <div>
                {!isChild && (
                  <button
                    className={`cleared-btn ${t.reconciled ? 'locked' : t.cleared ? 'on' : ''}`}
                    title={t.reconciled ? 'Reconciled (locked)' : t.cleared ? 'Cleared' : 'Uncleared'}
                    aria-label={t.reconciled ? 'Reconciled' : t.cleared ? 'Cleared' : 'Not cleared'}
                    onClick={e => {
                      e.stopPropagation();
                      void toggleCleared(t);
                    }}
                  >
                    {t.reconciled ? <Icon name="lock" size={11} /> : t.cleared ? <Icon name="check" size={12} /> : null}
                  </button>
                )}
              </div>
            </div>
          );
        })}
        <div style={{ height: Math.max(0, (items.length - last) * ROW) }} />
      </div>
    </div>
  );
}

interface Draft {
  date: string;
  account: string;
  payee: string | null;
  payeeName: string | null;
  notes: string;
  category: string | null;
  payment: number;
  deposit: number;
  cleared: boolean;
  subs: { id?: string; payee: string | null; payeeName?: string | null; notes: string; category: string | null; amount: number }[];
}

function toDraft(t: TransactionEntity | undefined, account: string, date: string): Draft {
  return {
    date: t?.date ?? date,
    account: t?.account ?? account,
    payee: t?.payee ?? null,
    payeeName: null,
    notes: t?.notes ?? '',
    category: t?.category ?? null,
    payment: t && t.amount < 0 ? -t.amount : 0,
    deposit: t && t.amount > 0 ? t.amount : 0,
    cleared: t?.cleared ?? false,
    subs: (t?.subtransactions ?? []).map(s => ({ id: s.id, payee: s.payee, notes: s.notes ?? '', category: s.category, amount: s.amount })),
  };
}

let lastNewDate = dates.today();

function TxnEditor({
  txn,
  isNew,
  defaultAccount,
  showAccount,
  columns,
  single,
  onDone,
}: {
  txn?: TransactionEntity;
  isNew?: boolean;
  defaultAccount: string;
  showAccount: boolean;
  columns: RegisterColumns;
  single: string | null;
  onDone: () => void;
}) {
  const { payees, accounts, groups, notify } = useApp();
  const act = useAction();
  const [draft, setDraft] = useState<Draft>(() => toDraft(txn, defaultAccount, lastNewDate));
  const ref = useRef(draft);
  const [error, setError] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);
  const update = (patch: Partial<Draft>) => {
    ref.current = { ...ref.current, ...patch };
    setDraft(ref.current);
  };

  const pItems = useMemo(() => payeeItems(payees, accounts, draft.account), [payees, accounts, draft.account]);
  const cItems = useMemo(() => categoryItems(groups), [groups]);
  const aItems = useMemo(() => accountItems(accounts), [accounts]);
  const transferAcct = payees.find(p => p.id === draft.payee)?.transfer_acct ?? null;
  const thisOff = accounts.find(a => a.id === draft.account)?.offbudget;
  const otherOff = accounts.find(a => a.id === transferAcct)?.offbudget;
  const categoryDisabled = (!!transferAcct && !thisOff && !otherOff) || !!thisOff;
  const amount = draft.deposit - draft.payment;
  const remaining = amount - draft.subs.reduce((s, c) => s + c.amount, 0);

  const save = async () => {
    const d = ref.current;
    const amt = d.deposit - d.payment;
    if (!d.date || !dates.isValidDate(d.date)) return setError('Enter a valid date');
    if (d.subs.length) {
      const rem = amt - d.subs.reduce((s, c) => s + c.amount, 0);
      if (rem !== 0) return setError(`Split amounts don’t add up: ${(rem / 100).toFixed(2)} remaining`);
    }
    setError(null);
    const subtransactions = d.subs.map(s => ({ id: s.id, payee: s.payeeName ? undefined : s.payee, payee_name: s.payeeName ?? undefined, notes: s.notes || null, category: s.category, amount: s.amount }));
    const common = {
      date: d.date,
      account: d.account,
      payee: d.payeeName ? undefined : d.payee,
      payee_name: d.payeeName ?? undefined,
      notes: d.notes || null,
      category: categoryDisabled || d.subs.length ? null : d.category,
      amount: amt,
    };
    try {
      if (isNew) {
        await send('transaction-add', { ...common, cleared: d.cleared, subtransactions: subtransactions.length ? subtransactions : undefined });
        lastNewDate = d.date;
        // Keep adding: fresh row with the same date and account.
        ref.current = toDraft(undefined, d.account, d.date);
        setDraft(ref.current);
        setFormKey(k => k + 1);
      } else {
        await send('transaction-update', { id: txn!.id, ...common, subtransactions: txn!.is_parent || subtransactions.length ? subtransactions : undefined });
        onDone();
      }
    } catch (e: any) {
      notify('error', e.message);
    }
  };

  const keys = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.defaultPrevented) {
      e.preventDefault();
      void save();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onDone();
    }
  };

  const split = () => {
    const subs = draft.subs.length ? [...draft.subs, { payee: null, notes: '', category: null, amount: remaining }] : [{ payee: null, notes: '', category: draft.category, amount }, { payee: null, notes: '', category: null, amount: 0 }];
    update({ subs, category: null });
  };

  const distribute = () => {
    if (!draft.subs.length) return;
    const share = Math.trunc(remaining / draft.subs.length);
    let left = remaining - share * draft.subs.length;
    update({
      subs: draft.subs.map(s => {
        const extra = left !== 0 ? Math.sign(left) : 0;
        left -= extra;
        return { ...s, amount: s.amount + share + extra };
      }),
    });
  };

  return (
    <div key={formKey} className="reg-editor" onKeyDown={keys}>
      <div className="reg-row editing" role="row">
        <div />
        <div>
          <input type="date" value={draft.date} onChange={e => update({ date: e.target.value })} autoFocus={isNew} aria-label="Date" />
        </div>
        {columns.account && (
          <div>{showAccount ? <Autocomplete items={aItems} value={draft.account} onSelect={id => id && update({ account: id })} ariaLabel="Account" /> : null}</div>
        )}
        <div>
          <Autocomplete
            items={pItems}
            value={draft.payee}
            allowCreate
            autoFocus={!isNew}
            placeholder="Payee"
            ariaLabel="Payee"
            extraItems={draft.payeeName ? [{ id: '__new', label: draft.payeeName }] : []}
            onSelect={(id, name) => update(name ? { payee: '__new', payeeName: name } : { payee: id, payeeName: null })}
          />
        </div>
        {columns.notes && (
          <div>
            <input value={draft.notes} placeholder="Notes" onChange={e => update({ notes: e.target.value })} aria-label="Notes" />
          </div>
        )}
        <div>
          {draft.subs.length ? (
            <span className="dim">Split</span>
          ) : categoryDisabled ? (
            <span className="dim">{thisOff ? 'Off budget' : 'Transfer'}</span>
          ) : (
            <div className="row" style={{ gap: 2 }}>
              <div className="grow">
                <Autocomplete items={cItems} value={draft.category} placeholder="Category" ariaLabel="Category" onSelect={id => update({ category: id })} />
              </div>
              <button className="icon" title="Split transaction" onClick={split} aria-label="Split transaction">
                <Icon name="split" size={14} />
              </button>
            </div>
          )}
        </div>
        <div>
          <AmountInput value={draft.payment} allowEmpty onCommit={v => update({ payment: Math.abs(v ?? 0), deposit: v ? 0 : ref.current.deposit })} ariaLabel="Payment" />
        </div>
        <div>
          <AmountInput value={draft.deposit} allowEmpty onCommit={v => update({ deposit: Math.abs(v ?? 0), payment: v ? 0 : ref.current.payment })} ariaLabel="Deposit" />
        </div>
        {columns.balance && single && <div />}
        <div className="col" style={{ gap: 2 }}>
          <button className="icon" title="Save (Enter)" onClick={save} aria-label="Save">
            <Icon name="check" />
          </button>
        </div>
      </div>
      {draft.subs.map((s, i) => (
        <div key={i} className="reg-row editing child" role="row">
          <div />
          <div className="dim small" style={{ textAlign: 'right' }}>
            split {i + 1}
          </div>
          {columns.account && <div />}
          <div>
            <Autocomplete
              items={pItems.filter(p => !p.group?.startsWith('Transfer'))}
              value={s.payee}
              allowCreate
              placeholder="Payee (optional)"
              extraItems={s.payeeName ? [{ id: '__new', label: s.payeeName }] : []}
              onSelect={(id, name) => update({ subs: ref.current.subs.map((x, j) => (j === i ? { ...x, payee: name ? '__new' : id, payeeName: name ?? null } : x)) })}
            />
          </div>
          {columns.notes && (
            <div>
              <input value={s.notes} placeholder="Notes" onChange={e => update({ subs: ref.current.subs.map((x, j) => (j === i ? { ...x, notes: e.target.value } : x)) })} />
            </div>
          )}
          <div>
            <Autocomplete items={cItems} value={s.category} placeholder="Category" onSelect={id => update({ subs: ref.current.subs.map((x, j) => (j === i ? { ...x, category: id } : x)) })} />
          </div>
          <div>
            <AmountInput
              value={s.amount < 0 ? -s.amount : 0}
              allowEmpty
              onCommit={v => update({ subs: ref.current.subs.map((x, j) => (j === i ? { ...x, amount: -(Math.abs(v ?? 0)) } : x)) })}
              ariaLabel="Split payment"
            />
          </div>
          <div>
            <AmountInput
              value={s.amount > 0 ? s.amount : 0}
              allowEmpty
              onCommit={v => update({ subs: ref.current.subs.map((x, j) => (j === i ? { ...x, amount: Math.abs(v ?? 0) } : x)) })}
              ariaLabel="Split deposit"
            />
          </div>
          {columns.balance && single && <div />}
          <div>
            <button className="icon" aria-label="Remove split" onClick={() => update({ subs: ref.current.subs.filter((_, j) => j !== i) })}>
              <Icon name="x" size={14} />
            </button>
          </div>
        </div>
      ))}
      <div className="row wrap" style={{ padding: '6px 10px', background: 'var(--accent-soft)', borderBottom: '1px solid var(--border)', gap: 8 }}>
        {draft.subs.length > 0 && (
          <>
            <button className="small" onClick={split}>
              <Icon name="plus" size={12} /> Add split
            </button>
            <button className="small" onClick={distribute} disabled={remaining === 0}>
              Distribute remainder
            </button>
            <button className="small ghost" onClick={() => update({ subs: [], category: null })}>
              Unsplit
            </button>
            <span className={remaining === 0 ? 'pos small' : 'neg small'}>
              Remaining: <Amount value={remaining} />
            </span>
          </>
        )}
        {isNew && (
          <label className="check small">
            <input type="checkbox" checked={draft.cleared} onChange={e => update({ cleared: e.target.checked })} /> Cleared
          </label>
        )}
        {error && <span className="err">{error}</span>}
        <div className="spacer" />
        <span className="dim small">Enter to save · Esc to cancel</span>
        <button className="small" onClick={onDone}>
          {isNew ? 'Done' : 'Cancel'}
        </button>
        <button className="small primary" onClick={save}>
          {isNew ? 'Add' : 'Save'}
        </button>
      </div>
    </div>
  );
}
