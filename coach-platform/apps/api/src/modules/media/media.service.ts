import { randomUUID } from 'node:crypto';
import type { AttachmentEntity, Media, MediaKind, MediaStatus, Prisma } from '@prisma/client';
import { z } from 'zod';
import { env } from '../../config/env';
import { assertTraineeAccess } from '../../lib/access';
import { isoDate, parseDate, addDays } from '../../lib/dates';
import { Errors } from '../../lib/errors';
import { PaginationQuery, toPage } from '../../lib/pagination';
import { prisma, type Tx } from '../../lib/prisma';
import { enqueueMedia } from '../../lib/queue';
import { storage } from '../../lib/storage';
import type { AuthUser } from '../../types';

/** Whitelist — anything else is rejected before a URL is ever signed. */
const MIME: Record<string, { kind: MediaKind; ext: string }> = {
  'image/jpeg': { kind: 'IMAGE', ext: 'jpg' },
  'image/png': { kind: 'IMAGE', ext: 'png' },
  'image/webp': { kind: 'IMAGE', ext: 'webp' },
  'image/heic': { kind: 'IMAGE', ext: 'heic' },
  'video/mp4': { kind: 'VIDEO', ext: 'mp4' },
  'video/quicktime': { kind: 'VIDEO', ext: 'mov' },
  'video/webm': { kind: 'VIDEO', ext: 'webm' },
};

const VIEWABLE: MediaStatus[] = ['UPLOADED', 'PROCESSING', 'READY', 'FAILED'];
const ATTACHABLE: MediaStatus[] = ['UPLOADED', 'PROCESSING', 'READY'];

export const InitUploadBody = z.object({
  mimeType: z.string().refine((m) => m in MIME, { message: `mimeType must be one of: ${Object.keys(MIME).join(', ')}` }),
  sizeBytes: z.number().int().positive(),
  /** Subject of the media. Defaults to the caller when the caller is a trainee. */
  traineeId: z.string().uuid().optional(),
  takenAt: z.string().datetime().optional(),
});

export const PresignPartsBody = z.object({
  partNumbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(100),
});

export const CompleteUploadBody = z.object({
  parts: z
    .array(z.object({ partNumber: z.number().int().min(1).max(10_000), etag: z.string().min(1).max(200) }))
    .max(10_000)
    .optional(),
});

