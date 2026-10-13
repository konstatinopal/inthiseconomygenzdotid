import { useState } from 'react';
import { FIELD_TYPES, OPS_BY_TYPE, describeRecurrence, type Action, type Condition, type ConditionField, type ConditionOp, type RecurConfig } from '@envelope/core';
import { useApp } from '../lib/app';
import { Autocomplete, accountItems, categoryItems, payeeItems, type AcItem } from './Autocomplete';
import { AmountInput } from './ui';
import { Icon } from './Icon';

export const FIELD_LABELS: Record<string, string> = {
  account: 'Account',
  payee: 'Payee',
  category: 'Category',
  date: 'Date',
  notes: 'Notes',
  amount: 'Amount',
  imported_payee: 'Imported payee',
  cleared: 'Cleared',
  reconciled: 'Reconciled',
  transfer: 'Is transfer',
  saved: 'Saved',
};

export const OP_LABELS: Record<string, string> = {
  is: 'is',
  isNot: 'is not',
  oneOf: 'is one of',
  notOneOf: 'is not one of',
  contains: 'contains',
  doesNotContain: 'does not contain',
  matches: 'matches (regex)',
  gt: 'is greater than',
  gte: 'is greater than or equal to',
  lt: 'is less than',
  lte: 'is less than or equal to',
  isapprox: 'is approximately',
  isbetween: 'is between',
  hasTags: 'has tags',
  onBudget: 'is on budget',
  offBudget: 'is off budget',
};

const CONDITION_FIELDS: ConditionField[] = ['payee', 'imported_payee', 'account', 'category', 'notes', 'amount', 'date', 'cleared', 'reconciled', 'transfer'];

export function useEntityItems() {
  const { payees, accounts, groups } = useApp();
  return {
    payee: payeeItems(payees, accounts),
    category: categoryItems(groups, { includeHidden: true }),
    account: accountItems(accounts, true),
  } as Record<string, AcItem[]>;
}

function defaultValue(field: ConditionField, op: ConditionOp) {
  const type = FIELD_TYPES[field];
  if (op === 'oneOf' || op === 'notOneOf') return [];
  if (op === 'isbetween') return { num1: 0, num2: 0 };
  if (type === 'boolean') return true;
  if (type === 'number') return 0;
  if (type === 'date') return new Date().toISOString().slice(0, 10);
  if (type === 'id') return null;
  return '';
}

