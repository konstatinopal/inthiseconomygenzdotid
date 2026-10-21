import { currentPeriod, normalizeStartDay, periodRange } from '@envelope/core';
import { useEngineState } from '@/engine/provider';

export function useStartDay() {
  return normalizeStartDay(useEngineState().prefs.monthStartDay ?? 1);
}

export function useCurrentPeriod() {
  return currentPeriod(useStartDay());
}

/** "25 Okt – 24 Nov" when the budget month doesn't start on the 1st. */
export function rangeLabel(period: string, startDay: number) {
  if (startDay === 1) return null;
  const { start, end } = periodRange(period, startDay);
  const f = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
  return `${f(start)} – ${f(end)}`;
}
