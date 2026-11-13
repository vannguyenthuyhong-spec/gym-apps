import type { Logger } from 'pino';
import { prisma } from '../lib/prisma';

export interface OutboxMessage {
  id: bigint;
  type: string;
  payload: Record<string, unknown>;
}

/** Plug a real provider (FCM/APNs, email, Zalo OA...) here. Must be idempotent per message id. */
export interface Notifier {
  dispatch(msg: OutboxMessage): Promise<void>;
}

export const logNotifier = (log: Logger): Notifier => ({
  async dispatch(msg) {
    const recipient =
      msg.type === 'assignment.completed' ? msg.payload.coachId : msg.type === 'feedback.created' ? msg.payload.traineeId : null;
    log.info({ eventId: String(msg.id), type: msg.type, recipient }, 'notify');
  },
});

const BATCH = 100;
const MAX_ATTEMPTS = 10;

/**
 * Polls the outbox with FOR UPDATE SKIP LOCKED, so any number of worker replicas can run safely
 * without double-sending. Returns a stop function for graceful shutdown.
 */
export function startOutboxRelay(log: Logger, notifier: Notifier = logNotifier(log), intervalMs = 2000) {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;

  const drainOnce = () =>
    prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<{ id: bigint; type: string; payload: Record<string, unknown> }[]>`
          SELECT id, type, payload FROM outbox_events
          WHERE processed_at IS NULL AND attempts < ${MAX_ATTEMPTS}
          ORDER BY id
          LIMIT ${BATCH}
          FOR UPDATE SKIP LOCKED`;
        for (const row of rows) {
          try {
            await notifier.dispatch(row);
            await tx.outboxEvent.update({
              where: { id: row.id },
              data: { processedAt: new Date(), attempts: { increment: 1 } },
            });
          } catch (err) {
            log.warn({ err, eventId: String(row.id) }, 'Outbox dispatch failed; will retry');
            await tx.outboxEvent.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });
          }
        }
        return rows.length;
      },
      { timeout: 60_000 },
    );

  const tick = async () => {
    try {
      while (!stopped && (await drainOnce()) === BATCH);
    } catch (err) {
      log.error({ err }, 'Outbox relay error');
    }
    if (!stopped) timer = setTimeout(() => (running = tick()), intervalMs);
  };
  running = tick();

  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await running;
  };
}
