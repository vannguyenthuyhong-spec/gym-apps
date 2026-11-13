import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import * as svc from './auth.service';

export const authRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const sign: svc.SignFn = (payload) => app.jwt.sign(payload);
  const meta = (req: FastifyRequest): svc.ClientMeta => ({ ip: req.ip, userAgent: req.headers['user-agent'] });
  const strictLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

  r.post(
    '/auth/login',
    { config: strictLimit, schema: { tags: ['auth'], security: [], body: svc.LoginBody } },
    async (req) => svc.login(req.body, sign, meta(req)),
  );

  r.post(
    '/auth/refresh',
    { config: strictLimit, schema: { tags: ['auth'], security: [], body: svc.RefreshBody } },
    async (req) => svc.refresh(req.body.refreshToken, sign, meta(req)),
  );

  r.post(
    '/auth/logout',
    { onRequest: [app.authenticate], schema: { tags: ['auth'], body: svc.RefreshBody } },
    async (req, reply) => {
      await svc.logout(req.body.refreshToken, req.user.id);
      return reply.status(204).send();
    },
  );

  r.get('/me', { onRequest: [app.authenticate], schema: { tags: ['auth'] } }, async (req) => svc.me(req.user.id));
};
