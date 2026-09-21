import { Injectable, Inject, Logger } from '@nestjs/common';
import { AppError } from '@daftar/domain-core';
import { imageSize } from 'image-size';
import sharp from 'sharp';
import { Database } from '../../infra/database';
import { AuditService, OutboxService, newId } from '../audit/audit.service';
import { mediaStorageKey, type MalwareScanner, type ObjectStorage } from '../../infra/storage';
import type { AppConfig } from '../../config';
import type { MembershipContext } from '../tenancy/tenancy.service';

const ALLOWED_MIME: Readonly<Record<string, string>> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};
const VARIANT_SIZES = [256, 1024, 2048] as const;
const MAX_DIMENSION = 6000;

/**
 * Media pipeline (§63–64): extension/MIME agreement, magic-byte validation via
 * image-size, size + dimension limits, sharp RE-ENCODE (metadata stripped,
 * payloads neutralized), server-generated tenant+business-scoped keys.
 * The malware scanner seam exists; the dev adapter is disabled and honest (§106).
 */
@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject('OBJECT_STORAGE') private readonly storage: ObjectStorage,
    @Inject('MALWARE_SCANNER') private readonly scanner: MalwareScanner,
    @Inject('APP_CONFIG') private readonly config: AppConfig,
  ) {}

  async upload(m: MembershipContext, file: { buffer: Buffer; mimetype: string; originalname: string; size: number }): Promise<{ id: string; url: string }> {
    if (file.buffer.length === 0) throw AppError.validation({ file: ['empty'] });
    if (file.size > this.config.MEDIA_MAX_BYTES || file.buffer.length > this.config.MEDIA_MAX_BYTES) {
      throw new AppError('MEDIA_TOO_LARGE', 'File exceeds the size limit', 413);
    }
    const expectedExt = ALLOWED_MIME[file.mimetype];
    if (!expectedExt) throw new AppError('MEDIA_INVALID', 'Unsupported media type', 415);

    // Magic bytes must agree with the declared MIME (a ".png" that isn't one is rejected).
    let dims: { width: number; height: number; type: string };
    try {
      const d = imageSize(file.buffer);
      if (!d.width || !d.height || !d.type) throw new Error('bad');
      dims = { width: d.width, height: d.height, type: d.type };
    } catch {
      throw new AppError('MEDIA_INVALID', 'File content is not a valid image', 400);
    }
    const mimeByMagic = `image/${dims.type === 'jpg' ? 'jpeg' : dims.type}`;
    if (mimeByMagic !== file.mimetype) {
      throw new AppError('MEDIA_INVALID', 'File content does not match its declared type', 400);
    }
    if (dims.width > MAX_DIMENSION || dims.height > MAX_DIMENSION) {
      throw new AppError('MEDIA_INVALID', 'Image dimensions exceed limits', 400);
    }

    const mediaId = newId();
    // Re-encode (strips EXIF/metadata and any embedded payloads), then variant set.
    const uploadedKeys: string[] = [];
    try {
      const cleaned = await sharp(file.buffer).rotate().webp({ quality: 90 }).toBuffer();
      const originalKey = mediaStorageKey(m.tenantId, m.businessId, mediaId, 'original', '.webp');
      await this.storage.put(originalKey, cleaned, 'image/webp');
      uploadedKeys.push(originalKey);

      const variants: { size: number; storage_key: string; width: number; height: number }[] = [];
      for (const size of VARIANT_SIZES) {
        if (dims.width <= size && dims.height <= size) continue;
        const buf = await sharp(cleaned).resize(size, size, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
        const meta = await sharp(buf).metadata();
        const key = mediaStorageKey(m.tenantId, m.businessId, mediaId, `w${size}`, '.webp');
        await this.storage.put(key, buf, 'image/webp');
        uploadedKeys.push(key);
        variants.push({ size, storage_key: key, width: meta.width ?? size, height: meta.height ?? size });
      }

      // Malware seam: dev scanner is disabled — we record that honestly, never "scanned: true".
      const scanNote = this.scanner.enabled ? 'scanner_enabled' : 'scanner_disabled_development_only';

      await this.db.withTransaction({ tenantId: m.tenantId, businessId: m.businessId }, async (c) => {
        await c.query(
          `INSERT INTO media (business_id, id, storage_key, original_mime, byte_size, width, height, variants)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [m.businessId, mediaId, originalKey, 'image/webp', cleaned.length, dims.width, dims.height, JSON.stringify(variants)],
        );
        await this.audit.recordTx(c, {
          action: 'catalog.media_uploaded',
          entity: 'media',
          entityId: mediaId,
          metadata: { byteSize: cleaned.length, scan: scanNote },
        });
      });
      // §45–47 (Stabilization): after the DB commit NO storage call may fail
      // this request — especially not publicUrl() on a private bucket. The
      // client receives the media id + the authorized access-URL endpoint;
      // signed URLs are minted on demand by getAccessUrl().
      return { id: mediaId, url: `/v1/catalog/media/${mediaId}/access-url` };
    } catch (e) {
      // §46: compensation runs ONLY when DB ownership persistence did NOT
      // commit. A failure after commit can never reach this catch — the
      // committed object is never deleted from under a media row.
      await this.compensateOrphans(m, mediaId, uploadedKeys);
      throw e;
    }
  }

  /**
   * §47: authorized short-TTL access URL for a PRIVATE bucket. The business
   * scope is verified against the media row (RLS scope); the storage key
   * never leaves the server.
   */
  async getAccessUrl(m: MembershipContext, mediaId: string): Promise<{ url: string; expiresInSeconds: number }> {
    const row = await this.db
      .scoped<{
        storage_key: string;
      }>({ tenantId: m.tenantId, businessId: m.businessId }, 'SELECT storage_key FROM media WHERE business_id = $1 AND id = $2', [m.businessId, mediaId])
      .then((r) => r.rows[0]);
    if (!row) throw AppError.notFound('Media not found');
    const expiresInSeconds = 300;
    const url = await this.storage.signedUrl(row.storage_key, expiresInSeconds);
    return { url, expiresInSeconds };
  }

  /** §24: best-effort object cleanup + reconciliation record for leftovers. */
  private async compensateOrphans(m: MembershipContext, mediaId: string, keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const leftovers: string[] = [];
    for (const key of keys) {
      try {
        await this.storage.delete(key);
      } catch {
        leftovers.push(key);
      }
    }
    if (leftovers.length > 0) {
      // §17: the reconciliation event goes through the OUTBOX-SAFE BUSINESS
      // boundary (app role, business scope) — never the platform transaction.
      // A reconciliation write failure is logged, never silently swallowed.
      try {
        await this.outbox.emit(
          { tenantId: m.tenantId, businessId: m.businessId },
          { tenantId: m.tenantId, businessId: m.businessId, type: 'media.orphan_cleanup_failed', payload: { mediaId, keys: leftovers } },
        );
      } catch (e) {
        this.logger.error(`media orphan reconciliation event failed for media ${mediaId}: ${(e as Error).message}`);
      }
    }
  }

  /** Attach media to a product — composite FK enforces same-business (§39). */
  async attachToProduct(m: MembershipContext, productId: string, mediaId: string): Promise<void> {
    try {
      await this.db.withTransaction({ tenantId: m.tenantId, businessId: m.businessId }, async (c) => {
        const pos =
          (
            await c.query<{ n: number }>('SELECT coalesce(max(position) + 1, 0) AS n FROM product_media WHERE business_id = $1 AND product_id = $2', [
              m.businessId,
              productId,
            ])
          ).rows[0]?.n ?? 0;
        await c.query('INSERT INTO product_media (business_id, id, product_id, media_id, position) VALUES ($1, $2, $3, $4, $5)', [
          m.businessId,
          newId(),
          productId,
          mediaId,
          pos,
        ]);
        await this.audit.recordTx(c, {
          action: 'catalog.media_attached',
          entity: 'product',
          entityId: productId,
          metadata: { mediaId },
        });
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23503') {
        throw AppError.validation({ mediaId: ['media_or_product_not_in_business'] });
      }
      throw e;
    }
  }
}
