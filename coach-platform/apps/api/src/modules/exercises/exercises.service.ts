import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { Errors } from '../../lib/errors';
import { PaginationQuery, toPage } from '../../lib/pagination';
import { prisma } from '../../lib/prisma';
import type { AuthUser } from '../../types';

export const TRACKING_FIELDS = ['reps', 'weight_kg', 'duration_sec', 'distance_m', 'rpe'] as const;

export const CreateExerciseBody = z.object({
  name: z.string().trim().min(1).max(120),
  category: z.string().trim().min(1).max(60),
  description: z.string().max(5000).optional(),
  trackingFields: z.array(z.enum(TRACKING_FIELDS)).min(1).max(TRACKING_FIELDS.length).default(['reps']),
  demoMediaId: z.string().uuid().optional(),
});

export const UpdateExerciseBody = CreateExerciseBody.partial().extend({ isArchived: z.boolean().optional() });

export const ListExercisesQuery = PaginationQuery.extend({
  q: z.string().trim().max(100).optional(),
  category: z.string().max(60).optional(),
  includeArchived: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
});

async function assertDemoMedia(orgId: string, mediaId?: string) {
  if (!mediaId) return;
  const m = await prisma.media.findFirst({ where: { id: mediaId, orgId, status: { not: 'DELETED' } } });
  if (!m) throw Errors.unprocessable('demoMediaId not found');
}

export async function listExercises(user: AuthUser, q: z.infer<typeof ListExercisesQuery>) {
  const where: Prisma.ExerciseWhereInput = {
    orgId: user.orgId,
    ...(q.includeArchived ? {} : { isArchived: false }),
    ...(q.category ? { category: q.category } : {}),
    ...(q.q ? { name: { contains: q.q, mode: 'insensitive' } } : {}),
  };
  const rows = await prisma.exercise.findMany({
    where,
    orderBy: { id: 'asc' },
    take: q.limit + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
  });
  return toPage(rows, q.limit, (r) => r.id);
}

export async function createExercise(user: AuthUser, input: z.infer<typeof CreateExerciseBody>) {
  await assertDemoMedia(user.orgId, input.demoMediaId);
  return prisma.exercise.create({ data: { ...input, orgId: user.orgId, createdById: user.id } });
}

export async function updateExercise(user: AuthUser, id: string, input: z.infer<typeof UpdateExerciseBody>) {
  const ex = await prisma.exercise.findFirst({ where: { id, orgId: user.orgId } });
  if (!ex) throw Errors.notFound('Exercise');
  await assertDemoMedia(user.orgId, input.demoMediaId);
  return prisma.exercise.update({ where: { id }, data: input });
}
