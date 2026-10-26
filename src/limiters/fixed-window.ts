import { ALLOWED, denied, type LimitResult, type WindowConfig } from './types.ts';

export const windowStartOf = (nowMs: number, windowMs: number): number =>
  Math.floor(nowMs / windowMs) * windowMs;

export class FixedWindowLimiter {
  readonly #config: WindowConfig;
  readonly #counts = new Map<string, number>();
  #windowStart = 0;

  constructor(config: WindowConfig) {
    this.#config = config;
  }

  get trackedKeys(): number {
    return this.#counts.size;
  }

  hit(key: string, nowMs = Date.now()): LimitResult {
    const { limit, windowMs } = this.#config;
    const windowStart = windowStartOf(nowMs, windowMs);

    // Windows are aligned for all keys, so a new window makes every stored count stale.
    if (windowStart !== this.#windowStart) {
      this.#windowStart = windowStart;
      this.#counts.clear();
    }

    const count = this.#counts.get(key) ?? 0;
    if (count >= limit) return denied(windowStart + windowMs - nowMs);

    this.#counts.set(key, count + 1);
    return ALLOWED;
  }
}
