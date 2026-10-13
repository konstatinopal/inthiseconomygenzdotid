import { describe, expect, it } from 'vitest';
import { Clock, Timestamp, merkle } from './index';

describe('HLC', () => {
  it('produces monotonically increasing sortable timestamps', () => {
    let t = 1_700_000_000_000;
    const clock = new Clock({ millis: 0, counter: 0, node: 'aaaaaaaaaaaaaaaa' }, () => t);
    const a = clock.send().toString();
    const b = clock.send().toString();
    t -= 1000; // physical clock goes backwards
    const c = clock.send().toString();
    expect(a.length).toBe(46);
    expect(a < b && b < c).toBe(true);
    expect(Timestamp.parse(c)!.counter).toBe(2);
  });

  it('advances past received remote timestamps', () => {
    const t = 1_700_000_000_000;
    const clock = new Clock({ millis: 0, counter: 0, node: 'aaaaaaaaaaaaaaaa' }, () => t);
    clock.recv(new Timestamp(t + 1000, 5, 'bbbbbbbbbbbbbbbb'));
    const next = clock.send();
    expect(next.millis).toBe(t + 1000);
    expect(next.counter).toBe(7);
  });
});

describe('merkle', () => {
  const ts = (m: number, c = 0, n = 'aaaaaaaaaaaaaaaa') => new Timestamp(m, c, n);

  it('is order independent and diffs to the earliest divergence', () => {
    const base = Date.UTC(2026, 0, 1);
    const all = [ts(base), ts(base + 60_000), ts(base + 5 * 60_000), ts(base + 9 * 60_000, 1)];
    const t1 = merkle.build(all);
    const t2 = merkle.build([...all].reverse());
    expect(t1.hash).toBe(t2.hash);
    expect(merkle.diff(t1, t2)).toBeNull();

    const partial = merkle.build(all.slice(0, 2));
    const d = merkle.diff(t1, partial)!;
    expect(d).toBeLessThanOrEqual(base + 5 * 60_000);
    expect(d).toBeGreaterThan(base + 60_000 - 1);
  });
});
