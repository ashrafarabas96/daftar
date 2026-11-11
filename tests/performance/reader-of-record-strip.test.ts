/**
 * `P4-AL-07`'s REMOVAL, measured directly and without a database.
 *
 * The law itself lives in `receivables-s4-budgets.test.ts` and needs a loaded
 * fixture, so every class of statement it must refuse could only ever be
 * exercised by whatever statements that cluster's reads happened to issue. This
 * suite exercises the classes themselves: the removal is a pure function of the
 * statement text and the names, so its verdict is host-independent and it is
 * red on any machine the day the removal stops refusing a second copy of the
 * arithmetic.
 *
 * The four classes are the card's own terms
 * (`P4PERF_AL07_STRIP_UNBALANCED_PARENS_AR.md`):
 *
 *   1. a bare sum in the read            → REFUSED
 *   2. a sum inside a reader's argument  → REFUSED   ← the class that escapes
 *   3. a reader call with no sum         → ALLOWED
 *   4. a call nested in a call, no sum   → ALLOWED
 *
 * Negative controls, so a green here cannot be a probe that refuses nothing or
 * everything: classes 3 and 4 are the "allowed" side, and the last case proves
 * the removal is driven by the NAMES and not by the shape — an unlisted
 * function's call is not removed, so its argument's sum still stands.
 */
import { describe, expect, it } from 'vitest';

import { readerOfRecordCall, stripReaderOfRecordCalls } from './reader-of-record-calls';

/**
 * A literal pair, not the live closure. The removal does not care which names
 * it is given, and a fixed pair keeps this suite's subject the removal itself;
 * the live closure is the gate's own subject, discovered there by dependency
 * over the Phase 4 DDL. `invoice_outstanding` is in the pair because it is the
 * name the escaping class was measured on (`0084:526`, `0084:593` — two live
 * signatures).
 */
const NAMES = ['invoice_outstanding', 'customer_ar_outstanding'] as const;

/** The law's verdict, verbatim: refuse a `sum(` in what is left after the removal. */
const refuses = (text: string): boolean => /\bsum\s*\(/i.test(stripReaderOfRecordCalls(text, NAMES));

describe('P4-AL-07 — the removal that gives the law its teeth', () => {
  it('REFUSES a bare sum in the read itself', () => {
    const text = 'SELECT sum(amount) FROM invoices WHERE customer_id = $1';
    expect(refuses(text), `the read sums money itself and was allowed:\n${text}`).toBe(true);
  });

  it('REFUSES a sum inside a reader of record’s argument — the second copy, one call deep', () => {
    const text = 'SELECT invoice_outstanding(sum(x), $2)';
    expect(
      refuses(text),
      `a sum in the reader's argument is a second copy of the arithmetic and was allowed. What the removal left: ${JSON.stringify(
        stripReaderOfRecordCalls(text, NAMES),
      )}`,
    ).toBe(true);
  });

  it('ALLOWS a reader of record call that sums nothing itself', () => {
    const text = 'SELECT * FROM customer_ar_outstanding($1, $2)';
    expect(refuses(text), `a plain reader call was refused:\n${text}`).toBe(false);
  });

  it('ALLOWS a reader of record call nested in another, with no sum of its own', () => {
    const text = 'SELECT invoice_outstanding(customer_ar_outstanding($1, $2), $3)';
    expect(refuses(text), `nesting two readers is not a second copy, and it was refused:\n${text}`).toBe(false);
  });

  it('CONTROL: the removal is driven by the names, so an unlisted function keeps its argument', () => {
    const text = 'SELECT some_other_function(sum(x), $2)';
    expect(stripReaderOfRecordCalls(text, NAMES), 'an unlisted function was removed, so the names are not the subject').toBe(text);
    expect(refuses(text), "an unlisted function's summed argument must still be refused").toBe(true);
  });

  it('CONTROL: the name matcher finds a call at all, and does not match a bare mention', () => {
    expect(readerOfRecordCall(NAMES).test('SELECT invoice_outstanding($1, $2)')).toBe(true);
    expect(readerOfRecordCall(NAMES).test('-- invoice_outstanding is the reader of record'), 'a mention without a call matched').toBe(false);
  });
});
