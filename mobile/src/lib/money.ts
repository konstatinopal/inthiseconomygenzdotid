// Money is integer cents everywhere (the engine's rule); format only for display.

export interface MoneyPrefs {
  currencySymbol?: string;
  hideFraction?: boolean;
  numberFormat?: string;
}

const LOCALE = 'id-ID';

/** Full amount for details and totals: "Rp25.000" / "-Rp1.250.000". */
export function formatMoney(cents: number, prefs: MoneyPrefs = {}, opts: { sign?: boolean } = {}) {
  const units = cents / 100;
  const decimals = prefs.hideFraction || Number.isInteger(units) ? 0 : 2;
  const n = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(Math.abs(units));
  const symbol = prefs.currencySymbol ?? 'Rp';
  const sign = cents < 0 ? '-' : opts.sign && cents > 0 ? '+' : '';
  return `${sign}${symbol}${n}`;
}

/** Compact amount for tight spaces: "Rp25rb", "Rp1,2jt". */
export function formatShort(cents: number, prefs: MoneyPrefs = {}) {
  const units = Math.abs(cents / 100);
  const symbol = prefs.currencySymbol ?? 'Rp';
  const sign = cents < 0 ? '-' : '';
  const fmt = (v: number) => new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 }).format(v);
  if (units >= 1_000_000_000) return `${sign}${symbol}${fmt(units / 1_000_000_000)}M`;
  if (units >= 1_000_000) return `${sign}${symbol}${fmt(units / 1_000_000)}jt`;
  if (units >= 10_000) return `${sign}${symbol}${fmt(units / 1_000)}rb`;
  return formatMoney(cents, prefs);
}

/**
 * Parses what the keypad (or a person) typed into cents:
 * "25000", "25.000", "25rb", "1,5jt", "12.5k", "50000+25000".
 */
export function parseAmountInput(text: string): number | null {
  const s = text.trim().toLowerCase().replace(/\s/g, '');
  if (!s) return null;
  let total = 0;
  for (const part of s.split('+')) {
    const m = part.match(/^(\d+(?:[.,]\d+)*)(rb|ribu|k|jt|juta|m)?$/);
    if (!m) return null;
    let num = m[1];
    const unit = m[2];
    if (unit) num = num.replace(',', '.');
    else if (/^\d{1,3}(\.\d{3})+$/.test(num)) num = num.replace(/\./g, ''); // 25.000 = twenty-five thousand
    else num = num.replace(',', '.');
    const v = parseFloat(num);
    if (!Number.isFinite(v)) return null;
    const mult = unit === 'rb' || unit === 'ribu' || unit === 'k' ? 1e3 : unit === 'jt' || unit === 'juta' || unit === 'm' ? 1e6 : 1;
    total += v * mult;
  }
  return Math.round(total * 100);
}

export function todayISO(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function addDaysISO(date: string, n: number) {
  const d = new Date(date + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return todayISO(d);
}

export function dayLabel(date: string, today = todayISO()) {
  if (date === today) return 'Hari ini';
  if (date === addDaysISO(today, -1)) return 'Kemarin';
  return new Date(date + 'T00:00:00').toLocaleDateString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short' });
}

export function monthTitle(period: string) {
  const [y, m] = period.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(LOCALE, { month: 'long', year: 'numeric' });
}
