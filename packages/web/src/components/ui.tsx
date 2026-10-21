import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { parseAmount } from '@envelope/core';
import { useApp } from '../lib/app';
import { Icon } from './Icon';

export function Modal({
  title,
  onClose,
  children,
  footer,
  size,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'wide' | 'xwide';
}) {
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', fn, true);
    return () => window.removeEventListener('keydown', fn, true);
  }, [onClose]);
  return createPortal(
    <div className="overlay" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${size ?? ''}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
        <div className="modal-head">
          <h2 className="grow">{title}</h2>
          <button className="icon" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export interface MenuItem {
  label: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  divider?: boolean;
  header?: boolean;
}

export function Popover({ anchor, onClose, children, align = 'left' }: { anchor: HTMLElement | null; onClose: () => void; children: ReactNode; align?: 'left' | 'right' }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!anchor || !ref.current) return;
    const r = anchor.getBoundingClientRect();
    const m = ref.current.getBoundingClientRect();
    let left = align === 'right' ? r.right - m.width : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - m.width - 8));
    let top = r.bottom + 4;
    if (top + m.height > window.innerHeight - 8) top = Math.max(8, r.top - m.height - 4);
    setPos({ top, left });
  }, [anchor, align]);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !anchor?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
    };
  }, [anchor, onClose]);
  return createPortal(
    <div ref={ref} className="menu" style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }} role="menu">
      {children}
    </div>,
    document.body,
  );
}

export function MenuButton({
  items,
  children,
  className = 'icon',
  title,
  align,
}: {
  items: MenuItem[] | (() => MenuItem[]);
  children: ReactNode;
  className?: string;
  title?: string;
  align?: 'left' | 'right';
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const list = anchor ? (typeof items === 'function' ? items() : items) : [];
  return (
    <>
      <button className={className} title={title} aria-label={title} aria-haspopup="menu" onClick={e => setAnchor(anchor ? null : e.currentTarget)}>
        {children}
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} align={align}>
          <MenuList items={list} onDone={() => setAnchor(null)} />
        </Popover>
      )}
    </>
  );
}

export function MenuList({ items, onDone }: { items: MenuItem[]; onDone: () => void }) {
  return (
    <>
      {items.map((it, i) =>
        it.divider ? (
          <hr key={i} />
        ) : it.header ? (
          <div key={i} className="label">
            {it.label}
          </div>
        ) : (
          <button
            key={i}
            role="menuitem"
            disabled={it.disabled}
            className={it.danger ? 'danger' : ''}
            onClick={() => {
              onDone();
              it.onClick?.();
            }}
          >
            {it.label}
          </button>
        ),
      )}
    </>
  );
}

/** Formatted money with privacy blur and sign coloring. */
export function Amount({ value, color = false, className = '', sign }: { value: number; color?: boolean; className?: string; sign?: boolean }) {
  const { fmt } = useApp();
  const cls = color ? (value < 0 ? 'neg' : value > 0 ? 'pos' : 'dim') : '';
  return <span className={`amount num ${cls} ${className}`}>{fmt(value, { sign })}</span>;
}

