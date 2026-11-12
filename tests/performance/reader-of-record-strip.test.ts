/**
 * `P4-AL-07`'s REMOVAL, measured directly and without a database.
 *
 * The law itself lives in `receivables-s4-budgets.test.ts` and needs a loaded
 * fixture, so every class of statement it must refuse could only ever be
 * exercised by whatever statements that cluster's reads happened to issue. The
 * classes themselves live in `READER_STRIP_CASES`: the removal is a pure
 * function of the statement text and the names, so its verdict is
 * host-independent and red on any machine the day the removal stops refusing a
 * second copy of the arithmetic.
 *
 * WHERE THIS SUITE IS AND IS NOT A MEASUREMENT, measured rather than assumed.
 * The question is whether a runner REACHES a suite, not whether `ci.yml` names
 * it: the CI-speed lane measured three suites that no argument in `ci.yml` names
 * and that the runner executes anyway, through `scripts/*-gate.ts`
 * (`accounting-read-plans`, `phase3-s7-read-budgets`, `phase3-s8-budgets`), and
 * a fourth that another workflow runs — so "not named" is NOT "not run", and
 * that lane's numbers are theirs, not mine. What is measured here is the
 * narrower thing: NOTHING reaches THIS file. Its name appears nowhere in
 * `scripts`, `.github`, `packages`, `apps` or `tests` except a doc comment in
 * `reader-of-record-calls.ts`, with the same probe sighted on the two suites
 * that lane named (it finds their gate scripts). So THIS FILE is NOT_RUN on the
 * runner, and `ci.yml` belongs to another lane. That is why the same table is
 * asserted from `receivables-s4-budgets.test.ts`, which the runner does
 * execute, on the same head as the law: the runner's verdict comes from there,
 * and this file is the local one. Being reached through a named suite is itself
 * one of the routes that lane's own reach guard counts.
 *
 * The four classes are the card's own terms
 * (`P4PERF_AL07_STRIP_UNBALANCED_PARENS_AR.md`):
 *
 *   1. a bare sum in the read            → REFUSED
 *   2. a sum inside a reader's argument  → REFUSED   ← the class that escaped
 *   3. a reader call with no sum         → ALLOWED
 *   4. a call nested in a call, no sum   → ALLOWED
 *
 * Negative controls, so a green here cannot be a probe that refuses nothing or
 * everything: classes 3 and 4 are the "allowed" side, and the last case proves
 * the removal is driven by the NAMES and not by the shape — an unlisted
 * function's call is not removed, so its argument's sum still stands. Each case
 * also pins the EXACT remainder, so a pass is a measurement of what the
 * removal left and not of the verdict alone.
 */
import { describe, expect, it } from 'vitest';

import { READER_STRIP_CASES, readerOfRecordCall, stripReaderOfRecordCalls } from './reader-of-record-calls';

/** The law's verdict, verbatim: refuse a `sum(` in what is left after the removal. */
const refuses = (text: string, names: readonly string[]): boolean => /\bsum\s*\(/i.test(stripReaderOfRecordCalls(text, names));

describe('P4-AL-07 — the removal that gives the law its teeth', () => {
  for (const c of READER_STRIP_CASES) {
    it(`${c.mustRefuse ? 'REFUSES' : 'ALLOWS'}: ${c.what}`, () => {
      expect(stripReaderOfRecordCalls(c.text, c.names), `the removal left something else:\n${c.text}`).toBe(c.remainder);
      expect(refuses(c.text, c.names), `${c.what}\nstatement: ${c.text}\nremainder: ${JSON.stringify(stripReaderOfRecordCalls(c.text, c.names))}`).toBe(
        c.mustRefuse,
      );
    });
  }

  /**
   * A guard needs a seed that proves it can go red (DR-55, RULE-27). The seed
   * here is the implementation this removal replaced: the pattern
   * `…\([^)]*\)`, which cannot balance parentheses. If the table's classes were
   * vacuous, the two implementations would agree on all of them — so this case
   * is red the day the table stops discriminating between a removal that
   * balances and one that does not.
   */
  it('SEED: the table discriminates — the unbalanced pattern this replaced gets a class WRONG', () => {
    const unbalanced = (text: string, names: readonly string[]): string =>
      text.replace(new RegExp(`\\b(?:public\\.)?(?:${names.join('|')})\\([^)]*\\)`, 'gi'), '');
    const wrong = READER_STRIP_CASES.filter((c) => /\bsum\s*\(/i.test(unbalanced(c.text, c.names)) !== c.mustRefuse);
    expect(
      wrong.length,
      'the old unbalanced pattern satisfies every class in the table, so the table cannot tell the two removals apart and proves nothing',
    ).toBeGreaterThan(0);
    // And the seed must actually bite something: the pattern has to match a call
    // at all, or its agreement would be the agreement of a probe that does nothing.
    expect(unbalanced('SELECT invoice_outstanding($1)', ['invoice_outstanding']), 'the seed pattern matched nothing').toBe('SELECT ');
  });

  it('CONTROL: the name matcher finds a call at all, and does not match a bare mention', () => {
    const names = ['invoice_outstanding', 'customer_ar_outstanding'];
    expect(readerOfRecordCall(names).test('SELECT invoice_outstanding($1, $2)')).toBe(true);
    expect(readerOfRecordCall(names).test('-- invoice_outstanding is the reader of record'), 'a mention without a call matched').toBe(false);
  });
});
