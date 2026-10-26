import { readFileSync } from 'node:fs';
import type { Redis, Result } from 'ioredis';
import { ALLOWED, type BucketConfig, denied, type LimitResult } from './types.ts';

declare module 'ioredis' {
  interface RedisCommander<Context> {
    takeToken(key: string, ratePerSec: number, burst: number): Result<[number, number], Context>;
  }
}

const TAKE_TOKEN_LUA = readFileSync(new URL('./token-bucket.lua', import.meta.url), 'utf8');

export class RedisTokenBucket {
  readonly #redis: Redis;
  readonly #config: BucketConfig;

  constructor(redis: Redis, config: BucketConfig) {
    this.#redis = redis;
    this.#config = config;
    redis.defineCommand('takeToken', { numberOfKeys: 1, lua: TAKE_TOKEN_LUA });
  }

  async take(key: string): Promise<LimitResult> {
    const { ratePerSec, burst } = this.#config;
    const [allowed, retryAfterMs] = await this.#redis.takeToken(
      `rate-limit:robust:${key}`,
      ratePerSec,
      burst,
    );
    return allowed === 1 ? ALLOWED : denied(retryAfterMs);
  }
}
