import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ExecutionContext } from '@nestjs/common';
import { Subject } from 'rxjs';
import sharp from 'sharp';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { AppError } from '@daftar/domain-core';
import {
  MEDIA_UPLOAD_LIMITS,
  MEDIA_UPLOAD_MAX_CONCURRENT,
  MEDIA_UPLOAD_MAX_CONCURRENT_PER_BUSINESS,
  MULTER_ERROR_CODES,
  mapMulterError,
  mapUploadParseError,
} from '../../apps/api/src/modules/catalog/media-upload-limits';
import { UploadAdmissionInterceptor } from '../../apps/api/src/modules/catalog/media-upload.interceptors';
import { createTestApp, resetData, uniqueEmail, type TestApp } from '../helpers/test-app';

/**
 * DR-71 section 2 — the multipart limits of `POST /v1/catalog/media`.
 *
 * Before: `FileInterceptor('file', { limits: { fileSize } })` — `fileSize` and
 * nothing else, so a request with thousands of parts or fields was bounded
 * only by Node's own defaults. After: `files`, `fields`, `parts` and
 * `fieldSize` are explicit and DERIVED FROM A MEASUREMENT (section A below
 * re-derives it from the request the web client really builds).
 *
 * THE SUITE IS ORGANISED BY WHAT EACH CASE CAN AND CANNOT PROVE
 *
 *  A  need        what the endpoint's clients send (the source of the numbers)
 *  B  parser      each limit in ISOLATION, on a bare multer instance fed the
 *                 shared constant with every other limit left at its default.
 *                 This is the only place `parts` and `fieldSize` can be proved
 *                 at all, because over HTTP they are SHADOWED (see C.shadow).
 *  C  http        the real app, every REACHABLE limit, status + code
 *  D  DR-64       a multer error is a 4xx by `err.code`, never a 500
 *  E  order       authentication runs BEFORE the parser (documented, tested)
 *  F  admission   the memory bound (concurrent-upload cap) and slot release
 *
 * NEGATIVE CONTROLS (each was PLANTED, with the file digest printed before and
 * after the plant, and the file restored byte-for-byte; the result is in the
 * commit message and the report): removing exactly one limit from
 * MEDIA_UPLOAD_LIMITS reddens, BY NAME, the B-case of that limit — and, for
 * the three reachable ones, its C-case too. `parts` and `fieldSize` redden
 * only their B-case: that is the honest statement of what an HTTP request can
 * reach, not a gap in the control.
 *
 * WHAT WOULD MAKE A GREEN HERE VACUOUS
 *  - B proves the CONSTANT, not that the controller passes it. C proves the
 *    wiring for the three reachable limits; for `parts`/`fieldSize` the wiring
 *    is pinned structurally by `controller wiring` below (comment-stripped
 *    source, with a positive control for the stripper). Delete that case and
 *    nothing HTTP-visible notices a controller that stopped passing them.
 *  - E's oversize/unauthenticated case accepts a reset socket as well as a 401
 *    (a server that answers 401 and closes may reset a client still writing 8
 *    MiB). The count-based case in the same block is the one that cannot be
 *    satisfied by a socket error.
 */

const require_ = createRequire(import.meta.url);

// ───────────────────────── helpers ─────────────────────────

/**
 * The MEASURED NEED, written out as literals on purpose (section A derives the
 * same numbers from the clients). Payload sizes below are taken from HERE, not
 * from the constant under test: a test that built its payload from the
 * constant would CRASH (NaN) when a limit is removed instead of failing an
 * assertion, and a red caused by a crash is not evidence that the limit was
 * the thing being checked.
 */
const EXPECTED = Object.freeze({ fileSize: 8 * 1024 * 1024, files: 1, fields: 0, parts: 1, fieldSize: 0 });

const noise = (bytes: number): Buffer => Buffer.alloc(bytes, 0x5a);

function stripLineAndBlockComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function countParts(serialised: string): { files: number; fields: number } {
  let files = 0;
  let fields = 0;
  for (const m of serialised.matchAll(/Content-Disposition: form-data; name="[^"]*"(; filename="[^"]*")?/gi)) {
    if (m[1]) files += 1;
    else fields += 1;
  }
  return { files, fields };
}

