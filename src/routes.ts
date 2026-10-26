import type { FastifyInstance, FastifyReply } from 'fastify';
import type { FixedWindowLimiter } from './limiters/fixed-window.ts';
import type { RobustLimiter } from './limiters/robust-limiter.ts';
import type { LimitResult } from './limiters/types.ts';

declare module 'fastify' {
  interface FastifyRequest {
    apiKey: string;
  }
}

export interface RouteDeps {
  readonly basic: FixedWindowLimiter;
  readonly robust: RobustLimiter;
}

const OK_BODY = { ok: true } as const;

const retryAfterSeconds = (retryAfterMs: number): number =>
  Math.max(1, Math.ceil(retryAfterMs / 1000));

const sendLimitResult = (reply: FastifyReply, result: LimitResult): FastifyReply => {
  if (result.allowed) return reply.send(OK_BODY);

  return reply
    .code(429)
    .header('Retry-After', retryAfterSeconds(result.retryAfterMs))
    .send({ error: 'Too Many Requests' });
};

export const registerRoutes = (app: FastifyInstance, { basic, robust }: RouteDeps): void => {
  app.decorateRequest('apiKey', '');

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Instance', `${request.socket.localAddress}:${request.socket.localPort}`);

    const apiKey = request.headers['x-api-key'];
    if (typeof apiKey !== 'string' || apiKey === '') {
      return reply.code(401).send({ error: 'Missing X-API-Key header' });
    }
    request.apiKey = apiKey;
  });

  app.get('/naive', async () => OK_BODY);

  app.get('/basic', async (request, reply) => sendLimitResult(reply, basic.hit(request.apiKey)));

  app.get('/robust', async (request, reply) => {
    const result = await robust.check(request.apiKey);
    reply.header('X-Limiter-Decision', result.decision);
    return sendLimitResult(reply, result);
  });
};