export function AmountInput({
  value,
  onCommit,
  autoFocus,
  placeholder,
  className,
  onKeyDown,
  allowEmpty,
  ariaLabel,
}: {
  value: number | null;
  onCommit: (cents: number | null) => void;
  autoFocus?: boolean;
  placeholder?: string;
  className?: string;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  allowEmpty?: boolean;
  ariaLabel?: string;
}) {
  const { prefs } = useApp();
  const dec = prefs.numberFormat === 'dot-comma' || prefs.numberFormat === 'space-comma' ? ',' : '.';
  const toText = (v: number | null) => (v === null || (allowEmpty && v === 0) ? '' : (v / 100).toFixed(2).replace('.', dec));
  const [text, setText] = useState(toText(value));
  const committed = useRef(value);
  useEffect(() => {
    setText(toText(value));
    committed.current = value;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const commit = () => {
    const v = text.trim() === '' ? (allowEmpty ? null : 0) : parseAmount(text, dec);
    if (v === null && !allowEmpty) {
      setText(toText(committed.current));
      return;
    }
    if (v !== committed.current) {
      committed.current = v;
      onCommit(v);
    }
  };
  return (
    <input
      className={`num ${className ?? ''}`}
      inputMode="decimal"
      value={text}
      placeholder={placeholder}
      autoFocus={autoFocus}
      aria-label={ariaLabel}
      onFocus={e => e.target.select()}
      onChange={e => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') setText(toText(committed.current));
        onKeyDown?.(e);
      }}
    />
  );
}

export function Confirm({
  title,
  message,
  confirmLabel = 'Confirm',
  danger,
  onConfirm,
  onClose,
}: {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button
            className={danger ? 'danger solid' : 'primary'}
            autoFocus
            onClick={() => {
              // Confirm first: closing resolves a pending confirmDialog() with false.
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <div>{message}</div>
    </Modal>
  );
}

/** Imperative confirm dialog, so handlers can `await confirm(...)`. */
let confirmHost: ((req: ConfirmRequest) => void) | null = null;
interface ConfirmRequest {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}

export function confirmDialog(opts: Omit<ConfirmRequest, 'resolve'>): Promise<boolean> {
  return new Promise(resolve => {
    if (!confirmHost) resolve(window.confirm(String(opts.message)));
    else confirmHost({ ...opts, resolve });
  });
}

export function ConfirmHost() {
  const [req, setReq] = useState<ConfirmRequest | null>(null);
  useEffect(() => {
    confirmHost = setReq;
    return () => {
      confirmHost = null;
    };
  }, []);
  if (!req) return null;
  return (
    <Confirm
      title={req.title}
      message={req.message}
      confirmLabel={req.confirmLabel}
      danger={req.danger}
      onConfirm={() => req.resolve(true)}
      onClose={() => {
        req.resolve(false);
        setReq(null);
      }}
    />
  );
}

/** Imperative prompt for a single line of text. */
let promptHost: ((req: PromptRequest) => void) | null = null;
interface PromptRequest {
  title: string;
  label?: string;
  initial?: string;
  type?: string;
  resolve: (v: string | null) => void;
}

export function promptDialog(opts: Omit<PromptRequest, 'resolve'>): Promise<string | null> {
  return new Promise(resolve => {
    if (!promptHost) resolve(window.prompt(opts.title, opts.initial));
    else promptHost({ ...opts, resolve });
  });
}

export function PromptHost() {
  const [req, setReq] = useState<PromptRequest | null>(null);
  const [value, setValue] = useState('');
  useEffect(() => {
    promptHost = r => {
      setValue(r.initial ?? '');
      setReq(r);
    };
    return () => {
      promptHost = null;
    };
  }, []);
  if (!req) return null;
  const done = (v: string | null) => {
    req.resolve(v);
    setReq(null);
  };
  return (
    <Modal
      title={req.title}
      onClose={() => done(null)}
      footer={
        <>
          <button onClick={() => done(null)}>Cancel</button>
          <button className="primary" onClick={() => done(value)}>
            OK
          </button>
        </>
      }
    >
      <label className="field">
        {req.label}
        <input autoFocus type={req.type ?? 'text'} value={value} onChange={e => setValue(e.target.value)} onKeyDown={e => e.key === 'Enter' && done(value)} />
      </label>
    </Modal>
  );
}

export function Toasts() {
  const { toasts, dismiss } = useApp();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map(t => (
        <div key={t.id} className={`toast ${t.level}`}>
          <span className="grow">{t.message}</span>
          {t.action && (
            <button
              className="small"
              onClick={() => {
                t.action!.run();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button className="icon" style={{ color: 'inherit' }} onClick={() => dismiss(t.id)} aria-label="Dismiss">
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Renders note text with #tags highlighted. */
export function NotesText({ text, onTag }: { text: string | null | undefined; onTag?: (tag: string) => void }) {
  if (!text) return null;
  const parts = text.split(/((?:^|\s)#[\p{L}\p{N}_-]+)/u);
  return (
    <>
      {parts.map((p, i) => {
        const m = p.match(/^(\s?)(#[\p{L}\p{N}_-]+)$/u);
        if (!m) return <span key={i}>{p}</span>;
        return (
          <span key={i}>
            {m[1]}
            <span
              className="tag"
              onClick={e => {
                e.stopPropagation();
                onTag?.(m[2]);
              }}
            >
              {m[2]}
            </span>
          </span>
        );
      })}
    </>
  );
}

/** Minimal Markdown renderer for notes: headings, bold, italics, code, links and lists. */
export function Markdown({ text }: { text: string }) {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s: string) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  const html: string[] = [];
  let inList = false;
  for (const line of text.split('\n')) {
    const li = line.match(/^\s*[-*]\s+(.*)$/);
    if (li) {
      if (!inList) html.push('<ul>');
      inList = true;
      html.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    if (inList) {
      html.push('</ul>');
      inList = false;
    }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) html.push(`<h${h[1].length + 2}>${inline(h[2])}</h${h[1].length + 2}>`);
    else if (line.trim()) html.push(`<p>${inline(line)}</p>`);
  }
  if (inList) html.push('</ul>');
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html.join('') }} />;
}
