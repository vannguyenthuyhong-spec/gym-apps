import { z } from 'zod';
import { assertSelf, assertTraineeAccess } from '../../lib/access';
import { addDays, assertRange, isoDate, parseDate, todayInTz } from '../../lib/dates';
import { Errors } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import type { AuthUser } from '../../types';
import { attachMedia, mediaForEntities } from '../media/media.service';

const scale = z.number().int().min(1).max(5);

export const CheckinBody = z.object({
  mood: scale.optional(),
  energy: scale.optional(),
  soreness: scale.optional(),
  sleepHours: z.number().min(0).max(24).optional(),
  note: z.string().max(2000).optional(),
  /** e.g. daily progress photos (front/side/back) */
  mediaIds: z.array(z.string().uuid()).max(10).optional(),
});

export const RangeQuery = z.object({ from: isoDate, to: isoDate });

export const MetricsBody = z.object({
  entries: z
    .array(
      z.object({
        metricKey: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/, 'snake_case key, e.g. weight_kg'),
        value: z.number().min(-100_000).max(100_000),
        unit: z.string().min(1).max(16),
        measuredOn: isoDate,
      }),
    )
    .min(1)
    .max(50),
});

export const MetricsQuery = RangeQuery.extend({ metricKey: z.string().max(42).optional() });

async function orgToday(orgId: string) {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { timezone: true } });
  return todayInTz(org.timezone);
}

export async function upsertCheckin(user: AuthUser, traineeId: string, date: string, input: z.infer<typeof CheckinBody>) {
  await assertTraineeAccess(user, traineeId);
  assertSelf(user, traineeId, 'submit a check-in');
  if (date > (await orgToday(user.orgId))) throw Errors.unprocessable('Cannot check in for a future date');

  const { mediaIds, ...fields } = input;
  const values = {
    mood: fields.mood ?? null,
    energy: fields.energy ?? null,
    soreness: fields.soreness ?? null,
    sleepHours: fields.sleepHours ?? null,
    note: fields.note ?? null,
  };

  return prisma.$transaction(async (tx) => {
    const checkin = await tx.dailyCheckin.upsert({
      where: { traineeId_date: { traineeId, date: parseDate(date) } },
      create: { ...values, traineeId, date: parseDate(date) },
      update: values,
    });
    if (mediaIds?.length) {
      await attachMedia(tx, { orgId: user.orgId, traineeId, mediaIds, entityType: 'CHECKIN', entityId: checkin.id });
    }
    return checkin;
  });
}

export async function listCheckins(user: AuthUser, traineeId: string, from: string, to: string) {
  assertRange(from, to, 366);
  await assertTraineeAccess(user, traineeId);
  const rows = await prisma.dailyCheckin.findMany({
    where: { traineeId, date: { gte: parseDate(from), lte: parseDate(to) } },
    orderBy: { date: 'asc' },
  });
  const media = await mediaForEntities(rows.map((r) => ({ entityType: 'CHECKIN' as const, entityId: r.id })));
  return rows.map((r) => ({ ...r, media: media.filter((m) => m.entityId === r.id).map((m) => m.media) }));
}

export async function recordMetrics(user: AuthUser, traineeId: string, input: z.infer<typeof MetricsBody>) {
  await assertTraineeAccess(user, traineeId);
  const tomorrow = addDays(await orgToday(user.orgId), 1);
  if (input.entries.some((e) => e.measuredOn > tomorrow)) throw Errors.unprocessable('measuredOn is in the future');

  return prisma.$transaction(
    input.entries.map((e) =>
      prisma.bodyMetric.upsert({
        where: {
          traineeId_metricKey_measuredOn: { traineeId, metricKey: e.metricKey, measuredOn: parseDate(e.measuredOn) },
        },
        create: { traineeId, metricKey: e.metricKey, value: e.value, unit: e.unit, measuredOn: parseDate(e.measuredOn), recordedBy: user.id },
        update: { value: e.value, unit: e.unit, recordedBy: user.id },
      }),
    ),
  );
}

export async function listMetrics(user: AuthUser, traineeId: string, q: z.infer<typeof MetricsQuery>) {
  assertRange(q.from, q.to, 3 * 366);
  await assertTraineeAccess(user, traineeId);
  return prisma.bodyMetric.findMany({
    where: {
      traineeId,
      measuredOn: { gte: parseDate(q.from), lte: parseDate(q.to) },
      ...(q.metricKey ? { metricKey: q.metricKey } : {}),
    },
    orderBy: [{ metricKey: 'asc' }, { measuredOn: 'asc' }],
  });
}
