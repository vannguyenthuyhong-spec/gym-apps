import { z } from 'zod';

export const PaginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().uuid().optional(),
});

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Callers fetch `limit + 1` rows; the extra row tells us whether another page exists. */
export function toPage<T>(rows: T[], limit: number, keyOf: (row: T) => string): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? keyOf(last) : null };
}
