import { Fragment, createContext, useContext, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { dates, goalStatus, type CategoryEntity, type CategoryGroupEntity, type MonthBudget } from '@envelope/core';
import { useApp, useAction } from '../lib/app';
import { send } from '../lib/client';
import { useLocalStorage, useMediaQuery, useQuery } from '../lib/hooks';
import { periodRangeLabel, useCurrentPeriod, useStartDay } from '../lib/periods';
import { Icon } from '../components/Icon';
import { Amount, AmountInput, MenuButton, Modal, Popover, confirmDialog, promptDialog } from '../components/ui';
import { NotesModal } from '../components/NotesModal';

type BudgetMonth = MonthBudget & { goals: Record<string, { target: number | null; longGoal: number | null }> };
const TABLES = ['transactions', 'zero_budgets', 'reflect_budgets', 'zero_budget_months', 'categories', 'category_groups', 'notes', 'preferences', 'accounts', 'schedules', 'rules'];

function monthLabel(m: string) {
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function BudgetPage() {
  const { groups, prefs } = useApp();
  const act = useAction();
  const wide = useMediaQuery('(min-width: 1500px)');
  const mid = useMediaQuery('(min-width: 1100px)');
  const [monthCount, setMonthCount] = useLocalStorage<number | 'auto'>('budgetMonths', 'auto');
  const count = monthCount === 'auto' ? (wide ? 3 : mid ? 2 : 1) : monthCount;
  const current = useCurrentPeriod();
  // null = follow the current period (it moves if the start day setting changes).
  const [picked, setStart] = useState<string | null>(null);
  const start = picked ?? current;
  const [showHidden, setShowHidden] = useLocalStorage('budgetShowHidden', false);
  const [collapsed, setCollapsed] = useLocalStorage<string[]>('budgetCollapsed', []);
  const bounds = useQuery<{ start: string; end: string }>('budget-bounds', {}, ['transactions', 'zero_budgets']);
  const notes = useQuery<Record<string, string>>('notes-all', {}, ['notes']);
  const months = useMemo(() => Array.from({ length: count }, (_, i) => dates.addMonths(start, i)), [start, count]);
  const monthData = useMonths(months);
  const [editing, setEditing] = useState<{ month: string; cat: string } | null>(null);
  const [notesFor, setNotesFor] = useState<{ id: string; title: string; templates?: boolean } | null>(null);
  const [deleting, setDeleting] = useState<{ kind: 'category' | 'group'; id: string; name: string } | null>(null);
  const [drag, setDrag] = useState<{ kind: 'cat' | 'group'; id: string } | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const tracking = prefs.budgetType === 'tracking';

  const visibleGroups = groups.filter(g => showHidden || !g.hidden);
  const catOrder = visibleGroups.flatMap(g => (collapsed.includes(g.id) ? [] : g.categories.filter(c => showHidden || !c.hidden).map(c => c.id)));
  const nextCat = (id: string, dir = 1) => catOrder[catOrder.indexOf(id) + dir] ?? null;

  const canPrev = !bounds.data || start > bounds.data.start;
  const canNext = !bounds.data || dates.addMonths(start, count - 1) < bounds.data.end;

  const narrow = useMediaQuery('(max-width: 800px)');
  const cols = `${narrow ? '130px' : 'minmax(170px, 260px)'} repeat(${count}, minmax(${narrow ? 300 : count > 1 ? 250 : 0}px, 1fr))`;

  const onDrop = async (target: { kind: 'cat' | 'group'; id: string; group: string }) => {
    if (!drag) return;
    try {
      if (drag.kind === 'cat') {
        if (target.kind === 'cat') await send('category-move', { id: drag.id, groupId: target.group, targetId: target.id });
        else await send('category-move', { id: drag.id, groupId: target.id, targetId: null });
      } else if (target.kind === 'group') await send('category-group-move', { id: drag.id, targetId: target.id });
    } finally {
      setDrag(null);
      setOver(null);
    }
  };

  const addGroup = async () => {
    const name = await promptDialog({ title: 'Add category group', label: 'Name' });
    if (name) await act('category-group-create', { name });
  };
  const addCategory = async (g: CategoryGroupEntity) => {
    const name = await promptDialog({ title: `Add category to ${g.name}`, label: 'Name' });
    if (name) await act('category-create', { name, group: g.id });
  };

  return (
    <MonthsCtx.Provider value={monthData}>
    <div className="page" style={{ maxWidth: 'none' }}>
      <div className="page-header">
        <h1>Budget</h1>
        <span className="badge accent">{tracking ? 'Tracking' : 'Envelope'}</span>
        <div className="spacer" />
        <div className="row">
          <button className="icon" disabled={!canPrev} onClick={() => setStart(dates.addMonths(start, -1))} aria-label="Previous month">
            <Icon name="left" />
          </button>
          <button onClick={() => setStart(null)}>Today</button>
          <button className="icon" disabled={!canNext} onClick={() => setStart(dates.addMonths(start, 1))} aria-label="Next month">
            <Icon name="right" />
          </button>
        </div>
        <MenuButton
          className=""
          title="View options"
          align="right"
          items={[
            { label: showHidden ? 'Hide hidden categories' : 'Show hidden categories', onClick: () => setShowHidden(!showHidden) },
            { label: 'Collapse all groups', onClick: () => setCollapsed(groups.map(g => g.id)) },
            { label: 'Expand all groups', onClick: () => setCollapsed([]) },
            { divider: true, label: '' },
            { header: true, label: 'Months shown' },
            ...(['auto', 1, 2, 3] as const).map(n => ({ label: `${monthCount === n ? '✓ ' : ''}${n === 'auto' ? 'Fit to screen' : n}`, onClick: () => setMonthCount(n) })),
            { divider: true, label: '' },
            { label: 'Add category group', onClick: addGroup },
            {
              label: 'Check templates',
              onClick: async () => {
                const errs = await act<{ name: string; errors: string[] }[]>('budget-check-templates');
                if (!errs) return;
                if (!errs.length) await confirmDialog({ title: 'Templates', message: 'All templates are valid.', confirmLabel: 'OK' });
                else await confirmDialog({ title: 'Template problems', message: <ul>{errs.map(e => <li key={e.name}><strong>{e.name}</strong>: {e.errors.join('; ')}</li>)}</ul>, confirmLabel: 'OK' });
              },
            },
          ]}
        >
          View <Icon name="down" size={14} />
        </MenuButton>
      </div>

      <div className="card budget" style={{ overflowX: 'auto' }}>
        <div className="budget-head" style={{ gridTemplateColumns: cols }}>
          <div style={{ padding: 12, display: 'flex', alignItems: 'flex-end' }}>
            <button className="small" onClick={addGroup}>
              <Icon name="plus" size={14} /> Group
            </button>
          </div>
          {months.map(m => (
            <MonthSummary key={m} month={m} tracking={tracking} onNotes={() => setNotesFor({ id: `budget-${m}`, title: `Notes for ${monthLabel(m)}` })} />
          ))}
        </div>
        <MonthColumnsHeader cols={cols} months={months} tracking={tracking} />

        {visibleGroups.map(g => {
          const isCollapsed = collapsed.includes(g.id);
          const cats = g.categories.filter(c => showHidden || !c.hidden);
          return (
            <Fragment key={g.id}>
              <div
                className={`budget-row group ${over === 'g' + g.id ? 'drop-before' : ''} ${g.hidden ? 'hidden-cat' : ''}`}
                style={{ gridTemplateColumns: cols }}
                draggable
                onDragStart={() => setDrag({ kind: 'group', id: g.id })}
                onDragOver={e => {
                  e.preventDefault();
                  setOver('g' + g.id);
                }}
                onDragLeave={() => setOver(null)}
                onDrop={() => onDrop({ kind: 'group', id: g.id, group: g.id })}
              >
                <div className="name">
                  <button className="icon" onClick={() => setCollapsed(isCollapsed ? collapsed.filter(x => x !== g.id) : [...collapsed, g.id])} aria-label={isCollapsed ? 'Expand group' : 'Collapse group'}>
                    <Icon name={isCollapsed ? 'right' : 'down'} size={14} />
                  </button>
                  <span className="ellipsis grow">{g.name}</span>
                  {notes.data?.[g.id] && (
                    <button className="icon" onClick={() => setNotesFor({ id: g.id, title: `Notes: ${g.name}` })} title={notes.data[g.id]}>
                      <Icon name="note" size={14} />
                    </button>
                  )}
                  <MenuButton
                    title="Group actions"
                    items={[
                      { label: 'Add category', onClick: () => addCategory(g) },
                      {
                        label: 'Rename group',
                        onClick: async () => {
                          const name = await promptDialog({ title: 'Rename group', label: 'Name', initial: g.name });
                          if (name) await act('category-group-update', { id: g.id, name });
                        },
                      },
                      { label: 'Edit notes', onClick: () => setNotesFor({ id: g.id, title: `Notes: ${g.name}` }) },
                      ...(!g.is_income ? [{ label: g.hidden ? 'Show group' : 'Hide group', onClick: () => act('category-group-update', { id: g.id, hidden: !g.hidden }) }] : []),
                      { divider: true, label: '' },
                      { label: 'Delete group', danger: true, onClick: () => setDeleting({ kind: 'group', id: g.id, name: g.name }) },
                    ]}
                  >
                    <Icon name="more" size={14} />
                  </MenuButton>
                </div>
                {months.map(m => (
                  <GroupTotals key={m} month={m} group={g} tracking={tracking} />
                ))}
              </div>
              {!isCollapsed &&
                cats.map(c => (
                  <div
                    key={c.id}
                    className={`budget-row cat ${c.hidden ? 'hidden-cat' : ''} ${over === c.id ? 'drop-before' : ''} ${drag?.id === c.id ? 'dragging' : ''}`}
                    style={{ gridTemplateColumns: cols }}
                    onDragOver={e => {
                      if (drag?.kind !== 'cat') return;
                      e.preventDefault();
                      setOver(c.id);
                    }}
                    onDragLeave={() => setOver(null)}
                    onDrop={() => onDrop({ kind: 'cat', id: c.id, group: g.id })}
                  >
                    <div className="name" draggable onDragStart={() => setDrag({ kind: 'cat', id: c.id })} style={{ paddingLeft: 34 }}>
                      <Link to={`/categories/${c.id}`} className="ellipsis grow" style={{ color: 'inherit' }}>
                        {c.name}
                      </Link>
                      {notes.data?.[c.id] && (
                        <button className="icon" onClick={() => setNotesFor({ id: c.id, title: `Notes: ${c.name}`, templates: true })} title={notes.data[c.id]}>
                          <Icon name="note" size={14} />
                        </button>
                      )}
                      <MenuButton
                        title="Category actions"
                        items={[
                          {
                            label: 'Rename',
                            onClick: async () => {
                              const name = await promptDialog({ title: 'Rename category', label: 'Name', initial: c.name });
                              if (name) await act('category-update', { id: c.id, name });
                            },
                          },
                          { label: 'Notes & templates', onClick: () => setNotesFor({ id: c.id, title: `Notes: ${c.name}`, templates: true }) },
                          { label: c.hidden ? 'Show category' : 'Hide category', onClick: () => act('category-update', { id: c.id, hidden: !c.hidden }) },
                          { divider: true, label: '' },
                          { label: 'Delete', danger: true, onClick: () => setDeleting({ kind: 'category', id: c.id, name: c.name }) },
                        ]}
                      >
                        <Icon name="more" size={14} />
                      </MenuButton>
                    </div>
                    {months.map(m => (
                      <CategoryCells
                        key={m}
                        month={m}
                        cat={c}
                        tracking={tracking}
                        editing={editing?.month === m && editing.cat === c.id}
                        onEdit={() => setEditing({ month: m, cat: c.id })}
                        onDone={dir => {
                          if (dir === 0) setEditing(null);
                          else {
                            const n = nextCat(c.id, dir);
                            setEditing(n ? { month: m, cat: n } : null);
                          }
                        }}
                      />
                    ))}
                  </div>
                ))}
              {!isCollapsed && cats.length === 0 && (
                <div className="budget-row cat" style={{ gridTemplateColumns: cols }}>
                  <div className="name" style={{ paddingLeft: 34 }}>
                    <button className="link small" onClick={() => addCategory(g)}>
                      + Add a category
                    </button>
                  </div>
                </div>
              )}
            </Fragment>
          );
        })}
      </div>

      {notesFor && <NotesModal {...notesFor} onClose={() => setNotesFor(null)} />}
      {deleting && <DeleteCategoryModal {...deleting} onClose={() => setDeleting(null)} />}
    </div>
    </MonthsCtx.Provider>
  );
}

// One query per visible month, shared by every cell through context.
const MonthsCtx = createContext<Record<string, BudgetMonth | undefined>>({});

function useMonth(month: string) {
  return { data: useContext(MonthsCtx)[month] };
}

function useMonths(months: string[]) {
  const a = useQuery<BudgetMonth>(months[0] ? 'budget-month' : null, { month: months[0] }, TABLES);
  const b = useQuery<BudgetMonth>(months[1] ? 'budget-month' : null, { month: months[1] }, TABLES);
  const c = useQuery<BudgetMonth>(months[2] ? 'budget-month' : null, { month: months[2] }, TABLES);
  return useMemo(() => {
    const out: Record<string, BudgetMonth | undefined> = {};
    [a.data, b.data, c.data].forEach((d, i) => {
      if (months[i] && d?.month === months[i]) out[months[i]] = d;
    });
    return out;
  }, [a.data, b.data, c.data, months]);
}

function MonthColumnsHeader({ cols, months, tracking }: { cols: string; months: string[]; tracking: boolean }) {
  return (
    <div className="budget-row" style={{ gridTemplateColumns: cols, minHeight: 28, background: 'var(--surface)' }}>
      <div className="name dim small">Category</div>
      {months.map(m => (
        <div key={m} className="month-cols" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', borderLeft: '1px solid var(--border)', height: '100%', alignItems: 'center' }}>
          <span style={{ textAlign: 'right', padding: '0 10px' }}>{tracking ? 'Planned' : 'Budgeted'}</span>
          <span style={{ textAlign: 'right', padding: '0 10px' }}>Spent</span>
          <span style={{ textAlign: 'right', padding: '0 10px' }}>Balance</span>
        </div>
      ))}
    </div>
  );
}

function MonthSummary({ month, tracking, onNotes }: { month: string; tracking: boolean; onNotes: () => void }) {
  const { data } = useMonth(month);
  const act = useAction();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const startDay = useStartDay();
  const isCurrent = month === useCurrentPeriod();
  const range = periodRangeLabel(month, startDay);
  const menu = [
    { label: 'Copy last month’s budget', onClick: () => act('budget-month-action', { month, action: 'copy-last' }) },
    { label: 'Set budgets to zero', onClick: () => act('budget-month-action', { month, action: 'set-zero' }) },
    { label: 'Set to 3-month average', onClick: () => act('budget-month-action', { month, action: 'avg-3' }) },
    { label: 'Set to 6-month average', onClick: () => act('budget-month-action', { month, action: 'avg-6' }) },
    { label: 'Set to 12-month average', onClick: () => act('budget-month-action', { month, action: 'avg-12' }) },
    { divider: true, label: '' },
    {
      label: 'Apply budget templates',
      onClick: async () => {
        const r = await act<{ errors: string[] }>('budget-apply-templates', { month }, 'Templates applied');
        if (r?.errors.length) await confirmDialog({ title: 'Some templates failed', message: r.errors.join('\n'), confirmLabel: 'OK' });
      },
    },
    ...(!tracking ? [{ label: 'End-of-month cleanup', onClick: () => act('budget-cleanup', { month }, 'Cleanup applied') }] : []),
    { divider: true, label: '' },
    { label: 'Month notes', onClick: onNotes },
  ];
  if (!data) return <div className="month-summary" />;
  return (
    <div className="month-summary">
      <div className={`month-title ${isCurrent ? 'current' : ''}`}>
        <span className="col" style={{ gap: 0 }}>
          <span>{monthLabel(month)}</span>
          {range && <span className="period-range">{range}</span>}
        </span>
        <MenuButton title="Month actions" items={menu} align="right">
          <Icon name="more" />
        </MenuButton>
      </div>
      {tracking ? (
        <>
          <SumLine label="Income planned" value={data.plannedIncome} />
          <SumLine label="Income received" value={data.income} />
          <SumLine label="Expenses planned" value={-data.plannedExpenses} />
          <SumLine label="Spent" value={data.totalSpent} />
          <div className={`to-budget ${data.saved > 0 ? 'pos' : data.saved < 0 ? 'neg' : 'zero'}`} style={{ cursor: 'default' }}>
            <div className="small muted">Saved</div>
            <div className="big">
              <Amount value={data.saved} />
            </div>
          </div>
        </>
      ) : (
        <>
          <SumLine label="Available funds" value={data.availableFunds} />
          <SumLine label="Overspent last month" value={data.lastMonthOverspent} />
          <SumLine label="Budgeted" value={-data.totalBudgeted} />
          <SumLine label="For next month" value={-data.buffered} />
          <div
            className={`to-budget ${data.toBudget > 0 ? 'pos' : data.toBudget < 0 ? 'neg' : 'zero'}`}
            role="button"
            tabIndex={0}
            onClick={e => setAnchor(e.currentTarget)}
            onKeyDown={e => e.key === 'Enter' && setAnchor(e.currentTarget)}
          >
            <div className="small muted">{data.toBudget < 0 ? 'Overbudgeted' : 'To Budget'}</div>
            <div className="big">
              <Amount value={data.toBudget} />
            </div>
          </div>
          {anchor && (
            <Popover anchor={anchor} onClose={() => setAnchor(null)}>
              <ToBudgetMenu month={month} data={data} onDone={() => setAnchor(null)} />
            </Popover>
          )}
        </>
      )}
    </div>
  );
}

function SumLine({ label, value }: { label: string; value: number }) {
  return (
    <div className="row small">
      <span className="muted grow">{label}</span>
      <Amount value={value} />
    </div>
  );
}

function ToBudgetMenu({ month, data, onDone }: { month: string; data: BudgetMonth; onDone: () => void }) {
  const { groups } = useApp();
  const act = useAction();
  const [mode, setMode] = useState<'menu' | 'move' | 'hold'>('menu');
  const [amount, setAmount] = useState<number | null>(Math.max(0, data.toBudget));
  const [target, setTarget] = useState('');
  const cats = groups.filter(g => !g.is_income).flatMap(g => g.categories);
  if (mode === 'menu')
    return (
      <>
        <button onClick={() => setMode('move')}>Move to a category</button>
        <button onClick={() => setMode('hold')}>Hold for next month</button>
        <button
          disabled={!data.buffered}
          onClick={async () => {
            await act('budget-reset-hold', { month });
            onDone();
          }}
        >
          Reset next month’s hold
        </button>
      </>
    );
  return (
    <div className="col" style={{ padding: 8, minWidth: 260 }}>
      <label className="field">
        Amount
        <AmountInput value={amount} onCommit={setAmount} autoFocus />
      </label>
      {mode === 'move' && (
        <label className="field">
          To category
          <select value={target} onChange={e => setTarget(e.target.value)}>
            <option value="">Choose…</option>
            {cats.map(c => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <button
        className="primary"
        disabled={!amount || (mode === 'move' && !target)}
        onClick={async () => {
          if (mode === 'move') await act('budget-transfer', { month, from: null, to: target, amount });
          else await act('budget-hold', { month, amount });
          onDone();
        }}
      >
        {mode === 'move' ? 'Move' : 'Hold'}
      </button>
    </div>
  );
}

function GroupTotals({ month, group, tracking }: { month: string; group: CategoryGroupEntity; tracking: boolean }) {
  const { data } = useMonth(month);
  const t = data?.groups[group.id];
  if (!t) return <div className="cell" />;
  const isIncome = group.is_income;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', height: '100%' }}>
      <div className="cell">{(!isIncome || tracking) && <Amount value={t.budgeted} />}</div>
      <div className="cell">
        <Amount value={t.spent} />
      </div>
      <div className="cell">{!isIncome && <Amount value={t.balance} />}</div>
    </div>
  );
}

function CategoryCells({
  month,
  cat,
  tracking,
  editing,
  onEdit,
  onDone,
}: {
  month: string;
  cat: CategoryEntity;
  tracking: boolean;
  editing: boolean;
  onEdit: () => void;
  onDone: (dir: number) => void;
}) {
  const { data } = useMonth(month);
  const act = useAction();
  const navigate = useNavigate();
  const [balAnchor, setBalAnchor] = useState<HTMLElement | null>(null);
  const [ctx, setCtx] = useState<HTMLElement | null>(null);
  const v = data?.categories[cat.id];
  if (!v) return <div className="cell" />;
  const goal = data.goals?.[cat.id];
  const status = goalStatus(v.balance, v.budgeted, goal);
  const balCls = status === 'overspent' || v.balance < 0 ? 'neg' : status === 'underfunded' ? 'warn' : v.balance > 0 ? 'pos' : 'zero';
  const goalTip = goal
    ? [goal.target !== null ? `Template asks for ${(goal.target / 100).toFixed(2)} this month` : null, goal.longGoal !== null ? `Goal balance ${(goal.longGoal / 100).toFixed(2)}` : null]
        .filter(Boolean)
        .join(' · ')
    : undefined;
  const showBudget = !cat.is_income || tracking;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', height: '100%' }}>
      <div
        className={`cell ${showBudget ? 'click' : ''}`}
        onClick={showBudget && !editing ? onEdit : undefined}
        onContextMenu={e => {
          if (!showBudget) return;
          e.preventDefault();
          setCtx(e.currentTarget);
        }}
        title={showBudget ? 'Click to edit · right-click for actions' : undefined}
      >
        {showBudget &&
          (editing ? (
            <AmountInput
              autoFocus
              value={v.budgeted}
              ariaLabel={`Budget for ${cat.name}`}
              onCommit={amount => act('budget-set-amount', { month, category: cat.id, amount: amount ?? 0 })}
              onKeyDown={e => {
                if (e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey)) {
                  e.preventDefault();
                  (e.target as HTMLInputElement).blur();
                  onDone(1);
                } else if (e.key === 'Tab' && e.shiftKey) {
                  e.preventDefault();
                  (e.target as HTMLInputElement).blur();
                  onDone(-1);
                } else if (e.key === 'Escape') onDone(0);
              }}
            />
          ) : (
            <Amount value={v.budgeted} className={v.budgeted === 0 ? 'dim' : ''} />
          ))}
      </div>
      <div className="cell click" onClick={() => navigate(`/categories/${cat.id}?month=${month}`)} title="Show transactions">
        <Amount value={v.spent} className={v.spent === 0 ? 'dim' : ''} />
      </div>
      <div className="cell click" onClick={e => !cat.is_income && setBalAnchor(e.currentTarget)} title={goalTip}>
        {(!cat.is_income || tracking) && (
          <span className={`bal ${balCls}`}>
            {v.carryover && <span title="Rollover on">↻ </span>}
            <Amount value={cat.is_income ? v.balance : v.balance} />
          </span>
        )}
      </div>
      {balAnchor && (
        <Popover anchor={balAnchor} onClose={() => setBalAnchor(null)} align="right">
          <BalanceMenu month={month} cat={cat} balance={v.balance} carryover={v.carryover} tracking={tracking} onDone={() => setBalAnchor(null)} />
        </Popover>
      )}
      {ctx && (
        <Popover anchor={ctx} onClose={() => setCtx(null)}>
          {(
            [
              ['copy-last', 'Copy last month’s budget'],
              ['set-zero', 'Set to zero'],
              ['avg-3', 'Set to 3-month average'],
              ['avg-6', 'Set to 6-month average'],
              ['avg-12', 'Set to 12-month average'],
            ] as const
          ).map(([action, label]) => (
            <button
              key={action}
              onClick={async () => {
                setCtx(null);
                await act('budget-category-action', { month, category: cat.id, action });
              }}
            >
              {label}
            </button>
          ))}
          <hr />
          <button
            onClick={async () => {
              setCtx(null);
              await act('budget-apply-templates', { month, category: cat.id });
            }}
          >
            Apply template
          </button>
        </Popover>
      )}
    </div>
  );
}

function BalanceMenu({ month, cat, balance, carryover, tracking, onDone }: { month: string; cat: CategoryEntity; balance: number; carryover: boolean; tracking: boolean; onDone: () => void }) {
  const { groups } = useApp();
  const act = useAction();
  const [mode, setMode] = useState<'menu' | 'transfer' | 'cover'>('menu');
  const [amount, setAmount] = useState<number | null>(Math.abs(balance));
  const [target, setTarget] = useState(tracking ? '' : '__tobudget');
  const cats = groups.filter(g => !g.is_income).flatMap(g => g.categories).filter(c => c.id !== cat.id);
  if (mode === 'menu')
    return (
      <>
        {!tracking && (
          <button disabled={balance <= 0} onClick={() => setMode('transfer')}>
            Transfer to another category
          </button>
        )}
        {!tracking && (
          <button disabled={balance >= 0} onClick={() => setMode('cover')}>
            Cover overspending
          </button>
        )}
        <button
          onClick={async () => {
            await act('budget-set-carryover', { month, category: cat.id, flag: !carryover });
            onDone();
          }}
        >
          {carryover ? 'Turn off rollover' : tracking ? 'Roll over balance' : 'Roll over overspending'}
        </button>
      </>
    );
  return (
    <div className="col" style={{ padding: 8, minWidth: 260 }}>
      {mode === 'transfer' && (
        <label className="field">
          Amount
          <AmountInput value={amount} onCommit={setAmount} autoFocus />
        </label>
      )}
      <label className="field">
        {mode === 'transfer' ? 'To' : 'Cover from'}
        <select value={target} onChange={e => setTarget(e.target.value)} autoFocus={mode === 'cover'}>
          <option value="__tobudget">To Budget</option>
          {cats.map(c => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <button
        className="primary"
        onClick={async () => {
          const other = target === '__tobudget' ? null : target;
          if (mode === 'transfer') await act('budget-transfer', { month, from: cat.id, to: other, amount });
          else await act('budget-cover-overspending', { month, to: cat.id, from: other });
          onDone();
        }}
      >
        {mode === 'transfer' ? 'Transfer' : 'Cover'}
      </button>
    </div>
  );
}

function DeleteCategoryModal({ kind, id, name, onClose }: { kind: 'category' | 'group'; id: string; name: string; onClose: () => void }) {
  const { groups } = useApp();
  const act = useAction();
  const [target, setTarget] = useState('');
  const [needsTarget, setNeedsTarget] = useState<boolean | null>(null);
  const ids = kind === 'group' ? groups.find(g => g.id === id)?.categories.map(c => c.id) ?? [] : [id];
  const isIncome = kind === 'group' ? groups.find(g => g.id === id)?.is_income : groups.some(g => g.is_income && g.categories.some(c => c.id === id));
  useEffect(() => {
    Promise.all(ids.map(c => send<any[]>('transactions-get', { category: c }))).then(rs => setNeedsTarget(rs.some(r => r.length > 0)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  const options = groups.filter(g => !!g.is_income === !!isIncome).flatMap(g => g.categories).filter(c => !ids.includes(c.id));
  return (
    <Modal
      title={`Delete ${kind} “${name}”`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button
            className="danger solid"
            disabled={needsTarget === null || (needsTarget && !target)}
            onClick={async () => {
              await act(kind === 'group' ? 'category-group-delete' : 'category-delete', { id, transferId: target || null });
              onClose();
            }}
          >
            Delete
          </button>
        </>
      }
    >
      {needsTarget === null ? (
        <p className="muted">Checking…</p>
      ) : needsTarget ? (
        <>
          <p>This {kind} has transactions. Choose a category to move its transactions and budgeted amounts to — their history merges into it.</p>
          <select value={target} onChange={e => setTarget(e.target.value)} autoFocus>
            <option value="">Choose a category…</option>
            {options.map(c => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </>
      ) : (
        <p>Nothing uses this {kind}. Delete it?</p>
      )}
    </Modal>
  );
}
