import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { dates } from '@envelope/core';
import { useApp } from '../lib/app';
import { useQuery } from '../lib/hooks';
import { Register } from '../components/Register';
import { Icon } from '../components/Icon';

export function CategoryPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const month = params.get('month');
  const { groups, fmt, privacy } = useApp();
  const cat = groups.flatMap(g => g.categories).find(c => c.id === id);
  const [onlyMonth, setOnlyMonth] = useState(!!month);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const end = dates.currentMonth();
  const trend = useQuery<{ rows: { id: string; values: Record<string, number> }[]; periods: string[] }>(
    id ? 'report-custom' : null,
    { start: `${dates.addMonths(end, -11)}-01`, end: dates.lastDay(end), groupBy: 'category', interval: 'monthly', type: cat?.is_income ? 'income' : 'expense', showHidden: true, showUncategorized: false, filter: { conditionsOp: 'and', conditions: [{ field: 'category', op: 'is', value: id }] } },
    ['transactions'],
  );
  if (!cat || !id) return <div className="page empty">Category not found.</div>;
  const row = trend.data?.rows[0];
  const data = (trend.data?.periods ?? []).map(p => ({ month: p, value: row?.values[p] ?? 0 }));
  return (
    <div className="page" style={{ maxWidth: 'none', display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="page-header">
        <Link to="/budget" className="row small">
          <Icon name="left" size={14} /> Budget
        </Link>
        <h1>{cat.name}</h1>
        {month && (
          <label className="check small">
            <input type="checkbox" checked={onlyMonth} onChange={e => setOnlyMonth(e.target.checked)} /> Only {month}
          </label>
        )}
      </div>
      <div className="card pad" style={{ marginBottom: 12 }}>
        <div className="small muted">{cat.is_income ? 'Received' : 'Spending'} per month, last 12 months</div>
        <div style={{ height: 140 }}>
          <ResponsiveContainer>
            <BarChart data={data}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="month" tickLine={false} axisLine={false} tickFormatter={m => m.slice(5)} />
              <YAxis hide />
              <Tooltip formatter={(v: any) => [privacy ? '•••' : fmt(v), cat.name]} contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6 }} cursor={{ fill: 'var(--surface-2)' }} />
              <Bar dataKey="value" fill="var(--series-1)" radius={[4, 4, 0, 0]} maxBarSize={28} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
      <Register
        category={id}
        startDate={onlyMonth && month ? `${month}-01` : undefined}
        endDate={onlyMonth && month ? dates.lastDay(month) : undefined}
        columns={{ notes: true, balance: false, account: true }}
        adding={false}
        onAddingChange={() => {}}
        selected={selected}
        onSelectedChange={setSelected}
      />
    </div>
  );
}
