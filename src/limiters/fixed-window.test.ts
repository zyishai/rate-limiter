import { describe, expect, it } from 'vitest';
import { FixedWindowLimiter, windowStartOf } from './fixed-window.ts';

const config = { limit: 3, windowMs: 1000 };

const hitTimes = (limiter: FixedWindowLimiter, key: string, times: number, nowMs: number) =>
  Array.from({ length: times }, () => limiter.hit(key, nowMs).allowed);

describe('windowStartOf', () => {
  it('aligns timestamps to the start of their window', () => {
    expect(windowStartOf(0, 1000)).toBe(0);
    expect(windowStartOf(999, 1000)).toBe(0);
    expect(windowStartOf(1000, 1000)).toBe(1000);
    expect(windowStartOf(2500, 1000)).toBe(2000);
  });
});

describe('FixedWindowLimiter', () => {
  it('allows up to the limit and rejects the rest of the window', () => {
    const limiter = new FixedWindowLimiter(config);

    expect(hitTimes(limiter, 'a', 4, 10_100)).toEqual([true, true, true, false]);
  });

  it('reports the time left in the window as retry after', () => {
    const limiter = new FixedWindowLimiter(config);
    hitTimes(limiter, 'a', 3, 10_100);

    expect(limiter.hit('a', 10_250)).toEqual({ allowed: false, retryAfterMs: 750 });
  });

  it('starts a fresh count at the next window boundary', () => {
    const limiter = new FixedWindowLimiter(config);
    hitTimes(limiter, 'a', 3, 10_999);

    expect(limiter.hit('a', 11_000).allowed).toBe(true);
  });

  it('counts each key separately', () => {
    const limiter = new FixedWindowLimiter(config);
    hitTimes(limiter, 'a', 3, 10_000);

    expect(limiter.hit('b', 10_000).allowed).toBe(true);
  });

  it('drops counts from previous windows', () => {
    const limiter = new FixedWindowLimiter(config);
    limiter.hit('a', 10_000);
    limiter.hit('b', 10_000);
    expect(limiter.trackedKeys).toBe(2);

    limiter.hit('c', 11_000);
    expect(limiter.trackedKeys).toBe(1);
  });
});
