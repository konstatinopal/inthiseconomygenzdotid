import { parseAmount } from '../util/amounts';
import type { ParseResult, ParsedTransaction } from './types';

// OFX 1.x is SGML (unclosed tags); 2.x is XML. A tag-value scan handles both.
function tag(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}>([^<\\r\\n]*)`, 'i'));
  return m ? decode(m[1].trim()) : null;
}

function decode(s: string) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function ofxDate(s: string | null): string | null {
  if (!s || s.length < 8) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

export function parseOfx(text: string, opts: { swapPayeeAndMemo?: boolean } = {}): ParseResult {
  const errors: string[] = [];
  const out: ParsedTransaction[] = [];
  const blocks = text.split(/<STMTTRN>/i).slice(1);
  for (const raw of blocks) {
    const block = raw.split(/<\/STMTTRN>/i)[0];
    const date = ofxDate(tag(block, 'DTPOSTED') ?? tag(block, 'DTUSER'));
    const amount = parseAmount(tag(block, 'TRNAMT') ?? '');
    if (!date || amount === null) {
      errors.push('Skipped a transaction with a missing date or amount');
      continue;
    }
    let name = tag(block, 'NAME') ?? tag(block, 'PAYEE');
    let memo = tag(block, 'MEMO');
    if (opts.swapPayeeAndMemo) [name, memo] = [memo, name];
    // Fall back to the memo when the payee is missing.
    const payee = name || memo || null;
    out.push({
      date,
      amount,
      payee_name: payee,
      imported_payee: payee,
      notes: name ? memo : null,
      imported_id: tag(block, 'FITID'),
    });
  }
  if (!blocks.length) errors.push('No transactions found in OFX file');
  return { transactions: out, errors };
}
