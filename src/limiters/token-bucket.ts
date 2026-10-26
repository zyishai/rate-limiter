import { ALLOWED, type BucketConfig, denied, type LimitResult } from './types.ts';

export interface BucketState {
  readonly tokens: number;
  readonly updatedAtMs: number;
}

export const msUntilFull = ({ ratePerSec, burst }: BucketConfig): number =>
  (burst * 1000) / ratePerSec;

export const refill = (
  state: BucketState | undefined,
  nowMs: number,
  { ratePerSec, burst }: BucketConfig,
): number => {
  if (state === undefined) return burst;

  const elapsedMs = Math.max(0, nowMs - state.updatedAtMs);
  return Math.min(burst, state.tokens + (elapsedMs * ratePerSec) / 1000);
};

export const takeToken = (
  state: BucketState | undefined,
  nowMs: number,
  config: BucketConfig,
): { state: BucketState; result: LimitResult } => {
  const tokens = refill(state, nowMs, config);

  if (tokens >= 1) {
    return { state: { tokens: tokens - 1, updatedAtMs: nowMs }, result: ALLOWED };
  }
  return {
    state: { tokens, updatedAtMs: nowMs },
    result: denied(Math.ceil(((1 - tokens) * 1000) / config.ratePerSec)),
  };
};

export class TokenBucketLimiter {
  readonly #config: BucketConfig;
  readonly #buckets = new Map<string, BucketState>();
  #lastSweepMs = 0;

  constructor(config: BucketConfig) {
    this.#config = config;
  }

  get trackedKeys(): number {
    return this.#buckets.size;
  }

  take(key: string, nowMs = Date.now()): LimitResult {
    this.#sweep(nowMs);

    const { state, result } = takeToken(this.#buckets.get(key), nowMs, this.#config);
    this.#buckets.set(key, state);
    return result;
  }

  // A bucket idle for msUntilFull is full again, which is the same as having no entry.
  #sweep(nowMs: number): void {
    const idleMs = msUntilFull(this.#config);
    if (nowMs - this.#lastSweepMs < idleMs) return;

    this.#lastSweepMs = nowMs;
    for (const [key, state] of this.#buckets) {
      if (nowMs - state.updatedAtMs >= idleMs) this.#buckets.delete(key);
    }
  }
}
