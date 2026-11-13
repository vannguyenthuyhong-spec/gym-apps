import { Redis, type RedisOptions } from 'ioredis';
import { env } from '../config/env';

/** BullMQ requires maxRetriesPerRequest = null on its connections. */
export function createRedis(opts: RedisOptions = {}): Redis {
  return new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: true, ...opts });
}

let shared: Redis | undefined;

/** Shared connection for rate limiting, cache and health checks. */
export function getRedis(): Redis {
  shared ??= createRedis({ maxRetriesPerRequest: 3 });
  return shared;
}

export async function closeRedis(): Promise<void> {
  if (shared) {
    await shared.quit();
    shared = undefined;
  }
}
