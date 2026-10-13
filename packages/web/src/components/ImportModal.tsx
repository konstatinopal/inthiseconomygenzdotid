import { useEffect, useMemo, useState } from 'react';
import { DATE_FORMATS, type AccountEntity, type FileFormat, type ImportPreviewRow, type ParsedTransaction } from '@envelope/core';
import { useApp, useAction } from '../lib/app';
import { send } from '../lib/client';
import { Amount, Modal } from './ui';

interface Options {
  delimiter?: string;
  hasHeader: boolean;
  skipStart: number;
  skipEnd: number;
  dateFormat: string | null;
  flipAmount: boolean;
  multiplier: number;
  decimalSep: '.' | ',';
  swapPayeeAndMemo: boolean;
  mapping: Record<string, number | null | string>;
  merge: boolean;
  reimportDeleted: boolean;
}

const DEFAULTS: Options = {
  hasHeader: true,
  skipStart: 0,
  skipEnd: 0,
  dateFormat: null,
  flipAmount: false,
  multiplier: 1,
  decimalSep: '.',
  swapPayeeAndMemo: false,
  mapping: {},
  merge: true,
  reimportDeleted: false,
};

const MAP_FIELDS: [string, string][] = [
  ['date', 'Date'],
  ['payee', 'Payee'],
  ['notes', 'Notes'],
  ['category', 'Category'],
  ['amount', 'Amount'],
  ['inflow', 'Inflow'],
  ['outflow', 'Outflow'],
  ['inOut', 'In/out flag'],
];

