import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { assertTraineeAccess } from '../../lib/access';
import { isoDate, parseDate, todayInTz } from '../../lib/dates';
import { Errors } from '../../lib/errors';
import { PaginationQuery, toPage } from '../../lib/pagination';
import { prisma } from '../../lib/prisma';
import type { AuthUser } from '../../types';
import { hashPassword } from '../auth/auth.service';

export const CreateTraineeBody = z.object({
  email: z.string().email().max(254).transform((s) => s.toLowerCase()),
  fullName: z.string().trim().min(1).max(120),
  tempPassword: z.string().min(8).max(128),
  goal: z.string().max(500).optional(),
  startDate: isoDate.optional(),
  heightCm: z.number().positive().max(300).optional(),
  birthYear: z.number().int().min(1900).max(2100).optional(),
  /** ADMIN only: assign to another coach. */
  coachId: z.string().uuid().optional(),
});

export const UpdateTraineeBody = z
  .object({
    fullName: z.string().trim().min(1).max(120),
    goal: z.string().max(500).nullable(),
    notes: z.string().max(5000).nullable(),
    heightCm: z.number().positive().max(300).nullable(),
    birthYear: z.number().int().min(1900).max(2100).nullable(),
    status: z.enum(['ACTIVE', 'PAUSED', 'ARCHIVED']),
    coachId: z.string().uuid(),
  })
  .partial();

export const ListTraineesQuery = PaginationQuery.extend({
  status: z.enum(['ACTIVE', 'PAUSED', 'ARCHIVED']).optional(),
  q: z.string().trim().max(100).optional(),
});

const userSelect = { select: { email: true, fullName: true, isActive: true } } as const;

async function assertCoachInOrg(orgId: string, coachId: string) {
  const coach = await prisma.user.findFirst({ where: { id: coachId, orgId, role: 'COACH', isActive: true } });
  if (!coach) throw Errors.unprocessable('coachId is not an active coach in this organisation');
}

export async function createTrainee(user: AuthUser, input: z.infer<typeof CreateTraineeBody>) {
  let coachId = user.id;
  if (input.coachId && input.coachId !== user.id) {
    if (user.role !== 'ADMIN') throw Errors.forbidden('Only admins can assign trainees to another coach');
    await assertCoachInOrg(user.orgId, input.coachId);
    coachId = input.coachId;
  }

  const org = await prisma.organization.findUniqueOrThrow({ where: { id: user.orgId } });
  const passwordHash = await hashPassword(input.tempPassword);

  const created = await prisma.user.create({
    data: {
      orgId: user.orgId,
      email: input.email,
      fullName: input.fullName,
      passwordHash,
      role: 'TRAINEE',
      traineeProfile: {
        create: {
          orgId: user.orgId,
          coachId,
          goal: input.goal,
          startDate: parseDate(input.startDate ?? todayInTz(org.timezone)),
          heightCm: input.heightCm,
          birthYear: input.birthYear,
        },
      },
    },
    include: { traineeProfile: true },
  });

  return { id: created.id, email: created.email, fullName: created.fullName, profile: created.traineeProfile };
}

export async function listTrainees(user: AuthUser, q: z.infer<typeof ListTraineesQuery>) {
  const where: Prisma.TraineeProfileWhereInput = {
    orgId: user.orgId,
    ...(user.role === 'COACH' ? { coachId: user.id } : {}),
    ...(q.status ? { status: q.status } : {}),
    ...(q.q ? { user: { fullName: { contains: q.q, mode: 'insensitive' } } } : {}),
  };
  const rows = await prisma.traineeProfile.findMany({
    where,
    include: { user: userSelect },
    orderBy: { userId: 'asc' },
    take: q.limit + 1,
    ...(q.cursor ? { cursor: { userId: q.cursor }, skip: 1 } : {}),
  });
  return toPage(rows, q.limit, (r) => r.userId);
}

export async function getTrainee(user: AuthUser, traineeId: string) {
  await assertTraineeAccess(user, traineeId);
  return prisma.traineeProfile.findUniqueOrThrow({
    where: { userId: traineeId },
    include: { user: userSelect, coach: { select: { id: true, fullName: true } } },
  });
}

export async function updateTrainee(user: AuthUser, traineeId: string, input: z.infer<typeof UpdateTraineeBody>) {
  await assertTraineeAccess(user, traineeId, { coachOnly: true });
  const { fullName, coachId, ...profile } = input;

  if (coachId) {
    if (user.role !== 'ADMIN') throw Errors.forbidden('Only admins can reassign trainees');
    await assertCoachInOrg(user.orgId, coachId);
  }

  // Archiving a trainee also disables their login.
  const userUpdate: Prisma.UserUpdateWithoutTraineeProfileInput = {
    ...(fullName ? { fullName } : {}),
    ...(profile.status ? { isActive: profile.status !== 'ARCHIVED' } : {}),
  };

  return prisma.traineeProfile.update({
    where: { userId: traineeId },
    data: {
      ...profile,
      ...(coachId ? { coach: { connect: { id: coachId } } } : {}),
      ...(Object.keys(userUpdate).length ? { user: { update: userUpdate } } : {}),
    },
    include: { user: userSelect },
  });
}
