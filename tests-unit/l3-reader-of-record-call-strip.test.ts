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
 * call whose own arguments contain a parenthesis is only partly removed, and
 * what is left over is read as the statement's own arithmetic. The direction
 * of the defect is a FALSE RED -- stripping less can only leave more text, so
 * it cannot hide a violation, it can only invent one -- and a law that goes
 * red on a compliant read is a law somebody disables.
 *
 * This file is a unit control because the performance suite needs a cluster
 * and a dataset to run at all, so its own machine could never be controlled
 * there. `tests/helpers/reader-of-record-calls.ts` is that machine, lifted
 * out, and §1 below is the defect reproduced from the exact expression the
 * suite used to carry -- kept rather than deleted, so a regression is a
 * failing case and not a reread of this comment.
 */
import { describe, expect, it } from 'vitest';
import { stripReaderOfRecordCalls } from '../tests/helpers/reader-of-record-calls';

const READERS = ['customer_ar_outstanding', 'customer_ar_aging', 'invoice_outstanding'] as const;

/** The expression the suite carried, built exactly as it built it. */
const OLD = new RegExp(String.raw`\b(?:public\.)?(?:${READERS.join('|')})\([^)]*\)`, 'gi');

/** A reader call whose arguments hold a paren AND a `sum(` -- the shape the old expression could not remove. */
const NESTED = 'select * from invoice_outstanding(array_agg(i.id), sum(i.total_minor)) x';

describe('P4-AL-07 — stripping reader-of-record calls out of a statement', () => {
  it('§1 the expression the law used to carry leaves a `sum(` behind on a nested call — the false red, reproduced', () => {
    const residue = NESTED.replace(OLD, '');
    expect(residue, 'the old expression stops at the first `)`').toContain('sum(');
    expect(/\bsum\s*\(/i.test(residue), 'so the law read a compliant statement as summing money itself').toBe(true);
  });

  it('§2 the balanced stripper removes the whole call, nested parens and all', () => {
    const residue = stripReaderOfRecordCalls(NESTED, READERS);
    expect(/\bsum\s*\(/i.test(residue), `residue: ${residue}`).toBe(false);
    expect(residue.includes('invoice_outstanding')).toBe(false);
  });

  it('§3 NEGATIVE CONTROL: a statement that really does sum money itself still keeps its `sum(`', () => {
    const own = 'select sum(i.total_minor) from invoices i where i.customer_id = $1';
    expect(/\bsum\s*\(/i.test(stripReaderOfRecordCalls(own, READERS)), 'the law must still redden on a second copy').toBe(true);
  });

  it('§4 NEGATIVE CONTROL: a sum OUTSIDE the call survives while the call goes', () => {
    const mixed = 'select sum(x.v), customer_ar_outstanding($1, (select max(d) from t)) from x';
    const residue = stripReaderOfRecordCalls(mixed, READERS);
    expect(residue.includes('customer_ar_outstanding')).toBe(false);
    expect(/\bsum\s*\(/i.test(residue), `residue: ${residue}`).toBe(true);
  });

  it('§5 an unterminated call is not treated as a clean strip', () => {
    const truncated = 'select customer_ar_aging($1, sum(y)';
    const residue = stripReaderOfRecordCalls(truncated, READERS);
    expect(residue, 'a truncated capture must not look like a removal').toContain('sum(');
  });

  it('§6 a parenthesis inside a quoted literal does not close the call', () => {
    const quoted = "select invoice_outstanding(array[$1], ') not a paren') from t";
    const residue = stripReaderOfRecordCalls(quoted, READERS);
    expect(residue.includes('invoice_outstanding')).toBe(false);
    expect(residue.trim()).toBe('select  from t');
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

  it('§8 an empty reader list changes nothing', () => {
    expect(stripReaderOfRecordCalls(NESTED, [])).toBe(NESTED);
  });
});
