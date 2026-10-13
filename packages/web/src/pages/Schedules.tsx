import { useMemo, useState } from 'react';
import { dates, describeRecurrence, getOccurrences, type RecurConfig, type ScheduleEntity, type ScheduleInput } from '@envelope/core';
import { useApp, useAction } from '../lib/app';
import { send } from '../lib/client';
import { useQuery } from '../lib/hooks';
import { Autocomplete, accountItems, payeeItems } from '../components/Autocomplete';
import { Amount, AmountInput, MenuButton, Modal, confirmDialog } from '../components/ui';
import { Icon } from '../components/Icon';

const STATUS_CLASS: Record<string, string> = { missed: 'neg', due: 'warn', upcoming: 'accent', paid: 'pos', completed: '', scheduled: '' };

export function SchedulesPage() {
  const { payeeName, accountName, fmtDate, prefs, setPref } = useApp();
  const act = useAction();
  const q = useQuery<ScheduleEntity[]>('schedules-get', {}, ['schedules', 'rules', 'transactions', 'preferences']);
  const [editing, setEditing] = useState<ScheduleEntity | 'new' | null>(null);
  const [discover, setDiscover] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);
  const list = (q.data ?? []).filter(s => showCompleted || !s.completed);
  const amountLabel = (s: ScheduleEntity) =>
    typeof s.amount === 'number' ? (
      <>
        {s.amountOp === 'isapprox' && '~'}
        <Amount value={s.amount} color />
      </>
    ) : (
      <>
        <Amount value={s.amount.num1} /> – <Amount value={s.amount.num2} />
      </>
    );

  return (
    <div className="page">
      <div className="page-header">
        <h1>Schedules</h1>
        <div className="spacer" />
        <label className="field" style={{ flexDirection: 'row', alignItems: 'center' }}>
          Show upcoming
          <select value={prefs.upcomingScheduledTransactionLength ?? 7} onChange={e => setPref('upcomingScheduledTransactionLength', Number(e.target.value))}>
            <option value={1}>1 day</option>
            <option value={7}>1 week</option>
            <option value={14}>2 weeks</option>
            <option value={30}>1 month</option>
          </select>
          ahead
        </label>
        <label className="check small">
          <input type="checkbox" checked={showCompleted} onChange={e => setShowCompleted(e.target.checked)} /> Completed
        </label>
        <button onClick={() => setDiscover(true)}>Find schedules</button>
        <button className="primary" onClick={() => setEditing('new')}>
          <Icon name="plus" /> Add schedule
        </button>
      </div>
      <div className="card" style={{ overflowX: 'auto' }}>
        <table className="grid">
          <thead>
            <tr>
              <th>Name</th>
              <th>Payee</th>
              <th>Account</th>
              <th>Next date</th>
              <th>Repeats</th>
              <th>Status</th>
              <th className="num">Amount</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map(s => (
              <tr key={s.id} style={{ cursor: 'pointer' }} onClick={() => setEditing(s)}>
                <td>
                  <strong>{s.name || <span className="dim">Unnamed</span>}</strong>
                  {s.posts_transaction && <span className="badge" style={{ marginLeft: 6 }}>auto</span>}
                </td>
                <td>{payeeName(s.payee)}</td>
                <td>{accountName(s.account)}</td>
                <td>{s.next_date ? fmtDate(s.next_date) : '—'}</td>
                <td className="muted small">{s.description}</td>
                <td>
                  <span className={`badge ${STATUS_CLASS[s.status]}`}>{s.status}</span>
                </td>
                <td className="num">{amountLabel(s)}</td>
                <td onClick={e => e.stopPropagation()}>
                  <MenuButton
                    title="Schedule actions"
                    align="right"
                    items={[
                      { label: 'Post transaction now', disabled: s.completed, onClick: () => act('schedule-post', { id: s.id }, 'Transaction posted') },
                      { label: 'Skip next date', disabled: s.completed, onClick: () => act('schedule-skip', { id: s.id }) },
                      s.completed ? { label: 'Restore', onClick: () => act('schedule-complete', { id: s.id, completed: false }) } : { label: 'Complete', onClick: () => act('schedule-complete', { id: s.id, completed: true }) },
                      { divider: true, label: '' },
                      {
                        label: 'Delete',
                        danger: true,
                        onClick: async () => {
                          if (await confirmDialog({ title: 'Delete schedule', message: `Delete “${s.name ?? 'schedule'}”? Linked transactions are kept.`, danger: true, confirmLabel: 'Delete' })) await act('schedule-delete', { id: s.id });
                        },
                      },
                    ]}
                  >
                    <Icon name="more" />
                  </MenuButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.length === 0 && <div className="empty">No schedules. Add recurring bills and paychecks to see them coming and fund them with templates.</div>}
      </div>
      {editing && <ScheduleEditor schedule={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {discover && <DiscoverModal onClose={() => setDiscover(false)} />}
    </div>
  );
}

function ScheduleEditor({ schedule, onClose }: { schedule: ScheduleEntity | null; onClose: () => void }) {
  const { payees, accounts, fmtDate } = useApp();
  const act = useAction();
  const recurring0 = schedule ? typeof schedule.date === 'object' : true;
  const [name, setName] = useState(schedule?.name ?? '');
  const [payee, setPayee] = useState<string | null>(schedule?.payee ?? null);
  const [newPayee, setNewPayee] = useState<string | null>(null);
  const [account, setAccount] = useState<string | null>(schedule?.account ?? accounts.find(a => !a.closed && !a.offbudget)?.id ?? null);
  const [amountOp, setAmountOp] = useState(schedule?.amountOp ?? 'isapprox');
  const [amount, setAmount] = useState<number>(typeof schedule?.amount === 'number' ? schedule.amount : 0);
  const [range, setRange] = useState(typeof schedule?.amount === 'object' ? schedule.amount : { num1: 0, num2: 0 });
  const [recurring, setRecurring] = useState(recurring0);
  const [once, setOnce] = useState(typeof schedule?.date === 'string' ? schedule.date : dates.today());
  const [cfg, setCfg] = useState<RecurConfig>(typeof schedule?.date === 'object' ? schedule.date : { start: dates.today(), interval: 1, frequency: 'monthly', endMode: 'never' });
  const [auto, setAuto] = useState(schedule?.posts_transaction ?? false);
  const upcoming = useMemo(() => (recurring ? getOccurrences(cfg, dates.today(), dates.addDays(dates.today(), 800), 5) : [once]), [recurring, cfg, once]);

  const save = async () => {
    let payeeId = payee;
    if (newPayee) payeeId = await send<string>('payee-create', { name: newPayee });
    const input: ScheduleInput = {
      name: name || null,
      payee: payeeId,
      account,
      amountOp,
      amount: amountOp === 'isbetween' ? range : amount,
      date: recurring ? cfg : once,
      posts_transaction: auto,
    };
    const r = await act(schedule ? 'schedule-update' : 'schedule-create', schedule ? { id: schedule.id, ...input } : input, 'Schedule saved');
    if (r !== undefined) onClose();
  };

  return (
    <Modal
      title={schedule ? `Schedule: ${schedule.name ?? ''}` : 'New schedule'}
      size="wide"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={save} disabled={!account}>
            Save schedule
          </button>
        </>
      }
    >
      <div className="row wrap">
        <label className="field grow">
          Name
          <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Rent" autoFocus />
        </label>
        <label className="field grow">
          Payee
          <Autocomplete items={payeeItems(payees, accounts)} value={newPayee ? '__new' : payee} allowCreate extraItems={newPayee ? [{ id: '__new', label: newPayee }] : []} onSelect={(id, n) => (n ? (setNewPayee(n), setPayee(null)) : (setPayee(id), setNewPayee(null)))} />
        </label>
        <label className="field grow">
          Account
          <Autocomplete items={accountItems(accounts)} value={account} onSelect={setAccount} />
        </label>
      </div>
      <div className="row wrap">
        <label className="field">
          Amount
          <select value={amountOp} onChange={e => setAmountOp(e.target.value as any)}>
            <option value="is">Is exactly</option>
            <option value="isapprox">Is approximately</option>
            <option value="isbetween">Is between</option>
          </select>
        </label>
        {amountOp === 'isbetween' ? (
          <>
            <label className="field">
              From
              <AmountInput value={range.num1} onCommit={v => setRange({ ...range, num1: v ?? 0 })} />
            </label>
            <label className="field">
              To
              <AmountInput value={range.num2} onCommit={v => setRange({ ...range, num2: v ?? 0 })} />
            </label>
          </>
        ) : (
          <label className="field">
            Amount (negative = payment)
            <AmountInput value={amount} onCommit={v => setAmount(v ?? 0)} />
          </label>
        )}
      </div>
      <div className="segmented" role="group">
        <button className={recurring ? 'on' : ''} onClick={() => setRecurring(true)}>
          Repeats
        </button>
        <button className={!recurring ? 'on' : ''} onClick={() => setRecurring(false)}>
          Once
        </button>
      </div>
      {recurring ? <RecurrenceEditor cfg={cfg} onChange={setCfg} /> : <input type="date" value={once} onChange={e => setOnce(e.target.value)} aria-label="Date" />}
      <div className="small muted">
        {recurring && describeRecurrence(cfg)}. Next: {upcoming.length ? upcoming.map(fmtDate).join(', ') : 'none'}
      </div>
      <label className="check">
        <input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)} /> Automatically add the transaction on its date
      </label>
      <p className="dim small">Otherwise, post it yourself from the register, or it’s matched when a similar transaction is entered or imported (±2 days).</p>
    </Modal>
  );
}

