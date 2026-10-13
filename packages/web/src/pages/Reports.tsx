import { useState } from 'react';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { dates, type TransactionEntity } from '@envelope/core';
import { useApp } from '../lib/app';
import { useLocalStorage, useQuery } from '../lib/hooks';
import { Icon } from '../components/Icon';
import { Amount, Modal } from '../components/ui';
import { REPORTS, SERIES } from './reports/catalog';

const TABLES = ['transactions', 'accounts', 'categories', 'category_groups', 'payees', 'zero_budgets'];

type Range = { preset: string; start: string; end: string };

function presetRange(preset: string): { start: string; end: string } {
  const cur = dates.currentMonth();
  switch (preset) {
    case 'this-month':
      return { start: cur, end: cur };
    case '3m':
      return { start: dates.addMonths(cur, -2), end: cur };
    case '6m':
      return { start: dates.addMonths(cur, -5), end: cur };
    case 'ytd':
      return { start: `${cur.slice(0, 4)}-01`, end: cur };
    case 'last-year': {
      const y = Number(cur.slice(0, 4)) - 1;
      return { start: `${y}-01`, end: `${y}-12` };
    }
    case 'all':
      return { start: dates.addMonths(cur, -120), end: cur };
    default:
      return { start: dates.addMonths(cur, -11), end: cur };
  }
}

function useRange(key: string, def = '12m') {
  const [r, setR] = useLocalStorage<Range>(`report-range-${key}`, { preset: def, ...presetRange(def) });
  // Live presets re-resolve every visit; custom ranges stay static.
  const resolved = r.preset === 'custom' ? r : { ...r, ...presetRange(r.preset) };
  return [resolved, setR] as const;
}

function RangePicker({ range, onChange, bounds }: { range: Range; onChange: (r: Range) => void; bounds?: { start: string } }) {
  return (
    <div className="row wrap">
      <select
        value={range.preset}
        aria-label="Date range"
        onChange={e => {
          const p = e.target.value;
          onChange(p === 'custom' ? { ...range, preset: p } : { preset: p, ...presetRange(p) });
        }}
      >
        <option value="this-month">This month</option>
        <option value="3m">Last 3 months</option>
        <option value="6m">Last 6 months</option>
        <option value="12m">Last 12 months</option>
        <option value="ytd">Year to date</option>
        <option value="last-year">Last year</option>
        <option value="all">All time</option>
        <option value="custom">Custom</option>
      </select>
      {range.preset === 'custom' && (
        <>
          <input type="month" value={range.start} min={bounds?.start} onChange={e => onChange({ ...range, start: e.target.value })} aria-label="Start month" />
          <span className="dim">to</span>
          <input type="month" value={range.end} onChange={e => onChange({ ...range, end: e.target.value })} aria-label="End month" />
        </>
      )}
    </div>
  );
}

function monthShort(m: string) {
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString(undefined, { month: 'short', year: '2-digit', timeZone: 'UTC' });
}

function useAxisFmt() {
  const { fmt, privacy } = useApp();
  return (v: number) => (privacy ? '•••' : fmt(Math.round(v / 100) * 100).replace(/[.,]00$/, ''));
}

