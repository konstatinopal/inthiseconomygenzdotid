import { useEffect, useState } from 'react';
import type { Action, Condition, Rule, TransactionEntity } from '@envelope/core';
import { useApp, useAction } from '../lib/app';
import { send } from '../lib/client';
import { useQuery } from '../lib/hooks';
import { ActionRow, ConditionList, describeCondition } from '../components/Conditions';
import { Amount, Modal, confirmDialog } from '../components/ui';
import { Icon } from '../components/Icon';

type RuleDraft = Omit<Rule, 'id'> & { id?: string };

function describeAction(a: Action, names: { payee: (id: string) => string; category: (id: string) => string; account: (id: string) => string }, fmt: (n: number) => string) {
  switch (a.op) {
    case 'set': {
      const v = a.field === 'payee' ? names.payee(a.value) : a.field === 'category' ? names.category(a.value) : a.field === 'account' ? names.account(a.value) : a.field === 'amount' ? fmt(a.value) : String(a.value);
      return `set ${a.field} to ${v || '(none)'}`;
    }
    case 'prepend-notes':
      return `prepend “${a.value}” to notes`;
    case 'append-notes':
      return `append “${a.value}” to notes`;
    case 'link-schedule':
      return 'link schedule';
    case 'delete-transaction':
      return 'delete transaction';
  }
}

