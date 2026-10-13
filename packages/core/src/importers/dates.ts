import { isValidDate } from '../util/dates';

export type DateFormat = 'yyyy-mm-dd' | 'yy-mm-dd' | 'mm-dd-yyyy' | 'mm-dd-yy' | 'dd-mm-yyyy' | 'dd-mm-yy';
export const DATE_FORMATS: DateFormat[] = ['yyyy-mm-dd', 'mm-dd-yyyy', 'dd-mm-yyyy', 'yy-mm-dd', 'mm-dd-yy', 'dd-mm-yy'];

/** Parse a date in the given format, accepting any non-digit separator (or none). */
export function parseDateWith(raw: string, fmt: DateFormat): string | null {
  const s = String(raw).trim();
  let parts = s.split(/[^\d]+/).filter(Boolean);
  if (parts.length === 1) {
    const d = parts[0];
    if (fmt.startsWith('yyyy') && d.length === 8) parts = [d.slice(0, 4), d.slice(4, 6), d.slice(6, 8)];
    else if (fmt.endsWith('yyyy') && d.length === 8) parts = [d.slice(0, 2), d.slice(2, 4), d.slice(4, 8)];
    else if (d.length === 6) parts = [d.slice(0, 2), d.slice(2, 4), d.slice(4, 6)];
  }
  if (parts.length < 3) return null;
  const order = fmt.split('-');
  let y = '', m = '', d = '';
  order.forEach((k, i) => {
    if (k.startsWith('y')) y = parts[i];
    else if (k === 'mm') m = parts[i];
    else d = parts[i];
  });
  if (y.length === 2) y = (parseInt(y, 10) > 70 ? '19' : '20') + y;
  if (y.length !== 4) return null;
  const out = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  return isValidDate(out) ? out : null;
}

/** Pick the first format that parses every sample. */
export function detectDateFormat(samples: string[]): DateFormat | null {
  const vals = samples.filter(Boolean).slice(0, 50);
  if (!vals.length) return null;
  return DATE_FORMATS.find(f => vals.every(v => parseDateWith(v, f))) ?? null;
}
