import { Queue } from 'bullmq';
import { createRedis } from './redis';

export const MEDIA_QUEUE = 'media';

export type MediaJobName = 'process' | 'delete' | 'cleanup';
export interface MediaJobData {
  mediaId?: string;
}

let mediaQueue: Queue<MediaJobData, void, MediaJobName> | undefined;

export function getMediaQueue(): Queue<MediaJobData, void, MediaJobName> {
  mediaQueue ??= new Queue<MediaJobData, void, MediaJobName>(MEDIA_QUEUE, {
    connection: createRedis(),
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
    },
  });
  return mediaQueue;
}

/** jobId makes enqueueing idempotent: double "complete" calls never create two jobs. */
export async function enqueueMedia(name: 'process' | 'delete', mediaId: string): Promise<void> {
  await getMediaQueue().add(name, { mediaId }, { jobId: `${name}-${mediaId}` });
}

export async function closeQueues(): Promise<void> {
  await mediaQueue?.close();
  mediaQueue = undefined;
}
