import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import * as svc from './exercises.service';

export const exerciseRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);
  const r = app.withTypeProvider<ZodTypeProvider>();
  const coachOnly = app.requireRole('COACH', 'ADMIN');
  const tags = ['exercises'];

  r.get('/exercises', { schema: { tags, querystring: svc.ListExercisesQuery } }, async (req) =>
    svc.listExercises(req.user, req.query),
  );

  r.post('/exercises', { preHandler: coachOnly, schema: { tags, body: svc.CreateExerciseBody } }, async (req, reply) =>
    reply.status(201).send(await svc.createExercise(req.user, req.body)),
  );

  r.patch(
    '/exercises/:id',
    {
      preHandler: coachOnly,
      schema: { tags, params: z.object({ id: z.string().uuid() }), body: svc.UpdateExerciseBody },
    },
    async (req) => svc.updateExercise(req.user, req.params.id, req.body),
  );
};