export function ImportModal({ account, onClose }: { account: AccountEntity; onClose: () => void }) {
  const { prefs, fmtDate, notify } = useApp();
  const act = useAction();
  const prefKey = `import-${account.id}`;
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [format, setFormat] = useState<FileFormat>('csv');
  const [opts, setOpts] = useState<Options>({ ...DEFAULTS, ...(prefs[prefKey] ?? {}) });
  const [csv, setCsv] = useState<{ header: string[]; rows: string[][]; mapping: any; dateFormat: string | null; total: number } | null>(null);
  const [parsed, setParsed] = useState<{ transactions: ParsedTransaction[]; errors: string[] } | null>(null);
  const [preview, setPreview] = useState<ImportPreviewRow[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);

  const set = (patch: Partial<Options>) => setOpts(o => ({ ...o, ...patch }));

  useEffect(() => {
    if (!file) return;
    send<FileFormat>('import-detect', { filename: file.name, text: file.text }).then(setFormat);
  }, [file]);

  const parseOptions = useMemo(
    () => ({
      delimiter: opts.delimiter,
      hasHeader: opts.hasHeader,
      skipStart: opts.skipStart,
      skipEnd: opts.skipEnd,
      dateFormat: opts.dateFormat,
      flipAmount: opts.flipAmount,
      multiplier: opts.multiplier,
      decimalSep: opts.decimalSep,
      swapPayeeAndMemo: opts.swapPayeeAndMemo,
      mapping: Object.keys(opts.mapping).length ? opts.mapping : undefined,
    }),
    [opts],
  );

  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    (async () => {
      if (format === 'csv' || format === 'tsv') {
        const p = await send('import-csv-preview', { text: file.text, options: { ...parseOptions, delimiter: format === 'tsv' ? '\t' : parseOptions.delimiter } });
        if (cancelled) return;
        setCsv(p);
      } else setCsv(null);
      const r = await send<{ transactions: ParsedTransaction[]; errors: string[] }>('import-parse', { format, text: file.text, options: parseOptions });
      if (cancelled) return;
      setParsed(r);
      const rec = await send<{ preview: ImportPreviewRow[] }>('import-reconcile', {
        account: account.id,
        transactions: r.transactions,
        options: { dryRun: true, merge: opts.merge, reimportDeleted: opts.reimportDeleted },
      });
      if (cancelled) return;
      setPreview(rec.preview);
      setSelected(new Set(rec.preview.filter(p => p.status !== 'skipped').map(p => p.index)));
    })().catch(e => notify('error', e.message));
    return () => {
      cancelled = true;
    };
  }, [file, format, parseOptions, opts.merge, opts.reimportDeleted, account.id, notify]);

  const counts = useMemo(() => {
    const c = { new: 0, matched: 0, skipped: 0 };
    for (const p of preview ?? []) if (selected.has(p.index)) c[p.status === 'skipped' ? 'skipped' : p.status]++;
    return c;
  }, [preview, selected]);

  const doImport = async () => {
    if (!parsed) return;
    setBusy(true);
    const r = await act<{ added: string[]; updated: string[] }>('import-reconcile', {
      account: account.id,
      transactions: parsed.transactions,
      options: { merge: opts.merge, reimportDeleted: opts.reimportDeleted, selected: [...selected] },
    });
    setBusy(false);
    if (!r) return;
    const { mapping, ...rest } = opts;
    await send('pref-set', { id: prefKey, value: { ...rest, mapping: format === 'csv' || format === 'tsv' ? mapping : {} } });
    notify('success', `Imported ${r.added.length} new and updated ${r.updated.length} matched transaction${r.updated.length === 1 ? '' : 's'}`);
    onClose();
  };

  return (
    <Modal
      title={`Import into ${account.name}`}
      size="xwide"
      onClose={onClose}
      footer={
        <>
          {preview && (
            <span className="muted small grow">
              {counts.new} new · {counts.matched} matched (merged) · {preview.length - selected.size} not imported
            </span>
          )}
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!preview || selected.size === 0 || busy} onClick={doImport}>
            Import {selected.size || ''} transaction{selected.size === 1 ? '' : 's'}
          </button>
        </>
      }
    >
      <div className="row wrap">
        <input
          type="file"
          accept=".csv,.tsv,.txt,.ofx,.qfx,.qif,.xml"
          onChange={async e => {
            const f = e.target.files?.[0];
            if (f) setFile({ name: f.name, text: await f.text() });
          }}
          aria-label="Choose file"
        />
        {file && (
          <label className="field">
            Format
            <select value={format} onChange={e => setFormat(e.target.value as FileFormat)}>
              <option value="csv">CSV</option>
              <option value="tsv">TSV</option>
              <option value="ofx">OFX / QFX</option>
              <option value="qif">QIF</option>
              <option value="camt">CAMT.053 (XML)</option>
            </select>
          </label>
        )}
      </div>
      {!file && <p className="muted">Choose a CSV, TSV, OFX, QFX, QIF or CAMT.053 file exported from your bank. Rules run on every new transaction, and duplicates are matched instead of re-added.</p>}

      {file && (format === 'csv' || format === 'tsv') && csv && (
        <div className="card pad col">
          <div className="row wrap">
            {format === 'csv' && (
              <label className="field">
                Delimiter
                <select value={opts.delimiter ?? ''} onChange={e => set({ delimiter: e.target.value || undefined })}>
                  <option value="">Auto</option>
                  <option value=",">Comma</option>
                  <option value=";">Semicolon</option>
                  <option value={'\t'}>Tab</option>
                  <option value="|">Pipe</option>
                </select>
              </label>
            )}
            <label className="field">
              Date format
              <select value={opts.dateFormat ?? ''} onChange={e => set({ dateFormat: e.target.value || null })}>
                <option value="">Detect ({csv.dateFormat ?? 'unknown'})</option>
                {DATE_FORMATS.map(f => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Decimal
              <select value={opts.decimalSep} onChange={e => set({ decimalSep: e.target.value as '.' | ',' })}>
                <option value=".">1,234.56</option>
                <option value=",">1.234,56</option>
              </select>
            </label>
            <label className="field">
              Skip start
              <input type="number" min={0} value={opts.skipStart} onChange={e => set({ skipStart: Number(e.target.value) })} style={{ width: 70 }} />
            </label>
            <label className="field">
              Skip end
              <input type="number" min={0} value={opts.skipEnd} onChange={e => set({ skipEnd: Number(e.target.value) })} style={{ width: 70 }} />
            </label>
            <label className="field">
              Multiplier
              <input type="number" step="any" value={opts.multiplier} onChange={e => set({ multiplier: Number(e.target.value) || 1 })} style={{ width: 80 }} />
            </label>
            <label className="check">
              <input type="checkbox" checked={opts.hasHeader} onChange={e => set({ hasHeader: e.target.checked })} /> Header row
            </label>
            <label className="check">
              <input type="checkbox" checked={opts.flipAmount} onChange={e => set({ flipAmount: e.target.checked })} /> Flip amount
            </label>
          </div>
          <div className="row wrap">
            {MAP_FIELDS.map(([key, label]) => (
              <label key={key} className="field">
                {label}
                <select
                  value={csv.mapping[key] ?? ''}
                  onChange={e => set({ mapping: { ...csv.mapping, ...opts.mapping, [key]: e.target.value === '' ? null : Number(e.target.value) } })}
                >
                  <option value="">—</option>
                  {csv.header.map((h, i) => (
                    <option key={i} value={i}>
                      {h || `Column ${i + 1}`}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            {csv.mapping.inOut !== null && csv.mapping.inOut !== undefined && (
              <label className="field">
                “Out” value
                <input value={(opts.mapping.outValue as string) ?? ''} onChange={e => set({ mapping: { ...csv.mapping, ...opts.mapping, outValue: e.target.value } })} placeholder="e.g. DEBIT" />
              </label>
            )}
          </div>
        </div>
      )}
      {file && format !== 'csv' && format !== 'tsv' && (
        <div className="row wrap">
          <label className="check">
            <input type="checkbox" checked={opts.swapPayeeAndMemo} onChange={e => set({ swapPayeeAndMemo: e.target.checked })} /> Swap payee and memo
          </label>
          {format === 'qif' && (
            <>
              <label className="check">
                <input type="checkbox" checked={opts.flipAmount} onChange={e => set({ flipAmount: e.target.checked })} /> Flip amount
              </label>
              <select value={opts.dateFormat ?? ''} onChange={e => set({ dateFormat: e.target.value || null })} aria-label="Date format">
                <option value="">Detect date format</option>
                {DATE_FORMATS.map(f => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </>
          )}
        </div>
      )}
      {file && (
        <div className="row wrap">
          <label className="check">
            <input type="checkbox" checked={opts.merge} onChange={e => set({ merge: e.target.checked })} /> Merge with existing transactions
          </label>
          <label className="check">
            <input type="checkbox" checked={opts.reimportDeleted} onChange={e => set({ reimportDeleted: e.target.checked })} /> Reimport deleted transactions
          </label>
        </div>
      )}
      {parsed?.errors.length ? (
        <div className="badge warn" style={{ whiteSpace: 'normal' }}>
          {parsed.errors.slice(0, 3).join(' · ')}
          {parsed.errors.length > 3 ? ` (+${parsed.errors.length - 3} more)` : ''}
        </div>
      ) : null}
      {preview && (
        <div style={{ maxHeight: 360, overflow: 'auto' }} className="card">
          <table className="grid">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={selected.size === preview.length}
                    onChange={() => setSelected(selected.size === preview.length ? new Set() : new Set(preview.map(p => p.index)))}
                  />
                </th>
                <th>Status</th>
                <th>Date</th>
                <th>Payee</th>
                <th>Notes</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {preview.map(p => (
                <tr key={p.index} className={selected.has(p.index) ? '' : 'dim'}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(p.index)}
                      onChange={() => {
                        const n = new Set(selected);
                        if (n.has(p.index)) n.delete(p.index);
                        else n.add(p.index);
                        setSelected(n);
                      }}
                      aria-label="Import this row"
                    />
                  </td>
                  <td>
                    <span className={`badge ${p.status === 'new' ? 'pos' : p.status === 'matched' ? 'accent' : 'warn'}`} title={p.reason}>
                      {p.status}
                    </span>
                  </td>
                  <td>{fmtDate(p.transaction.date)}</td>
                  <td className="ellipsis" style={{ maxWidth: 260 }}>
                    {p.transaction.payee_name}
                  </td>
                  <td className="ellipsis dim" style={{ maxWidth: 260 }}>
                    {p.transaction.notes}
                  </td>
                  <td className="num">
                    <Amount value={p.transaction.amount} color />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {preview.length === 0 && <div className="empty">No transactions found in this file.</div>}
        </div>
      )}
    </Modal>
  );
}
