/**
 * DR-11 — WHAT A CLIENT MAY RELY ON WHEN VALIDATION FAILS.
 *
 * The owner's decision of 2026-10-26 accepts the `zod` upgrade (4.1.13 →
 * 4.6.7, a MINOR release, which is why it was accepted as a decision and not
 * as a patch) on one condition: **the client's error contract does not move.**
 * Three things are contractual —
 *
 *   1. the HTTP STATUS                      — 400 for a validation refusal,
 *   2. the ERROR CODE                       — `VALIDATION_FAILED`,
 *   3. the FIELD NAME                       — `issues[].path`,
 *
 * — and one thing is explicitly NOT: **the message text.** It is a generic
 * server-side fallback; what a merchant reads is produced by the client from
 * the code, in ar, en and tr (§29, P4-AL-54).
 *
 * ── WHY THIS TEST EXISTS, AND WHAT IT DELIBERATELY DOES NOT ASSERT ───────
 *
 * The upgrade's real behavioural change is that a string check now EXITS EARLY:
 * a value that is both too long and malformed can report one issue where it
 * used to report two. That is a change in the ISSUE SET — a 400's content —
 * arriving inside a security upgrade, and it is the reason the owner pinned a
 * contract rather than waving the version through.
 *
 * So this suite pins the three contractual facts and the ABSENCE of zod's own
 * prose, and it pins NOTHING about how many issues a request produces. Asserting
 * a count would freeze exactly the thing the decision released, and the next
 * `zod` release would go red for conforming.
 *
 * It is a PURE test: the real schemas, the real filter, a captured response.
 * No HTTP server, no database, no Nest container.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ArgumentsHost } from '@nestjs/common';
import { ZodError, z } from 'zod';
import { GlobalExceptionFilter } from '../../apps/api/src/common/error.filter';
import { CategoryCreateSchema, ProductCreateSchema } from '../../apps/api/src/modules/catalog/catalog.schemas';

interface Captured {
  status: number;
  body: { error: { code: string; message: string; requestId: string; details?: { issues?: { path: string; code: string }[] } } };
}

/** The filter writes through `host.switchToHttp().getResponse()`; this is the smallest thing that is one. */
function runFilter(exception: unknown): Captured {
  const captured: Partial<Captured> = {};
  const res = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(payload: unknown) {
      captured.body = payload as Captured['body'];
      return this;
    },
    setHeader() {
      return this;
    },
  };
  const host = { switchToHttp: () => ({ getResponse: () => res }) } as unknown as ArgumentsHost;
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  new GlobalExceptionFilter(logger as never).catch(exception, host);
  if (captured.status === undefined || captured.body === undefined) throw new Error('the filter wrote no response');
  return captured as Captured;
}

/** A real refusal from a real schema — never a hand-built `ZodError`, which would prove nothing about the product. */
function refuse(schema: { safeParse: (v: unknown) => { success: boolean; error?: unknown } }, value: unknown): ZodError {
  const r = schema.safeParse(value);
  expect(r.success, 'the input must actually be refused, or this case is vacuous').toBe(false);
  expect(r.error).toBeInstanceOf(ZodError);
  return r.error as ZodError;
}

const paths = (c: Captured): readonly string[] => (c.body.error.details?.issues ?? []).map((i) => i.path);

