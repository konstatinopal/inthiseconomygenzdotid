import { addDays, addMonths, dayOfWeek, daysInMonth, formatDate, parseDate } from './dates';

export type Frequency = 'daily' | 'weekly' | 'monthly' | 'yearly';
export type WeekdayCode = 'SU' | 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA';

export interface RecurPattern {
  /** 'day' = day of month (value 1..31, or -1 for the last day); weekday code = nth weekday (value 1..5 or -1 for last). */
  type: 'day' | WeekdayCode;
  value: number;
}

export interface RecurConfig {
  start: string;
  interval: number;
  frequency: Frequency;
  patterns?: RecurPattern[];
  skipWeekend?: boolean;
  weekendSolveMode?: 'before' | 'after';
  endMode?: 'never' | 'after_n_occurrences' | 'on_date';
  endOccurrences?: number;
  endDate?: string;
}

export function isRecurConfig(v: unknown): v is RecurConfig {
  return !!v && typeof v === 'object' && 'frequency' in (v as any) && 'start' in (v as any);
}

const WEEKDAYS: WeekdayCode[] = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function nthWeekday(month: string, weekday: number, n: number): string | null {
  const dim = daysInMonth(month);
  if (n > 0) {
    const first = dayOfWeek(month + '-01');
    const day = 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
    return day <= dim ? `${month}-${String(day).padStart(2, '0')}` : null;
  }
  const last = dayOfWeek(`${month}-${dim}`);
  const day = dim - ((last - weekday + 7) % 7);
  return `${month}-${String(day).padStart(2, '0')}`;
}

function periodDates(cfg: RecurConfig, k: number): string[] {
  const step = k * Math.max(1, cfg.interval || 1);
  const patterns = cfg.patterns?.filter(p => p.value !== 0) ?? [];
  switch (cfg.frequency) {
    case 'daily':
      return [addDays(cfg.start, step)];
    case 'weekly':
      return [addDays(cfg.start, step * 7)];
    case 'yearly': {
      const d = parseDate(cfg.start);
      const y = d.getUTCFullYear() + step;
      const m = d.getUTCMonth() + 1;
      const month = `${y}-${String(m).padStart(2, '0')}`;
      const day = Math.min(d.getUTCDate(), daysInMonth(month));
      return [`${month}-${String(day).padStart(2, '0')}`];
    }
    case 'monthly': {
      const month = addMonths(cfg.start.slice(0, 7), step);
      const dim = daysInMonth(month);
      if (!patterns.length) {
        const day = Math.min(parseInt(cfg.start.slice(8, 10), 10), dim);
        return [`${month}-${String(day).padStart(2, '0')}`];
      }
      const dates = patterns
        .map(p => {
          if (p.type === 'day') {
            const day = p.value === -1 ? dim : Math.min(p.value, dim);
            return `${month}-${String(day).padStart(2, '0')}`;
          }
          return nthWeekday(month, WEEKDAYS.indexOf(p.type), p.value);
        })
        .filter((d): d is string => !!d);
      return Array.from(new Set(dates)).sort();
    }
  }
}

function adjustWeekend(date: string, cfg: RecurConfig): string {
  if (!cfg.skipWeekend) return date;
  const dow = dayOfWeek(date);
  if (dow !== 0 && dow !== 6) return date;
  if (cfg.weekendSolveMode === 'before') return addDays(date, dow === 6 ? -1 : -2);
  return addDays(date, dow === 6 ? 2 : 1);
}

/** Iterate occurrences in order, up to `until` (inclusive). */
export function* iterate(cfg: RecurConfig, until: string): Generator<string> {
  let count = 0;
  const end = cfg.endMode === 'on_date' && cfg.endDate ? cfg.endDate : null;
  for (let k = 0; k < 20000; k++) {
    const dates = periodDates(cfg, k);
    if (dates.length && dates[0] > until && (!dates.length || adjustWeekend(dates[0], cfg) > until)) return;
    for (const raw of dates) {
      if (raw < cfg.start) continue;
      if (end && raw > end) return;
      if (cfg.endMode === 'after_n_occurrences' && count >= (cfg.endOccurrences ?? 1)) return;
      count++;
      const d = adjustWeekend(raw, cfg);
      if (d > until) return;
      yield d;
    }
  }
}

export function getOccurrences(cfg: RecurConfig, from: string, to: string, max = 1000): string[] {
  const out: string[] = [];
  for (const d of iterate(cfg, to)) {
    if (d >= from) out.push(d);
    if (out.length >= max) break;
  }
  return out;
}

/** First occurrence on or after `date`, or null when the schedule has ended. */
export function nextOccurrence(cfg: RecurConfig, date: string): string | null {
  // Search a generous horizon: yearly schedules with large intervals still resolve.
  const horizon = formatDate(new Date(parseDate(date).getTime() + 366 * 86400000 * Math.max(1, cfg.interval || 1) * 2));
  for (const d of iterate(cfg, horizon)) if (d >= date) return d;
  return null;
}

export function describeRecurrence(cfg: RecurConfig): string {
  const n = Math.max(1, cfg.interval || 1);
  const unit = { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' }[cfg.frequency];
  let s = n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`;
  if (cfg.frequency === 'monthly' && cfg.patterns?.length) {
    const ord = (v: number) => (v === -1 ? 'last' : v + (['th', 'st', 'nd', 'rd'][(v % 100 > 10 && v % 100 < 14) || v % 10 > 3 ? 0 : v % 10]));
    s +=
      ' on the ' +
      cfg.patterns
        .map(p => (p.type === 'day' ? (p.value === -1 ? 'last day' : ord(p.value)) : `${ord(p.value)} ${p.type}`))
        .join(', ');
  } else if (cfg.frequency === 'weekly') {
    s += ' on ' + ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dayOfWeek(cfg.start)];
  } else if (cfg.frequency === 'monthly') {
    s += ' on the ' + parseInt(cfg.start.slice(8), 10) + ['th', 'st', 'nd', 'rd'][parseInt(cfg.start.slice(8), 10) % 10 > 3 || [11, 12, 13].includes(parseInt(cfg.start.slice(8), 10)) ? 0 : parseInt(cfg.start.slice(8), 10) % 10];
  }
  if (cfg.endMode === 'after_n_occurrences') s += `, ${cfg.endOccurrences} times`;
  if (cfg.endMode === 'on_date' && cfg.endDate) s += `, until ${cfg.endDate}`;
  if (cfg.skipWeekend) s += ` (${cfg.weekendSolveMode === 'before' ? 'before' : 'after'} weekends)`;
  return s;
}
