import type { ParseResult, ParsedTransaction } from './types';

// ISO 20022 CAMT.053 bank-to-customer statements. Parsed with targeted regexes
// because DOMParser is not available inside Web Workers.
function first(xml: string, path: string[]): string | null {
  let cur = xml;
  for (const t of path) {
    const m = cur.match(new RegExp(`<(?:\\w+:)?${t}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${t}>`));
    if (!m) return null;
    cur = m[1];
  }
  return cur.trim();
}

function all(xml: string, t: string): string[] {
  return Array.from(xml.matchAll(new RegExp(`<(?:\\w+:)?${t}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${t}>`, 'g')), m => m[1]);
}

export function parseCamt(text: string, opts: { swapPayeeAndMemo?: boolean } = {}): ParseResult {
  const errors: string[] = [];
  const out: ParsedTransaction[] = [];
  for (const entry of all(text, 'Ntry')) {
    const amtStr = first(entry, ['Amt']);
    const sign = first(entry, ['CdtDbtInd']);
    const date = (first(entry, ['BookgDt', 'Dt']) ?? first(entry, ['BookgDt', 'DtTm']) ?? first(entry, ['ValDt', 'Dt']))?.slice(0, 10);
    if (!amtStr || !date) {
      errors.push('Skipped an entry with no amount or date');
      continue;
    }
    let amount = Math.round(parseFloat(amtStr) * 100);
    if (sign === 'DBIT') amount = -amount;
    const isCredit = sign === 'CRDT';
    let payee =
      (isCredit ? first(entry, ['RltdPties', 'Dbtr', 'Nm']) ?? first(entry, ['RltdPties', 'Dbtr', 'Pty', 'Nm']) : null) ??
      first(entry, ['RltdPties', 'Cdtr', 'Nm']) ??
      first(entry, ['RltdPties', 'Cdtr', 'Pty', 'Nm']) ??
      first(entry, ['RltdPties', 'Dbtr', 'Nm']);
    let memo = all(entry, 'Ustrd').map(s => s.trim()).join(' ') || first(entry, ['AddtlNtryInf']);
    if (opts.swapPayeeAndMemo) [payee, memo] = [memo, payee];
    out.push({
      date,
      amount,
      payee_name: payee,
      imported_payee: payee,
      notes: memo,
      imported_id: first(entry, ['AcctSvcrRef']) ?? first(entry, ['NtryRef']) ?? null,
    });
  }
  if (!out.length && !errors.length) errors.push('No entries found in CAMT file');
  return { transactions: out, errors };
}
