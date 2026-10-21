// Quick checks for amount parsing and formatting:  npx tsx mobile/src/lib/money.test.mts
import { formatMoney, formatShort, parseAmountInput } from './money.ts';
const cases: [string, number | null][] = [
  ['25000', 2500000], ['25.000', 2500000], ['25rb', 2500000], ['25 rb', 2500000], ['1,5jt', 150000000], ['1.5jt', 150000000],
  ['12.5k', 1250000], ['50000+25000', 7500000], ['2jt+500rb', 250000000], ['1.234.567', 123456700], ['12,50', 1250], ['', null], ['abc', null],
];
let bad = 0;
for (const [input, want] of cases) {
  const got = parseAmountInput(input);
  if (got !== want) { bad++; console.log('FAIL parse', JSON.stringify(input), got, '!=', want); }
}
const fm: [string, string][] = [
  [formatMoney(2500000), 'Rp25.000'], [formatMoney(-125000000), '-Rp1.250.000'], [formatMoney(1250), 'Rp12,50'],
  [formatShort(2500000), 'Rp25rb'], [formatShort(-120000000), '-Rp1,2jt'], [formatShort(500000), 'Rp5.000'],
];
for (const [got, want] of fm) if (got !== want) { bad++; console.log('FAIL format', got, '!=', want); }
console.log(bad ? `${bad} FAILED` : `ALL PASSED (${cases.length + fm.length} checks)`);
process.exit(bad ? 1 : 0);