export function RulesPage() {
  const { payeeName, categoryName, accountName, fmt } = useApp();
  const act = useAction();
  const rules = useQuery<Rule[]>('rules-get', {}, ['rules', 'payees', 'categories']);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<RuleDraft | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const names = { payee: payeeName, category: categoryName, account: accountName };
  const list = (rules.data ?? [])
    .map(r => ({
      r,
      conds: r.conditions.map(c => describeCondition(c, names, fmt)).join(r.conditionsOp === 'and' ? ' and ' : ' or '),
      acts: r.actions.map(a => describeAction(a, names, fmt)).join(', '),
    }))
    .filter(x => !search || `${x.conds} ${x.acts} ${x.r.description ?? ''}`.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => ['pre', null, 'post'].indexOf(a.r.stage) - ['pre', null, 'post'].indexOf(b.r.stage));

  return (
    <div className="page">
      <div className="page-header">
        <h1>Rules</h1>
        <span className="muted small">Run on every new and imported transaction: pre stage first, then default, then post; more specific rules later.</span>
        <div className="spacer" />
        <input placeholder="Search rules" value={search} onChange={e => setSearch(e.target.value)} aria-label="Search rules" />
        {selected.size > 0 && (
          <button
            className="danger"
            onClick={async () => {
              if (await confirmDialog({ title: 'Delete rules', message: `Delete ${selected.size} rule(s)? Rules that back a schedule are kept.`, danger: true, confirmLabel: 'Delete' })) {
                await act('rules-delete', { ids: [...selected] });
                setSelected(new Set());
              }
            }}
          >
            Delete {selected.size}
          </button>
        )}
        <button className="primary" onClick={() => setEditing({ stage: null, conditionsOp: 'and', conditions: [{ field: 'payee', op: 'is', value: null }], actions: [{ op: 'set', field: 'category', value: null }] })}>
          <Icon name="plus" /> New rule
        </button>
      </div>
      <div className="card">
        <table className="grid">
          <thead>
            <tr>
              <th style={{ width: 30 }} />
              <th style={{ width: 70 }}>Stage</th>
              <th>If</th>
              <th>Then</th>
            </tr>
          </thead>
          <tbody>
            {list.map(({ r, conds, acts }) => (
              <tr key={r.id} className={selected.has(r.id) ? 'selected' : ''} style={{ cursor: 'pointer' }} onClick={() => setEditing(r)}>
                <td onClick={e => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    aria-label="Select rule"
                    checked={selected.has(r.id)}
                    onChange={() => {
                      const n = new Set(selected);
                      if (n.has(r.id)) n.delete(r.id);
                      else n.add(r.id);
                      setSelected(n);
                    }}
                  />
                </td>
                <td>
                  <span className="badge">{r.stage ?? 'default'}</span>
                </td>
                <td>
                  {r.description && <div style={{ fontWeight: 600 }}>{r.description}</div>}
                  <span className="muted">{conds}</span>
                </td>
                <td>{acts}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.length === 0 && <div className="empty">{search ? 'No matching rules.' : 'No rules yet. The app learns payee categories as you categorize transactions.'}</div>}
      </div>
      {editing && <RuleEditor initial={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

export function RuleEditor({ initial, onClose }: { initial: RuleDraft; onClose: () => void }) {
  const { fmtDate, payeeName, categoryName, accountName } = useApp();
  const act = useAction();
  const [rule, setRule] = useState<RuleDraft>(initial);
  const [errors, setErrors] = useState<string[]>([]);
  const [matches, setMatches] = useState<TransactionEntity[] | null>(null);
  const isSchedule = rule.actions.some(a => a.op === 'link-schedule');

  useEffect(() => {
    const valid = rule.conditions.filter(c => c.value !== null && c.value !== '' || c.op === 'onBudget' || c.op === 'offBudget');
    const t = setTimeout(() => {
      send<TransactionEntity[]>('rule-preview', { conditionsOp: rule.conditionsOp, conditions: valid })
        .then(setMatches)
        .catch(() => setMatches(null));
    }, 250);
    return () => clearTimeout(t);
  }, [rule.conditions, rule.conditionsOp]);

  const save = async () => {
    const errs = await send<string[]>('rule-validate', rule);
    setErrors(errs);
    if (errs.length) return;
    const ok = await act(rule.id ? 'rule-update' : 'rule-create', rule, 'Rule saved');
    if (ok !== undefined) onClose();
  };

  return (
    <Modal
      title={rule.id ? 'Edit rule' : 'New rule'}
      size="wide"
      onClose={onClose}
      footer={
        <>
          {matches && matches.length > 0 && (
            <button
              className="ghost"
              onClick={async () => {
                if (await confirmDialog({ title: 'Apply actions', message: `Apply this rule’s actions to ${matches.length} matching transaction(s) now?`, confirmLabel: 'Apply' }))
                  await act('rule-apply-actions', { ids: matches.map(m => m.id), actions: rule.actions.filter(a => a.op !== 'link-schedule') }, 'Actions applied');
              }}
            >
              Apply to {matches.length} matching
            </button>
          )}
          <div className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={save}>
            Save rule
          </button>
        </>
      }
    >
      {isSchedule && <div className="badge accent">This rule belongs to a schedule. Edit the schedule to change its date.</div>}
      <div className="row wrap">
        <label className="field">
          Stage
          <select value={rule.stage ?? ''} onChange={e => setRule({ ...rule, stage: (e.target.value || null) as Rule['stage'] })}>
            <option value="pre">Pre</option>
            <option value="">Default</option>
            <option value="post">Post</option>
          </select>
        </label>
        <label className="field grow">
          Description (optional)
          <input value={rule.description ?? ''} onChange={e => setRule({ ...rule, description: e.target.value })} />
        </label>
      </div>
      <h3>If</h3>
      <ConditionList conditions={rule.conditions} op={rule.conditionsOp} onChange={(conditions: Condition[], conditionsOp) => setRule({ ...rule, conditions, conditionsOp })} />
      <h3>Then</h3>
      <div className="col">
        {rule.actions.map((a, i) => (
          <ActionRow key={i} action={a} onChange={na => setRule({ ...rule, actions: rule.actions.map((x, j) => (j === i ? na : x)) })} onRemove={() => setRule({ ...rule, actions: rule.actions.filter((_, j) => j !== i) })} />
        ))}
        <div>
          <button className="small" onClick={() => setRule({ ...rule, actions: [...rule.actions, { op: 'set', field: 'category', value: null }] })}>
            <Icon name="plus" size={14} /> Add action
          </button>
        </div>
      </div>
      {errors.length > 0 && <div className="badge neg" style={{ whiteSpace: 'normal' }}>{errors.join(' · ')}</div>}
      <h3>Matching transactions {matches ? `(${matches.length}${matches.length === 200 ? '+' : ''})` : ''}</h3>
      <div className="card" style={{ maxHeight: 220, overflow: 'auto' }}>
        <table className="grid">
          <tbody>
            {(matches ?? []).slice(0, 50).map(t => (
              <tr key={t.id}>
                <td>{fmtDate(t.date)}</td>
                <td>{accountName(t.account)}</td>
                <td>{payeeName(t.payee) || <span className="dim">{t.imported_payee}</span>}</td>
                <td>{categoryName(t.category)}</td>
                <td className="num">
                  <Amount value={t.amount} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {matches?.length === 0 && <div className="empty small">No existing transactions match.</div>}
      </div>
    </Modal>
  );
}
