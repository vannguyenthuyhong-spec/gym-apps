import type { Prisma } from '@prisma/client';
import type { Tx } from './prisma';

export type DomainEvent =
  | { type: 'assignment.completed'; payload: { assignmentId: string; traineeId: string; coachId: string; date: string } }
  | { type: 'feedback.created'; payload: { feedbackId: string; assignmentId: string; traineeId: string; coachId: string } };

/**
 * Transactional outbox: written in the SAME transaction as the business change,
 * relayed later by the worker. Guarantees no lost or phantom notifications.
 */
export async function emitEvent(tx: Tx, event: DomainEvent): Promise<void> {
  await tx.outboxEvent.create({
    data: { type: event.type, payload: event.payload as unknown as Prisma.InputJsonValue },
  });
}
