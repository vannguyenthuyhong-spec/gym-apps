import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import * as svc from './media.service';

const IdParams = z.object({ id: z.string().uuid() });

export const mediaRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['media'];

  r.post('/media/uploads', { schema: { tags, body: svc.InitUploadBody } }, async (req, reply) =>
    reply.status(201).send(await svc.initUpload(req.user, req.body)),
  );

  r.post('/media/:id/parts', { schema: { tags, params: IdParams, body: svc.PresignPartsBody } }, async (req) =>
    svc.presignParts(req.user, req.params.id, req.body.partNumbers),
  );

  r.post('/media/:id/complete', { schema: { tags, params: IdParams, body: svc.CompleteUploadBody } }, async (req, reply) =>
    reply.status(202).send(await svc.completeUpload(req.user, req.params.id, req.body)),
  );

  r.get('/media/:id', { schema: { tags, params: IdParams } }, async (req) => svc.getMedia(req.user, req.params.id));

  r.delete('/media/:id', { schema: { tags, params: IdParams } }, async (req, reply) => {
    await svc.deleteMedia(req.user, req.params.id);
    return reply.status(204).send();
  });

  r.get(
    '/trainees/:traineeId/media',
    { schema: { tags, params: z.object({ traineeId: z.string().uuid() }), querystring: svc.ListMediaQuery } },
    async (req) => svc.listTraineeMedia(req.user, req.params.traineeId, req.query),
  );
};
