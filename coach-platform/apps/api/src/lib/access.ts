import type { TraineeProfile } from '@prisma/client';
import type { AuthUser } from '../types';
import { Errors } from './errors';
import { prisma } from './prisma';

/**
 * Single choke point for "may this user touch this trainee's data?".
 *  - Tenant isolation: trainee must be in the caller's organisation (else 404, no existence leak).
 *  - ADMIN: any trainee in the org.
 *  - COACH: only trainees assigned to them.
 *  - TRAINEE: only themselves, and only when `coachOnly` is not set.
 */
export async function assertTraineeAccess(
  user: AuthUser,
  traineeId: string,
  opts: { coachOnly?: boolean } = {},
): Promise<TraineeProfile> {
  const profile = await prisma.traineeProfile.findUnique({ where: { userId: traineeId } });
  if (!profile || profile.orgId !== user.orgId) throw Errors.notFound('Trainee');

  if (user.role === 'ADMIN') return profile;
  if (user.role === 'COACH' && profile.coachId === user.id) return profile;
  if (user.role === 'TRAINEE' && profile.userId === user.id) {
    if (opts.coachOnly) throw Errors.forbidden('Only the coach can perform this action');
    return profile;
  }
  throw Errors.forbidden();
}

export function assertSelf(user: AuthUser, traineeId: string, what: string): void {
  if (user.id !== traineeId) throw Errors.forbidden(`Only the trainee can ${what}`);
}
