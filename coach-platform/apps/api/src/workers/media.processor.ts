import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'pino';
import sharp from 'sharp';
import { prisma } from '../lib/prisma';
import { storage } from '../lib/storage';

const STALE_UPLOAD_MS = 24 * 3600 * 1000;

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d: Buffer) => (out += d.toString()));
    p.stderr.on('data', (d: Buffer) => {
      err = (err + d.toString()).slice(-8000);
    });
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${cmd} exited with ${code}: ${err.slice(-1500)}`)),
    );
  });
}

interface ProbeStream {
  codec_type?: string;
  width?: number;
  height?: number;
  duration?: string;
  tags?: { rotate?: string };
  side_data_list?: { rotation?: number }[];
}

async function processImage(src: string, dir: string, base: string) {
  const display = join(dir, 'display.webp');
  const thumb = join(dir, 'thumb.webp');
  // .rotate() applies EXIF orientation (phone photos) and strips metadata incl. GPS.
  const out = await sharp(src, { failOn: 'error' })
    .rotate()
    .resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 })
    .toFile(display);
  await sharp(src).rotate().resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true }).webp({ quality: 75 }).toFile(thumb);

  const playbackKey = `${base}/display.webp`;
  const thumbnailKey = `${base}/thumb.webp`;
  await Promise.all([
    storage.uploadFile(playbackKey, display, 'image/webp'),
    storage.uploadFile(thumbnailKey, thumb, 'image/webp'),
  ]);
  return { width: out.width, height: out.height, durationSec: null, playbackKey, thumbnailKey };
}

async function processVideo(src: string, dir: string, base: string) {
  const probe = JSON.parse(
    await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', src]),
  ) as { streams?: ProbeStream[]; format?: { duration?: string } };
  const v = probe.streams?.find((s) => s.codec_type === 'video');
  if (!v) throw new Error('File has no video stream');

  const duration = Number(probe.format?.duration ?? v.duration ?? 0);
  const rotation = Math.abs(Number(v.side_data_list?.find((s) => s.rotation !== undefined)?.rotation ?? v.tags?.rotate ?? 0));
  const portrait = rotation === 90 || rotation === 270;

  const playback = join(dir, 'playback.mp4');
  const thumb = join(dir, 'thumb.jpg');
  // Longest side ≤ 1280, never upscale, even dims for H.264; faststart enables progressive playback.
  await run('ffmpeg', [
    '-y', '-i', src,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', "scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    playback,
  ]);
  await run('ffmpeg', [
    '-y', '-ss', String(Math.min(1, duration / 2)), '-i', src,
    '-frames:v', '1',
    '-vf', "scale='min(480,iw)':'min(480,ih)':force_original_aspect_ratio=decrease",
    '-q:v', '4',
    thumb,
  ]);

  const playbackKey = `${base}/playback.mp4`;
  const thumbnailKey = `${base}/thumb.jpg`;
  await Promise.all([
    storage.uploadFile(playbackKey, playback, 'video/mp4'),
    storage.uploadFile(thumbnailKey, thumb, 'image/jpeg'),
  ]);
  return {
    width: (portrait ? v.height : v.width) ?? null,
    height: (portrait ? v.width : v.height) ?? null,
    durationSec: Number.isFinite(duration) ? Math.round(duration * 100) / 100 : null,
    playbackKey,
    thumbnailKey,
  };
}

/** Idempotent: re-running on a READY or DELETED media is a no-op. */
export async function processMedia(mediaId: string, log: Logger): Promise<void> {
  const m = await prisma.media.findUnique({ where: { id: mediaId } });
  if (!m || m.status === 'DELETED' || m.status === 'READY') return;

  await prisma.media.update({ where: { id: mediaId }, data: { status: 'PROCESSING', errorMessage: null } });
  const dir = await mkdtemp(join(tmpdir(), 'media-'));
  try {
    const src = join(dir, 'original');
    await storage.download(m.storageKey, src);
    const base = m.storageKey.replace(/\/original\.[^/]+$/, '');
    const result = m.kind === 'IMAGE' ? await processImage(src, dir, base) : await processVideo(src, dir, base);

    await prisma.media.updateMany({
      where: { id: mediaId, status: { not: 'DELETED' } },
      data: { ...result, status: 'READY' },
    });
    log.info({ mediaId, kind: m.kind }, 'Media processed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function markMediaFailed(mediaId: string, message: string): Promise<void> {
  await prisma.media.updateMany({
    where: { id: mediaId, status: { not: 'DELETED' } },
    data: { status: 'FAILED', errorMessage: message.slice(0, 1000) },
  });
}

export async function deleteMediaObjects(mediaId: string): Promise<void> {
  const m = await prisma.media.findUnique({ where: { id: mediaId } });
  if (!m || m.status !== 'DELETED') return;
  if (m.multipartId) await storage.abortMultipart(m.storageKey, m.multipartId).catch(() => undefined);
  await storage.deleteObjects([m.storageKey, m.thumbnailKey, m.playbackKey].filter((k): k is string => !!k));
}

/** Abandoned uploads (app closed mid-upload) are aborted and soft-deleted after 24h. */
export async function cleanupStaleUploads(log: Logger): Promise<void> {
  const stale = await prisma.media.findMany({
    where: { status: 'PENDING_UPLOAD', createdAt: { lt: new Date(Date.now() - STALE_UPLOAD_MS) } },
    take: 500,
  });
  for (const m of stale) {
    await prisma.media.update({ where: { id: m.id }, data: { status: 'DELETED' } });
    await deleteMediaObjects(m.id).catch((err) => log.warn({ err, mediaId: m.id }, 'Cleanup failed'));
  }
  if (stale.length) log.info({ count: stale.length }, 'Cleaned up stale uploads');
}
