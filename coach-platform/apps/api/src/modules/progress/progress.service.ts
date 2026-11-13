import type { AssignmentStatus, Prisma } from '@prisma/client';
import { z } from 'zod';
import { assertTraineeAccess } from '../../lib/access';
import { addDays, assertRange, formatDate, isoDate, parseDate, todayInTz } from '../../lib/dates';
import { Errors } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import type { AuthUser } from '../../types';
import { adherence, computeStreak, summarizeSeries, type MetricPoint } from './progress.calc';

export const RangeQuery = z.object({ from: isoDate, to: isoDate });
export const DashboardQuery = z.object({ date: isoDate.optional() });

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

async function orgToday(orgId: string) {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { timezone: true } });
  return todayInTz(org.timezone);
}

export async function progressSummary(user: AuthUser, traineeId: string, from: string, to: string) {
  assertRange(from, to, 366);
  await assertTraineeAccess(user, traineeId);
  const today = await orgToday(user.orgId);
  const dueTo = to < today ? to : today;
  const range = { gte: parseDate(from), lte: parseDate(to) };

  const [byStatus, completedDays, checkins, metrics, mediaCount] = await Promise.all([
    prisma.assignment.groupBy({
      by: ['status'],
      where: { traineeId, date: { gte: parseDate(from), lte: parseDate(dueTo) } },
      _count: { _all: true },
    }),
    prisma.assignment.findMany({
      where: { traineeId, status: 'COMPLETED', date: { gte: parseDate(addDays(today, -366)), lte: parseDate(today) } },
      select: { date: true },
      distinct: ['date'],
    }),
    prisma.dailyCheckin.aggregate({
      where: { traineeId, date: range },
      _avg: { mood: true, energy: true, soreness: true, sleepHours: true },
      _count: { _all: true },
    }),
    prisma.bodyMetric.findMany({
      where: { traineeId, measuredOn: range },
      orderBy: [{ metricKey: 'asc' }, { measuredOn: 'asc' }],
      select: { metricKey: true, value: true, unit: true, measuredOn: true },
    }),
    prisma.media.count({
      where: {
        traineeId,
        status: { in: ['UPLOADED', 'PROCESSING', 'READY'] },
        createdAt: { gte: parseDate(from), lt: parseDate(addDays(to, 1)) },
      },
    }),
  ]);

  const counts = Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])) as Partial<Record<AssignmentStatus, number>>;
  const due = byStatus.reduce((sum, s) => sum + s._count._all, 0);
  const completed = counts.COMPLETED ?? 0;

  const series = new Map<string, { unit: string; points: MetricPoint[] }>();
  for (const m of metrics) {
    const s = series.get(m.metricKey) ?? { unit: m.unit, points: [] };
    s.points.push({ date: formatDate(m.measuredOn), value: m.value.toNumber() });
    series.set(m.metricKey, s);
  }

  return {
    range: { from, to },
    assignments: {
      due,
      completed,
      inProgress: counts.IN_PROGRESS ?? 0,
      skipped: counts.SKIPPED ?? 0,
      missed: counts.PLANNED ?? 0, // due date passed (or today) and never started
      adherence: adherence(completed, due),
      currentStreakDays: computeStreak(completedDays.map((d) => formatDate(d.date)), today),
    },
    checkins: {
      count: checkins._count._all,
      avgMood: num(checkins._avg.mood),
      avgEnergy: num(checkins._avg.energy),
      avgSoreness: num(checkins._avg.soreness),
      avgSleepHours: num(checkins._avg.sleepHours),
    },
    metrics: [...series.entries()].map(([metricKey, s]) => ({
      metricKey,
      unit: s.unit,
      ...summarizeSeries(s.points),
      series: s.points,
    })),
    mediaCount,
  };
}

type ExerciseDayRow = {
  date: Date;
  sets: bigint;
  total_reps: bigint | null;
  max_weight_kg: Prisma.Decimal | null;
  volume_kg: Prisma.Decimal | null;
  best_e1rm_kg: Prisma.Decimal | null;
  total_duration_sec: bigint | null;
  total_distance_m: bigint | null;
};