// ───────────────────────── A. the need ─────────────────────────

describe('DR-71 A. what the endpoint needs — the numbers are re-derived, not quoted', () => {
  it('the request the WEB client builds has exactly 1 file part and 0 fields; the constants equal that', async () => {
    // apps/web/src/lib/merchant-api.ts uploadMedia: `const form = new FormData(); form.append('file', file)`.
    const form = new FormData();
    form.append('file', new Blob([noise(16)], { type: 'image/png' }), 'a.png');
    const serialised = await new Response(form).text();
    const web = countParts(serialised);

    // Positive control for the counter: it does see a field and a second file when they exist.
    const wider = new FormData();
    wider.append('file', new Blob([noise(4)]), 'a.png');
    wider.append('note', 'x');
    wider.append('file', new Blob([noise(4)]), 'b.png');
    expect(countParts(await new Response(wider).text()), 'the part counter must be able to see fields and extra files').toEqual({ files: 2, fields: 1 });

    expect(web).toEqual({ files: 1, fields: 0 });
    expect(MEDIA_UPLOAD_LIMITS, 'the shared constant is exactly the measured need, all five keys').toEqual(EXPECTED);
    expect(MEDIA_UPLOAD_LIMITS.files).toBe(web.files);
    expect(MEDIA_UPLOAD_LIMITS.fields).toBe(web.fields);
    expect(MEDIA_UPLOAD_LIMITS.parts).toBe(web.files + web.fields);
  });

  it('the ANDROID client builds one multipart part with the same shape (source, comment-stripped; a quotation, not an execution)', () => {
    const path = join(__dirname, '../../apps/android/app/src/main/java/app/daftar/data/ApiClient.kt');
    const raw = readFileSync(path, 'utf8');
    const code = stripLineAndBlockComments(raw);
    // Positive control: the stripper removes a seeded commented-out call and keeps a live one.
    expect(stripLineAndBlockComments('// x.addFormDataPart(a)\nlive.addFormDataPart(b)')).not.toMatch(/\/\/ x/);
    expect(stripLineAndBlockComments('// x.addFormDataPart(a)\nlive.addFormDataPart(b)')).toMatch(/live\.addFormDataPart/);
    expect(code, 'the Android upload builds a MultipartBody').toMatch(/MultipartBody\.Builder\(\)/);
    const calls = code.match(/addFormDataPart\(/g) ?? [];
    expect(calls.length, 'exactly one part is added: the file').toBe(1);
    const call = code.slice(code.indexOf('addFormDataPart('));
    expect(call.slice(0, call.indexOf(')\n') + 1), 'it is the 3-argument (name, filename, body) form, i.e. a FILE part').toMatch(
      /fieldName[\s\S]*fileName[\s\S]*toRequestBody/,
    );
  });
});

// ───────────────────────── B. parser, each limit in isolation ─────────────────────────

interface ParserOutcome {
  ok: boolean;
  code?: string;
}

/** A bare multer+express app whose ONLY limit is the one passed in. Everything else is multer's default. */
async function parserOutcome(limits: Record<string, number | undefined>, build: (fd: FormData) => void): Promise<ParserOutcome> {
  const express = require_('express') as () => {
    post: (p: string, h: (req: unknown, res: { json: (b: unknown) => void }) => void) => void;
    listen: (port: number, cb: () => void) => http.Server;
  };
  const multer = require_('multer') as ((o: unknown) => {
    single: (n: string) => (req: unknown, res: unknown, cb: (e?: { code?: string }) => void) => void;
  }) & {
    memoryStorage: () => unknown;
  };
  const app = express();
  const up = multer({ storage: multer.memoryStorage(), limits }).single('file');
  app.post('/', (req, res) => up(req, res, (err) => res.json(err ? { ok: false, code: err.code } : { ok: true })));
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    const fd = new FormData();
    build(fd);
    const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`, { method: 'POST', body: fd });
    return (await r.json()) as ParserOutcome;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const only = (key: keyof typeof MEDIA_UPLOAD_LIMITS): Record<string, number | undefined> => ({ [key]: MEDIA_UPLOAD_LIMITS[key] });
const small = (n = 8): Blob => new Blob([noise(n)]);

describe('DR-71 B. each limit in isolation on the parser, fed the SHARED constant (the only place parts/fieldSize can be proved)', () => {
  it('LIMIT fileSize: one byte over is refused LIMIT_FILE_SIZE, exactly at the limit is accepted', async () => {
    const over = await parserOutcome(only('fileSize'), (fd) => fd.append('file', small(EXPECTED.fileSize + 1), 'a.png'));
    expect(over).toEqual({ ok: false, code: 'LIMIT_FILE_SIZE' });
    const at = await parserOutcome(only('fileSize'), (fd) => fd.append('file', small(EXPECTED.fileSize), 'a.png'));
    expect(at, 'the boundary is inclusive: a file of exactly fileSize bytes is the largest accepted').toEqual({ ok: true });
  });

  it('LIMIT files: a second file part is refused LIMIT_FILE_COUNT, one is accepted', async () => {
    expect(await parserOutcome(only('files'), (fd) => fd.append('file', small(), 'a.png'))).toEqual({ ok: true });
    const two = await parserOutcome(only('files'), (fd) => {
      fd.append('file', small(), 'a.png');
      fd.append('file', small(), 'b.png');
    });
    expect(two).toEqual({ ok: false, code: 'LIMIT_FILE_COUNT' });
  });

  it('LIMIT fields: any text field is refused LIMIT_FIELD_COUNT, none is accepted', async () => {
    expect(await parserOutcome(only('fields'), (fd) => fd.append('file', small(), 'a.png'))).toEqual({ ok: true });
    const withField = await parserOutcome(only('fields'), (fd) => {
      fd.append('file', small(), 'a.png');
      fd.append('note', 'x');
    });
    expect(withField).toEqual({ ok: false, code: 'LIMIT_FIELD_COUNT' });
  });

  it('LIMIT parts: a second part is refused LIMIT_PART_COUNT, one part is accepted', async () => {
    expect(await parserOutcome(only('parts'), (fd) => fd.append('file', small(), 'a.png'))).toEqual({ ok: true });
    const two = await parserOutcome(only('parts'), (fd) => {
      fd.append('file', small(), 'a.png');
      fd.append('note', 'x');
    });
    expect(two).toEqual({ ok: false, code: 'LIMIT_PART_COUNT' });
  });

  it('LIMIT fieldSize: a field value one byte over is refused LIMIT_FIELD_VALUE (and an empty value is accepted)', async () => {
    const over = await parserOutcome(only('fieldSize'), (fd) => {
      fd.append('file', small(), 'a.png');
      fd.append('note', 'x'.repeat(EXPECTED.fieldSize + 1));
    });
    expect(over).toEqual({ ok: false, code: 'LIMIT_FIELD_VALUE' });
    const empty = await parserOutcome(only('fieldSize'), (fd) => {
      fd.append('file', small(), 'a.png');
      fd.append('note', '');
    });
    expect(empty, 'a zero-length value is within fieldSize 0').toEqual({ ok: true });
  });

  it('PROBE (the shadowing the constants file documents): with the full constant, fields/files refuse BEFORE parts and fieldSize are consulted', async () => {
    const full = { ...MEDIA_UPLOAD_LIMITS };
    const fieldAndFile = await parserOutcome(full, (fd) => {
      fd.append('file', small(), 'a.png');
      fd.append('note', 'x'.repeat(2 * 1024 * 1024));
    });
    expect(fieldAndFile, 'an oversized field is refused as a FIELD, not as a field VALUE').toEqual({ ok: false, code: 'LIMIT_FIELD_COUNT' });
    const twoFiles = await parserOutcome(full, (fd) => {
      fd.append('file', small(), 'a.png');
      fd.append('file', small(), 'b.png');
    });
    expect(twoFiles, 'a second part that is a file is refused as a FILE, not as a PART').toEqual({ ok: false, code: 'LIMIT_FILE_COUNT' });
  });
});

// ───────────────────────── D (pure part). DR-64 mapping ─────────────────────────

describe('DR-71 D. DR-64 — a multer error maps to 4xx by err.code, never 500', () => {
  const multerDir = dirname(require_.resolve('multer'));
  const { MulterError } = require_('multer') as { MulterError: new (code: string, field?: string) => Error & { code: string } };
  const multerCodes = [...readFileSync(join(multerDir, 'lib/multer-error.js'), 'utf8').matchAll(/^\s{2}([A-Z_]+):\s*'/gm)].map((m) => m[1] as string);

  it("multer's own code list is read from the installed package (positive control: it is not empty and contains the code that caused the 500)", () => {
    expect(multerCodes.length).toBeGreaterThanOrEqual(10);
    expect(multerCodes).toContain('LIMIT_UNEXPECTED_FILE');
    expect(multerCodes).toContain('LIMIT_FILE_SIZE');
  });

  it('every code multer can raise is classified in the table — a new code on upgrade fails here, not in production', () => {
    for (const c of multerCodes) expect(MULTER_ERROR_CODES, `multer raises ${c}; the mapping has no row for it`).toContain(c);
  });

  it('every multer code maps to an AppError with a 4xx status (never 5xx)', () => {
    for (const c of multerCodes) {
      const mapped = mapMulterError(new MulterError(c, 'f'));
      expect(mapped, c).toBeInstanceOf(AppError);
      expect(mapped?.httpStatus, c).toBeGreaterThanOrEqual(400);
      expect(mapped?.httpStatus, c).toBeLessThan(500);
    }
  });

  it('the mapping keys on err.code, NOT on message: the message that made Nest miss LIMIT_UNEXPECTED_FILE changes nothing', () => {
    const e = new MulterError('LIMIT_UNEXPECTED_FILE', 'attachment');
    expect(e.message, 'the message multer 2.5.0 really uses (and Nest does not match)').toBe('Unexpected file field');
    expect(mapMulterError(e)?.details).toEqual({ multipart: ['unexpected_file_field'] });
    const renamed = Object.assign(new MulterError('LIMIT_UNEXPECTED_FILE', 'attachment'), { message: 'Unexpected field' });
    expect(mapMulterError(renamed)?.details, 'same code, different prose, same answer').toEqual({ multipart: ['unexpected_file_field'] });
    const wrongCode = Object.assign(new MulterError('LIMIT_FILE_COUNT'), { message: 'Unexpected file field' });
    expect(mapMulterError(wrongCode)?.details, 'same prose, different code, different answer').toEqual({ multipart: ['too_many_files'] });
  });

  it("an UNKNOWN multer code is still a 400 (a request multer cannot parse is the client's), and the client field name is never echoed", () => {
    const mapped = mapMulterError(Object.assign(new MulterError('LIMIT_UNEXPECTED_FILE', 'attacker-chosen-name'), { code: 'SOMETHING_NEW' }));
    expect(mapped?.httpStatus).toBe(400);
    expect(JSON.stringify(mapped?.details)).not.toContain('attacker-chosen-name');
    expect(JSON.stringify(mapMulterError(new MulterError('LIMIT_UNEXPECTED_FILE', 'attacker-chosen-name'))?.details)).not.toContain('attacker-chosen-name');
  });

  it('only MulterErrors are rewritten by code; a stream busboy cannot parse is still a 400 (malformed), never a 500', () => {
    expect(mapMulterError(AppError.forbidden())).toBeNull();
    expect(mapMulterError(new Error('boom'))).toBeNull();
    expect(mapMulterError(null)).toBeNull();
    const malformed = mapUploadParseError(new Error('Unexpected end of form'));
    expect(malformed.httpStatus).toBe(400);
    expect(malformed.code).toBe('VALIDATION_FAILED');
    expect(malformed.details).toEqual({ multipart: ['malformed'] });
    expect(JSON.stringify(malformed.details), 'busboy prose is not forwarded').not.toContain('Unexpected end of form');
  });

  it('controller wiring (structural, comment-stripped): the route uses exactly UploadAdmissionInterceptor then MediaMultipartInterceptor, and no inline limits literal remains', () => {
    const ctrl = stripLineAndBlockComments(readFileSync(join(__dirname, '../../apps/api/src/modules/catalog/catalog.controller.ts'), 'utf8'));
    const iface = stripLineAndBlockComments(readFileSync(join(__dirname, '../../apps/api/src/modules/catalog/media-upload.interceptors.ts'), 'utf8'));
    expect(ctrl, 'positive control: the stripped controller still contains the route').toMatch(/@Post\('media'\)/);
    expect(ctrl).toMatch(/@UseInterceptors\(UploadAdmissionInterceptor,\s*MediaMultipartInterceptor\)/);
    expect(ctrl, 'no limits literal is left in the controller').not.toMatch(/limits\s*:/);
    expect(ctrl, 'the framework FileInterceptor (message-keyed translation) is not used').not.toMatch(/FileInterceptor/);
    expect(iface, 'the parser is built from the shared constant, not a copy').toMatch(/limits:\s*\{\s*\.\.\.MEDIA_UPLOAD_LIMITS\s*\}/);
  });
});

// ───────────────────────── F (pure part). admission ─────────────────────────

describe('DR-71 F. memory bound — the admission interceptor (unit)', () => {
  const ctx = (businessId: string): ExecutionContext =>
    ({ switchToHttp: () => ({ getRequest: () => ({ membership: { businessId } }) }) }) as unknown as ExecutionContext;

  function acquire(gate: UploadAdmissionInterceptor, businessId: string): { subject: Subject<unknown>; error: unknown[]; unsubscribe: () => void } {
    const subject = new Subject<unknown>();
    const error: unknown[] = [];
    const sub = gate.intercept(ctx(businessId), { handle: () => subject.asObservable() }).subscribe({ error: (e) => error.push(e) });
    return { subject, error, unsubscribe: () => sub.unsubscribe() };
  }

  it(`at most ${MEDIA_UPLOAD_MAX_CONCURRENT_PER_BUSINESS} uploads per business hold a slot; the next is 429 RATE_LIMITED`, () => {
    const gate = new UploadAdmissionInterceptor();
    const held = Array.from({ length: MEDIA_UPLOAD_MAX_CONCURRENT_PER_BUSINESS }, () => acquire(gate, 'biz-a'));
    const refused = acquire(gate, 'biz-a');
    expect(refused.error[0]).toBeInstanceOf(AppError);
    expect((refused.error[0] as AppError).httpStatus).toBe(429);
    expect((refused.error[0] as AppError).code).toBe('RATE_LIMITED');
    // Another business is not starved by biz-a's slots.
    const other = acquire(gate, 'biz-b');
    expect(other.error, 'a different business still gets a slot').toEqual([]);
    held.forEach((h) => h.unsubscribe());
    other.unsubscribe();
  });

  it(`at most ${MEDIA_UPLOAD_MAX_CONCURRENT} uploads parse at once across the process`, () => {
    const gate = new UploadAdmissionInterceptor();
    const held = Array.from({ length: MEDIA_UPLOAD_MAX_CONCURRENT }, (_, i) => acquire(gate, `biz-${i}`));
    for (const h of held) expect(h.error).toEqual([]);
    const refused = acquire(gate, 'biz-overflow');
    expect((refused.error[0] as AppError).httpStatus, 'the global cap is hit although this business holds none').toBe(429);
    held.forEach((h) => h.unsubscribe());
  });

  it('a slot is released on completion, on error AND on client disconnect — otherwise the cap becomes a self-inflicted outage', () => {
    const gate = new UploadAdmissionInterceptor();
    const fill = (): ReturnType<typeof acquire>[] => Array.from({ length: MEDIA_UPLOAD_MAX_CONCURRENT_PER_BUSINESS }, () => acquire(gate, 'biz-r'));
    for (const how of ['complete', 'error', 'disconnect'] as const) {
      const held = fill();
      expect(acquire(gate, 'biz-r').error, `${how}: full`).toHaveLength(1);
      for (const h of held) {
        if (how === 'complete') h.subject.complete();
        else if (how === 'error') h.subject.error(new Error('parser failed'));
        else h.unsubscribe();
      }
      const after = acquire(gate, 'biz-r');
      expect(after.error, `${how}: the slot came back`).toEqual([]);
      after.unsubscribe();
    }
  });
});

// ───────────────────────── C/E/F over the real app ─────────────────────────

describe('DR-71 C/D/E. the real app: every reachable limit, the 4xx contract and the authentication order', () => {
  let t: TestApp;
  let token: string;
  let businessId: string;
  const SERVICE_LIMIT = 2 * EXPECTED.fileSize; // lifts the service limit so the PARSER is the first limit met (same technique as t10-upload-limit-contract)

  beforeAll(async () => {
    t = await createTestApp({ configOverrides: { MEDIA_MAX_BYTES: String(SERVICE_LIMIT) } });
    await resetData();
    const reg = await t.request.post('/v1/auth/register').send({ email: uniqueEmail(), password: 'Str0ng!Passw0rd', displayName: 'U', preferredLocale: 'ar' });
    token = reg.body.accessToken as string;
    const on = await t.request
      .post('/v1/onboarding/complete')
      .set('Idempotency-Key', `idem-${Date.now()}-${Math.floor(Math.random() * 1e9)}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ businessName: 'Upload Co', countryCode: 'PS', baseCurrency: 'ILS', storeSlug: `dr71-${Date.now()}-${Math.floor(Math.random() * 1e6)}` });
    businessId = on.body.businessId as string;
  });
  afterAll(async () => {
    await t.close();
  });

  const auth = (): Record<string, string> => ({ Authorization: `Bearer ${token}`, 'X-Business-Id': businessId });
  const err = (res: { body?: { error?: Record<string, unknown> } }): Record<string, unknown> => res.body?.error ?? {};

  /** The contract every refused multipart request must satisfy: 4xx, a stable product code, and no leaked prose. */
  function expectRefusal(res: { status: number; body?: { error?: Record<string, unknown> } }, status: number, code: string, reason?: string): void {
    expect(res.status).toBe(status);
    expect(res.status, 'DR-64: never a 5xx').toBeLessThan(500);
    expect(err(res).code).toBe(code);
    expect(err(res).code).not.toBe('INTERNAL_ERROR');
    const wire = JSON.stringify(res.body);
    expect(wire, 'multer prose never reaches the client').not.toMatch(
      /Unexpected file field|Too many files|Too many fields|Too many parts|File too large|Field value too long/i,
    );
    expect(wire, 'no stack and no module path reaches the client').not.toMatch(/node_modules|MulterError|at .*\(.*:\d+:\d+\)/);
    if (reason !== undefined) expect((err(res).details as { multipart?: string[] } | undefined)?.multipart).toEqual([reason]);
  }

  // ── C. reachable limits ──
  it('C.fileSize: one byte over the limit is 413 MEDIA_TOO_LARGE; exactly at the limit is NOT refused for size', async () => {
    const over = await t.request
      .post('/v1/catalog/media')
      .set(auth())
      .attach('file', noise(EXPECTED.fileSize + 1), { filename: 'over.png', contentType: 'image/png' });
    expectRefusal(over, 413, 'MEDIA_TOO_LARGE');
    const at = await t.request.post('/v1/catalog/media').set(auth()).attach('file', noise(EXPECTED.fileSize), { filename: 'at.png', contentType: 'image/png' });
    expect(at.status, 'inside the limit the bytes reach the media service, which refuses them on content').not.toBe(413);
    expect(err(at).code).not.toBe('MEDIA_TOO_LARGE');
  });

  it('C.files: a second file part is 400 VALIDATION_FAILED (too_many_files), never a 500', async () => {
    const res = await t.request
      .post('/v1/catalog/media')
      .set(auth())
      .attach('file', noise(32), { filename: 'a.png', contentType: 'image/png' })
      .attach('file', noise(32), { filename: 'b.png', contentType: 'image/png' });
    expectRefusal(res, 400, 'VALIDATION_FAILED', 'too_many_files');
  });

  it('C.fields: a text field alongside the file is 400 VALIDATION_FAILED (fields_not_accepted)', async () => {
    const res = await t.request
      .post('/v1/catalog/media')
      .set(auth())
      .field('note', 'x')
      .attach('file', noise(32), { filename: 'a.png', contentType: 'image/png' });
    expectRefusal(res, 400, 'VALIDATION_FAILED', 'fields_not_accepted');
  });

  it('C.fields: a field and no file at all is the same refusal, not "missing file" and not a crash', async () => {
    const res = await t.request.post('/v1/catalog/media').set(auth()).field('note', 'x');
    expectRefusal(res, 400, 'VALIDATION_FAILED', 'fields_not_accepted');
  });

  it('C.shadow (documented, asserted so a reordering is noticed): over HTTP an oversized field and an extra file are refused as a FIELD and a FILE, so parts/fieldSize are not what answers', async () => {
    const bigField = await t.request
      .post('/v1/catalog/media')
      .set(auth())
      .field('note', 'x'.repeat(2 * 1024 * 1024))
      .attach('file', noise(32), { filename: 'a.png', contentType: 'image/png' });
    expectRefusal(bigField, 400, 'VALIDATION_FAILED', 'fields_not_accepted');
    const extra = await t.request
      .post('/v1/catalog/media')
      .set(auth())
      .attach('file', noise(32), { filename: 'a.png', contentType: 'image/png' })
      .attach('other', noise(32), { filename: 'b.png', contentType: 'image/png' });
    // `other` is a file under a name the route does not take: the file COUNT is exceeded first.
    expect(extra.status).toBe(400);
    expect(['too_many_files', 'unexpected_file_field']).toContain((err(extra).details as { multipart: string[] }).multipart[0]);
  });

  // ── D. DR-64 over HTTP ──
  it('D.DR-64: a part under the wrong field name is 400 VALIDATION_FAILED (unexpected_file_field) — it was a 500 INTERNAL_ERROR', async () => {
    const res = await t.request.post('/v1/catalog/media').set(auth()).attach('attachment', noise(64), { filename: 'x.png', contentType: 'image/png' });
    expectRefusal(res, 400, 'VALIDATION_FAILED', 'unexpected_file_field');
    expect(JSON.stringify(res.body), 'the attacker-chosen field name is not reflected').not.toContain('attachment');
  });

  it('C.positive: a real image inside every limit is accepted, so the limits are not just refusing everything', async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } } })
      .png()
      .toBuffer();
    const res = await t.request.post('/v1/catalog/media').set(auth()).attach('file', png, { filename: 'ok.png', contentType: 'image/png' });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    expect(res.body?.id).toBeTruthy();
  });

  // ── E. order ──
  it('E.order: the SAME parser-violating body is refused by the parser for an authenticated caller, and by authentication (401) for an anonymous one', async () => {
    const twoFiles = (r: ReturnType<typeof t.request.post>): ReturnType<typeof t.request.post> =>
      r.attach('file', noise(32), { filename: 'a.png', contentType: 'image/png' }).attach('file', noise(32), { filename: 'b.png', contentType: 'image/png' });
    const authed = await twoFiles(t.request.post('/v1/catalog/media').set(auth()));
    expect(err(authed).code, 'positive control: this body IS refused by the parser when it is reached').toBe('VALIDATION_FAILED');
    const anon = await twoFiles(t.request.post('/v1/catalog/media'));
    expect(anon.status, 'authentication runs before the multipart parser: an anonymous caller never reaches it').toBe(401);
    expect(err(anon).code).toBe('UNAUTHENTICATED');
    expect(JSON.stringify(anon.body)).not.toMatch(/too_many_files/);
  });

  it('E.order: an invalid bearer token is refused as 401 before an over-limit body is parsed (a reset socket is tolerated, a 413 is not)', async () => {
    let status: number | null = null;
    try {
      const res = await t.request
        .post('/v1/catalog/media')
        .set({ Authorization: 'Bearer not.a.token', 'X-Business-Id': businessId })
        .attach('file', noise(EXPECTED.fileSize + 1), { filename: 'over.png', contentType: 'image/png' });
      status = res.status;
    } catch (e) {
      expect((e as { code?: string }).code ?? (e as Error).message, 'a server that answers 401 and closes may reset a client still writing').toMatch(
        /ECONNRESET|EPIPE|socket hang up/i,
      );
    }
    if (status !== null) expect(status).toBe(401);
    expect(status, 'never 413: the parser did not run for an unauthenticated caller').not.toBe(413);
  });
});

