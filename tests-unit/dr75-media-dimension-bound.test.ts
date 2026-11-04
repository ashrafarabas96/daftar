/**
 * DR-75 §1 — THE IMAGE DIMENSION BOUND, AND THE PROOF THAT IT PRECEDES DECODE.
 *
 * The bound already exists. `media.service.ts:17` declares
 * `const MAX_DIMENSION = 6000` and line 59 enforces it; the first `sharp()`
 * call is line 67. What did NOT exist, measured on `9abb381f` before this
 * file, is a single test that names it: `grep -rn "MAX_DIMENSION" tests
 * tests-unit` returned 0 and `grep -rn "dimensions exceed" tests tests-unit`
 * returned 0, while the same probe over `apps/` returned 4 — so the probe
 * discriminates and the absence was real. `limitInputPixels` appears 0 times
 * in project code (an earlier count of 4 was unscoped and had matched only
 * `node_modules`).
 *
 * So this file adds NO second limit and changes no product code. It is the
 * missing assertion, nothing more.
 *
 * ── WHY "400" ALONE WOULD PROVE NOTHING ───────────────────────────────────
 *
 * Six refusals stand on this path before any pixel is read:
 *
 *   1. line 38  empty buffer                 -> VALIDATION_FAILED 400
 *   2. line 40  over MEDIA_MAX_BYTES         -> MEDIA_TOO_LARGE   413
 *   3. line 42  MIME not in ALLOWED_MIME     -> MEDIA_INVALID     415
 *   4. line 47  image-size cannot parse it   -> MEDIA_INVALID     400
 *   5. line 56  magic MIME != declared MIME  -> MEDIA_INVALID     400
 *   6. line 59  a side exceeds MAX_DIMENSION -> MEDIA_INVALID     400  <- ours
 *
 * Refusals 4, 5 and 6 are the SAME code and the SAME status. A test that
 * asserted only `400` + `MEDIA_INVALID` would pass just as happily on a
 * malformed file, and would keep passing with line 59 deleted.
 *
 * ── THE DISCRIMINATOR ─────────────────────────────────────────────────────
 *
 * Two arms come out of ONE generator with ONE argument changed: the dimension.
 *
 *   refused  a REAL, fully valid 7000x7000 PNG  (measured: 156,520 bytes)
 *   accepted the same generator at 100x100
 *
 * Every property refusals 1-5 test is a property the two arms SHARE, and this
 * file asserts each one on BOTH arms rather than reasoning about it: non-empty,
 * under MEDIA_MAX_BYTES, the same declared MIME literal, parseable by
 * image-size with width/height/type, and magic agreeing with declared. The arms
 * differ in exactly one input.
 *
 * Then the two outcomes differ in a way no earlier refusal can produce:
 *
 *   — the refused arm reaches NO decoder: the `sharp` recorder below counts 0;
 *   — the accepted arm DOES reach it: the recorder counts >= 1.
 *
 * That asymmetry is the discriminator. Refusals 1-5 would also leave the
 * decoder uncalled, so "uncalled" alone proves nothing either; what proves it
 * is that when ONLY the dimension changes, the decoder runs. The refusal is
 * therefore attributable to the dimension and to nothing else on the path.
 * `sharp` is mocked for exactly this reason: "before decode" is then a COUNT,
 * not an inference from the order of lines.
 *
 * The 400 and the code are asserted too, and the prose message with them — but
 * prose is prose. The structural claim rests on the pair and the count.
 *
 * ── THE BOUND IS READ OFF THE HEADER, SO THE ATTACK IS CHEAP ──────────────
 *
 * `image-size` 2.0.4 does not verify the IHDR CRC — measured here, in both
 * directions. A 94-byte PNG can therefore DECLARE 7000x7000, and is refused
 * identically. That is the cheaper attack and it is pinned separately, because
 * the real bomb and the header lie fail at the same line for different
 * reasons about the payload.
 *
 * ── BOTH ARMS OF THE `||` ────────────────────────────────────────────────
 *
 * Line 59 is `dims.width > MAX_DIMENSION || dims.height > MAX_DIMENSION`. A
 * test that varied only the width would leave half the bound unguarded, so
 * 6001x6000 and 6000x6001 are both exercised, and 6000x6000 — the value ON the
 * limit, where `>` is strict — is asserted to pass the bound.
 *
 * ── THE ONE NUMBER THIS FILE RESTATES, AND HOW IT IS PINNED ──────────────
 *
 * `MAX_DIMENSION` is module-private and this card may not edit the service to
 * export it, so 6000 is written down twice. The duplicate is not left to rot:
 * the first case asserts the service's own source declares exactly
 * `const MAX_DIMENSION = 6000;`, so changing the product constant fails here
 * BY NAME instead of silently making this file assert the wrong boundary.
 *
 * NOT RUN HERE, and not implied: the HTTP status mapping (this asserts the
 * `AppError`'s own `httpStatus`; `tests/integration/media.test.ts:80` covers
 * the mapped body) and the real memory cost of a decode that is refused —
 * refusing it is the point, so no decode is measured.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { imageSize } from 'image-size';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppError } from '../packages/domain-core/src/errors';
import type { AppConfig } from '../apps/api/src/config';
import type { Database } from '../apps/api/src/infra/database';
import { MediaService } from '../apps/api/src/modules/catalog/media.service';
import type { AuditService, OutboxService } from '../apps/api/src/modules/audit/audit.service';
import type { MalwareScanner, ObjectStorage } from '../apps/api/src/infra/storage';
import type { MembershipContext } from '../apps/api/src/modules/tenancy/tenancy.service';

/**
 * The decoder recorder. `vi.hoisted` because the mock factory is lifted above
 * the imports: a plain module-scope `const` would be in its temporal dead zone
 * if the factory ever touched it at factory time.
 */