function ChartTip({ active, payload, label, labelFmt }: any) {
  const { fmt, privacy } = useApp();
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tip">
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{labelFmt ? labelFmt(label) : label}</div>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="row">
          <span>
            <i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: p.color ?? p.payload?.fill, marginRight: 6 }} />
            {p.name}
          </span>
          <span className="num">{privacy ? '•••' : fmt(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="legend">
      {items.map(i => (
        <span key={i.label}>
          <i style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

export function ReportsPage() {
  return (
    <Routes>
      <Route index element={<Overview />} />
      <Route path=":report" element={<ReportDetail />} />
    </Routes>
  );
}

function Overview() {
  const navigate = useNavigate();
  return (
    <div className="page">
      <div className="page-header">
        <h1>Reports</h1>
      </div>
      <div className="report-grid">
        {REPORTS.map(r => (
          <div key={r.id} className="card report-card" role="link" tabIndex={0} onClick={() => navigate(`/reports/${r.id}`)} onKeyDown={e => e.key === 'Enter' && navigate(`/reports/${r.id}`)}>
            <h3>{r.title}</h3>
            <div className="dim small">{r.description}</div>
            <div className="grow" style={{ minHeight: 150 }}>
              <ReportBody id={r.id} compact />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReportDetail() {
  const { report } = useParams();
  const meta = REPORTS.find(r => r.id === report);
  if (!meta) return <div className="page empty">Unknown report.</div>;
  return (
    <div className="page">
      <div className="page-header">
        <Link to="/reports" className="row small">
          <Icon name="left" size={14} /> Reports
        </Link>
        <h1>{meta.title}</h1>
      </div>
      <div className="card pad">
        <ReportBody id={meta.id} />
      </div>
    </div>
  );
}

function ReportBody({ id, compact }: { id: string; compact?: boolean }) {
  switch (id) {
    case 'net-worth':
      return <NetWorth compact={compact} />;
    case 'cash-flow':
      return <CashFlow compact={compact} />;
    case 'spending':
      return <Spending compact={compact} />;
    case 'custom':
      return <Custom compact={compact} />;
    case 'calendar':
      return <CalendarReport compact={compact} />;
    case 'age-of-money':
      return <AgeOfMoney compact={compact} />;
  }
  return null;
}

function NetWorth({ compact }: { compact?: boolean }) {
  const { accounts } = useApp();
  const [range, setRange] = useRange('net-worth');
  const [selected, setSelected] = useLocalStorage<string[]>('report-networth-accounts', []);
  const q = useQuery<{ month: string; assets: number; debts: number; networth: number }[]>('report-net-worth', { start: range.start, end: range.end, accounts: selected }, TABLES);
  const axis = useAxisFmt();
  const data = q.data ?? [];
  const last = data.at(-1);
  const first = data[0];
  return (
    <div className="col">
      {!compact && (
        <div className="row wrap">
          <RangePicker range={range} onChange={setRange} />
          <select
            multiple
            value={selected}
            onChange={e => setSelected(Array.from(e.target.selectedOptions, o => o.value))}
            style={{ minHeight: 34, maxHeight: 90 }}
            aria-label="Accounts (none selected = all)"
            title="Accounts (none selected = all)"
          >
            {accounts.map(a => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          {selected.length > 0 && (
            <button className="small ghost" onClick={() => setSelected([])}>
              All accounts
            </button>
          )}
        </div>
      )}
      {last && (
        <div className="row wrap" style={{ gap: 24 }}>
          <div className="stat">
            <span className="small muted">Net worth</span>
            <span className="big">
              <Amount value={last.networth} />
            </span>
          </div>
          {first && (
            <div className="stat">
              <span className="small muted">Change</span>
              <Amount value={last.networth - first.networth} color sign />
            </div>
          )}
          {!compact && (
            <>
              <div className="stat">
                <span className="small muted">Assets</span>
                <Amount value={last.assets} />
              </div>
              <div className="stat">
                <span className="small muted">Debts</span>
                <Amount value={last.debts} />
              </div>
            </>
          )}
        </div>
      )}
      <div style={{ height: compact ? 130 : 340 }}>
        <ResponsiveContainer>
          <AreaChart data={data} margin={{ top: 8, right: 8, left: compact ? 0 : 8, bottom: 0 }}>
            {!compact && <CartesianGrid vertical={false} />}
            <XAxis dataKey="month" tickFormatter={monthShort} hide={compact} tickLine={false} axisLine={false} />
            <YAxis tickFormatter={axis} hide={compact} width={80} tickLine={false} axisLine={false} />
            <Tooltip content={<ChartTip labelFmt={monthShort} />} />
            <Area type="monotone" dataKey="networth" name="Net worth" stroke="var(--series-1)" strokeWidth={2} fill="var(--series-1)" fillOpacity={0.12} dot={false} activeDot={{ r: 4 }} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      {!compact && <DataTable rows={data.map(d => ({ label: monthShort(d.month), values: [d.assets, d.debts, d.networth] }))} headers={['Month', 'Assets', 'Debts', 'Net worth']} />}
    </div>
  );
}

function CashFlow({ compact }: { compact?: boolean }) {
  const [range, setRange] = useRange('cash-flow', '6m');
  const [transfers, setTransfers] = useLocalStorage('report-cashflow-transfers', false);
  const q = useQuery<{ month: string; income: number; expenses: number; net: number; balance: number }[]>('report-cash-flow', { start: range.start, end: range.end, includeTransfers: transfers }, TABLES);
  const axis = useAxisFmt();
  const data = (q.data ?? []).map(d => ({ ...d, expensesAbs: -d.expenses }));
  const income = data.reduce((s, d) => s + d.income, 0);
  const expenses = data.reduce((s, d) => s + d.expenses, 0);
  return (
    <div className="col">
      {!compact && (
        <div className="row wrap">
          <RangePicker range={range} onChange={setRange} />
          <label className="check small">
            <input type="checkbox" checked={transfers} onChange={e => setTransfers(e.target.checked)} /> Include transfers to off-budget accounts
          </label>
        </div>
      )}
      <div className="row wrap" style={{ gap: 24 }}>
        <div className="stat">
          <span className="small muted">Income</span>
          <Amount value={income} />
        </div>
        <div className="stat">
          <span className="small muted">Expenses</span>
          <Amount value={expenses} />
        </div>
        <div className="stat">
          <span className="small muted">Net</span>
          <Amount value={income + expenses} color sign />
        </div>
      </div>
      <Legend items={[{ label: 'Income', color: 'var(--series-1)' }, { label: 'Expenses', color: 'var(--series-2)' }]} />
      <div style={{ height: compact ? 110 : 300 }}>
        <ResponsiveContainer>
          <BarChart data={data} barGap={2} margin={{ top: 8, right: 8, left: compact ? 0 : 8, bottom: 0 }}>
            {!compact && <CartesianGrid vertical={false} />}
            <XAxis dataKey="month" tickFormatter={monthShort} hide={compact} tickLine={false} axisLine={false} />
            <YAxis tickFormatter={axis} hide={compact} width={80} tickLine={false} axisLine={false} />
            <Tooltip content={<ChartTip labelFmt={monthShort} />} cursor={{ fill: 'var(--surface-2)' }} />
            <Bar dataKey="income" name="Income" fill="var(--series-1)" radius={[4, 4, 0, 0]} maxBarSize={28} />
            <Bar dataKey="expensesAbs" name="Expenses" fill="var(--series-2)" radius={[4, 4, 0, 0]} maxBarSize={28} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      {!compact && (
        <>
          <h3>Running balance (on-budget accounts)</h3>
          <div style={{ height: 200 }}>
            <ResponsiveContainer>
              <LineChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="month" tickFormatter={monthShort} tickLine={false} axisLine={false} />
                <YAxis tickFormatter={axis} width={80} tickLine={false} axisLine={false} />
                <Tooltip content={<ChartTip labelFmt={monthShort} />} />
                <Line dataKey="balance" name="Balance" stroke="var(--series-1)" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <DataTable rows={data.map(d => ({ label: monthShort(d.month), values: [d.income, d.expenses, d.net, d.balance] }))} headers={['Month', 'Income', 'Expenses', 'Net', 'Balance']} />
        </>
      )}
    </div>
  );
}

function Spending({ compact }: { compact?: boolean }) {
  const [month, setMonth] = useState(dates.currentMonth());
  const q = useQuery<{ day: number; current: number | null; lastMonth: number; average: number; budgeted: number }[]>('report-spending', { month }, TABLES);
  const axis = useAxisFmt();
  const data = q.data ?? [];
  const today = data.filter(d => d.current !== null).at(-1);
  return (
    <div className="col">
      {!compact && (
        <div className="row">
          <button className="icon" onClick={() => setMonth(dates.addMonths(month, -1))} aria-label="Previous month">
            <Icon name="left" />
          </button>
          <strong>{monthShort(month)}</strong>
          <button className="icon" onClick={() => setMonth(dates.addMonths(month, 1))} aria-label="Next month">
            <Icon name="right" />
          </button>
        </div>
      )}
      {today && (
        <div className="row wrap" style={{ gap: 24 }}>
          <div className="stat">
            <span className="small muted">Spent so far</span>
            <span className="big">
              <Amount value={today.current ?? 0} />
            </span>
          </div>
          <div className="stat">
            <span className="small muted">vs last month, same day</span>
            <Amount value={(today.current ?? 0) - today.lastMonth} sign />
          </div>
          {!compact && today.budgeted > 0 && (
            <div className="stat">
              <span className="small muted">Budgeted</span>
              <Amount value={today.budgeted} />
            </div>
          )}
        </div>
      )}
      <Legend
        items={[
          { label: 'This month', color: 'var(--series-1)' },
          { label: 'Last month', color: 'var(--series-2)' },
          { label: '3-month average', color: 'var(--series-3)' },
        ]}
      />
      <div style={{ height: compact ? 110 : 340 }}>
        <ResponsiveContainer>
          <LineChart data={data} margin={{ top: 8, right: 8, left: compact ? 0 : 8, bottom: 0 }}>
            {!compact && <CartesianGrid vertical={false} />}
            <XAxis dataKey="day" hide={compact} tickLine={false} axisLine={false} />
            <YAxis tickFormatter={axis} hide={compact} width={80} tickLine={false} axisLine={false} />
            <Tooltip content={<ChartTip labelFmt={(d: number) => `Day ${d}`} />} />
            <Line dataKey="average" name="3-month average" stroke="var(--series-3)" strokeWidth={2} strokeDasharray="4 3" dot={false} />
            <Line dataKey="lastMonth" name="Last month" stroke="var(--series-2)" strokeWidth={2} dot={false} />
            <Line dataKey="current" name="This month" stroke="var(--series-1)" strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} connectNulls={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

interface CustomCfg {
  groupBy: 'category' | 'group' | 'payee' | 'account';
  interval: 'total' | 'monthly' | 'yearly';
  type: 'expense' | 'income' | 'net';
  view: 'bar' | 'stacked' | 'line' | 'area' | 'donut' | 'table';
  showHidden: boolean;
  showOffbudget: boolean;
  showUncategorized: boolean;
  showEmpty: boolean;
}

function Custom({ compact }: { compact?: boolean }) {
  const [range, setRange] = useRange('custom', '6m');
  const [cfg, setCfg] = useLocalStorage<CustomCfg>('report-custom', {
    groupBy: 'category',
    interval: 'total',
    type: 'expense',
    view: 'bar',
    showHidden: false,
    showOffbudget: false,
    showUncategorized: true,
    showEmpty: false,
  });
  const [drill, setDrill] = useState<{ groupId?: string; period?: string; title: string } | null>(null);
  const set = (p: Partial<CustomCfg>) => setCfg({ ...cfg, ...p });
  const interval = compact ? 'total' : cfg.interval;
  const args = {
    start: `${range.start}-01`,
    end: dates.lastDay(range.end),
    groupBy: cfg.groupBy,
    interval,
    type: cfg.type,
    showHidden: cfg.showHidden,
    showOffbudget: cfg.showOffbudget,
    showUncategorized: cfg.showUncategorized,
    showEmpty: cfg.showEmpty,
  };
  const q = useQuery<{ periods: string[]; rows: { id: string; name: string; total: number; values: Record<string, number> }[]; total: number; average: number }>('report-custom', args, TABLES);
  const axis = useAxisFmt();
  const r = q.data;
  // Up to 7 named series; the rest fold into "Other" so hues are never cycled.
  const top = (r?.rows ?? []).slice(0, 7);
  const rest = (r?.rows ?? []).slice(7);
  const series = [...top, ...(rest.length ? [{ id: '__other', name: 'Other', total: rest.reduce((s, x) => s + x.total, 0), values: Object.fromEntries((r?.periods ?? []).map(p => [p, rest.reduce((s, x) => s + (x.values[p] ?? 0), 0)])) }] : [])];
  const color = (i: number) => (series[i]?.id === '__other' ? 'var(--text-3)' : SERIES[i]);
  const view = compact ? 'bar' : cfg.view;
  const timeData = (r?.periods ?? []).map(p => ({ period: p, ...Object.fromEntries(series.map(s => [s.id, s.values[p] ?? 0])) }));
  const label = (p: string) => (p.length === 7 ? monthShort(p) : p);

  return (
    <div className="col">
      {!compact && (
        <div className="row wrap">
          <RangePicker range={range} onChange={setRange} />
          <select value={cfg.type} onChange={e => set({ type: e.target.value as any })} aria-label="Type">
            <option value="expense">Payments</option>
            <option value="income">Deposits</option>
            <option value="net">Net</option>
          </select>
          <select value={cfg.groupBy} onChange={e => set({ groupBy: e.target.value as any })} aria-label="Split by">
            <option value="category">By category</option>
            <option value="group">By group</option>
            <option value="payee">By payee</option>
            <option value="account">By account</option>
          </select>
          <select value={cfg.interval} onChange={e => set({ interval: e.target.value as any, view: e.target.value === 'total' && ['line', 'area', 'stacked'].includes(cfg.view) ? 'bar' : cfg.view })} aria-label="Mode">
            <option value="total">Total</option>
            <option value="monthly">Monthly</option>
            <option value="yearly">Yearly</option>
          </select>
          <div className="segmented" role="group" aria-label="View">
            {(cfg.interval === 'total' ? (['bar', 'donut', 'table'] as const) : (['bar', 'stacked', 'line', 'area', 'table'] as const)).map(v => (
              <button key={v} className={cfg.view === v ? 'on' : ''} onClick={() => set({ view: v })}>
                {v}
              </button>
            ))}
          </div>
          <label className="check small">
            <input type="checkbox" checked={cfg.showHidden} onChange={e => set({ showHidden: e.target.checked })} /> Hidden
          </label>
          <label className="check small">
            <input type="checkbox" checked={cfg.showOffbudget} onChange={e => set({ showOffbudget: e.target.checked })} /> Off budget
          </label>
          <label className="check small">
            <input type="checkbox" checked={cfg.showUncategorized} onChange={e => set({ showUncategorized: e.target.checked })} /> Uncategorized
          </label>
          <label className="check small">
            <input type="checkbox" checked={cfg.showEmpty} onChange={e => set({ showEmpty: e.target.checked })} /> Empty rows
          </label>
        </div>
      )}
      {r && (
        <div className="row wrap" style={{ gap: 24 }}>
          <div className="stat">
            <span className="small muted">Total</span>
            <span className="big">
              <Amount value={r.total} />
            </span>
          </div>
          {interval !== 'total' && (
            <div className="stat">
              <span className="small muted">Average per {interval === 'monthly' ? 'month' : 'year'}</span>
              <Amount value={r.average} />
            </div>
          )}
        </div>
      )}
      {!compact && view !== 'table' && series.length > 1 && <Legend items={series.map((s, i) => ({ label: s.name, color: color(i) }))} />}
      {view !== 'table' && (
        <div style={{ height: compact ? 120 : 360 }}>
          <ResponsiveContainer>
            {interval === 'total' ? (
              view === 'donut' ? (
                <PieChart>
                  <Tooltip content={<ChartTip />} />
                  <Pie data={series.map(s => ({ name: s.name, value: s.total, id: s.id }))} dataKey="value" nameKey="name" innerRadius="55%" outerRadius="85%" stroke="var(--surface)" strokeWidth={2} onClick={(d: any) => setDrill({ groupId: d.id === '__other' ? undefined : d.id, title: d.name })}>
                    {series.map((s, i) => (
                      <Cell key={s.id} fill={color(i)} cursor="pointer" />
                    ))}
                  </Pie>
                </PieChart>
              ) : (
                <BarChart data={series.map(s => ({ name: s.name, total: s.total, id: s.id }))} layout="vertical" margin={{ left: 8, right: 16 }}>
                  <XAxis type="number" tickFormatter={axis} hide={compact} tickLine={false} axisLine={false} />
                  <YAxis type="category" dataKey="name" width={compact ? 90 : 140} tickLine={false} axisLine={false} interval={0} />
                  <Tooltip content={<ChartTip />} cursor={{ fill: 'var(--surface-2)' }} />
                  <Bar dataKey="total" name="Total" radius={[0, 4, 4, 0]} maxBarSize={22} onClick={(d: any) => !compact && setDrill({ groupId: d.id === '__other' ? undefined : d.id, title: d.name })} cursor="pointer">
                    {series.map((s, i) => (
                      <Cell key={s.id} fill={color(i)} />
                    ))}
                  </Bar>
                </BarChart>
              )
            ) : view === 'line' ? (
              <LineChart data={timeData}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="period" tickFormatter={label} tickLine={false} axisLine={false} />
                <YAxis tickFormatter={axis} width={80} tickLine={false} axisLine={false} />
                <Tooltip content={<ChartTip labelFmt={label} />} />
                {series.map((s, i) => (
                  <Line key={s.id} dataKey={s.id} name={s.name} stroke={color(i)} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                ))}
              </LineChart>
            ) : view === 'area' ? (
              <AreaChart data={timeData}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="period" tickFormatter={label} tickLine={false} axisLine={false} />
                <YAxis tickFormatter={axis} width={80} tickLine={false} axisLine={false} />
                <Tooltip content={<ChartTip labelFmt={label} />} />
                {series.map((s, i) => (
                  <Area key={s.id} dataKey={s.id} name={s.name} stackId="a" stroke="var(--surface)" strokeWidth={1} fill={color(i)} fillOpacity={0.85} />
                ))}
              </AreaChart>
            ) : (
              <BarChart data={timeData} barGap={2}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="period" tickFormatter={label} tickLine={false} axisLine={false} />
                <YAxis tickFormatter={axis} width={80} tickLine={false} axisLine={false} />
                <Tooltip content={<ChartTip labelFmt={label} />} cursor={{ fill: 'var(--surface-2)' }} />
                {series.map((s, i) => (
                  <Bar
                    key={s.id}
                    dataKey={s.id}
                    name={s.name}
                    fill={color(i)}
                    stackId={view === 'stacked' ? 'a' : undefined}
                    stroke={view === 'stacked' ? 'var(--surface)' : undefined}
                    strokeWidth={view === 'stacked' ? 2 : 0}
                    radius={view === 'stacked' ? 0 : [4, 4, 0, 0]}
                    maxBarSize={36}
                    cursor="pointer"
                    onClick={(d: any) => setDrill({ groupId: s.id === '__other' ? undefined : s.id, period: d.period, title: `${s.name} · ${label(d.period)}` })}
                  />
                ))}
              </BarChart>
            )}
          </ResponsiveContainer>
        </div>
      )}
      {!compact && r && (
        <div style={{ overflowX: 'auto' }}>
          <table className="grid">
            <thead>
              <tr>
                <th>{cfg.groupBy[0].toUpperCase() + cfg.groupBy.slice(1)}</th>
                {interval !== 'total' && r.periods.map(p => <th key={p} className="num">{label(p)}</th>)}
                <th className="num">Total</th>
                {interval !== 'total' && <th className="num">Average</th>}
              </tr>
            </thead>
            <tbody>
              {r.rows.map(row => (
                <tr key={row.id} style={{ cursor: 'pointer' }} onClick={() => setDrill({ groupId: row.id, title: row.name })}>
                  <td>{row.name}</td>
                  {interval !== 'total' &&
                    r.periods.map(p => (
                      <td
                        key={p}
                        className="num"
                        onClick={e => {
                          e.stopPropagation();
                          setDrill({ groupId: row.id, period: p, title: `${row.name} · ${label(p)}` });
                        }}
                      >
                        <Amount value={row.values[p] ?? 0} className={!row.values[p] ? 'dim' : ''} />
                      </td>
                    ))}
                  <td className="num">
                    <strong>
                      <Amount value={row.total} />
                    </strong>
                  </td>
                  {interval !== 'total' && (
                    <td className="num">
                      <Amount value={Math.round(row.total / Math.max(1, r.periods.length))} />
                    </td>
                  )}
                </tr>
              ))}
              <tr>
                <td>
                  <strong>Total</strong>
                </td>
                {interval !== 'total' &&
                  r.periods.map(p => (
                    <td key={p} className="num">
                      <Amount value={r.rows.reduce((s, x) => s + (x.values[p] ?? 0), 0)} />
                    </td>
                  ))}
                <td className="num">
                  <strong>
                    <Amount value={r.total} />
                  </strong>
                </td>
                {interval !== 'total' && (
                  <td className="num">
                    <Amount value={r.average} />
                  </td>
                )}
              </tr>
            </tbody>
          </table>
        </div>
      )}
      {drill && <DrilldownModal args={{ ...args, groupId: drill.groupId, period: drill.period }} title={drill.title} onClose={() => setDrill(null)} />}
    </div>
  );
}

function DrilldownModal({ args, title, onClose }: { args: any; title: string; onClose: () => void }) {
  const { fmtDate, payeeName, categoryName, accountName } = useApp();
  const q = useQuery<TransactionEntity[]>('report-drilldown', args, TABLES);
  return (
    <Modal title={title} onClose={onClose} size="wide">
      <table className="grid">
        <thead>
          <tr>
            <th>Date</th>
            <th>Account</th>
            <th>Payee</th>
            <th>Category</th>
            <th className="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {(q.data ?? []).map(t => (
            <tr key={t.id}>
              <td>{fmtDate(t.date)}</td>
              <td>{accountName(t.account)}</td>
              <td>{payeeName(t.payee)}</td>
              <td>{t.is_parent ? 'Split' : categoryName(t.category)}</td>
              <td className="num">
                <Amount value={t.amount} color />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {q.data?.length === 0 && <div className="empty">No transactions.</div>}
    </Modal>
  );
}

function CalendarReport({ compact }: { compact?: boolean }) {
  const { fmt, privacy } = useApp();
  const [month, setMonth] = useState(dates.currentMonth());
  const q = useQuery<{ date: string; income: number; expenses: number }[]>('report-calendar', { month }, TABLES);
  const days = q.data ?? [];
  const max = Math.max(1, ...days.map(d => -d.expenses));
  const offset = days.length ? new Date(days[0].date + 'T00:00:00Z').getUTCDay() : 0;
  // Sequential single-hue ramp for spending magnitude.
  const shade = (v: number) => (v <= 0 ? 'var(--surface-2)' : `var(--seq-${Math.min(6, 1 + Math.floor((v / max) * 5.99))})`);
  const total = days.reduce((s, d) => ({ income: s.income + d.income, expenses: s.expenses + d.expenses }), { income: 0, expenses: 0 });
  return (
    <div className="col">
      {!compact && (
        <div className="row">
          <button className="icon" onClick={() => setMonth(dates.addMonths(month, -1))} aria-label="Previous month">
            <Icon name="left" />
          </button>
          <strong>{monthShort(month)}</strong>
          <button className="icon" onClick={() => setMonth(dates.addMonths(month, 1))} aria-label="Next month">
            <Icon name="right" />
          </button>
        </div>
      )}
      <div className="row wrap small" style={{ gap: 16 }}>
        <span>
          Income <Amount value={total.income} />
        </span>
        <span>
          Expenses <Amount value={total.expenses} />
        </span>
      </div>
      <div className="calendar" style={compact ? { gap: 2 } : undefined}>
        {!compact && ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => <div key={d} className="dim small" style={{ textAlign: 'center' }}>{d}</div>)}
        {Array.from({ length: offset }, (_, i) => (
          <div key={'pad' + i} />
        ))}
        {days.map(d => {
          const spend = -d.expenses;
          const strong = spend / max > 0.5;
          return (
            <div
              key={d.date}
              className="day"
              style={{ background: shade(spend), minHeight: compact ? 18 : 58, color: strong ? '#fff' : undefined }}
              title={privacy ? d.date : `${d.date}: income ${fmt(d.income)}, expenses ${fmt(d.expenses)}`}
            >
              {!compact && (
                <>
                  <strong>{Number(d.date.slice(8))}</strong>
                  {d.income > 0 && <Amount value={d.income} />}
                  {d.expenses < 0 && <Amount value={d.expenses} />}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AgeOfMoney({ compact }: { compact?: boolean }) {
  const [range, setRange] = useRange('aom');
  const q = useQuery<{ month: string; age: number | null }[]>('report-age-of-money', { start: range.start, end: range.end }, TABLES);
  const data = q.data ?? [];
  const last = [...data].reverse().find(d => d.age !== null);
  return (
    <div className="col">
      {!compact && <RangePicker range={range} onChange={setRange} />}
      <div className="stat">
        <span className="small muted">Age of money</span>
        <span className="big">{last?.age != null ? `${last.age} days` : '—'}</span>
      </div>
      <div style={{ height: compact ? 110 : 300 }}>
        <ResponsiveContainer>
          <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            {!compact && <CartesianGrid vertical={false} />}
            <XAxis dataKey="month" tickFormatter={monthShort} hide={compact} tickLine={false} axisLine={false} />
            <YAxis hide={compact} width={40} tickLine={false} axisLine={false} />
            <Tooltip formatter={(v: any) => [`${v} days`, 'Age']} labelFormatter={monthShort} contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6 }} />
            <Line dataKey="age" name="Age" stroke="var(--series-1)" strokeWidth={2} dot={false} activeDot={{ r: 4 }} connectNulls />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function DataTable({ headers, rows }: { headers: string[]; rows: { label: string; values: number[] }[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button className="small ghost" onClick={() => setOpen(!open)}>
        {open ? 'Hide' : 'Show'} data table
      </button>
      {open && (
        <table className="grid">
          <thead>
            <tr>
              {headers.map((h, i) => (
                <th key={h} className={i ? 'num' : ''}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.label}>
                <td>{r.label}</td>
                {r.values.map((v, i) => (
                  <td key={i} className="num">
                    <Amount value={v} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

