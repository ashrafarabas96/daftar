/**
 * THE TWO UNIQUE BACKSTOPS OF `payment_allocations`, AND WHAT THE MERCHANT
 * WOULD SEE IF ONE OF THEM EVER ANSWERED (card L3-C-02).
 *
 * `0081:325-326` declares two constraints that no other rule declares:
 *
 *   payment_allocations_invoice_uq  UNIQUE (business_id, payment_id, invoice_id)
 *   payment_allocations_line_no_uq  UNIQUE (business_id, payment_id, line_no)
 *
 * They are BACKSTOPS: today `assertAllocations`
 * (`receivables-payload.ts:259-261`) refuses a duplicate invoice or a
 * duplicate allocation id before any statement runs, so neither key is
 * reachable on a known path. That is exactly why this is worth pinning rather
 * than leaving: the day a path reaches one of them -- a new caller, a batch
 * command, a routine that inserts allocations itself -- the refusal arrives as
 * a raw `23505` and `rethrowReceivablesRefusal` re-throws it UNTOUCHED, so the
 * merchant gets a 500 with a Postgres constraint name instead of the same
 * refusal the payload guard would have given.
 *
 * `UNIQUE_KEY_REFUSALS` already classifies `payment_allocations_pkey` and
 * `customer_credits_pkey`. These two sit in the same table, in the same
 * statement, and answer the same question -- "this payment names this invoice
 * twice" -- so they take the SAME code the payload guard raises,
 * `customer_payment.allocations_invalid`. No new code reaches the merchant:
 * the classification only stops an unclassified one from reaching them.
 *
 * An independent finance review of 8ed0d8f7 found the gap; this file is the
 * control, and §3 is the negative control that keeps the classification from
 * swallowing a refusal it must NOT answer.
 */
import { describe, expect, it } from 'vitest';
import { rethrowReceivablesRefusal } from '../apps/api/src/modules/receivables/receivables-errors';

/** A `pg` unique violation, shaped as the driver shapes it: `code` and `constraint`. */
const uniqueViolation = (constraint: string): Error & { code: string; constraint: string } =>
  Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), {
    code: '23505',
    constraint,
  });

const refusalOf = (error: unknown): { readonly code: string | null; readonly receivablesCode: unknown } => {
  try {
    rethrowReceivablesRefusal(error);
  } catch (thrown) {
    // Duck-typed on purpose: importing the AppError class here would drag the
    // workspace package in, and what this control is about is the SHAPE the
    // merchant receives -- a named code plus the receivables code in details.
    const shaped = thrown as { code?: unknown; details?: Record<string, unknown> };
    const hasCode = typeof shaped.code === 'string' && shaped.details !== undefined;
    if (hasCode) return { code: shaped.code as string, receivablesCode: shaped.details?.['receivablesCode'] ?? null };
    return { code: null, receivablesCode: null };
  }
  throw new Error('rethrowReceivablesRefusal returned instead of throwing');
};

describe('L3-C-02 — the two unique backstops of payment_allocations are classified', () => {
  it.each([
    ['payment_allocations_invoice_uq', 'the same invoice named twice in one payment'],
    ['payment_allocations_line_no_uq', 'the same line number twice in one payment'],
  ])('§1 %s is answered as the allocations refusal, not re-thrown raw', (constraint, why) => {
    const seen = refusalOf(uniqueViolation(constraint));
    expect(seen.receivablesCode, `${constraint} (${why}) must not reach the merchant unclassified`).toBe('customer_payment.allocations_invalid');
  });

  it('§2 the two keys already classified are untouched', () => {
    for (const constraint of ['payment_allocations_pkey', 'customer_credits_pkey']) {
      expect(refusalOf(uniqueViolation(constraint)).receivablesCode, constraint).toBe('customer_payment.allocations_invalid');
    }
  });

  it('§3 NEGATIVE CONTROL: an unrelated unique violation is still re-thrown UNTOUCHED', () => {
    // A failure answered as a business refusal is money the merchant thinks
    // did not arrive, so the classification must stay a named list and never
    // become "any 23505".
    const foreign = uniqueViolation('invoices_pkey');
    expect(() => rethrowReceivablesRefusal(foreign)).toThrow(foreign);
    const seen = refusalOf(foreign);
    expect(seen.code, 'an unlisted constraint must not become an AppError').toBeNull();
  });

  it('§4 NEGATIVE CONTROL: a non-23505 error carrying one of these names is NOT classified', () => {
    // The gate is the pair (code, constraint). A deadlock or a serialisation
    // failure that happens to mention the constraint is an infrastructure
    // failure, and answering it as a refusal would hide it.
    const notUnique = Object.assign(new Error('could not serialize access'), {
      code: '40001',
      constraint: 'payment_allocations_invoice_uq',
    });
    expect(refusalOf(notUnique).code, '40001 must pass through').toBeNull();
  });
});
