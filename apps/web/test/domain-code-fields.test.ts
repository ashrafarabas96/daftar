/**
 * EVERY MERCHANT REFUSAL THE API CAN SEND MUST BE RENDERABLE BY THE CLIENT.
 *
 * This suite exists because of a defect that shipped with P4-S2 and was found
 * in P4-S3. `apps/web/src/lib/client.ts` resolved a refusal's domain code by
 * reading a HAND-WRITTEN list of `details` field names, and `sellingCode` was
 * not on it. The API sets `details.sellingCode` on every selling refusal
 * (`apps/api/src/modules/selling/selling-errors.ts:473`), so `domainCode`
 * returned null, `refusalCode` fell back to the envelope code, `error.CONFLICT`
 * is not a catalogue key, and `refusalKey` returned the generic fallback. The
 * entire `error.sale.*` family and, once P4-S3 added them, the entire
 * `error.pos.*` family were DEAD STRINGS: present, translated in three
 * locales, asserted by a guard that reads the catalogues — and unreachable on
 * a screen.
 *
 * Measured, because the symptom is worse than "no message": `refusalCode`
 * falls through to the ENVELOPE code, and `error.CONFLICT` is a real catalogue
 * key reading "Something changed while you were working. Nothing was saved.
 * Refresh and try again." So a cashier meeting `pos.terminal_already_open`
 * was told something generic AND WRONG, and instructed to refresh, which
 * cannot help when a colleague's till is open on their device. A wrong
 * instruction gets followed.
 *
 * `tests/guards/phase4-pos-refusal-catalogue.test.ts` cannot catch this and is
 * not at fault: it reads the registry and the catalogues, which is exactly the
 * right question for "is the text written". This is the other question —
 * "can the text be reached" — and nothing was asking it.
 *
 * So neither claim below is written as "`sellingCode` is in the list". A test
 * that names the one code that was missing proves only that this instance was
 * fixed; the defect was a hand-kept list beside a growing set of namespaces,
 * and a hand-kept assertion beside it would go stale the same way, on the same
 * day, for the same reason. Claim 1 DERIVES the required field names from the
 * API's own refusal modules. Claim 2 drives the real resolver end to end.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ApiError } from '../src/lib/client';
import { FALLBACK_ERROR_KEY, refusalKey } from '../src/lib/phase3-errors';

const REPO = join(__dirname, '..', '..', '..');
const API_MODULES = join(REPO, 'apps/api/src/modules');

/**
 * The API's refusal modules, by their own naming convention: a `*-errors.ts`
 * under `apps/api/src/modules/`. These are the files whose job is to turn a
 * database or service refusal into an `AppError` carrying a stable domain
 * code, so they are where a new `details` field name appears.
 */
function refusalModules(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return refusalModules(path);
    return /-errors\.ts$/.test(entry) ? [path] : [];
  });
}

/**
 * A value that is a DOMAIN CODE rather than anything else called `…Code`. Two
 * shapes only: a dotted lower-case literal such as `'pos.session_not_open'`,
 * or a variable the module computed (`code`, or another `…Code` identifier).
 *
 * The filter is what keeps this derivation honest. Without it the scan also
 * reports `countryCode: 'SA'`, `unitCode: z.string()` and
 * `phoneCountryCode: …`, none of which is a refusal code, and a claim that
 * drowns in false positives gets weakened until it says nothing.
 */
const DOMAIN_CODE_VALUE = /^(?:'[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+'|code|[a-z][A-Za-z]*Code)$/;

/** Every `details` field name the API attaches a domain code to, with where it does it. */
function attachedCodeFields(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of refusalModules(API_MODULES)) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        // A type declaration is not an attachment: `readonly refusalCode:
        // string;` names a class property, and `shapeCode: 'a.b' | 'c.d'`
        // is a union. Both are excluded by shape rather than by name.
        if (/\breadonly\b/.test(line)) return;
        for (const match of line.matchAll(/\b([a-z][A-Za-z]*Code)\s*:\s*([^,;}\s]+)\s*(\|)?/g)) {
          if (match[3] === '|') continue;
          if (!DOMAIN_CODE_VALUE.test(match[2] ?? '')) continue;
          const field = match[1] ?? '';
          if (!found.has(field)) found.set(field, []);
          found.get(field)?.push(`${file.slice(REPO.length + 1)}:${index + 1}`);
        }
      });
  }
  return found;
}

