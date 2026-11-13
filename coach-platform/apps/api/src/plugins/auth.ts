import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Role } from '@prisma/client';
import { env } from '../config/env';
import { Errors } from '../lib/errors';
import type { AuthUser, JwtPayload } from '../types';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtPayload;
    user: AuthUser;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRole: (...roles: Role[]) => (req: FastifyRequest) => Promise<void>;
  }
}

export default fp(async (app) => {
  await app.register(jwt, {
    secret: env.JWT_SECRET,
    sign: { expiresIn: env.ACCESS_TOKEN_TTL },
    formatUser: (p) => ({ id: p.sub, orgId: p.org, role: p.role }),
  });

  app.decorate('authenticate', async (req: FastifyRequest) => {
    try {
      await req.jwtVerify();
    } catch {
      throw Errors.unauthorized('Invalid or expired access token');
    }
  });

  app.decorate('requireRole', (...roles: Role[]) => async (req: FastifyRequest) => {
    if (!roles.includes(req.user.role)) throw Errors.forbidden();
  });
});