function RecurrenceEditor({ cfg, onChange }: { cfg: RecurConfig; onChange: (c: RecurConfig) => void }) {
  const set = (p: Partial<RecurConfig>) => onChange({ ...cfg, ...p });
  return (
    <div className="card pad col">
      <div className="row wrap">
        <label className="field">
          Starting
          <input type="date" value={cfg.start} onChange={e => set({ start: e.target.value })} />
        </label>
        <label className="field">
          Every
          <input type="number" min={1} value={cfg.interval} onChange={e => set({ interval: Math.max(1, Number(e.target.value)) })} style={{ width: 70 }} />
        </label>
        <label className="field">
          &nbsp;
          <select value={cfg.frequency} onChange={e => set({ frequency: e.target.value as any, patterns: undefined })}>
            <option value="daily">day(s)</option>
            <option value="weekly">week(s)</option>
            <option value="monthly">month(s)</option>
            <option value="yearly">year(s)</option>
          </select>
        </label>
      </div>
      {cfg.frequency === 'monthly' && (
        <div className="col">
          <span className="small muted">On specific days (optional)</span>
          {(cfg.patterns ?? []).map((p, i) => (
            <div key={i} className="row">
              <select
                value={p.value}
                onChange={e => set({ patterns: cfg.patterns!.map((x, j) => (j === i ? { ...x, value: Number(e.target.value) } : x)) })}
                aria-label="Which"
              >
                {p.type === 'day'
                  ? [...Array.from({ length: 31 }, (_, d) => d + 1), -1].map(d => (
                      <option key={d} value={d}>
                        {d === -1 ? 'last day' : `day ${d}`}
                      </option>
                    ))
                  : [1, 2, 3, 4, -1].map(d => (
                      <option key={d} value={d}>
                        {d === -1 ? 'last' : ['1st', '2nd', '3rd', '4th'][d - 1]}
                      </option>
                    ))}
              </select>
              <select value={p.type} onChange={e => set({ patterns: cfg.patterns!.map((x, j) => (j === i ? { type: e.target.value as any, value: e.target.value === 'day' ? 1 : 1 } : x)) })} aria-label="Day type">
                <option value="day">day of month</option>
                {(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const).map(d => (
                  <option key={d} value={d}>
                    {{ MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday', FR: 'Friday', SA: 'Saturday', SU: 'Sunday' }[d]}
                  </option>
                ))}
              </select>
              <button className="icon" onClick={() => set({ patterns: cfg.patterns!.filter((_, j) => j !== i) })} aria-label="Remove day">
                <Icon name="x" />
              </button>
            </div>
          ))}
          <div>
            <button className="small" onClick={() => set({ patterns: [...(cfg.patterns ?? []), { type: 'day', value: 1 }] })}>
              <Icon name="plus" size={12} /> Add day
            </button>
          </div>
        </div>
      )}
      <div className="row wrap">
        <label className="check">
          <input type="checkbox" checked={!!cfg.skipWeekend} onChange={e => set({ skipWeekend: e.target.checked })} /> Move off weekends
        </label>
        {cfg.skipWeekend && (
          <select value={cfg.weekendSolveMode ?? 'after'} onChange={e => set({ weekendSolveMode: e.target.value as any })} aria-label="Weekend handling">
            <option value="before">to the Friday before</option>
            <option value="after">to the Monday after</option>
          </select>
        )}
      </div>
      <div className="row wrap">
        <label className="field">
          Ends
          <select value={cfg.endMode ?? 'never'} onChange={e => set({ endMode: e.target.value as any })}>
            <option value="never">Never</option>
            <option value="after_n_occurrences">After N times</option>
            <option value="on_date">On a date</option>
          </select>
        </label>
        {cfg.endMode === 'after_n_occurrences' && (
          <label className="field">
            Times
            <input type="number" min={1} value={cfg.endOccurrences ?? 12} onChange={e => set({ endOccurrences: Number(e.target.value) })} style={{ width: 80 }} />
          </label>
        )}
        {cfg.endMode === 'on_date' && (
          <label className="field">
            End date
            <input type="date" value={cfg.endDate ?? ''} onChange={e => set({ endDate: e.target.value })} />
          </label>
        )}
      </div>
    </div>
  );
}

function DiscoverModal({ onClose }: { onClose: () => void }) {
  const { payeeName, accountName } = useApp();
  const act = useAction();
  const q = useQuery<{ payee: string; account: string; amount: number; date: RecurConfig; occurrences: number }[]>('schedules-discover', {}, ['transactions', 'schedules']);
  return (
    <Modal title="Found recurring transactions" onClose={onClose} size="wide">
      <p className="muted small">Same payee, account and amount around the same day each month, at least three times in the last six months.</p>
      <table className="grid">
        <tbody>
          {(q.data ?? []).map((s, i) => (
            <tr key={i}>
              <td>{payeeName(s.payee)}</td>
              <td>{accountName(s.account)}</td>
              <td className="small muted">{describeRecurrence(s.date)}</td>
              <td className="num">
                <Amount value={s.amount} />
              </td>
              <td>
                <button
                  className="small"
                  onClick={() => act('schedule-create', { name: payeeName(s.payee), payee: s.payee, account: s.account, amount: s.amount, amountOp: 'isapprox', date: s.date }, 'Schedule created')}
                >
                  Create
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {q.data?.length === 0 && <div className="empty">No new recurring patterns found.</div>}
    </Modal>
  );
}
