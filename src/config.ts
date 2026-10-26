import type { BucketConfig, WindowConfig } from './limiters/types.ts';

const readString = (name: string, fallback: string): string => process.env[name] || fallback;

const readPositiveInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
};

export interface Config {
  readonly host: string;
  readonly port: number;
  readonly redisUrl: string;
  readonly instances: number;
}

export interface Limits {
  readonly basic: WindowConfig;
  readonly localGuard: WindowConfig;
  readonly global: BucketConfig;
  readonly fallback: BucketConfig;
  readonly redisCommandTimeoutMs: number;
}

export const config: Config = {
  host: readString('HOST', '0.0.0.0'),
  port: readPositiveInt('PORT', 3001),
  redisUrl: readString('REDIS_URL', 'redis://localhost:6379'),
  instances: readPositiveInt('INSTANCES', 1),
};

const globalBucket: BucketConfig = { ratePerSec: 100, burst: 20 };

export const limits: Limits = {
  basic: { limit: 100, windowMs: 1000 },
  localGuard: { limit: 200, windowMs: 1000 },
  global: globalBucket,
  fallback: {
    ratePerSec: Math.ceil(globalBucket.ratePerSec / config.instances),
    burst: Math.ceil(globalBucket.burst / config.instances),
  },
  redisCommandTimeoutMs: 20,
};
