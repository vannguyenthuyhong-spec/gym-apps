import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { isoDate } from '../../lib/dates';
import * as svc from './tracking.service';

const TraineeParams = z.object({ traineeId: z.string().uuid() });

export const trackingRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.put(
    '/trainees/:traineeId/checkins/:date',
    { schema: { tags: ['checkins'], params: TraineeParams.extend({ date: isoDate }), body: svc.CheckinBody } },
    async (req) => svc.upsertCheckin(req.user, req.params.traineeId, req.params.date, req.body),
  );

  r.get(
    '/trainees/:traineeId/checkins',
    { schema: { tags: ['checkins'], params: TraineeParams, querystring: svc.RangeQuery } },
    async (req) => svc.listCheckins(req.user, req.params.traineeId, req.query.from, req.query.to),
  );

  r.post(
    '/trainees/:traineeId/metrics',
    { schema: { tags: ['metrics'], params: TraineeParams, body: svc.MetricsBody } },
    async (req, reply) => reply.status(201).send(await svc.recordMetrics(req.user, req.params.traineeId, req.body)),
  );

  r.get(
    '/trainees/:traineeId/metrics',
    { schema: { tags: ['metrics'], params: TraineeParams, querystring: svc.MetricsQuery } },
    async (req) => svc.listMetrics(req.user, req.params.traineeId, req.query),
  );
};
