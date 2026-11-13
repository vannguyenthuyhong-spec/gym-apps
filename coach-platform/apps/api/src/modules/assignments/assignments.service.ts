import type { AttachmentEntity, Prisma } from '@prisma/client';
import { z } from 'zod';
import { assertSelf, assertTraineeAccess } from '../../lib/access';
import { assertRange, formatDate, isoDate, parseDate } from '../../lib/dates';
import { Errors } from '../../lib/errors';
import { emitEvent } from '../../lib/outbox';
import { prisma } from '../../lib/prisma';
import type { AuthUser } from '../../types';
import { attachMedia, mediaForEntities } from '../media/media.service';

const MediaIds = z.array(z.string().uuid()).max(10).optional();

const ItemInput = z.object({
  exerciseId: z.string().uuid(),
  targetSets: z.number().int().min(1).max(50).optional(),
  targetReps: z.number().int().min(1).max(1000).optional(),
  targetWeightKg: z.number().min(0).max(1000).optional(),
  targetDurationSec: z.number().int().min(1).max(86_400).optional(),
  targetDistanceM: z.number().int().min(1).max(1_000_000).optional(),
  instructions: z.string().max(1000).optional(),
});

export const CreateAssignmentsBody = z.object({
  /** Same workout on several days at once — coaches plan a week in one call. */
  dates: z
    .array(isoDate)
    .min(1)
    .max(60)
    .refine((d) => new Set(d).size === d.length, 'dates must be unique'),
  title: z.string().trim().min(1).max(200),
  notes: z.string().max(2000).optional(),
  items: z.array(ItemInput).min(1).max(30),
});

export const ListAssignmentsQuery = z.object({ from: isoDate, to: isoDate });

export const UpdateAssignmentBody = z.object({
  /** Optimistic locking: must equal the version the client last read. */
  version: z.number().int().positive(),
  title: z.string().trim().min(1).max(200).optional(),
  notes: z.string().max(2000).nullable().optional(),
  status: z.enum(['PLANNED', 'IN_PROGRESS', 'COMPLETED', 'SKIPPED']).optional(),
});

export const UpsertLogsBody = z.object({
  sets: z
    .array(
      z.object({
        setIndex: z.number().int().min(1).max(50),
        reps: z.number().int().min(0).max(1000).optional(),
        weightKg: z.number().min(0).max(1000).optional(),
        durationSec: z.number().int().min(0).max(86_400).optional(),
        distanceM: z.number().int().min(0).max(1_000_000).optional(),
        rpe: z.number().int().min(1).max(10).optional(),
        note: z.string().max(500).optional(),
      }),
    )
    .max(50)
    .refine((s) => new Set(s.map((x) => x.setIndex)).size === s.length, 'setIndex must be unique'),
  mediaIds: MediaIds,
});

export const CreateFeedbackBody = z.object({
  body: z.string().trim().min(1).max(5000),
  rating: z.number().int().min(1).max(5).optional(),
  mediaIds: MediaIds,
});

