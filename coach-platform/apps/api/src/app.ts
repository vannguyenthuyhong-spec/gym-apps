import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { env } from './config/env';
import { toJSON } from './lib/json';
import { prisma } from './lib/prisma';
import { closeQueues } from './lib/queue';
import { closeRedis, getRedis } from './lib/redis';
import authPlugin from './plugins/auth';
import { errorHandler } from './plugins/error-handler';
import { assignmentRoutes } from './modules/assignments/assignments.routes';
import { authRoutes } from './modules/auth/auth.routes';
import { exerciseRoutes } from './modules/exercises/exercises.routes';
import { healthRoutes } from './modules/health/health.routes';
import { mediaRoutes } from './modules/media/media.routes';
import { progressRoutes } from './modules/progress/progress.routes';
import { traineeRoutes } from './modules/trainees/trainees.routes';
import { trackingRoutes } from './modules/tracking/tracking.routes';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.headers.cookie'],
      ...(env.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
    },
    trustProxy: true,
    bodyLimit: 1_048_576, // media never goes through the API
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setReplySerializer((payload) => toJSON(payload));
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.url} not found` } }),
  );
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: env.CORS_ORIGINS, credentials: true, maxAge: 600 });
  await app.register(rateLimit, {
    global: true,
    max: env.RATE_LIMIT_PER_MIN,
    timeWindow: '1 minute',
    redis: getRedis(),
    nameSpace: 'rl:',
  });

  if (env.ENABLE_DOCS) {
    await app.register(swagger, {
      openapi: {
        info: { title: 'CoachTrack API', version: '1.0.0' },
        components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
        security: [{ bearerAuth: [] }],
      },
      transform: jsonSchemaTransform,
    });
    await app.register(swaggerUi, { routePrefix: '/docs' });
  }

  await app.register(authPlugin);
  await app.register(healthRoutes);

  await app.register(
    async (api) => {
      await api.register(authRoutes);
      await api.register(traineeRoutes);
      await api.register(exerciseRoutes);
      await api.register(assignmentRoutes);
      await api.register(trackingRoutes);
      await api.register(mediaRoutes);
      await api.register(progressRoutes);
    },
    { prefix: '/api/v1' },
  );

  app.addHook('onClose', async () => {
    await Promise.allSettled([prisma.$disconnect(), closeQueues(), closeRedis()]);
  });

  return app;
}