/** Per-day aggregates for one exercise: max weight, volume, estimated 1RM (Epley), duration, distance. */
export async function exerciseProgress(user: AuthUser, traineeId: string, exerciseId: string, from: string, to: string) {
  assertRange(from, to, 3 * 366);
  await assertTraineeAccess(user, traineeId);
  const exercise = await prisma.exercise.findFirst({
    where: { id: exerciseId, orgId: user.orgId },
    select: { id: true, name: true, category: true, trackingFields: true },
  });
  if (!exercise) throw Errors.notFound('Exercise');

  const rows = await prisma.$queryRaw<ExerciseDayRow[]>`
    SELECT a.date                                                   AS date,
           COUNT(*)                                                 AS sets,
           SUM(l.reps)                                              AS total_reps,
           MAX(l.weight_kg)                                         AS max_weight_kg,
           SUM(COALESCE(l.reps, 0) * COALESCE(l.weight_kg, 0))      AS volume_kg,
           MAX(l.weight_kg * (1 + COALESCE(l.reps, 1) / 30.0))      AS best_e1rm_kg,
           SUM(l.duration_sec)                                      AS total_duration_sec,
           SUM(l.distance_m)                                        AS total_distance_m
    FROM exercise_logs l
    JOIN assignment_items i ON i.id = l.assignment_item_id
    JOIN assignments a      ON a.id = i.assignment_id
    WHERE l.trainee_id = ${traineeId}::uuid
      AND i.exercise_id = ${exerciseId}::uuid
      AND a.date BETWEEN ${from}::date AND ${to}::date
    GROUP BY a.date
    ORDER BY a.date`;

  const series = rows.map((r) => ({
    date: formatDate(r.date),
    sets: Number(r.sets),
    totalReps: num(r.total_reps),
    maxWeightKg: num(r.max_weight_kg),
    volumeKg: num(r.volume_kg),
    bestE1rmKg: r.best_e1rm_kg === null ? null : Math.round(Number(r.best_e1rm_kg) * 10) / 10,
    totalDurationSec: num(r.total_duration_sec),
    totalDistanceM: num(r.total_distance_m),
  }));

  const best = (pick: (s: (typeof series)[number]) => number | null) =>
    series.reduce<number | null>((acc, s) => {
      const v = pick(s);
      return v !== null && (acc === null || v > acc) ? v : acc;
    }, null);

  return {
    exercise,
    range: { from, to },
    personalRecords: {
      maxWeightKg: best((s) => s.maxWeightKg),
      bestE1rmKg: best((s) => s.bestE1rmKg),
      maxVolumeKg: best((s) => s.volumeKg),
      maxDurationSec: best((s) => s.totalDurationSec),
      maxDistanceM: best((s) => s.totalDistanceM),
    },
    series,
  };
}

/** Coach's "today" screen: who trained, who hasn't, what needs review. */
export async function coachDashboard(user: AuthUser, date?: string) {
  const day = date ?? (await orgToday(user.orgId));
  const coachId = user.id;

  const [trainees, assignments, pendingReview] = await Promise.all([
    prisma.traineeProfile.findMany({
      where: { coachId, status: 'ACTIVE' },
      select: { userId: true, goal: true, user: { select: { fullName: true } } },
      orderBy: { user: { fullName: 'asc' } },
      take: 1000,
    }),
    prisma.assignment.findMany({
      where: { coachId, date: parseDate(day) },
      select: { id: true, traineeId: true, title: true, status: true, completedAt: true },
    }),
    prisma.assignment.findMany({
      where: {
        coachId,
        status: 'COMPLETED',
        completedAt: { gte: new Date(Date.now() - 7 * 86_400_000) },
        feedback: { none: {} },
      },
      select: { id: true, traineeId: true, title: true, date: true, completedAt: true },
      orderBy: { completedAt: 'asc' },
      take: 100,
    }),
  ]);

  const byTrainee = new Map<string, typeof assignments>();
  for (const a of assignments) byTrainee.set(a.traineeId, [...(byTrainee.get(a.traineeId) ?? []), a]);

  const rows = trainees.map((t) => {
    const list = byTrainee.get(t.userId) ?? [];
    const dayStatus =
      list.length === 0
        ? 'REST'
        : list.every((a) => a.status === 'COMPLETED')
          ? 'COMPLETED'
          : list.some((a) => a.status === 'IN_PROGRESS' || a.status === 'COMPLETED')
            ? 'IN_PROGRESS'
            : list.every((a) => a.status === 'SKIPPED')
              ? 'SKIPPED'
              : 'NOT_STARTED';
    return { traineeId: t.userId, fullName: t.user.fullName, goal: t.goal, dayStatus, assignments: list };
  });

  const tally = (s: string) => rows.filter((r) => r.dayStatus === s).length;
  return {
    date: day,
    summary: {
      activeTrainees: rows.length,
      completed: tally('COMPLETED'),
      inProgress: tally('IN_PROGRESS'),
      notStarted: tally('NOT_STARTED'),
      rest: tally('REST'),
      pendingReview: pendingReview.length,
    },
    trainees: rows,
    pendingReview,
  };
}
