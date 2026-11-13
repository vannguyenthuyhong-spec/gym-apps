import type { FastifyPluginAsync } from 'fastify';
import { prisma } from '../../lib/prisma';
import { getRedis } from '../../lib/redis';

export const healthRoutes: FastifyPluginAsync = async (app) => {
  const opts = { logLevel: 'warn' as const, config: { rateLimit: false as const }, schema: { hide: true } };

  /** Liveness: the process is up. Never touches dependencies (avoids restart storms). */
  app.get('/healthz', opts, async () => ({ status: 'ok' }));

  /** Readiness: dependencies reachable; pod is removed from the LB otherwise. */
  app.get('/readyz', opts, async (_req, reply) => {
    const checks = await Promise.allSettled([prisma.$queryRaw`SELECT 1`, getRedis().ping()]);
    const [db, redis] = checks.map((c) => (c.status === 'fulfilled' ? 'ok' : 'down'));
    const ok = db === 'ok' && redis === 'ok';
    return reply.status(ok ? 200 : 503).send({ status: ok ? 'ok' : 'degraded', db, redis });
  });
};
