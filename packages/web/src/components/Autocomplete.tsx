import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AccountEntity, CategoryGroupEntity, PayeeEntity } from '@envelope/core';

export interface AcItem {
  id: string;
  label: string;
  group?: string;
  hint?: string;
}

interface Props {
  value: string | null;
  items: AcItem[];
  onSelect: (id: string | null, createName?: string) => void;
  allowCreate?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
  ariaLabel?: string;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  extraItems?: AcItem[];
}

/** Keyboard-first combobox: type to filter, arrows to move, Enter or Tab to pick. */
export function Autocomplete({ value, items, onSelect, allowCreate, placeholder, autoFocus, className, ariaLabel, onKeyDown, extraItems = [] }: Props) {
  const label = items.find(i => i.id === value)?.label ?? extraItems.find(i => i.id === value)?.label ?? '';
  const [text, setText] = useState(label);
  const [open, setOpen] = useState(false);
  const [hl, setHl] = useState(0);
  const [dirty, setDirty] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (!dirty) setText(label);
  }, [label, dirty]);

  const filtered = useMemo(() => {
    const q = dirty ? text.trim().toLowerCase() : '';
    const all = [...extraItems, ...items];
    const out = q ? all.filter(i => i.label.toLowerCase().includes(q)) : all;
    // Prefix matches first.
    if (q) out.sort((a, b) => Number(!a.label.toLowerCase().startsWith(q)) - Number(!b.label.toLowerCase().startsWith(q)));
    const exact = all.some(i => i.label.toLowerCase() === q);
    if (allowCreate && q && !exact) out.unshift({ id: '__create__', label: `Create “${text.trim()}”` });
    return out.slice(0, 200);
  }, [items, extraItems, text, dirty, allowCreate]);

  useLayoutEffect(() => {
    if (open && inputRef.current) setRect(inputRef.current.getBoundingClientRect());
  }, [open, text]);

  useEffect(() => {
    listRef.current?.querySelector('.hl')?.scrollIntoView({ block: 'nearest' });
  }, [hl]);

  const pick = (item: AcItem | undefined) => {
    setOpen(false);
    setDirty(false);
    if (!item) {
      if (dirty && text.trim() === '') onSelect(null);
      else setText(label);
      return;
    }
    if (item.id === '__create__') {
      onSelect(null, text.trim());
      setText(text.trim());
    } else {
      onSelect(item.id);
      setText(item.label);
    }
  };

  return (
    <div className="ac">
      <input
        ref={inputRef}
        className={className}
        value={text}
        placeholder={placeholder}
        autoFocus={autoFocus}
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-autocomplete="list"
        onFocus={e => {
          e.target.select();
          setOpen(true);
          setHl(0);
        }}
        onBlur={() => {
          if (dirty) pick(text.trim() === '' ? undefined : filtered[0]);
          setOpen(false);
        }}
        onChange={e => {
          setText(e.target.value);
          setDirty(true);
          setOpen(true);
          setHl(0);
        }}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setHl(h => Math.min(h + 1, filtered.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHl(h => Math.max(h - 1, 0));
          } else if (e.key === 'Enter') {
            if (open && (dirty || hl > 0)) {
              e.preventDefault();
              e.stopPropagation();
              pick(filtered[hl]);
              return;
            }
          } else if (e.key === 'Tab') {
            if (dirty) pick(text.trim() === '' ? undefined : filtered[hl]);
            setOpen(false);
          } else if (e.key === 'Escape') {
            if (open) {
              e.stopPropagation();
              setOpen(false);
              setDirty(false);
              setText(label);
              return;
            }
          }
          onKeyDown?.(e);
        }}
      />
      {open &&
        rect &&
        filtered.length > 0 &&
        createPortal(
          <div
            ref={listRef}
            className="ac-list"
            role="listbox"
            style={{ top: rect.bottom + 2, left: rect.left, width: Math.max(rect.width, 220) }}
            onMouseDown={e => e.preventDefault()}
          >
            {filtered.map((item, i) => {
              const showGroup = item.group && item.group !== filtered[i - 1]?.group;
              return (
                <div key={item.id + i}>
                  {showGroup && <div className="ac-group">{item.group}</div>}
                  <div className={`ac-item ${i === hl ? 'hl' : ''}`} role="option" aria-selected={i === hl} onMouseEnter={() => setHl(i)} onClick={() => pick(item)}>
                    <span className="ellipsis">{item.label}</span>
                    {item.hint && <span className="dim small">{item.hint}</span>}
                  </div>
                </div>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}

export function payeeItems(payees: PayeeEntity[], accounts: AccountEntity[], excludeAccount?: string): AcItem[] {
  const accts = new Map(accounts.map(a => [a.id, a]));
  const normal = payees
    .filter(p => !p.transfer_acct)
    .sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name))
    .map(p => ({ id: p.id, label: p.name, group: p.favorite ? 'Favorites' : 'Payees' }));
  normal.sort((a, b) => (a.group === b.group ? 0 : a.group === 'Favorites' ? -1 : 1));
  const transfers = payees
    .filter(p => p.transfer_acct && p.transfer_acct !== excludeAccount && accts.get(p.transfer_acct) && !accts.get(p.transfer_acct)!.closed)
    .map(p => ({ id: p.id, label: `Transfer: ${accts.get(p.transfer_acct!)!.name}`, group: 'Transfer to/from' }));
  return [...normal, ...transfers];
}

export function categoryItems(groups: CategoryGroupEntity[], opts: { includeIncome?: boolean; includeHidden?: boolean } = {}): AcItem[] {
  return groups
    .filter(g => opts.includeIncome !== false || !g.is_income)
    .flatMap(g => g.categories.filter(c => opts.includeHidden || (!c.hidden && !g.hidden)).map(c => ({ id: c.id, label: c.name, group: g.name })));
}

export function accountItems(accounts: AccountEntity[], includeClosed = false): AcItem[] {
  return accounts.filter(a => includeClosed || !a.closed).map(a => ({ id: a.id, label: a.name, group: a.offbudget ? 'Off budget' : 'On budget' }));
}
