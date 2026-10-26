import { Redis } from 'ioredis';

export const createRedisClient = (url: string, commandTimeoutMs: number): Redis => {
  const redis = new Redis(url, {
    commandTimeout: commandTimeoutMs,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    autoResendUnfulfilledCommands: false,
    // Reconnect within ~1 s of Redis coming back; jitter keeps instances from reconnecting in lockstep.
    retryStrategy: (times) =>
      Math.min(50 * 2 ** (times - 1), 1000) + Math.floor(Math.random() * 100),
  });

  // Connection errors are reported once by the robust limiter when it enters fallback.
  redis.on('error', () => {});

  return redis;
};
