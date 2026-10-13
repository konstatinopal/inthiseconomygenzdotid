import { parseAmount } from '../util/amounts';
import { detectDateFormat, parseDateWith, type DateFormat } from './dates';
import type { ParseResult, ParsedTransaction } from './types';

function normalizeQifDate(s: string) {
  // QIF uses forms like 1/31'26 or 1/31/2026.
  return s.replace(/'/g, '/').replace(/\s/g, '');
}

export function parseQif(
  text: string,
  opts: { dateFormat?: DateFormat | null; swapPayeeAndMemo?: boolean; flipAmount?: boolean } = {},
): ParseResult {
  const errors: string[] = [];
  const records: Record<string, string>[] = [];
  let cur: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('!')) continue;
    if (line === '^') {
      records.push(cur);
      cur = {};
      continue;
    }
    const code = line[0];
    const value = line.slice(1).trim();
    if (code === 'S' || code === '$' || code === 'E') continue; // split lines are not imported as splits
    cur[code] = value;
  }
  if (Object.keys(cur).length) records.push(cur);
  const fmt = opts.dateFormat ?? detectDateFormat(records.map(r => normalizeQifDate(r.D ?? ''))) ?? 'mm-dd-yyyy';
  const out: ParsedTransaction[] = [];
  for (const r of records) {
    const date = parseDateWith(normalizeQifDate(r.D ?? ''), fmt);
    let amount = parseAmount(r.T ?? r.U ?? '');
    if (!date || amount === null) {
      errors.push(`Skipped record with date "${r.D ?? ''}"`);
      continue;
    }
    if (opts.flipAmount) amount = -amount;
    let payee = r.P ?? null;
    let memo = r.M ?? null;
    if (opts.swapPayeeAndMemo) [payee, memo] = [memo, payee];
    out.push({ date, amount, payee_name: payee, imported_payee: payee, notes: memo, category_name: r.L && !r.L.startsWith('[') ? r.L : null });
  }
  return { transactions: out, errors };
}
