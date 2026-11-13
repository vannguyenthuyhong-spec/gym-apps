import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import * as svc from './assignments.service';

const TraineeParams = z.object({ traineeId: z.string().uuid() });
const IdParams = z.object({ id: z.string().uuid() });

export const assignmentRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);
  const r = app.withTypeProvider<ZodTypeProvider>();
  const coachOnly = app.requireRole('COACH', 'ADMIN');
  const tags = ['assignments'];

  r.post(
    '/trainees/:traineeId/assignments',
    { preHandler: coachOnly, schema: { tags, params: TraineeParams, body: svc.CreateAssignmentsBody } },
    async (req, reply) => reply.status(201).send(await svc.createAssignments(req.user, req.params.traineeId, req.body)),
  );

  r.get(
    '/trainees/:traineeId/assignments',
    { schema: { tags, params: TraineeParams, querystring: svc.ListAssignmentsQuery } },
    async (req) => svc.listAssignments(req.user, req.params.traineeId, req.query.from, req.query.to),
  );

  r.get('/assignments/:id', { schema: { tags, params: IdParams } }, async (req) =>
    svc.getAssignment(req.user, req.params.id),
  );

  r.patch('/assignments/:id', { schema: { tags, params: IdParams, body: svc.UpdateAssignmentBody } }, async (req) =>
    svc.updateAssignment(req.user, req.params.id, req.body),
  );

  r.delete('/assignments/:id', { preHandler: coachOnly, schema: { tags, params: IdParams } }, async (req, reply) => {
    await svc.deleteAssignment(req.user, req.params.id);
    return reply.status(204).send();
  });

  r.put(
    '/assignment-items/:id/logs',
    { schema: { tags, params: IdParams, body: svc.UpsertLogsBody } },
    async (req) => svc.upsertLogs(req.user, req.params.id, req.body),
  );

  r.post(
    '/assignments/:id/feedback',
    { preHandler: coachOnly, schema: { tags, params: IdParams, body: svc.CreateFeedbackBody } },
    async (req, reply) => reply.status(201).send(await svc.createFeedback(req.user, req.params.id, req.body)),
  );

  r.get('/assignments/:id/feedback', { schema: { tags, params: IdParams } }, async (req) =>
    svc.listFeedback(req.user, req.params.id),
  );
};
