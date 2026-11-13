import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const MB = 1024 * 1024;

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  ENABLE_DOCS: bool.default('true'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 chars'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173')
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)),
  RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(300),

  S3_REGION: z.string().default('ap-southeast-1'),
  S3_BUCKET: z.string().min(1),
  /** Endpoint the API/worker use (e.g. http://minio:9000 inside docker). Empty = AWS S3. */
  S3_ENDPOINT: z.string().url().optional(),
  /** Endpoint embedded in presigned URLs given to clients (e.g. http://localhost:9000). */
  S3_PUBLIC_ENDPOINT: z.string().url().optional(),
  S3_FORCE_PATH_STYLE: bool.default('false'),
  /** Leave empty in production to use the IAM role of the pod. */
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),

  PRESIGN_TTL_SEC: z.coerce.number().int().min(60).max(7 * 24 * 3600).default(900),
  MEDIA_MAX_IMAGE_BYTES: z.coerce.number().int().positive().default(20 * MB),
  MEDIA_MAX_VIDEO_BYTES: z.coerce.number().int().positive().default(2048 * MB),
  MULTIPART_THRESHOLD_BYTES: z.coerce.number().int().positive().default(50 * MB),
  MULTIPART_PART_SIZE: z.coerce.number().int().min(5 * MB).default(10 * MB),

  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
});

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // Fail fast with a readable message — never start with a broken config.
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    console.error(`Invalid environment configuration:\n${issues}`);
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();
