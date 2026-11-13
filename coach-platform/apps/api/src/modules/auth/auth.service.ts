import { createHash, randomBytes, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import type { User } from '@prisma/client';
import { z } from 'zod';
import { env } from '../../config/env';
import { Errors } from '../../lib/errors';
import { prisma, type Tx } from '../../lib/prisma';
import type { JwtPayload } from '../../types';

export const LoginBody = z.object({
  email: z.string().email().max(254).transform((s) => s.toLowerCase()),
  password: z.string().min(1).max(256),
});
export const RefreshBody = z.object({ refreshToken: z.string().min(20).max(256) });

export type SignFn = (payload: JwtPayload) => string;
export interface ClientMeta {
  ip?: string;
  userAgent?: string;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function hashPassword(password: string): Promise<string> {
  // OWASP 2024 baseline for argon2id
  return argon2.hash(password, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
}

let dummyHash: Promise<string> | undefined;
/** Verifying against a dummy hash for unknown emails keeps response time constant (no user enumeration). */
const getDummyHash = () => (dummyHash ??= hashPassword(randomUUID()));

export const publicUser = (u: Pick<User, 'id' | 'orgId' | 'email' | 'fullName' | 'role'>) => ({
  id: u.id,
  orgId: u.orgId,
  email: u.email,
  fullName: u.fullName,
  role: u.role,
});

async function issueTokens(
  user: Pick<User, 'id' | 'orgId' | 'role'>,
  sign: SignFn,
  meta: ClientMeta,
  familyId: string = randomUUID(),
  tx: Tx = prisma,
) {
  const refreshToken = randomBytes(48).toString('base64url');
  await tx.refreshToken.create({
    data: {
      userId: user.id,
      familyId,
      tokenHash: sha256(refreshToken),
      expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
      userAgent: meta.userAgent?.slice(0, 255),
      ip: meta.ip,
    },
  });
  return {
    tokenType: 'Bearer' as const,
    accessToken: sign({ sub: user.id, org: user.orgId, role: user.role }),
    refreshToken,
  };
}

export async function login(input: z.infer<typeof LoginBody>, sign: SignFn, meta: ClientMeta) {
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  const valid = user
    ? await argon2.verify(user.passwordHash, input.password)
    : (await argon2.verify(await getDummyHash(), input.password), false);

  if (!user || !valid || !user.isActive) throw Errors.unauthorized('Invalid email or password');

  const tokens = await issueTokens(user, sign, meta);
  return { ...tokens, user: publicUser(user) };
}

/**
 * Refresh-token rotation with reuse detection: every refresh revokes the presented token and
 * issues a new one in the same family. Presenting an already-revoked token means it was stolen,
 * so the whole family is revoked and the user must log in again.
 */
export async function refresh(token: string, sign: SignFn, meta: ClientMeta) {
  const record = await prisma.refreshToken.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: true },
  });
  if (!record) throw Errors.unauthorized('Invalid refresh token');

  if (record.revokedAt) {
    await prisma.refreshToken.updateMany({
      where: { familyId: record.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    throw Errors.unauthorized('Refresh token reuse detected; please log in again');
  }
  if (record.expiresAt <= new Date() || !record.user.isActive) {
    throw Errors.unauthorized('Refresh token expired');
  }

  return prisma.$transaction(async (tx) => {
    const { count } = await tx.refreshToken.updateMany({
      where: { id: record.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count !== 1) throw Errors.unauthorized('Refresh token already used');
    return issueTokens(record.user, sign, meta, record.familyId, tx);
  });
}

export async function logout(token: string, userId: string): Promise<void> {
  const record = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(token) } });
  if (!record || record.userId !== userId) return;
  await prisma.refreshToken.updateMany({
    where: { familyId: record.familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function me(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { traineeProfile: true },
  });
  if (!user || !user.isActive) throw Errors.unauthorized();
  return { ...publicUser(user), traineeProfile: user.traineeProfile };
}
