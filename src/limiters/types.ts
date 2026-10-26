export interface LimitResult {
  readonly allowed: boolean;
  readonly retryAfterMs: number;
}

export interface WindowConfig {
  readonly limit: number;
  readonly windowMs: number;
}

export interface BucketConfig {
  readonly ratePerSec: number;
  readonly burst: number;
}

export const ALLOWED: LimitResult = { allowed: true, retryAfterMs: 0 };

export const denied = (retryAfterMs: number): LimitResult => ({ allowed: false, retryAfterMs });
