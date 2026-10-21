import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { Condition, TransactionEntity } from '@envelope/core';
import { useApp, useAction } from '../lib/app';
import { send } from '../lib/client';
import { useLocalStorage, useQuery } from '../lib/hooks';
import { Register, type RegisterColumns } from '../components/Register';
import { Icon } from '../components/Icon';
import { Amount, AmountInput, MenuButton, Modal, Popover, confirmDialog, promptDialog } from '../components/ui';
import { ConditionList, describeCondition } from '../components/Conditions';
import { Autocomplete, accountItems, categoryItems, payeeItems } from '../components/Autocomplete';
import { NotesModal } from '../components/NotesModal';
import { ImportModal } from '../components/ImportModal';
import { RuleEditor } from './Rules';

export function downloadText(name: string, text: string, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function AccountPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const view = params.get('view');
  const accountKey: string | null = id ?? (view === 'onbudget' || view === 'offbudget' ? view : null);
  const { accounts, payeeName, categoryName, accountName, fmt, notify } = useApp();
  const act = useAction();
  const navigate = useNavigate();
  const account = id ? accounts.find(a => a.id === id) : null;
  const [search, setSearch] = useState(params.get('search') ?? '');
  const [filter, setFilter] = useState<{ conditionsOp: 'and' | 'or'; conditions: Condition[] }>({ conditionsOp: 'and', conditions: [] });
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filterAnchor, setFilterAnchor] = useState<HTMLElement | null>(null);
  const [modal, setModal] = useState<null | 'import' | 'reconcile' | 'close' | 'notes' | 'bulk' | 'rule'>(null);
  const [loaded, setLoaded] = useState<TransactionEntity[]>([]);
  const [colPrefs, setColPrefs] = useLocalStorage<Record<string, RegisterColumns>>('registerColumns', {});
  const searchRef = useRef<HTMLInputElement>(null);
  const savedFilters = useQuery<{ id: string; name: string; conditionsOp: 'and' | 'or'; conditions: Condition[] }[]>('filters-get', {}, ['transaction_filters']);
  const columns: RegisterColumns = colPrefs[accountKey ?? 'all'] ?? { notes: true, balance: true, account: !id };

  useEffect(() => {
    setSelected(new Set());
    setAdding(false);
    setFilter({ conditionsOp: 'and', conditions: [] });
    setSearch(params.get('search') ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountKey]);

  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 't') {
        e.preventDefault();
        setAdding(true);
      } else if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, []);

  const list = id ? (account ? [account] : []) : accounts.filter(a => (view === 'onbudget' ? !a.offbudget : view === 'offbudget' ? a.offbudget : true));
  const balance = list.reduce((s, a) => s + a.balance, 0);
  const cleared = list.reduce((s, a) => s + a.cleared, 0);
  const title = account?.name ?? (view === 'onbudget' ? 'On budget' : view === 'offbudget' ? 'Off budget' : 'All accounts');
  const selectedTxns = loaded.filter(t => selected.has(t.id));
  const filteredBalance = useMemo(() => (search || filter.conditions.length ? loaded.reduce((s, t) => s + t.amount, 0) : null), [loaded, search, filter]);

  if (id && !account) return <div className="page empty">Account not found.</div>;

  const bulkActions = [
    { label: 'Edit fields…', onClick: () => setModal('bulk') },
    { label: 'Duplicate', onClick: () => act('transactions-duplicate', { ids: [...selected] }) },
    { label: 'Run rules', onClick: () => act('transactions-run-rules', { ids: [...selected] }, 'Rules applied') },
    {
      label: 'Mark cleared',
      onClick: () => act('transactions-batch', { updated: selectedTxns.filter(t => !t.reconciled).map(t => ({ id: t.id, cleared: true })) }),
    },
    {
      label: 'Mark uncleared',
      onClick: () => act('transactions-batch', { updated: selectedTxns.filter(t => !t.reconciled).map(t => ({ id: t.id, cleared: false })) }),
    },
    {
      label: 'Merge the two transactions',
      disabled: selected.size !== 2,
      onClick: async () => {
        const [a, b] = [...selected];
        if ((await act('transactions-merge', { a, b }, 'Transactions merged')) !== undefined) setSelected(new Set());
      },
    },
    {
      label: 'Make transfer',
      disabled: selected.size !== 2,
      onClick: async () => {
        const [a, b] = [...selected];
        if ((await act('transactions-make-transfer', { a, b }, 'Linked as a transfer')) !== undefined) setSelected(new Set());
      },
    },
    { label: 'Create rule from transaction', disabled: selected.size !== 1, onClick: () => setModal('rule') },
    {
      label: 'Convert to schedule',
      disabled: selected.size !== 1,
      onClick: async () => {
        if ((await act('schedule-from-transaction', { id: [...selected][0] }, 'Schedule created')) !== undefined) setSelected(new Set());
      },
    },
    {
      label: 'Unlink schedule',
      disabled: !selectedTxns.some(t => t.schedule),
      onClick: () => act('transactions-batch', { updated: selectedTxns.filter(t => t.schedule).map(t => ({ id: t.id, schedule: null })) }),
    },
    { label: 'Export selected as CSV', onClick: async () => downloadText(`${title}-selected.csv`, await send('transactions-export-csv', { ids: [...selected] })) },
    { divider: true, label: '' },
    {
      label: `Delete ${selected.size} transaction${selected.size === 1 ? '' : 's'}`,
      danger: true,
      onClick: async () => {
        if (await confirmDialog({ title: 'Delete transactions', message: `Delete ${selected.size} selected transaction${selected.size === 1 ? '' : 's'}?`, danger: true, confirmLabel: 'Delete' })) {
          await act('transactions-batch', { deleted: [...selected] });
          setSelected(new Set());
        }
      },
    },
  ];

  const accountMenu = account
    ? [
        {
          label: 'Rename',
          onClick: async () => {
            const name = await promptDialog({ title: 'Rename account', label: 'Name', initial: account.name });
            if (name) await act('account-update', { id: account.id, name });
          },
        },
        { label: 'Notes', onClick: () => setModal('notes') },
        { label: 'Reconcile', onClick: () => setModal('reconcile'), disabled: account.closed },
        { label: 'Import transactions', onClick: () => setModal('import'), disabled: account.closed },
        { label: 'Export as CSV', onClick: async () => downloadText(`${account.name}.csv`, await send('transactions-export-csv', { account: account.id })) },
        { label: account.offbudget ? 'Move on budget' : 'Move off budget', onClick: () => act('account-update', { id: account.id, offbudget: !account.offbudget }) },
        {
          label: 'Link bank sync…',
          onClick: () =>
            notify('info', 'Bank sync providers (GoCardless, SimpleFIN, Pluggy.ai…) run through the sync server. Configure a server in Settings; provider linking is on the roadmap.'),
        },
        { divider: true, label: '' },
        account.closed ? { label: 'Reopen account', onClick: () => act('account-reopen', { id: account.id }) } : { label: 'Close account', onClick: () => setModal('close') },
        {
          label: 'Delete account',
          danger: true,
          onClick: async () => {
            if (await confirmDialog({ title: 'Delete account', message: `Delete “${account.name}” and all its transactions? Transfers in other accounts are kept as plain transactions.`, danger: true, confirmLabel: 'Delete' })) {
              await act('account-delete', { id: account.id });
              navigate('/accounts');
            }
          },
        },
      ]
    : [{ label: 'Export as CSV', onClick: async () => downloadText(`${title}.csv`, await send('transactions-export-csv', { account: accountKey })) }];

  return (
    <div className="page" style={{ height: '100%', display: 'flex', flexDirection: 'column', maxWidth: 'none', paddingBottom: 16 }}>
      <div className="page-header" style={{ marginBottom: 8 }}>
        <div className="col" style={{ gap: 2 }}>
          <div className="row">
            <h1>{title}</h1>
            {account?.offbudget && <span className="badge">Off budget</span>}
            {account?.closed && <span className="badge warn">Closed</span>}
            <MenuButton items={accountMenu} title="Account actions">
              <Icon name="more" />
            </MenuButton>
          </div>
          <div className="balance-header">
            <div className="stat">
              <span className="small muted">Working balance</span>
              <span className="big">
                <Amount value={balance} className={balance < 0 ? 'neg' : ''} />
              </span>
            </div>
            <div className="stat">
              <span className="small muted">Cleared</span>
              <Amount value={cleared} />
            </div>
            <div className="stat">
              <span className="small muted">Uncleared</span>
              <Amount value={balance - cleared} />
            </div>
            {filteredBalance !== null && (
              <div className="stat">
                <span className="small muted">Filtered total</span>
                <Amount value={filteredBalance} color />
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="toolbar">
        <button className="primary" onClick={() => setAdding(true)} disabled={account?.closed}>
          <Icon name="plus" /> Add transaction
        </button>
        {account && !account.closed && (
          <>
            <button onClick={() => setModal('import')}>
              <Icon name="upload" /> Import
            </button>
            <button onClick={() => setModal('reconcile')}>
              <Icon name="lock" /> Reconcile
            </button>
          </>
        )}
        <div className="row searchbox">
          <Icon name="search" size={14} />
          <input
            ref={searchRef}
            placeholder="Search (/)"
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => e.key === 'Escape' && (setSearch(''), (e.target as HTMLInputElement).blur())}
            aria-label="Search transactions"
          />
        </div>
        <button onClick={e => setFilterAnchor(e.currentTarget)}>
          <Icon name="filter" /> Filter{filter.conditions.length ? ` (${filter.conditions.length})` : ''}
        </button>
        {(savedFilters.data?.length ?? 0) > 0 && (
          <MenuButton
            className=""
            title="Saved filters"
            items={(savedFilters.data ?? []).map(f => ({ label: f.name, onClick: () => setFilter({ conditionsOp: f.conditionsOp, conditions: f.conditions }) }))}
          >
            Saved <Icon name="down" size={12} />
          </MenuButton>
        )}
        <MenuButton
          className="icon"
          title="Columns"
          items={() =>
            (['notes', 'account', 'balance'] as const).map(k => ({
              label: `${columns[k] ? '✓ ' : '   '}${k[0].toUpperCase() + k.slice(1)}`,
              onClick: () => setColPrefs({ ...colPrefs, [accountKey ?? 'all']: { ...columns, [k]: !columns[k] } }),
            }))
          }
        >
          <Icon name="settings" />
        </MenuButton>
        <div className="spacer" />
        {selected.size > 0 && (
          <MenuButton className="primary" items={bulkActions} title="Selected" align="right">
            {selected.size} selected <Icon name="down" size={12} />
          </MenuButton>
        )}
      </div>
      {filter.conditions.length > 0 && (
        <div className="row wrap" style={{ marginBottom: 8 }}>
          {filter.conditions.map((c, i) => (
            <span key={i} className="chip">
              {describeCondition(c, { payee: payeeName, category: categoryName, account: accountName }, fmt)}
              <button onClick={() => setFilter({ ...filter, conditions: filter.conditions.filter((_, j) => j !== i) })} aria-label="Remove filter">
                ×
              </button>
            </span>
          ))}
          {filter.conditions.length > 1 && <span className="dim small">({filter.conditionsOp === 'and' ? 'all' : 'any'})</span>}
          <button
            className="small ghost"
            onClick={async () => {
              const name = await promptDialog({ title: 'Save filter', label: 'Name' });
              if (name) await act('filter-save', { name, ...filter }, 'Filter saved');
            }}
          >
            Save filter
          </button>
          <button className="small ghost" onClick={() => setFilter({ conditionsOp: 'and', conditions: [] })}>
            Clear
          </button>
        </div>
      )}
      {filterAnchor && (
        <Popover anchor={filterAnchor} onClose={() => setFilterAnchor(null)}>
          <FilterEditor
            initial={filter}
            onApply={f => {
              setFilter(f);
              setFilterAnchor(null);
            }}
          />
        </Popover>
      )}

      <Register
        account={accountKey}
        search={search || undefined}
        filter={filter.conditions.length ? filter : undefined}
        columns={columns}
        adding={adding}
        onAddingChange={setAdding}
        selected={selected}
        onSelectedChange={setSelected}
        onTag={tag => setFilter({ conditionsOp: 'and', conditions: [{ field: 'notes', op: 'hasTags', value: tag }] })}
        onLoaded={setLoaded}
      />

      {modal === 'import' && account && <ImportModal account={account} onClose={() => setModal(null)} />}
      {modal === 'reconcile' && account && <ReconcileModal accountId={account.id} cleared={account.cleared} onClose={() => setModal(null)} />}
      {modal === 'close' && account && <CloseAccountModal accountId={account.id} balance={account.balance} onClose={() => setModal(null)} />}
      {modal === 'notes' && account && <NotesModal id={account.id} title={`Notes: ${account.name}`} onClose={() => setModal(null)} />}
      {modal === 'bulk' && <BulkEditModal ids={[...selected]} onClose={() => setModal(null)} />}
      {modal === 'rule' && selectedTxns[0] && (
        <RuleEditor
          initial={{
            stage: null,
            conditionsOp: 'and',
            conditions: [
              ...(selectedTxns[0].imported_payee ? [{ field: 'imported_payee' as const, op: 'is' as const, value: selectedTxns[0].imported_payee }] : selectedTxns[0].payee ? [{ field: 'payee' as const, op: 'is' as const, value: selectedTxns[0].payee }] : []),
            ],
            actions: [
              ...(selectedTxns[0].category ? [{ op: 'set' as const, field: 'category', value: selectedTxns[0].category }] : []),
              ...(selectedTxns[0].imported_payee && selectedTxns[0].payee ? [{ op: 'set' as const, field: 'payee', value: selectedTxns[0].payee }] : []),
            ],
          }}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

function ReconcileModal({ accountId, cleared, onClose }: { accountId: string; cleared: number; onClose: () => void }) {
  const act = useAction();
  const [statement, setStatement] = useState<number | null>(cleared);
  const diff = (statement ?? 0) - cleared;
  return (
    <Modal
      title="Reconcile account"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          {diff !== 0 && (
            <button onClick={() => act('account-reconcile-adjust', { id: accountId, balance: statement }, 'Adjustment created')}>Create adjustment transaction</button>
          )}
          <button
            className="primary"
            disabled={diff !== 0}
            onClick={async () => {
              await act('account-reconcile-lock', { id: accountId }, 'Cleared transactions locked');
              onClose();
            }}
          >
            Lock transactions
          </button>
        </>
      }
    >
      <p className="muted">Enter the balance on your bank statement. Mark transactions as cleared until the cleared balance matches.</p>
      <label className="field">
        Statement balance
        <AmountInput value={statement} onCommit={setStatement} autoFocus />
      </label>
      <div className="row">
        <span className="grow muted">Cleared balance</span>
        <Amount value={cleared} />
      </div>
      <div className="row">
        <span className="grow muted">Difference</span>
        <Amount value={diff} color />
      </div>
      {diff === 0 ? (
        <div className="badge pos">Balanced. Lock the cleared transactions to finish.</div>
      ) : (
        <div className="badge warn">Off by {Math.abs(diff / 100).toFixed(2)}. Clear more transactions or create an adjustment.</div>
      )}
    </Modal>
  );
}

function CloseAccountModal({ accountId, balance, onClose }: { accountId: string; balance: number; onClose: () => void }) {
  const { accounts, groups } = useApp();
  const act = useAction();
  const [transfer, setTransfer] = useState<string | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const others = accounts.filter(a => a.id !== accountId && !a.closed);
  const self = accounts.find(a => a.id === accountId);
  const target = accounts.find(a => a.id === transfer);
  const needsCategory = !!self && !self.offbudget && (!transfer || !!target?.offbudget);
  return (
    <Modal
      title="Close account"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          {balance !== 0 && (
            <button className="ghost" onClick={async () => (await act('account-close', { id: accountId, forced: true })) !== undefined && onClose()}>
              Close anyway
            </button>
          )}
          <button
            className="primary"
            disabled={balance !== 0 && !transfer && !category}
            onClick={async () => {
              const r = await act('account-close', { id: accountId, transferAccountId: transfer, categoryId: needsCategory ? category : null });
              if (r !== undefined) onClose();
            }}
          >
            Close account
          </button>
        </>
      }
    >
      {balance === 0 ? (
        <p>This account has a zero balance and can be closed. You can reopen it later.</p>
      ) : (
        <>
          <p>
            This account still has a balance of <Amount value={balance} />. Transfer it to another account, or categorize it (for example as a write-off).
          </p>
          <label className="field">
            Transfer balance to
            <Autocomplete items={accountItems(others)} value={transfer} onSelect={setTransfer} placeholder="Choose an account…" />
          </label>
          {needsCategory && (
            <label className="field">
              Category {transfer ? '(needed for a transfer off budget)' : ''}
              <Autocomplete items={categoryItems(groups)} value={category} onSelect={setCategory} placeholder="Choose a category…" />
            </label>
          )}
        </>
      )}
    </Modal>
  );
}

function BulkEditModal({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const { payees, accounts, groups } = useApp();
  const act = useAction();
  const [field, setField] = useState<'category' | 'payee' | 'date' | 'notes' | 'account' | 'cleared'>('category');
  const [value, setValue] = useState<any>(null);
  const [notesMode, setNotesMode] = useState<'replace' | 'prepend' | 'append'>('replace');
  const apply = async () => {
    if (field === 'notes' && notesMode !== 'replace') {
      await act('rule-apply-actions', { ids, actions: [{ op: notesMode === 'prepend' ? 'prepend-notes' : 'append-notes', value }] });
    } else {
      await act('rule-apply-actions', { ids, actions: [{ op: 'set', field, value }] });
    }
    onClose();
  };
  return (
    <Modal
      title={`Edit ${ids.length} transaction${ids.length === 1 ? '' : 's'}`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={apply}>
            Apply
          </button>
        </>
      }
    >
      <label className="field">
        Field
        <select
          value={field}
          onChange={e => {
            setField(e.target.value as any);
            setValue(e.target.value === 'cleared' ? true : null);
          }}
        >
          <option value="category">Category</option>
          <option value="payee">Payee</option>
          <option value="account">Account</option>
          <option value="date">Date</option>
          <option value="notes">Notes</option>
          <option value="cleared">Cleared</option>
        </select>
      </label>
      <label className="field">
        New value
        {field === 'category' && <Autocomplete items={categoryItems(groups)} value={value} onSelect={setValue} />}
        {field === 'payee' && <Autocomplete items={payeeItems(payees, accounts)} value={value} onSelect={setValue} />}
        {field === 'account' && <Autocomplete items={accountItems(accounts)} value={value} onSelect={setValue} />}
        {field === 'date' && <input type="date" value={value ?? ''} onChange={e => setValue(e.target.value)} />}
        {field === 'cleared' && (
          <select value={value ? 'true' : 'false'} onChange={e => setValue(e.target.value === 'true')}>
            <option value="true">Cleared</option>
            <option value="false">Uncleared</option>
          </select>
        )}
        {field === 'notes' && (
          <div className="row">
            <select value={notesMode} onChange={e => setNotesMode(e.target.value as any)}>
              <option value="replace">Replace with</option>
              <option value="prepend">Prepend</option>
              <option value="append">Append</option>
            </select>
            <input className="grow" value={value ?? ''} onChange={e => setValue(e.target.value)} />
          </div>
        )}
      </label>
    </Modal>
  );
}

function FilterEditor({
  initial,
  onApply,
}: {
  initial: { conditionsOp: 'and' | 'or'; conditions: Condition[] };
  onApply: (f: { conditionsOp: 'and' | 'or'; conditions: Condition[] }) => void;
}) {
  const [draft, setDraft] = useState(initial.conditions.length ? initial : { conditionsOp: initial.conditionsOp, conditions: [{ field: 'payee', op: 'is', value: null } as Condition] });
  return (
    <div className="col" style={{ padding: 10, width: 'min(680px, 92vw)' }}>
      <ConditionList conditions={draft.conditions} op={draft.conditionsOp} onChange={(conditions, conditionsOp) => setDraft({ conditions, conditionsOp })} />
      <div className="row">
        <div className="spacer" />
        <button onClick={() => onApply({ conditionsOp: 'and', conditions: [] })}>Clear</button>
        <button className="primary" onClick={() => onApply(draft)}>
          Apply filter
        </button>
      </div>
    </div>
  );
}
