import { Worker } from 'bullmq';
import pino from 'pino';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { closeQueues, getMediaQueue, MEDIA_QUEUE, type MediaJobData, type MediaJobName } from '../lib/queue';
import { createRedis } from '../lib/redis';
import { cleanupStaleUploads, deleteMediaObjects, markMediaFailed, processMedia } from './media.processor';
import { startOutboxRelay } from './outbox.relay';

const log = pino({ level: env.LOG_LEVEL, name: 'worker' });

async function main() {
  const worker = new Worker<MediaJobData, void, MediaJobName>(
    MEDIA_QUEUE,
    async (job) => {
      switch (job.name) {
        case 'process':
          return processMedia(job.data.mediaId!, log);
        case 'delete':
          return deleteMediaObjects(job.data.mediaId!);
        case 'cleanup':
          return cleanupStaleUploads(log);
      }
    },
    {
      connection: createRedis(),
      concurrency: env.WORKER_CONCURRENCY,
      lockDuration: 120_000, // transcodes are long; the lock is auto-renewed while running
    },
  );

  worker.on('failed', (job, err) => {
    if (!job) return;
    const final = job.attemptsMade >= (job.opts.attempts ?? 1);
    log.error({ jobId: job.id, name: job.name, attempt: job.attemptsMade, final, err }, 'Job failed');
    if (final && job.name === 'process' && job.data.mediaId) {
      void markMediaFailed(job.data.mediaId, err.message).catch((e) => log.error({ err: e }, 'markMediaFailed'));
    }
  });
  worker.on('error', (err) => log.error({ err }, 'Worker error'));

  await getMediaQueue().add('cleanup', {}, { repeat: { every: 3600_000 }, jobId: 'cleanup-stale-uploads' });

  const stopOutbox = startOutboxRelay(log);
  log.info({ concurrency: env.WORKER_CONCURRENCY }, 'Worker started');

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'Worker shutting down: finishing active jobs');
    setTimeout(() => process.exit(1), 120_000).unref();
    await Promise.allSettled([worker.close(), stopOutbox()]);
    await Promise.allSettled([closeQueues(), prisma.$disconnect()]);
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  log.fatal({ err }, 'Worker failed to start');
  process.exit(1);
});
