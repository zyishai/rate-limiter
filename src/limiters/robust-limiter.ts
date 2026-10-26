import type { FastifyBaseLogger } from 'fastify';
import type { FixedWindowLimiter } from './fixed-window.ts';
import type { RedisTokenBucket } from './redis-token-bucket.ts';
import type { TokenBucketLimiter } from './token-bucket.ts';
import type { LimitResult } from './types.ts';

export type LimiterDecision = 'local' | 'global' | 'fallback';

export interface RobustResult extends LimitResult {
  readonly decision: LimiterDecision;
}

export interface RobustLimiterDeps {
  readonly localGuard: FixedWindowLimiter;
  readonly global: RedisTokenBucket;
  readonly fallback: TokenBucketLimiter;
  readonly logger: FastifyBaseLogger;
}

export class RobustLimiter {
  readonly #deps: RobustLimiterDeps;
  #inFallback = false;

  constructor(deps: RobustLimiterDeps) {
    this.#deps = deps;
  }

  async check(key: string): Promise<RobustResult> {
    const { localGuard, global, fallback } = this.#deps;

    const local = localGuard.hit(key);
    if (!local.allowed) return { ...local, decision: 'local' };

    try {
      const result = await global.take(key);
      this.#leaveFallback();
      return { ...result, decision: 'global' };
    } catch (error) {
      this.#enterFallback(error);
      return { ...fallback.take(key), decision: 'fallback' };
    }
  }

  #enterFallback(error: unknown): void {
    if (this.#inFallback) return;
    this.#inFallback = true;
    this.#deps.logger.warn({ err: error }, 'Redis unavailable, entering local fallback limiter');
  }

  #leaveFallback(): void {
    if (!this.#inFallback) return;
    this.#inFallback = false;
    this.#deps.logger.info('Redis available again, leaving local fallback limiter');
  }
}
