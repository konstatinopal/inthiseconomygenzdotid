import { useEffect, useState } from 'react';
import { useAction } from '../lib/app';
import { send } from '../lib/client';
import { Markdown, Modal } from './ui';

export function NotesModal({ id, title, onClose, templates }: { id: string; title: string; onClose: () => void; templates?: boolean }) {
  const [note, setNote] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const act = useAction();
  useEffect(() => {
    send<string | null>('note-get', { id }).then(n => setNote(n ?? ''));
  }, [id]);
  const save = async () => {
    await act('note-set', { id, note: note ?? '' });
    onClose();
  };
  return (
    <Modal
      title={title}
      onClose={onClose}
      size="wide"
      footer={
        <>
          <button className="ghost" onClick={() => setPreview(!preview)}>
            {preview ? 'Edit' : 'Preview'}
          </button>
          <div className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={save}>
            Save notes
          </button>
        </>
      }
    >
      {note === null ? (
        <div className="muted">Loading…</div>
      ) : preview ? (
        <div className="card pad">{note ? <Markdown text={note} /> : <span className="dim">Nothing yet</span>}</div>
      ) : (
        <textarea
          autoFocus
          rows={10}
          value={note}
          onChange={e => setNote(e.target.value)}
          placeholder="Markdown supported"
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void save();
          }}
        />
      )}
      {templates && (
        <details className="small muted">
          <summary>Budget template syntax</summary>
          <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'var(--mono)', fontSize: 12 }}>{`#template 50                          fixed amount each month
#template 50 up to 300                fixed amount, balance capped at 300
#template up to 150                   refill the balance to 150
#template 500 by 2026-12 repeat every year
#template 10 repeat every 2 weeks starting 2026-01-04
#template 10% of all income | of Paycheck | of available funds
#template schedule Internet           fund a schedule over time ("full" = only when due)
#template average 3 months increase 10%
#template copy from 12 months ago
#template remainder 2                 share leftover funds by weight
#template-2 …                         lower priority (runs later)
#goal 1000                            long-term balance goal
#cleanup source | sink 2              end-of-month sweep`}</pre>
        </details>
      )}
    </Modal>
  );
}