// ───────────────────────── F. admission over the real app ─────────────────────────

describe('DR-71 F. memory bound over the real app: in-flight uploads hold slots, a business cannot exceed its cap, and a dropped connection returns its slot', () => {
  let t: TestApp;
  let token: string;
  let businessId: string;
  let port: number;

  beforeAll(async () => {
    t = await createTestApp();
    await resetData();
    const reg = await t.request.post('/v1/auth/register').send({ email: uniqueEmail(), password: 'Str0ng!Passw0rd', displayName: 'U', preferredLocale: 'ar' });
    token = reg.body.accessToken as string;
    const on = await t.request
      .post('/v1/onboarding/complete')
      .set('Idempotency-Key', `idem-${Date.now()}-${Math.floor(Math.random() * 1e9)}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ businessName: 'Slots Co', countryCode: 'PS', baseCurrency: 'ILS', storeSlug: `dr71s-${Date.now()}-${Math.floor(Math.random() * 1e6)}` });
    businessId = on.body.businessId as string;
    await t.app.listen(0, '127.0.0.1');
    port = (t.app.getHttpServer().address() as AddressInfo).port;
  });
  afterAll(async () => {
    await t.close();
  });

  /** Opens an upload that has sent its headers and the start of the file part, then stalls. */
  function stalledUpload(): Promise<http.ClientRequest> {
    return new Promise((resolve, reject) => {
      const boundary = '----dr71stall';
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/v1/catalog/media',
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Business-Id': businessId,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(5_000_000),
        },
      });
      req.on('error', () => undefined);
      req.write(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`);
      req.write(noise(1024), (e) => (e ? reject(e) : resolve(req)));
    });
  }

  const probe = async (): Promise<{ status: number; code: unknown }> => {
    const res = await t.request
      .post('/v1/catalog/media')
      .set({ Authorization: `Bearer ${token}`, 'X-Business-Id': businessId })
      .attach('file', noise(32), { filename: 'p.png', contentType: 'image/png' });
    return { status: res.status, code: res.body?.error?.code };
  };

  async function waitFor(cond: () => Promise<boolean>, what: string, ms = 15_000): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await cond()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timed out waiting for: ${what}`);
  }

  it(`with ${MEDIA_UPLOAD_MAX_CONCURRENT_PER_BUSINESS} uploads in flight the next one is 429 RATE_LIMITED before its body is parsed, and a dropped connection returns the slot`, async () => {
    const baseline = await probe();
    expect(baseline.code, 'positive control: with nothing in flight a small upload is NOT rate limited (it dies on content)').not.toBe('RATE_LIMITED');

    const holders: http.ClientRequest[] = [];
    for (let i = 0; i < MEDIA_UPLOAD_MAX_CONCURRENT_PER_BUSINESS; i += 1) holders.push(await stalledUpload());

    try {
      await waitFor(async () => (await probe()).status === 429, 'the third upload to be refused while two stall');
      const refused = await probe();
      expect(refused).toEqual({ status: 429, code: 'RATE_LIMITED' });
    } finally {
      // never leave a stalled socket behind: an open upload keeps app.close() waiting
      holders.forEach((h) => h.destroy());
    }
    await waitFor(async () => (await probe()).status !== 429, 'the slots to come back after the clients dropped');
    const after = await probe();
    expect(after.code, 'after the disconnect the slot is free again').not.toBe('RATE_LIMITED');
  });
});
