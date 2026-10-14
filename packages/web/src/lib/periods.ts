import { currentPeriod, normalizeStartDay, periodRange } from '@envelope/core';
import { useApp } from './app';

/** The budget's month start day (synced preference; 1 = calendar months). */
export function useStartDay(): number {
  return normalizeStartDay(useApp().prefs.monthStartDay ?? 1);
}

export function useCurrentPeriod(): string {
  return currentPeriod(useStartDay());
}

const short = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** "Oct 25 – Nov 24" for a period, or null when periods are calendar months. */
export function periodRangeLabel(period: string, startDay: number): string | null {
  if (startDay === 1) return null;
  const { start, end } = periodRange(period, startDay);
  return `${short(start)} – ${short(end)}`;
}
