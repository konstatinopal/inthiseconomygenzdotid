import { parseCamt } from './camt';
import { parseCsv, previewCsv, type CsvOptions } from './csv';
import { parseOfx } from './ofx';
import { parseQif } from './qif';
import type { ParseResult } from './types';
import type { DateFormat } from './dates';

export * from './types';
export { previewCsv, parseCsv, type CsvOptions, type CsvMapping } from './csv';
export { DATE_FORMATS, type DateFormat } from './dates';
export { reconcileTransactions, type ImportOptions, type ImportPreviewRow } from './pipeline';

export type FileFormat = 'csv' | 'tsv' | 'ofx' | 'qfx' | 'qif' | 'camt' | 'xml';

export function detectFormat(filename: string, text: string): FileFormat {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'ofx' || ext === 'qfx' || /<OFX>/i.test(text)) return 'ofx';
  if (ext === 'qif' || /^!Type:/m.test(text)) return 'qif';
  if (ext === 'xml' || /camt\.053/i.test(text)) return 'camt';
  if (ext === 'tsv') return 'tsv';
  return 'csv';
}

export interface ParseOptions extends CsvOptions {
  swapPayeeAndMemo?: boolean;
  dateFormat?: DateFormat | null;
}

export function parseFile(format: FileFormat, text: string, opts: ParseOptions = {}): ParseResult {
  switch (format) {
    case 'ofx':
    case 'qfx':
      return parseOfx(text, opts);
    case 'qif':
      return parseQif(text, opts);
    case 'camt':
    case 'xml':
      return parseCamt(text, opts);
    case 'tsv':
      return parseCsv(text, { ...opts, delimiter: '\t' });
    default:
      return parseCsv(text, opts);
  }
}
