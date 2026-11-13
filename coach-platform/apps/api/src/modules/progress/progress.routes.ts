import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import * as svc from './progress.service';

const TraineeParams = z.object({ traineeId: z.string().uuid() });

export const progressRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['progress'];

  r.get(
    '/trainees/:traineeId/progress',
    { schema: { tags, params: TraineeParams, querystring: svc.RangeQuery } },
    async (req) => svc.progressSummary(req.user, req.params.traineeId, req.query.from, req.query.to),
  );

  r.get(
    '/trainees/:traineeId/progress/exercises/:exerciseId',
    {
      schema: {
        tags,
        params: TraineeParams.extend({ exerciseId: z.string().uuid() }),
        querystring: svc.RangeQuery,
      },
    },
    async (req) =>
      svc.exerciseProgress(req.user, req.params.traineeId, req.params.exerciseId, req.query.from, req.query.to),
  );

  r.get(
    '/coach/dashboard',
    { preHandler: app.requireRole('COACH'), schema: { tags, querystring: svc.DashboardQuery } },
    async (req) => svc.coachDashboard(req.user, req.query.date),
  );
};
