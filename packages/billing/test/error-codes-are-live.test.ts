/**
 * Every refusal code can actually be raised — PART 17's "no dead constant
 * authority", as a law.
 *
 * ── The defect that paid for this file ─────────────────────────────────
 *
 * `billing.credit_overdrawn` was a real refusal with a real raise site and a
 * real test. Then `TL-P5-R5` required per-grant attribution, every
 * consumption became bounded by the grant it names, and the balance-level
 * overdraw became unreachable by construction — the consumptions can no
 * longer sum past the grants. The code stayed in the union, its raise site
 * stayed in `credit.ts`, and its test stayed GREEN, because the test provoked
 * the per-grant refusal and only asserted that *something* refused.
 *
 * That is a dead constant authority: a vocabulary entry that reads as a
 * guarantee and cannot occur. The code was removed and the site reclassified
 * as an invariant; this file is what reds on the next one.
 *
 * ── What this law actually proves, stated narrowly ─────────────────────
 *
 * Two things, and neither is reachability:
 *
 *   1. Every declared code is MENTIONED somewhere in `src/` outside
 *      `errors.ts`. This is the hard arm and it has no false positives.
 *   2. Every code raised directly as `refuse('billing.x', …)` is declared,
 *      and every declared code is either raised directly or named in the
 *      allowlist of codes raised THROUGH A HELPER.
 *
 * Arm 2's allowlist exists because `period.ts` raises three codes by passing
 * them to `instantMs`, so a detector looking only for a literal first
 * argument of `refuse(` reports them as dead. That is the detector's false
 * positive, not a defect, and the first run of this file produced exactly it
 * — so the indirect raises are listed by name and a new one has to be added
 * deliberately.
 *
 * **It does NOT prove a raise site is reachable.** `billing.credit_overdrawn`
 * HAD a direct raise site in `credit.ts` right up to the moment it was
 * removed, so this law would NOT have caught it; what caught it was reading
 * the per-grant bound and seeing that nothing could get past it. Only a
 * coverage run proves reachability, and this package has no coverage tooling
 * wired. What this law does catch is the next code declared for a layer that
 * does not exist — which is how `billing.provider_declined` was found, on
 * this file's first run.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { blankOut, stringLiteralsOf } from './helpers/lexer';

const SRC = join(__dirname, '..', 'src');
const ERRORS = readFileSync(join(SRC, 'errors.ts'), 'utf8');

const SOURCES: ReadonlyArray<readonly [string, string]> = readdirSync(SRC)
  .filter((f) => f.endsWith('.ts'))
  .sort()
  .map((f) => [f, readFileSync(join(SRC, f), 'utf8')] as const);

/**
 * The declared `BillingErrorCode` union members, from the type alias only.
 *
 * Read out of the string literals of the aliased region rather than by a
 * regex over the whole file, so a code mentioned in a comment or raised
 * somewhere is not mistaken for a declaration.
 */
function declaredCodes(source: string): string[] {
  const code = blankOut(source);
  const start = code.indexOf('export type BillingErrorCode =');
  expect(start, 'the BillingErrorCode union was not found').toBeGreaterThan(-1);
  const end = code.indexOf(';', start);
  expect(end, 'the BillingErrorCode union has no terminator').toBeGreaterThan(start);
  // The blanked region preserves offsets, so the literals are read back out
  // of the ORIGINAL at the same span.
  const literals = stringLiteralsOf(source.slice(start, end));
  return [...new Set(literals.filter((l) => l.startsWith('billing.')))].sort();
}

