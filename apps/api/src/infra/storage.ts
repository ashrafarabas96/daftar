import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Injectable, Inject } from '@nestjs/common';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { AppConfig } from '../config';

/**
 * Object storage port (§63). S3-compatible port; keys are SERVER-GENERATED and
 * tenant+business scoped. Clients never supply storage keys.
 */
export interface ObjectStorage {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** §23: compensation/reconciliation — remove an object whose DB commit failed. */
  delete(key: string): Promise<void>;
  publicUrl(key: string): string;
  /** Signed, expiring access URL — the private-bucket access strategy (§22). */
  signedUrl(key: string, expiresInSeconds: number): Promise<string>;
  /** Readiness probe (§29): bucket reachable with the configured credentials. */
  healthCheck(): Promise<boolean>;
  readonly kind: string;
}

export function newMediaId(): string {
  return randomUUID();
}

export function mediaStorageKey(tenantId: string, businessId: string, mediaId: string, variant: string, ext: string): string {
  return `tenants/${tenantId}/businesses/${businessId}/media/${mediaId}/${variant}${ext}`;
}

/** Local disk implementation — development/test ONLY (§81: not a production source of truth). */
@Injectable()
export class LocalObjectStorage implements ObjectStorage {
  readonly kind = 'local-development-only';
  private readonly root: string;
  private readonly baseUrl: string;
  constructor(@Inject('APP_CONFIG') config: AppConfig) {
    this.root = normalize(config.MEDIA_ROOT);
    this.baseUrl = config.MEDIA_PUBLIC_BASE_URL;
  }
  private pathFor(key: string): string {
    const p = normalize(join(this.root, key));
    if (!p.startsWith(this.root)) throw new Error(`storage key traversal rejected: ${key}`);
    return p;
  }
  async put(key: string, data: Buffer): Promise<void> {
    const p = this.pathFor(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data);
  }
  async get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }
  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
  publicUrl(key: string): string {
    return `${this.baseUrl}/${key}`;
  }
  signedUrl(key: string): Promise<string> {
    return Promise.resolve(this.publicUrl(key));
  }
  healthCheck(): Promise<boolean> {
    return mkdir(this.root, { recursive: true }).then(() => true, () => false);
  }
}

/**
 * Real S3-compatible adapter (Gate A §22). AWS SDK v3: request timeouts,
 * SDK-managed retry policy (maxAttempts), path-style endpoints for
 * S3-compatible providers, signed URLs for private access, HeadBucket
 * readiness probe. Never logs secrets — errors are rethrown as safe messages.
 */
export class S3ObjectStorage implements ObjectStorage {
  readonly kind = 's3';
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicBase: string | undefined;

  constructor(config: AppConfig) {
    if (!config.S3_BUCKET || !config.S3_ACCESS_KEY_ID || !config.S3_SECRET_ACCESS_KEY) {
      throw new Error('S3ObjectStorage requires S3_BUCKET/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY');
    }
    this.bucket = config.S3_BUCKET;
    this.publicBase = config.S3_PUBLIC_BASE_URL;
    const handler = new NodeHttpHandler({ requestTimeout: 10_000, connectionTimeout: 5_000 });
    this.client = new S3Client({
      region: config.S3_REGION ?? 'auto',
      ...(config.S3_ENDPOINT ? { endpoint: config.S3_ENDPOINT, forcePathStyle: true } : {}),
      credentials: { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY },
      requestHandler: handler,
      maxAttempts: 3,
    });
  }

  private static safe(e: unknown): Error {
    // No credentials, keys or request bodies in error messages.
    const msg = e instanceof Error ? e.message : 'storage error';
    return new Error(`s3 storage operation failed: ${msg.slice(0, 200)}`);
  }

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    try {
      await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: contentType }));
    } catch (e) {
      throw S3ObjectStorage.safe(e);
    }
  }

  async get(key: string): Promise<Buffer> {
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!out.Body) throw new Error('empty object body');
      return Buffer.from(await out.Body.transformToByteArray());
    } catch (e) {
      throw S3ObjectStorage.safe(e);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (e) {
      throw S3ObjectStorage.safe(e);
    }
  }

  publicUrl(key: string): string {
    // Public base when the deployment serves the bucket/CDN publicly; otherwise
    // clients must use signedUrl(). Never fabricate an unsigned private URL.
    if (this.publicBase) return `${this.publicBase}/${key}`;
    throw new Error('bucket is private: use signedUrl() (S3_PUBLIC_BASE_URL not configured)');
  }

  async signedUrl(key: string, expiresInSeconds: number): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: expiresInSeconds });
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return true;
    } catch {
      return false;
    }
  }
}

/** §21 factory: local for dev/test, real S3 in production. Config validation
 *  already refuses local-in-production — this factory never silently falls back. */
export function createObjectStorage(config: AppConfig): ObjectStorage {
  if (config.MEDIA_STORAGE === 's3') return new S3ObjectStorage(config);
  if (config.isProd) throw new Error('MEDIA_STORAGE=local is forbidden in production');
  return new LocalObjectStorage(config);
}

/**
 * Malware scanning port (§64). Seam only. The development adapter is DISABLED
 * and says so — it never claims a file was scanned.
 */
export interface MalwareScanner {
  /** Returns true only when a REAL scan found the file clean. */
  scanClean(key: string): Promise<boolean>;
  readonly enabled: boolean;
}

export class DisabledDevelopmentMalwareScanner implements MalwareScanner {
  readonly enabled = false;
  scanClean(): Promise<boolean> {
    // Honest: no scanning happened. Uploads still proceed in dev because Phase 1
    // media is re-encoded (sharp) which strips payloads; production must wire a
    // real scanner (ClamAV/cloud) before claiming `scanned`.
    return Promise.resolve(false);
  }
}
