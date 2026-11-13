import { Prisma } from '@prisma/client';

/** Fields stored as Postgres DATE — rendered as YYYY-MM-DD instead of a full timestamp. */
const DATE_ONLY_KEYS = new Set(['date', 'startDate', 'measuredOn']);

/**
 * Reply serializer: Prisma Decimal -> number, BigInt -> number, DATE columns -> YYYY-MM-DD.
 * Uses `this[key]` (the raw value, before toJSON) so Decimals/Dates can be detected.
 */
export function toJSON(payload: unknown): string {
  return JSON.stringify(payload, function (this: Record<string, unknown>, key: string, value: unknown) {
    const raw = this[key];
    if (raw instanceof Prisma.Decimal) return raw.toNumber();
    if (typeof value === 'bigint') return Number(value);
    if (raw instanceof Date && DATE_ONLY_KEYS.has(key)) return raw.toISOString().slice(0, 10);
    return value;
  });
}