const decoder = vi.hoisted(() => ({ calls: [] as number[] }));

vi.mock('sharp', () => {
  const chain = (): Record<string, unknown> => ({
    rotate: () => chain(),
    resize: () => chain(),
    webp: () => chain(),
    toBuffer: async () => Buffer.from('stand-in for re-encoded bytes'),
    metadata: async () => ({ width: 1, height: 1 }),
  });
  return {
    default: (input?: unknown) => {
      decoder.calls.push(Buffer.isBuffer(input) ? input.length : -1);
      return chain();
    },
  };
});

const MAX_DIMENSION_UNDER_TEST = 6000;
const MEDIA_MAX_BYTES = 5 * 1024 * 1024;
const DECLARED_MIME = 'image/png';
const SERVICE_PATH = fileURLToPath(new URL('../apps/api/src/modules/catalog/media.service.ts', import.meta.url));

/** Low-entropy, obviously synthetic scope. */
const SCOPE = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  businessId: '22222222-2222-4222-8222-222222222222',
  userId: '33333333-3333-4333-8333-333333333333',
  roles: new Set(['owner']),
  roleKeys: ['owner'],
  branchScopeMode: 'all',
  allowedBranchIds: [],
} as unknown as MembershipContext;

type Recorder = { puts: string[]; deletes: string[]; transactions: number };
let recorder: Recorder;
let service: MediaService;

function buildService(): MediaService {
  recorder = { puts: [], deletes: [], transactions: 0 };
  const storage = {
    kind: 'recording',
    put: async (key: string) => void recorder.puts.push(key),
    delete: async (key: string) => void recorder.deletes.push(key),
    get: async () => Buffer.alloc(0),
    publicUrl: () => '',
    signedUrl: async () => '',
    healthCheck: async () => true,
  } as unknown as ObjectStorage;
  const db = {
    withTransaction: async <T>(_scope: unknown, fn: (c: unknown) => Promise<T>): Promise<T> => {
      recorder.transactions += 1;
      return fn({ query: async () => ({ rows: [], rowCount: 0 }) });
    },
  } as unknown as Database;
  return new MediaService(
    db,
    { recordTx: async () => undefined } as unknown as AuditService,
    { enqueueTx: async () => undefined } as unknown as OutboxService,
    storage,
    { enabled: false, scanClean: async () => false } as unknown as MalwareScanner,
    { MEDIA_MAX_BYTES } as unknown as AppConfig,
  );
}

const upload = (buffer: Buffer, mimetype = DECLARED_MIME): Promise<{ id: string; url: string }> =>
  service.upload(SCOPE, { buffer, mimetype, originalname: 'probe.png', size: buffer.length });

/** The refusal, or an explicit failure if the call was accepted. */
async function refusalOf(buffer: Buffer): Promise<AppError> {
  try {
    await upload(buffer);
  } catch (e) {
    return e as AppError;
  }
  throw new Error('the upload was ACCEPTED — there is no refusal to inspect');
}

// ── PNG header surgery, so a 94-byte file can declare any dimension ────────