export const ListMediaQuery = PaginationQuery.extend({
  kind: z.enum(['IMAGE', 'VIDEO']).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export async function toMediaDTO(m: Media) {
  const viewable = VIEWABLE.includes(m.status);
  const [original, playback, thumbnail] = viewable
    ? await Promise.all([
        storage.presignGet(m.storageKey),
        m.playbackKey ? storage.presignGet(m.playbackKey) : null,
        m.thumbnailKey ? storage.presignGet(m.thumbnailKey) : null,
      ])
    : [null, null, null];
  return {
    id: m.id,
    kind: m.kind,
    status: m.status,
    mimeType: m.mimeType,
    sizeBytes: Number(m.sizeBytes),
    width: m.width,
    height: m.height,
    durationSec: m.durationSec === null ? null : Number(m.durationSec),
    traineeId: m.traineeId,
    uploaderId: m.uploaderId,
    takenAt: m.takenAt,
    createdAt: m.createdAt,
    urls: viewable ? { original, playback, thumbnail, expiresIn: env.PRESIGN_TTL_SEC } : null,
  };
}

/** Load media + enforce read access (trainee-scoped media follows trainee rules; shared media = same org). */
async function loadMediaForUser(user: AuthUser, id: string) {
  const m = await prisma.media.findUnique({ where: { id } });
  if (!m || m.orgId !== user.orgId || m.status === 'DELETED') throw Errors.notFound('Media');
  if (m.traineeId) await assertTraineeAccess(user, m.traineeId);
  return m;
}

async function loadOwnPending(user: AuthUser, id: string) {
  const m = await prisma.media.findUnique({ where: { id } });
  if (!m || m.orgId !== user.orgId || m.status === 'DELETED') throw Errors.notFound('Media');
  if (m.uploaderId !== user.id) throw Errors.forbidden('Only the uploader can complete this upload');
  return m;
}

export async function initUpload(user: AuthUser, input: z.infer<typeof InitUploadBody>) {
  const spec = MIME[input.mimeType];
  if (!spec) throw Errors.unprocessable('Unsupported mimeType');
  const max = spec.kind === 'IMAGE' ? env.MEDIA_MAX_IMAGE_BYTES : env.MEDIA_MAX_VIDEO_BYTES;
  if (input.sizeBytes > max) throw Errors.unprocessable(`File too large; max ${max} bytes for ${spec.kind}`);

  const traineeId = input.traineeId ?? (user.role === 'TRAINEE' ? user.id : undefined);
  if (traineeId) await assertTraineeAccess(user, traineeId);

  const id = randomUUID();
  const now = new Date();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const owner = traineeId ? `trainee/${traineeId}` : 'shared';
  const storageKey = `org/${user.orgId}/${owner}/${now.getUTCFullYear()}/${month}/${id}/original.${spec.ext}`;

  const multipart = input.sizeBytes > env.MULTIPART_THRESHOLD_BYTES;
  const multipartId = multipart ? await storage.createMultipart(storageKey, input.mimeType) : null;

  await prisma.media.create({
    data: {
      id,
      orgId: user.orgId,
      uploaderId: user.id,
      traineeId,
      kind: spec.kind,
      mimeType: input.mimeType,
      sizeBytes: BigInt(input.sizeBytes),
      storageKey,
      multipartId,
      takenAt: input.takenAt ? new Date(input.takenAt) : null,
    },
  });

  if (multipart) {
    return {
      mediaId: id,
      mode: 'multipart' as const,
      partSize: env.MULTIPART_PART_SIZE,
      partCount: Math.ceil(input.sizeBytes / env.MULTIPART_PART_SIZE),
      expiresIn: env.PRESIGN_TTL_SEC,
    };
  }
  return {
    mediaId: id,
    mode: 'single' as const,
    method: 'PUT' as const,
    uploadUrl: await storage.presignPut(storageKey, input.mimeType, input.sizeBytes),
    headers: { 'Content-Type': input.mimeType },
    expiresIn: env.PRESIGN_TTL_SEC,
  };
}

export async function presignParts(user: AuthUser, id: string, partNumbers: number[]) {
  const m = await loadOwnPending(user, id);
  if (m.status !== 'PENDING_UPLOAD' || !m.multipartId) throw Errors.conflict('Media is not awaiting a multipart upload');
  const partCount = Math.ceil(Number(m.sizeBytes) / env.MULTIPART_PART_SIZE);
  const invalid = partNumbers.filter((n) => n > partCount);
  if (invalid.length) throw Errors.badRequest(`Part numbers exceed partCount (${partCount})`, invalid);

  const uploadId = m.multipartId;
  const parts = await Promise.all(
    [...new Set(partNumbers)].map(async (partNumber) => ({
      partNumber,
      url: await storage.presignPart(m.storageKey, uploadId, partNumber),
    })),
  );
  return { parts, expiresIn: env.PRESIGN_TTL_SEC };
}

/** Idempotent: calling twice returns the current state and never enqueues twice. */
export async function completeUpload(user: AuthUser, id: string, input: z.infer<typeof CompleteUploadBody>) {
  const m = await loadOwnPending(user, id);
  if (m.status !== 'PENDING_UPLOAD') return toMediaDTO(m);

  if (m.multipartId) {
    if (!input.parts?.length) throw Errors.badRequest('parts are required to complete a multipart upload');
    await storage.completeMultipart(m.storageKey, m.multipartId, input.parts);
  }

  const head = await storage.head(m.storageKey);
  if (!head) throw Errors.unprocessable('File not found in storage — upload it before completing');
  if (head.size !== Number(m.sizeBytes)) {
    await storage.deleteObjects([m.storageKey]);
    await prisma.media.update({
      where: { id },
      data: { status: 'FAILED', errorMessage: `Size mismatch: declared ${m.sizeBytes}, got ${head.size}` },
    });
    throw Errors.unprocessable('Uploaded size does not match declared size');
  }

  const { count } = await prisma.media.updateMany({
    where: { id, status: 'PENDING_UPLOAD' },
    data: { status: 'UPLOADED', multipartId: null },
  });
  if (count === 1) await enqueueMedia('process', id);

  return toMediaDTO(await prisma.media.findUniqueOrThrow({ where: { id } }));
}

export async function getMedia(user: AuthUser, id: string) {
  return toMediaDTO(await loadMediaForUser(user, id));
}

export async function deleteMedia(user: AuthUser, id: string): Promise<void> {
  const m = await loadMediaForUser(user, id);
  const canDelete =
    m.uploaderId === user.id ||
    user.role === 'ADMIN' ||
    (user.role === 'COACH' && (!m.traineeId || (await assertTraineeAccess(user, m.traineeId, { coachOnly: true }))));
  if (!canDelete) throw Errors.forbidden();

  await prisma.$transaction([
    prisma.mediaAttachment.deleteMany({ where: { mediaId: id } }),
    prisma.media.update({ where: { id }, data: { status: 'DELETED' } }),
  ]);
  await enqueueMedia('delete', id);
}

export async function listTraineeMedia(user: AuthUser, traineeId: string, q: z.infer<typeof ListMediaQuery>) {
  await assertTraineeAccess(user, traineeId);
  const createdAt: Prisma.DateTimeFilter = {};
  if (q.from) createdAt.gte = parseDate(q.from);
  if (q.to) createdAt.lt = parseDate(addDays(q.to, 1));

  const rows = await prisma.media.findMany({
    where: {
      traineeId,
      orgId: user.orgId,
      status: { in: VIEWABLE },
      ...(q.kind ? { kind: q.kind } : {}),
      ...(q.from || q.to ? { createdAt } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: q.limit + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
  });
  const page = toPage(rows, q.limit, (r) => r.id);
  return { items: await Promise.all(page.items.map(toMediaDTO)), nextCursor: page.nextCursor };
}

/** Attach already-uploaded media to a domain entity, inside the caller's transaction. */
export async function attachMedia(
  tx: Tx,
  p: { orgId: string; traineeId: string; mediaIds: string[]; entityType: AttachmentEntity; entityId: string },
): Promise<void> {
  const ids = [...new Set(p.mediaIds)];
  if (ids.length === 0) return;
  const found = await tx.media.count({
    where: { id: { in: ids }, orgId: p.orgId, traineeId: p.traineeId, status: { in: ATTACHABLE } },
  });
  if (found !== ids.length) {
    throw Errors.unprocessable('Some media are missing, not fully uploaded, or belong to another trainee');
  }
  await tx.mediaAttachment.createMany({
    data: ids.map((mediaId) => ({ mediaId, entityType: p.entityType, entityId: p.entityId })),
    skipDuplicates: true,
  });
}

/** Media attached to a set of entities, grouped for API responses. */
export async function mediaForEntities(refs: { entityType: AttachmentEntity; entityId: string }[]) {
  if (refs.length === 0) return [];
  const rows = await prisma.mediaAttachment.findMany({
    where: { OR: refs.map((r) => ({ entityType: r.entityType, entityId: r.entityId })), media: { status: { in: VIEWABLE } } },
    include: { media: true },
    orderBy: { createdAt: 'asc' },
  });
  return Promise.all(
    rows.map(async (r) => ({ entityType: r.entityType, entityId: r.entityId, media: await toMediaDTO(r.media) })),
  );
}
