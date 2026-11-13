import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors';

type ErrorBody = { error: { code: string; message: string; details?: unknown } };

const body = (code: string, message: string, details?: unknown): ErrorBody => ({
  error: { code, message, ...(details === undefined ? {} : { details }) },
});

export function errorHandler(err: FastifyError, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof AppError) {
    return reply.status(err.statusCode).send(body(err.code, err.message, err.details));
  }

  if (err instanceof ZodError) {
    return reply.status(400).send(
      body(
        'VALIDATION_ERROR',
        'Invalid request',
        err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      ),
    );
  }

  if (err.validation) {
    return reply.status(400).send(body('VALIDATION_ERROR', err.message, err.validation));
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    switch (err.code) {
      case 'P2002':
        return reply.status(409).send(body('CONFLICT', 'Resource already exists', err.meta?.target));
      case 'P2025':
        return reply.status(404).send(body('NOT_FOUND', 'Resource not found'));
      case 'P2003':
        return reply.status(422).send(body('UNPROCESSABLE', 'Referenced resource does not exist'));
    }
  }

  const status = err.statusCode ?? 500;
  if (status < 500) {
    return reply.status(status).send(body(err.code ?? 'REQUEST_ERROR', err.message));
  }

  req.log.error({ err }, 'Unhandled error');
  return reply.status(500).send(body('INTERNAL', 'Internal server error'));
}