function crc32(bytes: Buffer): number {
  const table: number[] = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of bytes) crc = (table[(crc ^ b) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Rewrites IHDR width/height and repairs the chunk CRC, so the file stays well formed. */
function declaring(src: Buffer, width: number, height: number): Buffer {
  const out = Buffer.from(src);
  out.writeUInt32BE(width, 16);
  out.writeUInt32BE(height, 20);
  out.writeUInt32BE(crc32(out.subarray(12, 29)), 29);
  return out;
}

/** Comments stripped, so a `sharp(` inside a comment cannot satisfy an ordering law. */
function sourceWithoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

let bomb: Buffer;
let small: Buffer;
let seed: Buffer;

beforeAll(async () => {
  // The REAL sharp, reached past the mock, builds the fixtures. The service
  // under test still sees the recorder.
  const actual = (await vi.importActual('sharp')) as {
    default: (i: { create: { width: number; height: number; channels: 3; background: string } }) => {
      png(o?: { compressionLevel?: number }): { toBuffer(): Promise<Buffer> };
    };
  };
  const make = (width: number, height: number): Promise<Buffer> =>
    actual
      .default({ create: { width, height, channels: 3, background: '#123456' } })
      .png({ compressionLevel: 9 })
      .toBuffer();

  // One generator, one argument changed between the two arms.
  bomb = await make(7000, 7000);
  small = await make(100, 100);
  seed = await make(4, 4);
}, 120_000);

beforeEach(() => {
  decoder.calls.length = 0;
  service = buildService();
});

describe('DR-75 §1 — a small-bytes, huge-dimensions image is refused before any decode', () => {
  it('the subject exists: the service declares MAX_DIMENSION = 6000, enforces it, and the check precedes the first decoder call', () => {
    const live = sourceWithoutComments(readFileSync(SERVICE_PATH, 'utf8'));

    // The number this file restates is pinned to the product's own declaration.
    expect(
      live,
      `this file asserts a boundary of ${MAX_DIMENSION_UNDER_TEST}. If the service's constant moved, THIS is the assertion that must fail.`,
    ).toContain(`const MAX_DIMENSION = ${MAX_DIMENSION_UNDER_TEST};`);

    const guard = live.indexOf('dims.width > MAX_DIMENSION || dims.height > MAX_DIMENSION');
    const decode = live.indexOf('sharp(');
    // Positive control for the stripper: it must not have eaten the subjects.
    expect(guard, 'the dimension guard is not in the stripped source — the comment stripper ate it').toBeGreaterThan(-1);
    expect(decode, 'no decoder call is in the stripped source — the comment stripper ate it').toBeGreaterThan(-1);
    expect(guard, 'the dimension guard must stand BEFORE the first decoder call').toBeLessThan(decode);
  });

  it('REFUSED: a real, valid 7000x7000 PNG is refused 400 MEDIA_INVALID, and no decoder, storage write or transaction is reached', async () => {
    const err = await refusalOf(bomb);

    expect(err.code, 'the refusal names the media contract').toBe('MEDIA_INVALID');
    expect(err.httpStatus, 'a client error, not a 500 and not a 413').toBe(400);
    expect(err.message).toBe('Image dimensions exceed limits');

    // "Before decode", as a count rather than as an inference.
    expect(decoder.calls, `the decoder was handed ${decoder.calls.length} buffer(s); the bound exists so that it is handed none`).toEqual([]);
    expect(recorder.puts, 'nothing was written to storage').toEqual([]);
    expect(recorder.transactions, 'no transaction was opened').toBe(0);
    expect(recorder.deletes, 'and so there was nothing to compensate').toEqual([]);
  });

  it('ACCEPTED: the same generator at 100x100 reaches the decoder and completes — so the dimension is what the refusal turned on', async () => {
    const out = await upload(small);

    expect(out.id, 'the accepted arm produced a media id').toMatch(/[0-9a-f-]{36}/i);
    expect(decoder.calls.length, 'the decoder WAS reached on this arm').toBeGreaterThanOrEqual(1);
    expect(decoder.calls[0], 'and it was handed the submitted bytes').toBe(small.length);
    expect(recorder.puts.length, 'and the original was stored').toBeGreaterThanOrEqual(1);
  });

  it('THE DISCRIMINATOR: every refusal earlier on this path is a property BOTH arms satisfy, so only the dimension can explain the difference', () => {
    const b = imageSize(bomb);
    const s = imageSize(small);

    // 1 (line 38) — neither arm is empty.
    expect(bomb.length, 'the bomb is non-empty').toBeGreaterThan(0);
    expect(small.length, 'the control is non-empty').toBeGreaterThan(0);

    // 2 (line 40) — neither arm reaches MEDIA_MAX_BYTES. This is the whole
    // point of the case: huge dimensions at small byte cost.
    expect(bomb.length, `the bomb is ${bomb.length} bytes, well under the ${MEDIA_MAX_BYTES}-byte limit`).toBeLessThan(MEDIA_MAX_BYTES);
    expect(small.length).toBeLessThan(MEDIA_MAX_BYTES);

    // 3 (line 42) — both arms are submitted under the same allowed MIME literal.
    expect(DECLARED_MIME).toBe('image/png');

    // 4 (lines 47-54) — image-size parses both, with all three fields.
    expect(
      [b.width, b.height, b.type].every((v) => Boolean(v)),
      'image-size parses the bomb',
    ).toBe(true);
    expect(
      [s.width, s.height, s.type].every((v) => Boolean(v)),
      'image-size parses the control',
    ).toBe(true);

    // 5 (lines 56-58) — magic agrees with declared on both arms.
    expect(`image/${b.type}`, 'the bomb is genuinely a PNG').toBe(DECLARED_MIME);
    expect(`image/${s.type}`, 'the control is genuinely a PNG').toBe(DECLARED_MIME);

    // 6 (line 59) — THE ONLY DIFFERENCE BETWEEN THE TWO ARMS.
    expect(Math.max(b.width ?? 0, b.height ?? 0), 'the bomb exceeds the bound').toBeGreaterThan(MAX_DIMENSION_UNDER_TEST);
    expect(Math.max(s.width ?? 0, s.height ?? 0), 'the control does not').toBeLessThanOrEqual(MAX_DIMENSION_UNDER_TEST);
  });

  it('the bound is read off the declared header, so the attack costs 94 bytes: image-size does not verify the IHDR CRC', async () => {
    const lie = declaring(seed, 7000, 7000);

    // The patcher is honest in both directions: identity at the seed's own
    // dimensions, and observed at the patched ones.
    expect(imageSize(declaring(seed, 4, 4)).width, 'the patcher is identity-safe').toBe(4);
    expect(imageSize(lie).width, 'and the patched header is what image-size reports').toBe(7000);

    // A buffer whose CRC was NOT repaired is still accepted by image-size —
    // measured, because it is why the attack is this cheap.
    const unrepaired = Buffer.from(seed);
    unrepaired.writeUInt32BE(7000, 16);
    unrepaired.writeUInt32BE(7000, 20);
    expect(imageSize(unrepaired).width, 'image-size trusts IHDR without checking its CRC').toBe(7000);

    expect(lie.length, 'the whole payload is smaller than a kilobyte').toBeLessThan(1024);

    const err = await refusalOf(lie);
    expect(err.code).toBe('MEDIA_INVALID');
    expect(err.httpStatus).toBe(400);
    expect(err.message).toBe('Image dimensions exceed limits');
    expect(decoder.calls, 'a header lie is refused before decode exactly as the real bomb is').toEqual([]);
  });

  it('the boundary is strict, and BOTH arms of the `||` refuse: 6000 passes, 6001 wide refuses, 6001 tall refuses', async () => {
    // ON the limit: `>` is strict, so 6000 must pass the bound and reach decode.
    service = buildService();
    decoder.calls.length = 0;
    await upload(declaring(seed, MAX_DIMENSION_UNDER_TEST, MAX_DIMENSION_UNDER_TEST));
    expect(decoder.calls.length, `${MAX_DIMENSION_UNDER_TEST} is ON the limit and the comparison is strict, so it passes the bound`).toBeGreaterThanOrEqual(1);

    // One minor unit over, on each side independently.
    for (const [w, h, arm] of [
      [MAX_DIMENSION_UNDER_TEST + 1, MAX_DIMENSION_UNDER_TEST, 'the WIDTH arm'],
      [MAX_DIMENSION_UNDER_TEST, MAX_DIMENSION_UNDER_TEST + 1, 'the HEIGHT arm'],
    ] as const) {
      service = buildService();
      decoder.calls.length = 0;
      const err = await refusalOf(declaring(seed, w, h));
      expect(err.message, `${arm}: ${w}x${h} is one unit over and must be refused`).toBe('Image dimensions exceed limits');
      expect(err.httpStatus).toBe(400);
      expect(decoder.calls, `${arm}: and refused before decode`).toEqual([]);
    }
  });
});
