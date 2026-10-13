import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
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
    return mkdir(this.root, { recursive: true }).then(
      () => true,
      () => false,
    );
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
 * Malware scanning port (§64) — FAIL-CLOSED (owner ruling, 2026-10-12).
 *
 * A verdict is a three-state FACT, never a boolean. `clean` may be produced
 * ONLY by an adapter that really scanned these bytes and really got a clean
 * answer. Everything else collapses to `unavailable`: disabled, unreachable,
 * timed out, protocol error, or a reply the adapter cannot vouch for. There is
 * no branch in this file that turns "we do not know" into "the file is fine",
 * and no adapter here may report `clean` without a scan.
 *
 * The caller (media upload) REFUSES the upload on anything but `clean`, before
 * a single byte reaches object storage or the database — so an unscanned file
 * is never stored, and no restart can later promote one to "accepted".
 */
export type MalwareVerdict =
  | { readonly outcome: 'clean'; readonly scanner: string }
  | { readonly outcome: 'infected'; readonly scanner: string; readonly signature: string }
  | { readonly outcome: 'unavailable'; readonly scanner: string; readonly reason: string };

export interface MalwareScanner {
  readonly kind: string;
  /** True ONLY for an adapter that performs a real scan. A disabled adapter is false. */
  readonly enabled: boolean;
  /** Scans the bytes BEFORE they are stored. Never returns `clean` unscanned. */
  scan(input: { bytes: Buffer; filename: string }): Promise<MalwareVerdict>;
}

/**
 * Development/test placeholder. It scans nothing, says so, and therefore
 * refuses every upload that needs a scan: `unavailable` is the only verdict it
 * can produce. It exists so the seam is wired in dev without pretending, and
 * `createMalwareScanner` refuses to build it in production.
 */
export class DisabledDevelopmentMalwareScanner implements MalwareScanner {
  readonly kind = 'disabled';
  readonly enabled = false;
  scan(): Promise<MalwareVerdict> {
    // Honest: no scanning happened. Re-encoding (sharp) strips payloads from a
    // valid image, which is NOT a scan and is never reported as one.
    return Promise.resolve({ outcome: 'unavailable', scanner: this.kind, reason: 'scanner_disabled' });
  }
}

/**
 * Real clamd adapter (INSTREAM over TCP).
 *
 * Two things have to be true before a file is called clean, and each is
 * checked against clamd's documented wire format rather than against a
 * pattern that something else could satisfy:
 *
 * 1. **The peer is clamd.** Before every scan the adapter sends `zPING` and
 *    requires the reply to be exactly `PONG\0`. A mis-pointed address, a load
 *    balancer, an HTTP server or any other listener fails this by name, so it
 *    can never go on to have its answer read as a verdict. The handshake is
 *    not cached: a DNS or VIP change between uploads must be caught at the
 *    upload that follows it, not at process start.
 * 2. **The reply is clamd's own clean reply, byte for byte.** `clean` requires
 *    the INSTREAM reply to equal exactly `stream: OK\0` — not a prefix, not a
 *    suffix, no trailing bytes, no second NUL. `infected` requires exactly
 *    `stream: <signature> FOUND\0`. An empty reply, a partial reply, extra
 *    bytes, an `ERROR`, or anything else is `unavailable`, with the reason
 *    naming which check refused.
 *
 * Verified against real clamd 1.5.4: `zPING` → `PONG\0`, a clean stream →
 * `stream: OK\0`, a signature hit → `stream: Daftar.Test.Signature.UNOFFICIAL
 * FOUND\0`.
 *
 * Errors never carry the scanned bytes, and a foreign reply only ever appears
 * as a bounded, escaped slice.
 */
export class ClamAvMalwareScanner implements MalwareScanner {
  readonly kind = 'clamav';
  readonly enabled = true;
  /** clamd's clean INSTREAM reply, exactly. Nothing else is a pass. */
  private static readonly CLEAN_REPLY = Buffer.from('stream: OK\0', 'utf8');
  /** clamd's reply to `zPING`, exactly. Nothing else proves the peer is clamd. */
  private static readonly PONG_REPLY = Buffer.from('PONG\0', 'utf8');
  /** `stream: <signature> FOUND` + the NUL terminator, and nothing around it. */
  private static readonly FOUND_REPLY = /^stream: (\S[^\0]*?) FOUND\0$/;
  private readonly host: string;
  private readonly port: number;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;

  constructor(config: AppConfig) {
    if (!config.MALWARE_SCANNER_URL) {
      throw new Error('ClamAvMalwareScanner requires MALWARE_SCANNER_URL (clamav://host:port)');
    }
    let url: URL;
    try {
      url = new URL(config.MALWARE_SCANNER_URL);
    } catch {
      throw new Error('MALWARE_SCANNER_URL must be a URL of the form clamav://host:port');
    }
    if (url.protocol !== 'clamav:' && url.protocol !== 'tcp:') {
      throw new Error(`MALWARE_SCANNER_URL protocol must be clamav:// or tcp:// (got ${url.protocol})`);
    }
    if (!url.hostname || !url.port) {
      throw new Error('MALWARE_SCANNER_URL must carry both a host and a port (clamav://host:port)');
    }
    this.host = url.hostname;
    this.port = Number(url.port);
    this.timeoutMs = config.MALWARE_SCAN_TIMEOUT_MS;
    this.maxBytes = config.MEDIA_MAX_BYTES;
  }

