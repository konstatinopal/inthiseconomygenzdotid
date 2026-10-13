// Dates are 'YYYY-MM-DD' strings at the API boundary and integers (YYYYMMDD)
// in SQLite. Months are 'YYYY-MM' strings and integers (YYYYMM). All date
// math is done in UTC so it never shifts across time zones.

export function toDateInt(date: string): number {
  return parseInt(date.replace(/-/g, ''), 10);
}

export function fromDateInt(n: number): string {
  const s = String(n);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

export function toMonthInt(month: string): number {
  return parseInt(month.replace('-', ''), 10);
}

export function fromMonthInt(n: number): string {
  const s = String(n);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}`;
}

function pad(n: number) {
  return String(n).padStart(2, '0');
}

export function parseDate(date: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function formatDate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function today(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

export function currentMonth(): string {
  return monthOf(today());
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${pad((idx % 12) + 1)}`;
}

export function monthRange(start: string, end: string): string[] {
  const out: string[] = [];
  for (let m = start; m <= end; m = addMonths(m, 1)) out.push(m);
  return out;
}

export function addDays(date: string, n: number): string {
  const d = parseDate(date);
  d.setUTCDate(d.getUTCDate() + n);
  return formatDate(d);
}

export function daysInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function firstDay(month: string) {
  return month + '-01';
}

export function lastDay(month: string) {
  return `${month}-${pad(daysInMonth(month))}`;
}

export function diffDays(a: string, b: string): number {
  return Math.round((parseDate(a).getTime() - parseDate(b).getTime()) / 86400000);
}

export function dayOfWeek(date: string): number {
  return parseDate(date).getUTCDay();
}

export function isValidDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  return formatDate(parseDate(date)) === date;
}