/** The list the client actually reads, parsed out of its source rather than exported for this test. */
function declaredFields(): readonly string[] {
  const src = readFileSync(join(REPO, 'apps/web/src/lib/client.ts'), 'utf8');
  const line = /const DOMAIN_CODE_FIELDS = \[([^\]]*)\]/.exec(src);
  expect(line, 'DOMAIN_CODE_FIELDS could not be found in apps/web/src/lib/client.ts').not.toBeNull();
  return [...(line?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
}

describe('a refusal the API can send is a refusal the client can name', () => {
  it('every details field the API attaches a domain code to is one the client reads', () => {
    const attached = attachedCodeFields();
    // Not vacuous: the derivation must have found the modules at all. A scan
    // that silently matched nothing would make the claim below trivially true,
    // which is the failure mode this whole suite was written about.
    expect(attached.size, 'the scan found no refusal-detail fields at all — the derivation is broken, not the client').toBeGreaterThanOrEqual(4);

    const declared = declaredFields();
    const unreadable = [...attached.entries()]
      .filter(([field]) => !declared.includes(field))
      .map(
        ([field, sites]) => `${field} is attached at ${sites[0]} and is not in DOMAIN_CODE_FIELDS, so every refusal carrying it renders the generic fallback`,
      );
    expect(unreadable).toEqual([]);
  });

  it('a selling refusal resolves to its own catalogue key and not to the fallback', () => {
    // The end-to-end claim, through the real resolver: this is the assertion
    // that was false before the fix, and it is false again the moment the
    // field list, the API's field name or the catalogue key shape diverge.
    const key = refusalKey(new ApiError(409, 'CONFLICT', { sellingCode: 'pos.session_already_open' }));
    expect(key).toBe('error.pos.session_already_open');
    expect(key).not.toBe(FALLBACK_ERROR_KEY);
  });

  it('an unknown selling code falls back to the safe sentence, not to the envelope message', () => {
    // The other half of the contract, and a MEASURED correction to how this
    // defect was first described to me. Before the fix a selling refusal did
    // not render `error.fallback`: `refusalCode` fell through to the ENVELOPE
    // code, and `error.CONFLICT` is a real catalogue key — "Something changed
    // while you were working. Nothing was saved. Refresh and try again."
    //
    // So a cashier meeting `pos.terminal_already_open` was not told nothing;
    // they were told something generic AND WRONG, and instructed to refresh,
    // which cannot help when a colleague's till is open on their device. That
    // is worse than silence, because a wrong instruction gets followed.
    //
    // With the field read, an unrecognised code resolves to the safe sentence
    // instead of to the envelope's. Resolving MORE codes must not make an
    // unknown one render a missing key.
    expect(refusalKey(new ApiError(409, 'CONFLICT', { sellingCode: 'pos.not_a_real_code' }))).toBe(FALLBACK_ERROR_KEY);
  });

  it('RED: a field the client stops reading is named, with where the API attaches it', () => {
    // The planted defect, on the real derivation rather than a fixture: drop
    // `sellingCode` from the declared list and the first claim must name it.
    const attached = attachedCodeFields();
    const declared = declaredFields().filter((f) => f !== 'sellingCode');
    const unreadable = [...attached.keys()].filter((field) => !declared.includes(field));
    expect(unreadable).toEqual(['sellingCode']);
    // The site is DERIVED and then checked against the file, not written down.
    // This assertion first read `.toBe('…/selling-errors.ts:473')`, and the
    // line moved to 576 the moment the registry grew — which is the exact
    // hand-kept-fact defect this whole suite exists to prevent, committed one
    // level down inside the suite itself. A literal line number beside a
    // derivation is a fact that goes stale on every merge that touches the
    // file, including the merges that prove the derivation works.
    const site = attached.get('sellingCode')?.[0] ?? '';
    const [file, line] = site.split(':');
    expect(file).toBe('apps/api/src/modules/selling/selling-errors.ts');
    expect(Number(line)).toBeGreaterThan(0);
    // And the derived site really points at the attachment, so "derived"
    // cannot quietly mean "wrong line".
    const text = readFileSync(join(REPO, file ?? ''), 'utf8').split('\n')[Number(line) - 1] ?? '';
    expect(text).toMatch(/\bsellingCode\s*:/);
  });
});