describe('DR-11 the validation error contract the zod upgrade may not move', () => {
  it('a refusal is 400 and VALIDATION_FAILED — the status and the code, which are contractual', () => {
    const c = runFilter(refuse(CategoryCreateSchema, { translations: {}, parentId: 'not-a-uuid' }));
    expect(c.status).toBe(400);
    expect(c.body.error.code).toBe('VALIDATION_FAILED');
    expect(typeof c.body.error.requestId).toBe('string');
  });

  it('the FIELD NAME comes back, for a top-level field and for one inside an array', () => {
    const top = runFilter(refuse(ProductCreateSchema, { translations: { en: 'Chair' }, basePriceMinor: '100', sku: '' }));
    expect(paths(top)).toContain('sku');

    // A nested path is still a field name, and it is dotted with its index —
    // which is how a client highlights the row that is wrong.
    const nested = runFilter(
      refuse(ProductCreateSchema, {
        translations: { en: 'Chair' },
        basePriceMinor: '100',
        variants: [{ sku: 'ok' }, { sku: '' }],
      }),
    );
    expect(paths(nested)).toContain('variants.1.sku');
  });

  it('every issue carries EXACTLY a path and a code — and no message', () => {
    const c = runFilter(refuse(ProductCreateSchema, { translations: { en: 'Chair' }, basePriceMinor: '-1', unit: '' }));
    const issues = c.body.error.details?.issues ?? [];
    expect(issues.length).toBeGreaterThan(0);
    for (const i of issues) {
      // The shape is the contract: a client reads `path` to find the field and
      // `code` to decide what to say. A `message` here would be prose the
      // client is tempted to render, in English, from the server.
      expect(Object.keys(i).sort()).toEqual(['code', 'path']);
      expect(typeof i.path).toBe('string');
      expect(typeof i.code).toBe('string');
    }
  });

  it('ZOD’S OWN PROSE NEVER REACHES THE CLIENT, not even a custom message the product wrote', () => {
    // `priceCurrency` refuses with `message: 'unsupported_currency'` in the
    // schema itself. If the filter ever forwarded `issue.message`, this is the
    // case that catches it — a product-authored string, so it cannot be
    // confused with a zod default that a future release might reword.
    const c = runFilter(refuse(ProductCreateSchema, { translations: { en: 'Chair' }, basePriceMinor: '100', priceCurrency: 'XYZ' }));
    const serialized = JSON.stringify(c.body);
    expect(serialized).not.toContain('unsupported_currency');
    expect(serialized.toLowerCase()).not.toContain('expected');
    expect(serialized.toLowerCase()).not.toContain('too_big'.replace('_', ' '));
    // The message is the generic fallback and nothing else.
    expect(c.body.error.message).toBe('Validation failed');
  });

  it('the message is NON-CONTRACTUAL, and the merchant’s text is the client’s, in ar, en and tr', () => {
    // The other half of the decision: because the server's message is generic,
    // SOMETHING must make it readable. That something is the client catalogue,
    // keyed by the code this suite just pinned.
    const root = join(__dirname, '..', '..');
    for (const locale of ['ar', 'en', 'tr'] as const) {
      // The catalogues are FLAT: the key is the dotted string itself.
      const catalogue = JSON.parse(readFileSync(join(root, 'apps', 'web', 'src', 'messages', `${locale}.json`), 'utf8')) as Record<string, string>;
      const text = catalogue['error.VALIDATION_FAILED'];
      expect(text, `${locale} must translate VALIDATION_FAILED`).toBeTruthy();
      // A sentence for a merchant, not the code echoed back.
      expect(text).not.toBe('VALIDATION_FAILED');
      expect((text ?? '').length).toBeGreaterThan(10);
    }
  });

  it('the EARLY-EXIT behaviour is released, not pinned: the field is still named when a value fails two ways at once', () => {
    // Too long AND malformed. Under 4.1 this reported both; under 4.6 the
    // string check can stop at the first. DR-11 permits either — what it does
    // not permit is losing the FIELD, so that is what is asserted.
    const twoWays = z
      .object({
        sku: z
          .string()
          .max(4)
          .regex(/^[A-Z]+$/),
      })
      .strict();
    const c = runFilter(refuse(twoWays, { sku: 'abcdefgh' }));
    expect(c.status).toBe(400);
    expect(c.body.error.code).toBe('VALIDATION_FAILED');
    expect(paths(c)).toContain('sku');
    // Deliberately no assertion on `issues.length`. See this file's header.
  });

  it('an unknown field is refused — and MEASURED HERE: its name is NOT in the envelope', () => {
    const c = runFilter(refuse(CategoryCreateSchema, { translations: { en: 'Chairs' }, business_id: 'x' }));
    expect(c.status).toBe(400);
    expect(c.body.error.code).toBe('VALIDATION_FAILED');

    // This is the one place where "the field name comes back" does NOT hold,
    // and it is pinned as measured rather than wished for. `zod` reports a
    // rejected unknown key as `{ code: 'unrecognized_keys', path: [], keys:
    // ['business_id'] }`, and the filter forwards `path` and `code` only — so
    // the client learns a key was refused and not which one.
    //
    // PRE-EXISTING, and NOT the upgrade's doing: the filter has never read
    // `keys`. Two readings, which is why this suite states the fact and
    // changes nothing. Against it: a client cannot highlight the field. For
    // it: the key is ATTACKER-SUPPLIED INPUT, and an envelope that echoed it
    // would reflect it back. The mass-assignment defence itself is unaffected
    // — the request is refused whole, which is what `.strict()` is for.
    expect(paths(c)).toEqual(['']);
    expect((c.body.error.details?.issues ?? []).map((i) => i.code)).toEqual(['unrecognized_keys']);
    // And the rejected key really is absent from the whole payload.
    expect(JSON.stringify(c.body)).not.toContain('business_id');
  });
});