const detailInclude = {
  items: {
    orderBy: { position: 'asc' },
    include: {
      exercise: { select: { id: true, name: true, category: true, trackingFields: true } },
      logs: { orderBy: { setIndex: 'asc' } },
    },
  },
  feedback: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.AssignmentInclude;

async function loadAssignment(user: AuthUser, id: string, opts: { coachOnly?: boolean } = {}) {
  const a = await prisma.assignment.findUnique({ where: { id } });
  if (!a || a.orgId !== user.orgId) throw Errors.notFound('Assignment');
  await assertTraineeAccess(user, a.traineeId, opts);
  return a;
}

export async function createAssignments(user: AuthUser, traineeId: string, input: z.infer<typeof CreateAssignmentsBody>) {
  const trainee = await assertTraineeAccess(user, traineeId, { coachOnly: true });
  if (trainee.status === 'ARCHIVED') throw Errors.conflict('Trainee is archived');

  const exerciseIds = [...new Set(input.items.map((i) => i.exerciseId))];
  const valid = await prisma.exercise.count({
    where: { id: { in: exerciseIds }, orgId: user.orgId, isArchived: false },
  });
  if (valid !== exerciseIds.length) throw Errors.unprocessable('One or more exercises are invalid or archived');

  const items = input.items.map((it, position) => ({ ...it, position }));
  return prisma.$transaction(
    input.dates.map((date) =>
      prisma.assignment.create({
        data: {
          orgId: user.orgId,
          traineeId,
          coachId: trainee.coachId,
          date: parseDate(date),
          title: input.title,
          notes: input.notes,
          items: { create: items },
        },
        include: { items: { orderBy: { position: 'asc' } } },
      }),
    ),
  );
}

export async function listAssignments(user: AuthUser, traineeId: string, from: string, to: string) {
  assertRange(from, to, 92);
  await assertTraineeAccess(user, traineeId);
  return prisma.assignment.findMany({
    where: { traineeId, date: { gte: parseDate(from), lte: parseDate(to) } },
    orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
    include: {
      items: {
        orderBy: { position: 'asc' },
        include: { exercise: { select: { id: true, name: true, category: true } }, _count: { select: { logs: true } } },
      },
      _count: { select: { feedback: true } },
    },
  });
}

export async function getAssignment(user: AuthUser, id: string) {
  await loadAssignment(user, id);
  const a = await prisma.assignment.findUniqueOrThrow({ where: { id }, include: detailInclude });

  const refs: { entityType: AttachmentEntity; entityId: string }[] = [
    { entityType: 'ASSIGNMENT', entityId: a.id },
    ...a.items.map((i) => ({ entityType: 'ASSIGNMENT_ITEM' as const, entityId: i.id })),
    ...a.feedback.map((f) => ({ entityType: 'FEEDBACK' as const, entityId: f.id })),
  ];
  return { ...a, media: await mediaForEntities(refs) };
}

export async function updateAssignment(user: AuthUser, id: string, input: z.infer<typeof UpdateAssignmentBody>) {
  const a = await loadAssignment(user, id);

  if (user.role === 'TRAINEE') {
    if (input.title !== undefined || input.notes !== undefined) {
      throw Errors.forbidden('Trainees can only update the status');
    }
    if (input.status === 'PLANNED') throw Errors.forbidden('Trainees cannot reset an assignment to PLANNED');
  }

  return prisma.$transaction(async (tx) => {
    const data: Prisma.AssignmentUpdateManyMutationInput = {
      version: { increment: 1 },
      title: input.title,
      notes: input.notes,
    };
    if (input.status) {
      data.status = input.status;
      data.completedAt = input.status === 'COMPLETED' ? (a.completedAt ?? new Date()) : null;
    }

    const { count } = await tx.assignment.updateMany({ where: { id, version: input.version }, data });
    if (count === 0) throw Errors.conflict('Assignment was modified by someone else — reload and retry');

    if (input.status === 'COMPLETED' && a.status !== 'COMPLETED') {
      await emitEvent(tx, {
        type: 'assignment.completed',
        payload: { assignmentId: id, traineeId: a.traineeId, coachId: a.coachId, date: formatDate(a.date) },
      });
    }
    return tx.assignment.findUniqueOrThrow({ where: { id } });
  });
}

export async function deleteAssignment(user: AuthUser, id: string): Promise<void> {
  const a = await loadAssignment(user, id, { coachOnly: true });
  const logs = await prisma.exerciseLog.count({ where: { item: { assignmentId: id } } });
  if (a.status !== 'PLANNED' || logs > 0) {
    throw Errors.conflict('Only untouched (PLANNED, no logs) assignments can be deleted; mark it SKIPPED instead');
  }
  await prisma.assignment.delete({ where: { id } });
}

/** PUT semantics: the request is the full list of sets for this item. Idempotent and retry-safe. */
export async function upsertLogs(user: AuthUser, itemId: string, input: z.infer<typeof UpsertLogsBody>) {
  const item = await prisma.assignmentItem.findUnique({ where: { id: itemId }, include: { assignment: true } });
  if (!item || item.assignment.orgId !== user.orgId) throw Errors.notFound('Assignment item');
  await assertTraineeAccess(user, item.assignment.traineeId);
  assertSelf(user, item.assignment.traineeId, 'log their sets');
  if (item.assignment.status === 'SKIPPED') throw Errors.conflict('Assignment was skipped');

  const traineeId = item.assignment.traineeId;
  return prisma.$transaction(
    async (tx) => {
      await tx.exerciseLog.deleteMany({
        where: { assignmentItemId: itemId, setIndex: { notIn: input.sets.map((s) => s.setIndex) } },
      });
      for (const s of input.sets) {
        const values = {
          reps: s.reps ?? null,
          weightKg: s.weightKg ?? null,
          durationSec: s.durationSec ?? null,
          distanceM: s.distanceM ?? null,
          rpe: s.rpe ?? null,
          note: s.note ?? null,
        };
        await tx.exerciseLog.upsert({
          where: { assignmentItemId_setIndex: { assignmentItemId: itemId, setIndex: s.setIndex } },
          create: { ...values, assignmentItemId: itemId, traineeId, setIndex: s.setIndex },
          update: { ...values, loggedAt: new Date() },
        });
      }

      if (input.mediaIds?.length) {
        await attachMedia(tx, {
          orgId: user.orgId,
          traineeId,
          mediaIds: input.mediaIds,
          entityType: 'ASSIGNMENT_ITEM',
          entityId: itemId,
        });
      }

      if (item.assignment.status === 'PLANNED') {
        await tx.assignment.updateMany({
          where: { id: item.assignmentId, status: 'PLANNED' },
          data: { status: 'IN_PROGRESS', version: { increment: 1 } },
        });
      }

      return tx.exerciseLog.findMany({ where: { assignmentItemId: itemId }, orderBy: { setIndex: 'asc' } });
    },
    { timeout: 15_000 },
  );
}

export async function createFeedback(user: AuthUser, assignmentId: string, input: z.infer<typeof CreateFeedbackBody>) {
  const a = await loadAssignment(user, assignmentId, { coachOnly: true });
  return prisma.$transaction(async (tx) => {
    const fb = await tx.feedback.create({
      data: { assignmentId, authorId: user.id, body: input.body, rating: input.rating },
    });
    if (input.mediaIds?.length) {
      await attachMedia(tx, {
        orgId: user.orgId,
        traineeId: a.traineeId,
        mediaIds: input.mediaIds,
        entityType: 'FEEDBACK',
        entityId: fb.id,
      });
    }
    await emitEvent(tx, {
      type: 'feedback.created',
      payload: { feedbackId: fb.id, assignmentId, traineeId: a.traineeId, coachId: a.coachId },
    });
    return fb;
  });
}

export async function listFeedback(user: AuthUser, assignmentId: string) {
  await loadAssignment(user, assignmentId);
  return prisma.feedback.findMany({ where: { assignmentId }, orderBy: { createdAt: 'asc' } });
}