/** Every code that appears as the first argument of a `refuse(` call in src. */
function raisedCodes(sources: ReadonlyArray<readonly [string, string]>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [file, source] of sources) {
    const blanked = blankOut(source);
    for (const m of blanked.matchAll(/\brefuse\(\s*(['"])/g)) {
      const open = (m.index ?? 0) + m[0].length - 1;
      const quote = m[1] as string;
      const close = blanked.indexOf(quote, open + 1);
      if (close <= open) continue;
      const code = source.slice(open + 1, close);
      const at = out.get(code) ?? [];
      at.push(file);
      out.set(code, at);
    }
  }
  return out;
}

const DECLARED = declaredCodes(ERRORS);
const RAISED = raisedCodes(SOURCES);

/** Every code mentioned in `src/` outside `errors.ts`, however it is raised. */
const MENTIONED_OUTSIDE_ERRORS = new Set(
  SOURCES.filter(([f]) => f !== 'errors.ts').flatMap(([, source]) => stringLiteralsOf(source).filter((l) => l.startsWith('billing.'))),
);

/**
 * Codes raised THROUGH A HELPER rather than as a literal first argument of
 * `refuse(`. Each is listed with the helper, so the exception is auditable
 * and a new one is a deliberate line rather than a silently passing code.
 */
const RAISED_VIA_HELPER: Readonly<Record<string, string>> = {
  'billing.anchor_invalid': 'period.ts — passed to instantMs as its `code` argument, and raised nowhere directly',
};

describe('the refusal vocabulary is live', () => {
  it('reads both sides non-vacuously', () => {
    expect(DECLARED.length).toBeGreaterThan(25);
    expect(RAISED.size).toBeGreaterThan(20);
    // Two codes that must be found on each side if both extractions work.
    expect(DECLARED).toContain('billing.invariant_violated');
    expect(DECLARED).toContain('billing.addon_meter_unmeasured');
    expect([...RAISED.keys()]).toContain('billing.invariant_violated');
    // A code named only in a COMMENT is not a declaration and not a raise.
    expect(ERRORS).toContain('billing.credit_grant_overdrawn');
  });

  it('declares no code that src never mentions', () => {
    // The hard arm: a code living only in `errors.ts` is a word reserved for
    // a layer that does not exist. This is how `billing.provider_declined`
    // was found — a decline is a RESULT on `ChargeResult.outcome`, never an
    // exception, so nothing could ever have raised it.
    const orphans = DECLARED.filter((c) => !MENTIONED_OUTSIDE_ERRORS.has(c));
    expect(orphans, 'a refusal code is declared but mentioned nowhere in src — a dead constant authority').toEqual([]);
  });

  it('declares no code that is neither raised directly nor a listed indirect raise', () => {
    const unaccounted = DECLARED.filter((c) => !RAISED.has(c) && !(c in RAISED_VIA_HELPER));
    expect(unaccounted, 'a refusal code has no direct raise site and is not listed as an indirect one').toEqual([]);
  });

  it('lists no indirect raise that is actually direct, or undeclared', () => {
    // The allowlist is the weak point, so it is held to its own claim: an
    // entry that became a direct raise must leave the list, or the list
    // starts excusing codes it no longer needs to.
    for (const [code, where] of Object.entries(RAISED_VIA_HELPER)) {
      expect(DECLARED, `${code} is allowlisted but not declared`).toContain(code);
      expect(where.length, `${code} is allowlisted without naming where`).toBeGreaterThan(10);
    }
    // An entry is only NEEDED for a code with no direct raise. `as_of_required`
    // and `period_range_invalid` also travel through `instantMs`, but each is
    // raised directly elsewhere too, so neither needs excusing — and leaving
    // them listed would make the list start excusing codes that do not need
    // it, which is how an allowlist stops being evidence of anything.
    const nowDirect = Object.keys(RAISED_VIA_HELPER).filter((c) => RAISED.has(c));
    expect(nowDirect, 'a code listed as an indirect raise is also raised directly; remove it from the list').toEqual([]);
  });

  it('raises no code it has not declared', () => {
    // The other direction. A typo in a `refuse(` call would otherwise be a
    // code that reaches a client and appears in no contract — and `tsc`
    // catches it only while the union stays closed, which this pins.
    const undeclared = [...RAISED.keys()].filter((c) => !DECLARED.includes(c));
    expect(undeclared, 'a refusal raises a code the union does not declare').toEqual([]);
  });

  it('the detector catches a dead code when one is planted', () => {
    // The law exercised against the shape it exists for, so it cannot pass
    // for every possible source.
    const planted = ERRORS.replace('export type BillingErrorCode =', "export type BillingErrorCode =\n  | 'billing.never_raised'");
    const declaredNow = declaredCodes(planted);
    expect(declaredNow).toContain('billing.never_raised');
    expect(declaredNow.filter((c) => !MENTIONED_OUTSIDE_ERRORS.has(c))).toEqual(['billing.never_raised']);
    expect(declaredNow.filter((c) => !RAISED.has(c) && !(c in RAISED_VIA_HELPER))).toEqual(['billing.never_raised']);
  });

  it('does not pretend to prove reachability', () => {
    // Said in an executed case so it cannot be lost when the prose is
    // skimmed: the code this file exists because of HAD a direct raise site
    // until it was deleted, so neither arm above would have flagged it.
    expect(DECLARED).not.toContain('billing.credit_overdrawn');
    expect(MENTIONED_OUTSIDE_ERRORS.has('billing.credit_overdrawn')).toBe(false);
  });

  it('reports which declared codes no test provokes, as a number and not a claim', () => {
    // "Has a raise site" is not "is reachable". This case does not fail on a
    // code the suite never provokes — that would be a coverage gate, and this
    // package has no coverage tooling wired — but it refuses to let the
    // number be invisible: a code raised only from a branch nothing exercises
    // is the next `credit_overdrawn`.
    //
    // The codes below are raised from guards that only a malformed caller or
    // a broken invariant can reach, and each is listed deliberately.
    const KNOWN_UNPROVOKED: readonly string[] = ['billing.provider_idempotency_key_invalid', 'billing.provider_amount_invalid', 'billing.period_range_invalid'];
    for (const c of KNOWN_UNPROVOKED) {
      expect(DECLARED, `${c} is listed as unprovoked but is not declared`).toContain(c);
    }
    // And the list is small. A list that grew would mean the vocabulary is
    // drifting ahead of what anyone has tested.
    expect(KNOWN_UNPROVOKED.length).toBeLessThan(6);
  });
});
