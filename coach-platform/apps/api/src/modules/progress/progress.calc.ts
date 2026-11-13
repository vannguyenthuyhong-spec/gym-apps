import { addDays } from '../../lib/dates';

/**
 * Consecutive days (ending today, or yesterday if today isn't done yet) with ≥1 completed assignment.
 * Pure function — unit-tested without a database.
 */
export function computeStreak(completedDates: Iterable<string>, today: string): number {
  const done = new Set(completedDates);
  let cursor = done.has(today) ? today : addDays(today, -1);
  let streak = 0;
  while (done.has(cursor)) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

/** Adherence = completed / due. `null` when nothing was due (avoid a misleading 0%). */
export function adherence(completed: number, due: number): number | null {
  if (due <= 0) return null;
  return Math.round((completed / due) * 1000) / 1000;
}

export interface MetricPoint {
  date: string;
  value: number;
}

export function summarizeSeries(points: MetricPoint[]) {
  const first = points[0];
  const latest = points[points.length - 1];
  if (!first || !latest) return null;
  return {
    first,
    latest,
    change: Math.round((latest.value - first.value) * 100) / 100,
    min: Math.min(...points.map((p) => p.value)),
    max: Math.max(...points.map((p) => p.value)),
  };
}
