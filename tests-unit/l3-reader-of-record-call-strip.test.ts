/**
 * P4-AL-07's STRIPPER, AND THE DEFECT IT WAS CARRYING (card
 * `P4PERF_AL07_STRIP_UNBALANCED_PARENS_AR`, handed to this lane by L1-q-10).
 *
 * The P4-D money law in `tests/performance/receivables-s4-budgets.test.ts`
 * removes every call to a reader of record from a captured statement and then
 * refuses a `sum(` in what REMAINS: a sum that survives the removal is a
 * second copy of money arithmetic outside the product's own reader.
 *
 * The removal was `\(([^)]*)\)`. `[^)]*` stops at the FIRST `)`, so a reader
 * call whose own arguments contain a parenthesis is cut at the wrong place.
 *
 * A CLAIM THAT USED TO STAND HERE WAS WRONG, and it is corrected rather than
 * deleted. It said the direction of the defect could only be a FALSE RED --
 * "stripping less can only leave more text, so it cannot hide a violation".
 * That is false, and §9 below is the measurement: on
 * `invoice_outstanding(coalesce(sum(a),0))` the old expression swallows
 * `sum(a` itself and the law passes a statement that sums money. So the defect
 * runs in BOTH directions, and the graver one is the hidden violation.
 *
 * The removal therefore takes the call's NAME and its two parentheses and
 * leaves the ARGUMENTS in the scanned text (§2, §10). Removing the whole call
 * body instead would make the law accept a statement that writes
 * `sum(i.total_minor)` into a reader's argument list -- a shape the law
 * reddened on before this card, so accepting it would be a WEAKENING of a
 * money law, not a repair. An independent finance round on `af8d8e09` caught
 * that weakening in an earlier version of this file; §10 is its control.
 *
 * This file is a unit control because the performance suite needs a cluster
 * and a dataset to run at all, so its own machine could never be controlled
 * there. `tests/helpers/reader-of-record-calls.ts` is that machine, lifted
 * out, and §1 and §9 reproduce the defect from the exact expression the suite
 * used to carry -- kept rather than deleted, so a regression is a failing case
 * and not a reread of this comment.
 */
import { describe, expect, it } from 'vitest';
import { stripReaderOfRecordCalls } from '../tests/helpers/reader-of-record-calls';

const READERS = ['customer_ar_outstanding', 'customer_ar_aging', 'invoice_outstanding'] as const;

/** The expression the suite carried, built exactly as it built it. */
const OLD = new RegExp(String.raw`\b(?:public\.)?(?:${READERS.join('|')})\([^)]*\)`, 'gi');

/** A reader call whose arguments hold a paren AND a `sum(` -- the shape the old expression could not remove. */
const NESTED = 'select * from invoice_outstanding(array_agg(i.id), sum(i.total_minor)) x';

/** A reader call whose arguments hold the `sum(` INSIDE a nested call -- the shape the old expression swallowed. */
const SWALLOWED = 'select invoice_outstanding(coalesce(sum(a),0)) from t';

describe('P4-AL-07 — stripping reader-of-record calls out of a statement', () => {
  it('§1 the expression the law used to carry cuts at the first `)` — reproduced', () => {
    const residue = NESTED.replace(OLD, '');
    expect(residue, 'the old expression stops at the first `)`').toContain('sum(');
    expect(residue.includes('invoice_outstanding'), 'and the name itself did go').toBe(false);
  });

  it('§2 the stripper removes the call NAME and its parentheses, and keeps the arguments in view', () => {
    const residue = stripReaderOfRecordCalls(NESTED, READERS);
    expect(residue.includes('invoice_outstanding'), `residue: ${residue}`).toBe(false);
    expect(residue.includes('array_agg(i.id)'), 'the arguments stay').toBe(true);
    expect(/\bsum\s*\(/i.test(residue), 'a sum the STATEMENT wrote must stay visible to the law').toBe(true);
  });

  it('§3 NEGATIVE CONTROL: a statement that really does sum money itself still keeps its `sum(`', () => {
    const own = 'select sum(i.total_minor) from invoices i where i.customer_id = $1';
    expect(/\bsum\s*\(/i.test(stripReaderOfRecordCalls(own, READERS)), 'the law must still redden on a second copy').toBe(true);
  });

  it('§4 NEGATIVE CONTROL: a sum OUTSIDE the call survives while the name goes', () => {
    const mixed = 'select sum(x.v), customer_ar_outstanding($1, (select max(d) from t)) from x';
    const residue = stripReaderOfRecordCalls(mixed, READERS);
    expect(residue.includes('customer_ar_outstanding')).toBe(false);
    expect(/\bsum\s*\(/i.test(residue), `residue: ${residue}`).toBe(true);
  });

  it('§5 an unterminated call is not treated as a clean strip', () => {
    const truncated = 'select customer_ar_aging($1, sum(y)';
    const residue = stripReaderOfRecordCalls(truncated, READERS);
    expect(residue, 'a truncated capture must not look like a removal').toContain('sum(');
    expect(residue, 'and nothing from the unterminated point on is removed').toBe(truncated);
  });

  it('§6 a parenthesis inside a quoted literal does not close the call', () => {
    const quoted = "select invoice_outstanding(array[$1], ') not a paren') from t";
    const residue = stripReaderOfRecordCalls(quoted, READERS);
    expect(residue.includes('invoice_outstanding')).toBe(false);
    expect(residue.trim()).toBe("select array[$1], ') not a paren' from t");
  });

  it('§7 several calls in one statement all go, and nothing between them is eaten', () => {
    const two = 'select customer_ar_aging($1, (1)) a, invoice_outstanding(array_agg(id)) b, sum(z) c from t';
    const residue = stripReaderOfRecordCalls(two, READERS);
    expect(residue.includes('customer_ar_aging')).toBe(false);
    expect(residue.includes('invoice_outstanding')).toBe(false);
    expect(residue).toContain(' a,');
    expect(residue).toContain(' b,');
    expect(/\bsum\s*\(/i.test(residue)).toBe(true);
  });

  it('§8 an empty reader list removes nothing at all', () => {
    expect(stripReaderOfRecordCalls(NESTED, [])).toBe(NESTED);
  });

  it('§9 THE GRAVER DIRECTION, measured: the old expression SWALLOWED a sum and passed the statement', () => {
    const residue = SWALLOWED.replace(OLD, '');
    expect(residue.includes('sum('), 'the old cut consumed `sum(a` with the call').toBe(false);
    expect(/\bsum\s*\(/i.test(residue), 'so the law accepted a statement that sums money -- a HIDDEN violation').toBe(false);
  });

  it('§10 ANTI-WEAKENING CONTROL: that same statement is reddened now', () => {
    const residue = stripReaderOfRecordCalls(SWALLOWED, READERS);
    expect(residue.includes('coalesce(sum(a),0)'), `residue: ${residue}`).toBe(true);
    expect(/\bsum\s*\(/i.test(residue), 'the repair must be TIGHTER than the defect, never looser').toBe(true);
  });

  it('§11 a nested reader call inside the arguments is removed too', () => {
    const inner = 'select invoice_outstanding(customer_ar_aging($1), 2) from t';
    const residue = stripReaderOfRecordCalls(inner, READERS);
    expect(residue.includes('invoice_outstanding')).toBe(false);
    expect(residue.includes('customer_ar_aging'), 'the scan continues inside the argument list').toBe(false);
  });
});
