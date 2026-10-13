import { parseAmount } from '../util/amounts';
import { detectDateFormat, parseDateWith, type DateFormat } from './dates';
import type { ParseResult, ParsedTransaction } from './types';

/** RFC 4180-ish CSV parser handling quotes, escaped quotes and newlines in fields. */
export function parseCsvRows(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

export function detectDelimiter(text: string): string {
  const firstLines = text.split(/\r?\n/).slice(0, 5).join('\n');
  const candidates = [',', ';', '\t', '|'];
  return candidates.map(d => [d, firstLines.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
}

export interface CsvMapping {
  date: number | null;
  payee: number | null;
  notes: number | null;
  category: number | null;
  amount: number | null;
  inflow: number | null;
  outflow: number | null;
  /** Column holding an in/out flag, and the value meaning "out" (e.g. "DEBIT"). */
  inOut: number | null;
  outValue?: string;
}

export interface CsvOptions {
  delimiter?: string;
  hasHeader?: boolean;
  skipStart?: number;
  skipEnd?: number;
  dateFormat?: DateFormat | null;
  flipAmount?: boolean;
  multiplier?: number;
  decimalSep?: '.' | ',';
  mapping?: Partial<CsvMapping>;
}

const GUESS: Record<keyof Omit<CsvMapping, 'outValue'>, RegExp> = {
  date: /date|datum|fecha|posted/i,
  payee: /payee|description|merchant|name|beneficiary|empf|counterparty/i,
  notes: /notes?|memo|reference|details/i,
  category: /category|kategorie/i,
  amount: /^amount$|^amt$|betrag|importe|value|^sum$/i,
  inflow: /inflow|deposit|credit|in$/i,
  outflow: /outflow|payment|debit|withdrawal|out$/i,
  inOut: /type|direction|dr\/cr/i,
};

export function guessMapping(header: string[]): CsvMapping {
  const used = new Set<number>();
  const pick = (re: RegExp) => {
    const i = header.findIndex((h, idx) => !used.has(idx) && re.test(h.trim()));
    if (i >= 0) used.add(i);
    return i >= 0 ? i : null;
  };
  const m: CsvMapping = {
    date: pick(GUESS.date),
    amount: pick(GUESS.amount),
    inflow: null,
    outflow: null,
    payee: pick(GUESS.payee),
    notes: pick(GUESS.notes),
    category: pick(GUESS.category),
    inOut: null,
  };
  if (m.amount === null) {
    m.inflow = pick(GUESS.inflow);
    m.outflow = pick(GUESS.outflow);
  }
  return m;
}

export function previewCsv(text: string, opts: CsvOptions = {}) {
  const delimiter = opts.delimiter ?? detectDelimiter(text);
  let rows = parseCsvRows(text, delimiter);
  rows = rows.slice(opts.skipStart ?? 0, rows.length - (opts.skipEnd ?? 0));
  const hasHeader = opts.hasHeader ?? true;
  const header = hasHeader ? rows[0] ?? [] : (rows[0] ?? []).map((_, i) => `Column ${i + 1}`);
  const data = hasHeader ? rows.slice(1) : rows;
  const mapping = { ...guessMapping(header), ...opts.mapping };
  const dateFormat = opts.dateFormat ?? (mapping.date !== null ? detectDateFormat(data.map(r => r[mapping.date!])) : null);
  return { delimiter, header, rows: data, mapping, dateFormat };
}

export function parseCsv(text: string, opts: CsvOptions = {}): ParseResult {
  const { rows, mapping, dateFormat } = previewCsv(text, opts);
  const errors: string[] = [];
  const out: ParsedTransaction[] = [];
  if (mapping.date === null) return { transactions: [], errors: ['Choose the date column'] };
  if (mapping.amount === null && mapping.inflow === null && mapping.outflow === null)
    return { transactions: [], errors: ['Choose an amount column, or inflow and outflow columns'] };
  if (!dateFormat) return { transactions: [], errors: ['Could not detect the date format; choose one'] };
  const dec = opts.decimalSep ?? '.';
  rows.forEach((r, idx) => {
    const date = parseDateWith(r[mapping.date!] ?? '', dateFormat);
    if (!date) {
      errors.push(`Row ${idx + 1}: invalid date "${r[mapping.date!] ?? ''}"`);
      return;
    }
    let amount: number | null;
    if (mapping.amount !== null) {
      amount = parseAmount(r[mapping.amount] ?? '', dec);
      if (amount !== null && mapping.inOut !== null && mapping.outValue) {
        const flag = (r[mapping.inOut] ?? '').trim().toLowerCase();
        amount = flag === mapping.outValue.trim().toLowerCase() ? -Math.abs(amount) : Math.abs(amount);
      }
    } else {
      const inflow = mapping.inflow !== null ? parseAmount(r[mapping.inflow] ?? '', dec) ?? 0 : 0;
      const outflow = mapping.outflow !== null ? parseAmount(r[mapping.outflow] ?? '', dec) ?? 0 : 0;
      amount = Math.abs(inflow) - Math.abs(outflow);
    }
    if (amount === null) {
      errors.push(`Row ${idx + 1}: invalid amount`);
      return;
    }
    if (opts.multiplier && opts.multiplier !== 1) amount = Math.round(amount * opts.multiplier);
    if (opts.flipAmount) amount = -amount;
    const payee = mapping.payee !== null ? (r[mapping.payee] ?? '').trim() : '';
    out.push({
      date,
      amount,
      payee_name: payee || null,
      imported_payee: payee || null,
      notes: mapping.notes !== null ? (r[mapping.notes] ?? '').trim() || null : null,
      category_name: mapping.category !== null ? (r[mapping.category] ?? '').trim() || null : null,
    });
  });
  return { transactions: out, errors };
}
