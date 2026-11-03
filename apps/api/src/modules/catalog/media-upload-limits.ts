import { AppError } from '@daftar/domain-core';

/**
 * Multipart limits of `POST /v1/catalog/media` (DR-71 section 2).
 *
 * EVERY NUMBER BELOW IS A MEASUREMENT OF WHAT THE ENDPOINT NEEDS, NOT A GUESS.
 *
 * What the endpoint consumes. The handler (`catalog.controller.ts`,
 * `uploadMedia`) takes exactly one thing from the request: the single part
 * named `file`. It declares no `@Body()` and reads no text field, so a text
 * field is never an input of this route.
 *
 * What the two real clients send (read from their source, not assumed):
 *   - web     apps/web/src/lib/merchant-api.ts `uploadMedia`:
 *               `form.append('file', file)`                -> 1 file part, 0 fields
 *             and the BFF proxy (`api/proxy/[...path]/route.ts`) forwards the
 *             body as raw bytes ("so multipart uploads survive intact"), so it
 *             neither adds nor drops a part.
 *   - android apps/android/.../data/ApiClient.kt `MultipartBody.Builder()
 *             .addFormDataPart(fieldName, fileName, body)` -> 1 file part, 0 fields
 * The suite `tests/security/dr71-multipart-limits.test.ts` re-derives this
 * count from the request the web client builds (FormData -> serialised body ->
 * parser), so the number is re-measured, not only quoted here.
 *
 * Therefore the need is: files = 1, fields = 0, parts = 1 (files + fields).
 *
 * `fieldSize` is 0 because no field is allowed. Measured on multer 2.5.0
 * (probe section of the suite): with `fields: 0` busboy rejects any text
 * field with LIMIT_FIELD_COUNT BEFORE it looks at the value, so over HTTP
 * `fieldSize` is SHADOWED by `fields`, and `parts` by `files` + `fields` (any
 * extra part is a file or a field and is refused as such first). They are
 * kept as explicit second lines on purpose: if `files` or `fields` is ever
 * raised for a real need, an unlimited `parts` / the 1 MiB busboy default
 * `fieldSize` would otherwise reopen silently. Each is proven by the
 * parser-isolation cases of that suite, which relax the other limits so the
 * one under test is the first met.
 *
 * `fileSize` is unchanged from the interceptor's previous literal (8 MiB). It
 * is intentionally >= the media service's MEDIA_MAX_BYTES default (5 MiB) so
 * that configuration, not this constant, owns the product limit.
 */
export const MEDIA_UPLOAD_FIELD_NAME = 'file';

export const MEDIA_UPLOAD_LIMITS = Object.freeze({
  fileSize: 8 * 1024 * 1024,
  files: 1,
  fields: 0,
  parts: 1,
  fieldSize: 0,
});

/**
 * Memory bound (DR-71 section 2, last bullet). multer's memory storage
 * buffers the whole part of every in-flight upload: a request may hold up to
 * `fileSize + 1` bytes before the parser aborts it. Without a cap on
 * concurrent uploads the worst case grows with the number of connections.
 * Admission caps it: at most MEDIA_UPLOAD_MAX_CONCURRENT uploads parse at
 * once in a process, and at most MEDIA_UPLOAD_MAX_CONCURRENT_PER_BUSINESS for
 * one business so that one tenant cannot occupy every slot. Worst-case parser
 * buffer = MEDIA_UPLOAD_MAX_CONCURRENT x (fileSize + 1) = about 64 MiB.
 * THESE TWO NUMBERS ARE A MEMORY BUDGET, NOT A MEASURED NEED: they are an
 * owner-adjustable decision (a deliberate trade of upload parallelism for a
 * bounded footprint). What is NOT bounded here: the sharp decode/re-encode
 * that follows in media.service.ts (an image up to MAX_DIMENSION^2 pixels is
 * decoded to raw pixels) — that is outside the parser and outside this card.
 */
export const MEDIA_UPLOAD_MAX_CONCURRENT = 8;
export const MEDIA_UPLOAD_MAX_CONCURRENT_PER_BUSINESS = 2;

/**
 * DR-64: a multer error is a client error and must be 4xx, never 500.
 *
 * `@nestjs/platform-express` translates multer errors by comparing
 * `error.message` with fixed strings. multer 2.5.0 raises
 * LIMIT_UNEXPECTED_FILE with the message 'Unexpected file field' while Nest
 * matches 'Unexpected field', and Nest has no case at all for
 * LIMIT_FIELD_ARRAY_INDEX / INVALID_FIELD_NAME / STREAM_DESTROYED — those
 * escaped untranslated and became 500 INTERNAL_ERROR. A message is prose and
 * changes with a dependency version; `err.code` is multer's contract. This
 * table is keyed by CODE.
 *
 * The reason keys are the stable machine vocabulary of the 400 body. The
 * offending client-supplied field/file name is NOT echoed back (it is
 * attacker-controlled input and the contract names the problem, not the input).
 */
const MULTER_REFUSALS: Readonly<Record<string, { status: 400 | 413; reason: string }>> = Object.freeze({
  LIMIT_FILE_SIZE: { status: 413, reason: 'too_large' },
  LIMIT_FILE_COUNT: { status: 400, reason: 'too_many_files' },
  LIMIT_PART_COUNT: { status: 400, reason: 'too_many_parts' },
  LIMIT_FIELD_COUNT: { status: 400, reason: 'fields_not_accepted' },
  LIMIT_FIELD_VALUE: { status: 400, reason: 'field_too_large' },
  LIMIT_FIELD_KEY: { status: 400, reason: 'field_name_too_long' },
  LIMIT_FIELD_NESTING: { status: 400, reason: 'invalid_part_name' },
  LIMIT_FIELD_ARRAY_INDEX: { status: 400, reason: 'invalid_part_name' },
  LIMIT_UNEXPECTED_FILE: { status: 400, reason: 'unexpected_file_field' },
  MISSING_FIELD_NAME: { status: 400, reason: 'invalid_part_name' },
  INVALID_FIELD_NAME: { status: 400, reason: 'invalid_part_name' },
  STREAM_DESTROYED: { status: 400, reason: 'upload_aborted' },
});

/** The multer error codes this mapping knows (exported so a test can compare against multer's own list). */
export const MULTER_ERROR_CODES: readonly string[] = Object.freeze(Object.keys(MULTER_REFUSALS));

function isMulterError(e: unknown): e is { name: string; code?: unknown } {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'MulterError';
}

/**
 * Maps a MulterError to the product error contract by `err.code`. Returns
 * null for anything that is not a MulterError, so callers re-throw it
 * untouched (an AppError / HttpException / unknown bug must not be rewritten).
 * An UNKNOWN multer code is still the client's request being unacceptable
 * (multer raises only on the request it parses), so it is a 400, not a 500.
 */
export function mapMulterError(e: unknown): AppError | null {
  if (!isMulterError(e)) return null;
  const hit = typeof e.code === 'string' ? MULTER_REFUSALS[e.code] : undefined;
  if (hit === undefined) return AppError.validation({ multipart: ['rejected'] });
  if (hit.status === 413) return new AppError('MEDIA_TOO_LARGE', 'File exceeds the size limit', 413);
  return AppError.validation({ multipart: [hit.reason] });
}

/**
 * Every error the parser callback reports is about the request being parsed
 * (see MediaMultipartInterceptor): a MulterError maps by code; anything else
 * is a malformed multipart stream from busboy. Always a 4xx.
 */
export function mapUploadParseError(e: unknown): AppError {
  return mapMulterError(e) ?? AppError.validation({ multipart: ['malformed'] });
}
