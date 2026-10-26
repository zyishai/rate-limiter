import { describe, expect, it } from 'vitest';
import { msUntilFull, refill, TokenBucketLimiter, takeToken } from './token-bucket.ts';

const config = { ratePerSec: 100, burst: 20 };

describe('refill', () => {
  it('starts a new bucket full', () => {
    expect(refill(undefined, 0, config)).toBe(20);
  });

  it('adds tokens at the configured rate', () => {
    expect(refill({ tokens: 0, updatedAtMs: 1000 }, 1050, config)).toBe(5);
  });

  it('caps tokens at the burst size', () => {
    expect(refill({ tokens: 10, updatedAtMs: 0 }, 60_000, config)).toBe(20);
  });

  it('ignores a clock that moves backwards', () => {
    expect(refill({ tokens: 3, updatedAtMs: 1000 }, 900, config)).toBe(3);
  });
});

describe('takeToken', () => {
  it('consumes one token when available', () => {
    const { state, result } = takeToken({ tokens: 5, updatedAtMs: 0 }, 0, config);

    expect(result).toEqual({ allowed: true, retryAfterMs: 0 });
    expect(state).toEqual({ tokens: 4, updatedAtMs: 0 });
  });

  it('rejects without consuming when less than one token is left', () => {
    const { state, result } = takeToken({ tokens: 0.5, updatedAtMs: 0 }, 0, config);

    expect(result.allowed).toBe(false);
    expect(state.tokens).toBe(0.5);
  });

  it('reports the time until one full token as retry after', () => {
    expect(takeToken({ tokens: 0, updatedAtMs: 0 }, 0, config).result.retryAfterMs).toBe(10);
    expect(
      takeToken({ tokens: 0.25, updatedAtMs: 0 }, 0, { ratePerSec: 1, burst: 1 }).result
        .retryAfterMs,
    ).toBe(750);
  });
});

describe('msUntilFull', () => {
  it('is the time an empty bucket takes to refill', () => {
    expect(msUntilFull(config)).toBe(200);
  });
});

describe('TokenBucketLimiter', () => {
  it('allows the burst immediately, then throttles to the rate', () => {
    const limiter = new TokenBucketLimiter(config);
    const burst = Array.from({ length: 21 }, () => limiter.take('a', 0).allowed);

    expect(burst.filter(Boolean)).toHaveLength(20);
    expect(burst.at(-1)).toBe(false);
    expect(limiter.take('a', 10).allowed).toBe(true);
    expect(limiter.take('a', 10).allowed).toBe(false);
  });

  it('keeps a bucket per key', () => {
    const limiter = new TokenBucketLimiter({ ratePerSec: 1, burst: 1 });
    limiter.take('a', 0);

    expect(limiter.take('a', 0).allowed).toBe(false);
    expect(limiter.take('b', 0).allowed).toBe(true);
  });

  it('drops buckets that have been idle long enough to refill', () => {
    const limiter = new TokenBucketLimiter(config);
    limiter.take('a', 1000);
    limiter.take('b', 1100);

    limiter.take('c', 1200);
    expect(limiter.trackedKeys).toBe(2);
  });
});