export function ConditionRow({ cond, onChange, onRemove }: { cond: Condition; onChange: (c: Condition) => void; onRemove: () => void }) {
  const items = useEntityItems();
  const type = FIELD_TYPES[cond.field];
  const ops: ConditionOp[] = cond.field === 'account' ? [...OPS_BY_TYPE.id, 'onBudget', 'offBudget'] : OPS_BY_TYPE[type];
  const value = cond.value;

  let editor: React.ReactNode = null;
  if (cond.op === 'onBudget' || cond.op === 'offBudget') editor = null;
  else if (type === 'boolean')
    editor = (
      <select value={value ? 'true' : 'false'} onChange={e => onChange({ ...cond, value: e.target.value === 'true' })}>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  else if (type === 'id' && (cond.op === 'oneOf' || cond.op === 'notOneOf'))
    editor = <MultiSelect items={items[cond.field]} value={Array.isArray(value) ? value : []} onChange={v => onChange({ ...cond, value: v })} />;
  else if (type === 'id')
    editor = <Autocomplete items={items[cond.field]} value={value} onSelect={id => onChange({ ...cond, value: id })} placeholder="Choose…" />;
  else if (type === 'number' && cond.op === 'isbetween')
    editor = (
      <div className="row">
        <AmountInput value={value?.num1 ?? 0} onCommit={v => onChange({ ...cond, value: { ...value, num1: v ?? 0 } })} />
        <span className="dim">and</span>
        <AmountInput value={value?.num2 ?? 0} onCommit={v => onChange({ ...cond, value: { ...value, num2: v ?? 0 } })} />
      </div>
    );
  else if (type === 'number') editor = <AmountInput value={typeof value === 'number' ? value : 0} onCommit={v => onChange({ ...cond, value: v ?? 0 })} />;
  else if (type === 'date' && value && typeof value === 'object')
    editor = <span className="muted small">{describeRecurrence(value as RecurConfig)}</span>;
  else if (type === 'date') editor = <input type="date" value={value ?? ''} onChange={e => onChange({ ...cond, value: e.target.value })} />;
  else if (cond.op === 'oneOf' || cond.op === 'notOneOf')
    editor = (
      <input
        placeholder="Comma-separated values"
        value={Array.isArray(value) ? value.join(', ') : ''}
        onChange={e => onChange({ ...cond, value: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
      />
    );
  else editor = <input value={value ?? ''} placeholder={cond.op === 'hasTags' ? '#tag' : ''} onChange={e => onChange({ ...cond, value: e.target.value })} />;

  return (
    <div className="row wrap" style={{ alignItems: 'flex-start' }}>
      <select
        value={cond.field}
        onChange={e => {
          const field = e.target.value as ConditionField;
          const op = (field === 'account' ? OPS_BY_TYPE.id : OPS_BY_TYPE[FIELD_TYPES[field]])[0];
          onChange({ field, op, value: defaultValue(field, op) });
        }}
        aria-label="Field"
      >
        {CONDITION_FIELDS.map(f => (
          <option key={f} value={f}>
            {FIELD_LABELS[f]}
          </option>
        ))}
      </select>
      <select
        value={cond.op}
        onChange={e => {
          const op = e.target.value as ConditionOp;
          const listy = (o: string) => o === 'oneOf' || o === 'notOneOf';
          const keep = listy(op) === listy(cond.op) && (op === 'isbetween') === (cond.op === 'isbetween');
          onChange({ ...cond, op, value: keep ? cond.value : defaultValue(cond.field, op) });
        }}
        aria-label="Operator"
      >
        {ops.map(o => (
          <option key={o} value={o}>
            {OP_LABELS[o]}
          </option>
        ))}
      </select>
      {type === 'number' && (
        <select
          value={cond.options?.outflow ? 'outflow' : cond.options?.inflow ? 'inflow' : ''}
          onChange={e => onChange({ ...cond, options: e.target.value ? { [e.target.value]: true } : undefined })}
          aria-label="Direction"
        >
          <option value="">(signed)</option>
          <option value="outflow">outflow</option>
          <option value="inflow">inflow</option>
        </select>
      )}
      <div className="grow" style={{ minWidth: 160 }}>
        {editor}
      </div>
      <button className="icon" onClick={onRemove} aria-label="Remove condition">
        <Icon name="x" />
      </button>
    </div>
  );
}

export function MultiSelect({ items, value, onChange }: { items: AcItem[]; value: string[]; onChange: (v: string[]) => void }) {
  const [key, setKey] = useState(0);
  const label = (id: string) => items.find(i => i.id === id)?.label ?? id;
  return (
    <div className="col" style={{ gap: 4 }}>
      <div className="row wrap" style={{ gap: 4 }}>
        {value.map(id => (
          <span key={id} className="chip">
            {label(id)}
            <button onClick={() => onChange(value.filter(v => v !== id))} aria-label={`Remove ${label(id)}`}>
              ×
            </button>
          </span>
        ))}
      </div>
      <Autocomplete
        key={key}
        items={items.filter(i => !value.includes(i.id))}
        value={null}
        placeholder="Add…"
        onSelect={id => {
          if (id) onChange([...value, id]);
          setKey(k => k + 1);
        }}
      />
    </div>
  );
}

export function ConditionList({
  conditions,
  op,
  onChange,
}: {
  conditions: Condition[];
  op: 'and' | 'or';
  onChange: (conditions: Condition[], op: 'and' | 'or') => void;
}) {
  return (
    <div className="col">
      {conditions.length > 1 && (
        <div className="row small">
          Match
          <select value={op} onChange={e => onChange(conditions, e.target.value as 'and' | 'or')} aria-label="Match mode">
            <option value="and">all</option>
            <option value="or">any</option>
          </select>
          of these conditions
        </div>
      )}
      {conditions.map((c, i) => (
        <ConditionRow
          key={i}
          cond={c}
          onChange={nc => onChange(conditions.map((x, j) => (j === i ? nc : x)), op)}
          onRemove={() => onChange(conditions.filter((_, j) => j !== i), op)}
        />
      ))}
      <div>
        <button className="small" onClick={() => onChange([...conditions, { field: 'payee', op: 'is', value: null }], op)}>
          <Icon name="plus" size={14} /> Add condition
        </button>
      </div>
    </div>
  );
}

const ACTION_FIELDS = ['category', 'payee', 'notes', 'account', 'cleared', 'date', 'amount'];

export function ActionRow({ action, onChange, onRemove }: { action: Action; onChange: (a: Action) => void; onRemove: () => void }) {
  const items = useEntityItems();
  const kind = action.op;
  let editor: React.ReactNode = null;
  if (action.op === 'set') {
    const type = action.field === 'cleared' ? 'boolean' : action.field === 'amount' ? 'number' : action.field === 'date' ? 'date' : ['category', 'payee', 'account'].includes(action.field) ? 'id' : 'string';
    editor = (
      <>
        <select value={action.field} onChange={e => onChange({ op: 'set', field: e.target.value, value: e.target.value === 'cleared' ? true : null })} aria-label="Field to set">
          {ACTION_FIELDS.map(f => (
            <option key={f} value={f}>
              {FIELD_LABELS[f]}
            </option>
          ))}
        </select>
        <span className="dim">to</span>
        <div className="grow" style={{ minWidth: 160 }}>
          {type === 'id' ? (
            <Autocomplete items={items[action.field]} value={action.value} onSelect={id => onChange({ ...action, value: id })} placeholder="Choose…" />
          ) : type === 'boolean' ? (
            <select value={action.value ? 'true' : 'false'} onChange={e => onChange({ ...action, value: e.target.value === 'true' })}>
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          ) : type === 'number' ? (
            <AmountInput value={action.value ?? 0} onCommit={v => onChange({ ...action, value: v ?? 0 })} />
          ) : type === 'date' ? (
            <input type="date" value={action.value ?? ''} onChange={e => onChange({ ...action, value: e.target.value })} />
          ) : (
            <input value={action.value ?? ''} onChange={e => onChange({ ...action, value: e.target.value })} />
          )}
        </div>
      </>
    );
  } else if (action.op === 'prepend-notes' || action.op === 'append-notes') {
    editor = <input className="grow" value={action.value ?? ''} onChange={e => onChange({ ...action, value: e.target.value })} placeholder="Text" />;
  } else if (action.op === 'link-schedule') {
    editor = <span className="muted small">Links matching transactions to this rule’s schedule</span>;
  }
  return (
    <div className="row wrap">
      <select
        value={kind}
        onChange={e => {
          const op = e.target.value as Action['op'];
          onChange(op === 'set' ? { op, field: 'category', value: null } : op === 'delete-transaction' ? { op } : ({ op, value: '' } as Action));
        }}
        aria-label="Action"
      >
        <option value="set">Set</option>
        <option value="prepend-notes">Prepend to notes</option>
        <option value="append-notes">Append to notes</option>
        <option value="delete-transaction">Delete transaction</option>
        {kind === 'link-schedule' && <option value="link-schedule">Link schedule</option>}
      </select>
      {editor}
      <button className="icon" onClick={onRemove} aria-label="Remove action">
        <Icon name="x" />
      </button>
    </div>
  );
}

export function describeCondition(c: Condition, names: { payee: (id: string) => string; category: (id: string) => string; account: (id: string) => string }, fmt: (n: number) => string) {
  const field = FIELD_LABELS[c.field] ?? c.field;
  const nameOf = (id: string) => (c.field === 'payee' ? names.payee(id) : c.field === 'category' ? names.category(id) : c.field === 'account' ? names.account(id) : id);
  let v: string;
  if (c.op === 'onBudget' || c.op === 'offBudget') v = '';
  else if (Array.isArray(c.value)) v = c.value.map(x => (FIELD_TYPES[c.field] === 'id' ? nameOf(x) : x)).join(', ');
  else if (FIELD_TYPES[c.field] === 'id') v = c.value ? nameOf(c.value) : '(none)';
  else if (FIELD_TYPES[c.field] === 'number') v = c.op === 'isbetween' ? `${fmt(c.value.num1)} and ${fmt(c.value.num2)}` : fmt(c.value);
  else if (c.value && typeof c.value === 'object') v = describeRecurrence(c.value);
  else v = String(c.value);
  const dir = c.options?.outflow ? ' (outflow)' : c.options?.inflow ? ' (inflow)' : '';
  return `${field}${dir} ${OP_LABELS[c.op] ?? c.op} ${v}`.trim();
}
