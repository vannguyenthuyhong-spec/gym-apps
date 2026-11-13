import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import * as svc from './trainees.service';

const Params = z.object({ traineeId: z.string().uuid() });

export const traineeRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);
  const r = app.withTypeProvider<ZodTypeProvider>();
  const coachOnly = app.requireRole('COACH', 'ADMIN');
  const tags = ['trainees'];

  r.post('/trainees', { preHandler: coachOnly, schema: { tags, body: svc.CreateTraineeBody } }, async (req, reply) =>
    reply.status(201).send(await svc.createTrainee(req.user, req.body)),
  );

  r.get('/trainees', { preHandler: coachOnly, schema: { tags, querystring: svc.ListTraineesQuery } }, async (req) =>
    svc.listTrainees(req.user, req.query),
  );

  r.get('/trainees/:traineeId', { schema: { tags, params: Params } }, async (req) =>
    svc.getTrainee(req.user, req.params.traineeId),
  );

  r.patch(
    '/trainees/:traineeId',
    { preHandler: coachOnly, schema: { tags, params: Params, body: svc.UpdateTraineeBody } },
    async (req) => svc.updateTrainee(req.user, req.params.traineeId, req.body),
  );
};
