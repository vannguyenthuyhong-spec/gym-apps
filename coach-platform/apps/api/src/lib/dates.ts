import { z } from 'zod';
import { Errors } from './errors';

const DAY_MS = 86_400_000;

/** Calendar date (no time) as YYYY-MM-DD. Stored in Postgres as DATE. */
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
  }, 'Invalid calendar date');

export const parseDate = (s: string): Date => new Date(`${s}T00:00:00.000Z`);

export const formatDate = (d: Date): string => d.toISOString().slice(0, 10);

export function addDays(iso: string, days: number): string {
  const d = parseDate(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return formatDate(d);
}

export const daysBetween = (from: string, to: string): number =>
  Math.round((parseDate(to).getTime() - parseDate(from).getTime()) / DAY_MS);

/** "Today" as seen by the organisation (training days follow local time, not UTC). */
export function todayInTz(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function assertRange(from: string, to: string, maxDays: number): void {
  if (from > to) throw Errors.badRequest('`from` must be on or before `to`');
  if (daysBetween(from, to) > maxDays) throw Errors.badRequest(`Date range must not exceed ${maxDays} days`);
}
