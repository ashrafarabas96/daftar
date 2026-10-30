import { createRequire } from 'node:module';
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { AppError } from '@daftar/domain-core';
import type { Request, Response } from 'express';
import { Observable, finalize, throwError } from 'rxjs';
import {
  MEDIA_UPLOAD_FIELD_NAME,
  MEDIA_UPLOAD_LIMITS,
  MEDIA_UPLOAD_MAX_CONCURRENT,
  MEDIA_UPLOAD_MAX_CONCURRENT_PER_BUSINESS,
  mapUploadParseError,
} from './media-upload-limits';

/**
 * Order matters and is part of the contract (DR-71 section 2):
 *
 *   guards (authentication, business membership, `media.manage`)
 *     -> UploadAdmissionInterceptor   (memory bound)
 *     -> MediaMultipartInterceptor    (the parser, its limits, and DR-64)
 *     -> handler
 *
 * Nest runs ALL guards before ANY interceptor, so the multipart parser — the
 * only thing that buffers the body — never starts for a caller that is not
 * authenticated or lacks `media.manage`. That is the safer order: an
 * unauthenticated request cannot make the process buffer up to `fileSize`
 * bytes, and the limits are enforced for authenticated callers only. The
 * suite `tests/security/dr71-multipart-limits.test.ts` pins this order.
 */

/**
 * Bounds the memory the parser can hold (see media-upload-limits.ts). A slot
 * is taken before the parser starts and ALWAYS released (`finalize` runs on
 * completion, error and client disconnect).
 */
@Injectable()
export class UploadAdmissionInterceptor implements NestInterceptor {
  private active = 0;
  private readonly perBusiness = new Map<string, number>();

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request & { membership?: { businessId?: string } }>();
    const business = req.membership?.businessId ?? '';
    const mine = this.perBusiness.get(business) ?? 0;
    if (this.active >= MEDIA_UPLOAD_MAX_CONCURRENT || mine >= MEDIA_UPLOAD_MAX_CONCURRENT_PER_BUSINESS) {
      return throwError(() => new AppError('RATE_LIMITED', 'Too many uploads in progress', 429));
    }
    this.active += 1;
    this.perBusiness.set(business, mine + 1);
    return next.handle().pipe(
      finalize(() => {
        this.active -= 1;
        const left = (this.perBusiness.get(business) ?? 1) - 1;
        if (left <= 0) this.perBusiness.delete(business);
        else this.perBusiness.set(business, left);
      }),
    );
  }
}

interface MulterInstance {
  single(name: string): (req: Request, res: Response, cb: (err?: unknown) => void) => void;
}
interface MulterFactory {
  (options: { storage: unknown; limits: Record<string, number> }): MulterInstance;
  memoryStorage(): unknown;
}

/**
 * Loads the SAME multer that `@nestjs/platform-express` depends on. `multer`
 * is a declared dependency of platform-express, not of apps/api, and no
 * `@types/multer` is installed; resolving it through platform-express avoids
 * an undeclared import without touching package manifests (the lockfile
 * belongs to the dependency-upgrade card). OWNER DECISION NEEDED: declare
 * `multer` (and its types) in apps/api/package.json and import it directly.
 */
function loadMulter(): MulterFactory {
  const here = createRequire(__filename);
  return createRequire(here.resolve('@nestjs/platform-express'))('multer') as MulterFactory;
}

/**
 * The multipart parser, owned here instead of `FileInterceptor` (DR-64).
 *
 * `FileInterceptor` translates multer errors inside the framework by comparing
 * `error.message` with fixed strings and then throws only the translated
 * HttpException — the original `err.code` is gone by the time any of our code
 * sees it, so no code-keyed fix is possible on top of it, and a dependency
 * that rewords a message turns a 4xx into a 500 silently (multer 2.5.0 did
 * exactly that for LIMIT_UNEXPECTED_FILE). Calling multer directly keeps the
 * raw error, so EVERY refusal goes through one table keyed by `err.code`
 * (media-upload-limits.ts) and one body shape.
 *
 * Everything this callback can report is about the request being parsed:
 * memory storage performs no IO, so a non-multer error here is a malformed
 * multipart stream (busboy), i.e. also the client's: 400, not 500.
 */
@Injectable()
export class MediaMultipartInterceptor implements NestInterceptor {
  private readonly parse = ((): ReturnType<MulterInstance['single']> => {
    const multer = loadMulter();
    return multer({ storage: multer.memoryStorage(), limits: { ...MEDIA_UPLOAD_LIMITS } }).single(MEDIA_UPLOAD_FIELD_NAME);
  })();

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    await new Promise<void>((resolve, reject) => {
      this.parse(http.getRequest<Request>(), http.getResponse<Response>(), (err) => (err ? reject(mapUploadParseError(err)) : resolve()));
    });
    return next.handle();
  }
}
