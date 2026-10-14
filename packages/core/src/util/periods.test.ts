import { describe, expect, it } from 'vitest';
import { currentPeriod, normalizeStartDay, periodDays, periodOf, periodRange } from './periods';
import { addMonths } from './dates';

describe('budget periods', () => {
  it('start day 1 is the calendar month', () => {
    expect(periodOf('2026-10-01', 1)).toBe('2026-10');
    expect(periodOf('2026-10-31', 1)).toBe('2026-10');
    expect(periodRange('2026-02', 1)).toEqual({ start: '2026-02-01', end: '2026-02-28' });
  });

  it('start day 25 names each period after the month it mostly covers', () => {
    expect(periodOf('2026-10-24', 25)).toBe('2026-10');
    expect(periodOf('2026-10-25', 25)).toBe('2026-11');
    expect(periodOf('2026-11-24', 25)).toBe('2026-11');
    expect(periodRange('2026-11', 25)).toEqual({ start: '2026-10-25', end: '2026-11-24' });
    // Across a year end, and into a short February.
    expect(periodOf('2026-12-30', 25)).toBe('2027-01');
    expect(periodRange('2027-03', 25)).toEqual({ start: '2027-02-25', end: '2027-03-24' });
  });

  it('start day 10 keeps the starting month name', () => {
    expect(periodOf('2026-10-09', 10)).toBe('2026-09');
    expect(periodOf('2026-10-10', 10)).toBe('2026-10');
    expect(periodRange('2026-10', 10)).toEqual({ start: '2026-10-10', end: '2026-11-09' });
  });

  it('periods tile the calendar with no gaps or overlaps for every start day', () => {
    for (let d = 1; d <= 28; d++) {
      let p = periodOf('2026-01-15', d);
      for (let i = 0; i < 26; i++) {
        const r = periodRange(p, d);
        const next = periodRange(addMonths(p, 1), d);
        const dayAfter = new Date(Date.parse(r.end + 'T00:00:00Z') + 864e5).toISOString().slice(0, 10);
        expect(next.start, `start day ${d}, ${p}`).toBe(dayAfter);
        expect(periodOf(r.start, d)).toBe(p);
        expect(periodOf(r.end, d)).toBe(p);
        p = addMonths(p, 1);
      }
    }
  });

  it('clamps bad start days and lists days', () => {
    expect(normalizeStartDay(31)).toBe(1);
    expect(normalizeStartDay('25')).toBe(25);
    expect(periodDays('2026-11', 25)).toHaveLength(31);
    expect(currentPeriod(25, new Date(2026, 9, 26))).toBe('2026-11');
  });
});
