// Budget periods. With a start day of 1 a period is a calendar month. With a
// start day d (2-28) it runs from the d-th to the day before the next d-th,
// and is named after the month most of its days fall in:
//   d <= 15 -> the month it starts in   (start 10: Oct 10 - Nov 9  = "2026-10")
//   d >= 16 -> the month it ends in     (start 25: Oct 25 - Nov 24 = "2026-11")
// The rule depends only on d, so every month name maps to exactly one period.
import { addDays, addMonths, lastDay, today } from './dates';

export const MIN_START_DAY = 1;
export const MAX_START_DAY = 28;

export function normalizeStartDay(v: unknown): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= MIN_START_DAY && n <= MAX_START_DAY ? n : 1;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The period ("YYYY-MM") a date ("YYYY-MM-DD") belongs to. */
export function periodOf(date: string, startDay = 1): string {
  const d = normalizeStartDay(startDay);
  const month = date.slice(0, 7);
  if (d === 1) return month;
  const day = parseInt(date.slice(8, 10), 10);
  const startMonth = day >= d ? month : addMonths(month, -1);
  return d <= 15 ? startMonth : addMonths(startMonth, 1);
}

/** First and last day (inclusive) of a period. */
export function periodRange(period: string, startDay = 1): { start: string; end: string } {
  const d = normalizeStartDay(startDay);
  if (d === 1) return { start: `${period}-01`, end: lastDay(period) };
  const startMonth = d <= 15 ? period : addMonths(period, -1);
  const start = `${startMonth}-${pad(d)}`;
  const end = addDays(`${addMonths(startMonth, 1)}-${pad(d)}`, -1);
  return { start, end };
}

export function currentPeriod(startDay = 1, now?: Date): string {
  return periodOf(today(now), startDay);
}

/** Days in a period, as "YYYY-MM-DD" strings. */
export function periodDays(period: string, startDay = 1): string[] {
  const { start, end } = periodRange(period, startDay);
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}
