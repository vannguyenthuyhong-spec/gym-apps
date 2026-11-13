import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env';

function makeClient(endpoint?: string): S3Client {
  return new S3Client({
    region: env.S3_REGION,
    endpoint,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials:
      env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
        ? { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY }
        : undefined,
  });
}

/** Client for server-side calls (may use an internal hostname). */
const s3 = makeClient(env.S3_ENDPOINT);
/** Client used only to sign URLs handed to browsers/apps (public hostname). */
const signer = env.S3_PUBLIC_ENDPOINT ? makeClient(env.S3_PUBLIC_ENDPOINT) : s3;
const Bucket = env.S3_BUCKET;
const ttl = env.PRESIGN_TTL_SEC;

export const storage = {
  presignPut(key: string, contentType: string, contentLength: number): Promise<string> {
    return getSignedUrl(
      signer,
      new PutObjectCommand({ Bucket, Key: key, ContentType: contentType, ContentLength: contentLength }),
      { expiresIn: ttl },
    );
  },

  presignGet(key: string, expiresIn = ttl): Promise<string> {
    return getSignedUrl(signer, new GetObjectCommand({ Bucket, Key: key }), { expiresIn });
  },

  async createMultipart(key: string, contentType: string): Promise<string> {
    const res = await s3.send(new CreateMultipartUploadCommand({ Bucket, Key: key, ContentType: contentType }));
    if (!res.UploadId) throw new Error('S3 did not return an UploadId');
    return res.UploadId;
  },

  presignPart(key: string, uploadId: string, partNumber: number): Promise<string> {
    return getSignedUrl(
      signer,
      new UploadPartCommand({ Bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }),
      { expiresIn: ttl },
    );
  },

  async completeMultipart(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]) {
    await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: [...parts]
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
        },
      }),
    );
  },

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    await s3.send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId: uploadId }));
  },

  async head(key: string): Promise<{ size: number; contentType?: string } | null> {
    try {
      const res = await s3.send(new HeadObjectCommand({ Bucket, Key: key }));
      return { size: res.ContentLength ?? 0, contentType: res.ContentType };
    } catch (err) {
      if (err instanceof NotFound || (err as { name?: string }).name === 'NotFound') return null;
      throw err;
    }
  },

  async download(key: string, filePath: string): Promise<void> {
    const res = await s3.send(new GetObjectCommand({ Bucket, Key: key }));
    if (!res.Body) throw new Error(`Empty body for ${key}`);
    await pipeline(res.Body as Readable, createWriteStream(filePath));
  },

  async uploadFile(key: string, filePath: string, contentType: string): Promise<void> {
    const { size } = await stat(filePath);
    await s3.send(
      new PutObjectCommand({
        Bucket,
        Key: key,
        Body: createReadStream(filePath),
        ContentType: contentType,
        ContentLength: size,
        CacheControl: 'private, max-age=31536000, immutable',
      }),
    );
  },

  async deleteObjects(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await s3.send(
      new DeleteObjectsCommand({ Bucket, Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true } }),
    );
  },
};
