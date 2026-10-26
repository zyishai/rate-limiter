import Fastify, { LogController } from 'fastify';
import { config, limits } from './config.ts';
import { FixedWindowLimiter } from './limiters/fixed-window.ts';
import { RedisTokenBucket } from './limiters/redis-token-bucket.ts';
import { RobustLimiter } from './limiters/robust-limiter.ts';
import { TokenBucketLimiter } from './limiters/token-bucket.ts';
import { createRedisClient } from './redis.ts';
import { registerRoutes } from './routes.ts';

const app = Fastify({
  logger: true,
  logController: new LogController({ disableRequestLogging: true }),
});
const redis = createRedisClient(config.redisUrl, limits.redisCommandTimeoutMs);

registerRoutes(app, {
  basic: new FixedWindowLimiter(limits.basic),
  robust: new RobustLimiter({
    localGuard: new TokenBucketLimiter(limits.localGuard),
    global: new RedisTokenBucket(redis, limits.global),
    fallback: new TokenBucketLimiter(limits.fallback),
    logger: app.log,
  }),
});

await app.listen({ host: config.host, port: config.port });