  /** A foreign reply, safe to log: bounded, and control bytes escaped. */
  private static describe(raw: Buffer): string {
    if (raw.length === 0) return 'empty';
    return JSON.stringify(raw.subarray(0, 64).toString('utf8')).slice(0, 96);
  }

  async scan(input: { bytes: Buffer; filename: string }): Promise<MalwareVerdict> {
    const unavailable = (reason: string): MalwareVerdict => ({ outcome: 'unavailable', scanner: this.kind, reason });
    if (input.bytes.length > this.maxBytes) {
      // Larger than what this deployment accepts at all: refuse, never scan.
      return unavailable('payload_exceeds_scan_ceiling');
    }

    // The adapter's own budget covers BOTH legs, because the caller races the
    // whole scan against one deadline: a quarter (and at most 2s) for the
    // handshake, the rest for the stream.
    const pingBudget = Math.max(100, Math.min(2000, Math.floor(this.timeoutMs / 4)));
    const streamBudget = Math.max(100, this.timeoutMs - pingBudget);

    // ── 1. the peer must prove it is clamd ───────────────────────────────────
    let pong: Buffer;
    try {
      pong = await this.converse(pingBudget, (socket) => socket.write('zPING\0'));
    } catch (e) {
      return unavailable(e instanceof Error ? e.message.slice(0, 120) : 'ping_transport_error');
    }
    if (!pong.equals(ClamAvMalwareScanner.PONG_REPLY)) {
      // Whatever is listening there, it is not clamd. Never scan through it.
      return unavailable(`peer_is_not_clamd:ping_reply=${ClamAvMalwareScanner.describe(pong)}`);
    }

    // ── 2. the stream, and a byte-exact reading of its reply ─────────────────
    let reply: Buffer;
    try {
      reply = await this.converse(streamBudget, (socket) => this.writeInstream(socket, input.bytes));
    } catch (e) {
      return unavailable(e instanceof Error ? e.message.slice(0, 120) : 'scan_transport_error');
    }
    if (reply.equals(ClamAvMalwareScanner.CLEAN_REPLY)) return { outcome: 'clean', scanner: this.kind };
    const found = ClamAvMalwareScanner.FOUND_REPLY.exec(reply.toString('utf8'));
    if (found?.[1]) return { outcome: 'infected', scanner: this.kind, signature: found[1] };
    if (reply.length === 0) return unavailable('scan_reply_empty');
    // A reply that merely RESEMBLES clamd's — a colon-free prefix, a longer
    // word, trailing bytes, a missing terminator — lands here, not on `clean`.
    return unavailable(`scan_reply_not_clamd_format:${ClamAvMalwareScanner.describe(reply)}`);
  }

  /** clamd zINSTREAM: length-prefixed chunks, then a zero-length terminator. */
  private writeInstream(socket: Socket, bytes: Buffer): void {
    socket.write('zINSTREAM\0');
    const CHUNK = 64 * 1024;
    for (let off = 0; off < bytes.length; off += CHUNK) {
      const slice = bytes.subarray(off, Math.min(off + CHUNK, bytes.length));
      const header = Buffer.alloc(4);
      header.writeUInt32BE(slice.length, 0);
      socket.write(header);
      socket.write(slice);
    }
    socket.write(Buffer.from([0, 0, 0, 0]));
  }

  /**
   * One clamd command on its own connection (clamd closes after a `z`
   * command), returning the raw reply bytes. Resolves with whatever arrived
   * when the peer closes — a partial reply is then refused by the byte-exact
   * comparison above rather than parsed.
   */
  private converse(budgetMs: number, send: (socket: Socket) => void): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const socket = connect({ host: this.host, port: this.port });
      const chunks: Buffer[] = [];
      let settled = false;
      const finish = (err: Error | null): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (err) reject(err);
        else resolve(Buffer.concat(chunks));
      };
      socket.setTimeout(budgetMs, () => finish(new Error('clamd_timeout')));
      socket.on('error', (e: Error) => finish(new Error(`clamd_unreachable:${e.message.slice(0, 80)}`)));
      socket.on('data', (d: Buffer) => chunks.push(d));
      socket.on('end', () => finish(null));
      socket.on('close', () => finish(null));
      socket.on('connect', () => send(socket));
    });
  }
}

/**
 * §21 factory, same shape as `createObjectStorage`: a real scanner when one is
 * configured, the honest disabled placeholder outside production, and a hard
 * refusal to compose the placeholder IN production. It never falls back
 * silently, and there is no adapter here that can answer `clean` without a
 * real scan.
 */
export function createMalwareScanner(config: AppConfig): MalwareScanner {
  if (config.MALWARE_SCANNER === 'clamav') return new ClamAvMalwareScanner(config);
  if (config.isProd) {
    throw new Error('MALWARE_SCANNER=disabled is forbidden in production: uploads fail closed, so a real scanner must be configured');
  }
  return new DisabledDevelopmentMalwareScanner();
}
