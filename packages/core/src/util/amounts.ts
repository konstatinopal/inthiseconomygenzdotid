// Money is always an integer number of minor units (cents).

export function toCents(value: number): number {
  return Math.round(value * 100);
}

export function fromCents(cents: number): number {
  return cents / 100;
}

/**
 * Parse user input like "1,234.56", "-12", "(5.00)", "1.234,56" into cents.
 * Supports simple arithmetic (+ - * /) so "12.50+3" works in amount fields.
 */
export function parseAmount(input: string, decimalSep: '.' | ',' = '.'): number | null {
  let s = String(input).trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[^\d.,+\-*/\s]/g, '');
  if (decimalSep === ',') s = s.replace(/\./g, '').replace(/,/g, '.');
  else s = s.replace(/,/g, '');
  s = s.replace(/\s/g, '');
  if (!s) return null;
  let value: number;
  if (/^[-+]?\d*\.?\d+$/.test(s) || /^[-+]?\d+\.$/.test(s)) {
    value = parseFloat(s);
  } else if (/^[-+*/.\d]+$/.test(s)) {
    value = evalArithmetic(s);
  } else {
    return null;
  }
  if (!isFinite(value)) return null;
  const cents = Math.round(value * 100);
  return negative ? -cents : cents;
}

// Tiny recursive-descent evaluator: no eval().
function evalArithmetic(expr: string): number {
  let i = 0;
  const peek = () => expr[i];
  const num = (): number => {
    let sign = 1;
    while (peek() === '-' || peek() === '+') {
      if (expr[i++] === '-') sign = -sign;
    }
    const start = i;
    while (i < expr.length && /[\d.]/.test(expr[i])) i++;
    const v = parseFloat(expr.slice(start, i));
    if (isNaN(v)) throw new Error('bad number');
    return sign * v;
  };
  const term = (): number => {
    let v = num();
    while (peek() === '*' || peek() === '/') {
      const op = expr[i++];
      const r = num();
      v = op === '*' ? v * r : v / r;
    }
    return v;
  };
  try {
    let v = term();
    while (peek() === '+' || peek() === '-') {
      const op = expr[i++];
      const r = term();
      v = op === '+' ? v + r : v - r;
    }
    if (i !== expr.length) return NaN;
    return v;
  } catch {
    return NaN;
  }
}

export type NumberFormat = 'comma-dot' | 'dot-comma' | 'space-comma' | 'apostrophe-dot' | 'comma-dot-in';

export interface FormatOptions {
  numberFormat?: NumberFormat;
  hideFraction?: boolean;
  currencySymbol?: string;
  symbolPosition?: 'before' | 'after';
  symbolSpace?: boolean;
}

export function separators(fmt: NumberFormat = 'comma-dot'): { thousands: string; decimal: string } {
  switch (fmt) {
    case 'dot-comma':
      return { thousands: '.', decimal: ',' };
    case 'space-comma':
      return { thousands: ' ', decimal: ',' };
    case 'apostrophe-dot':
      return { thousands: '’', decimal: '.' };
    default:
      return { thousands: ',', decimal: '.' };
  }
}

export function formatAmount(cents: number, opts: FormatOptions = {}): string {
  const { thousands, decimal } = separators(opts.numberFormat);
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  let wholeStr: string;
  if (opts.numberFormat === 'comma-dot-in') {
    const s = String(opts.hideFraction ? Math.round(abs / 100) : whole);
    const last3 = s.slice(-3);
    const rest = s.slice(0, -3);
    wholeStr = (rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' : '') + last3;
  } else {
    const w = opts.hideFraction ? Math.round(abs / 100) : whole;
    wholeStr = String(w).replace(/\B(?=(\d{3})+(?!\d))/g, thousands);
  }
  let out = opts.hideFraction ? wholeStr : `${wholeStr}${decimal}${String(frac).padStart(2, '0')}`;
  if (opts.currencySymbol) {
    const sp = opts.symbolSpace ? ' ' : '';
    out = opts.symbolPosition === 'after' ? `${out}${sp}${opts.currencySymbol}` : `${opts.currencySymbol}${sp}${out}`;
  }
  return neg ? `-${out}` : out;
}
