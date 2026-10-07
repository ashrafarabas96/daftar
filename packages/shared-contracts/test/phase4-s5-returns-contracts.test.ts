/**
 * P4-S5, maturity level C — the returns CONTRACT's absences, asserted over the
 * real declaration rather than over a hand-copied list.
 *
 * This suite reads `src/returns.ts` FROM DISK and parses the field names out of
 * each `interface`. That is the difference between a guard and a comment: a
 * hand-written list of "fields `RefundDto` must not have" goes stale the moment
 * somebody adds one, while this test's subject IS the shipped declaration. Add
 * `invoiceId` to `RefundDto` and this file goes red on the next run.
 *
 * The three absences it defends, and the law behind each:
 *
 * 1. no field on a refund may name an INVOICE — `TL-P4-S5-R1`, "a refund is not
 *    an invoice-outstanding reducer";
 * 2. no field on a refund may name a PAYMENT — the same ruling, "it carries no
 *    `payment_id`", and the execution plan's "no column that could name a
 *    payment";
 * 3. no shape anywhere in the contract may carry a stored consumption total —
 *    the cap is derived from the exact stored rows, and `refunded_amount_minor`
 *    is independently an authoritative-balance column to G-3.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REFUND_NAMES_NO_INVOICE, forbiddenRefundFields, refundInvoiceNamingFields } from '@daftar/domain-core';

const SOURCE = readFileSync(join(__dirname, '../src/returns.ts'), 'utf8');

/**
 * The field names declared inside one `interface` of the contract, read from the
 * text.
 *
 * Deliberately a text parse and not a type-level trick: a type-level assertion
 * is erased at runtime and a `keyof` over an interface cannot be enumerated
 * without a value, so the only way to make the SHIPPED declaration the subject
 * is to read it. Comment lines are dropped first, so a doc comment mentioning an
 * invoice can neither satisfy nor fail the law — the same precondition
 * `scripts/phase4-s1-gate.ts:1413-1424` asserts rather than assumes of its own
 * SQL bodies.
 */
function interfaceFields(name: string): readonly string[] {
  const start = SOURCE.indexOf(`export interface ${name} `);
  if (start < 0) throw new Error(`the contract declares no interface ${name} — this suite has lost its subject, which is not a pass`);
  const open = SOURCE.indexOf('{', start);
  let depth = 0;
  let end = open;
  for (let i = open; i < SOURCE.length; i++) {
    const ch = SOURCE[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = SOURCE.slice(open + 1, end)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  return Object.freeze([...body.matchAll(/^\s*readonly\s+([A-Za-z_][A-Za-z0-9_]*)\s*[?:]/gm)].map((m) => m[1] as string));
}

describe('P4-S5 contract — the refund shape, read from the shipped declaration', () => {
  it('declares the interfaces this suite judges, so the suite cannot be vacuous', () => {
    for (const name of ['RefundDto', 'RefundResultDto', 'CreditNoteDto', 'CreditNoteItemDto', 'CreditNoteApplicationDto']) {
      expect(() => interfaceFields(name)).not.toThrow();
    }
    // A non-trivial field count, so a future empty interface cannot pass by
    // having nothing to judge.
    expect(interfaceFields('RefundDto').length).toBeGreaterThan(10);
  });

  it('`RefundDto` names no invoice — TL-P4-S5-R1, over the real field list', () => {
    const fields = interfaceFields('RefundDto');
    expect(refundInvoiceNamingFields(fields)).toEqual([]);
    expect(REFUND_NAMES_NO_INVOICE(fields)).toBe(true);
  });

  it('`RefundDto` names no payment, and `paymentMethodId` is lawful because a method is configuration', () => {
    const fields = interfaceFields('RefundDto');
    expect(forbiddenRefundFields(fields)).toEqual([]);
    expect(fields).toContain('paymentMethodId');
  });

  it('`RefundDto` carries BOTH nullable sources and NO discriminator', () => {
    const fields = interfaceFields('RefundDto');
    expect(fields).toContain('creditNoteId');
    expect(fields).toContain('customerCreditId');
    // GOLD-74: a `*_id` beside a `*_type`/`*_kind` with no foreign key is a
    // polymorphic reference and is refused on the financial core. The kind is
    // derived from which id is set, in one place.
    expect(fields.filter((f) => /^(source|refund)(Type|Kind)$/.test(f))).toEqual([]);
  });

  it('RED PROOF — the guard this suite relies on fires on the real forbidden names', () => {
    // Planted against the actual declaration plus each of the three names the
    // rulings name. If the guard could not refuse these, every green above
    // would be vacuous.
    const fields = interfaceFields('RefundDto');
    expect(REFUND_NAMES_NO_INVOICE([...fields, 'invoiceId'])).toBe(false);
    expect(REFUND_NAMES_NO_INVOICE([...fields, 'invoiceNumber'])).toBe(false);
    expect(forbiddenRefundFields([...fields, 'paymentId'])).toHaveLength(1);
    expect(forbiddenRefundFields([...fields, 'refundedAmountMinor'])).toHaveLength(1);
    expect(forbiddenRefundFields([...fields, 'sourceType'])).toHaveLength(1);
  });

  it('no shape in the whole contract carries a stored consumption total or a derived settlement figure', () => {
    const all = ['RefundDto', 'RefundResultDto', 'CreditNoteDto', 'CreditNoteItemDto', 'CreditNoteApplicationDto', 'CreditNotePageDto', 'RefundPageDto'];
    for (const name of all) {
      expect(forbiddenRefundFields(interfaceFields(name))).toEqual([]);
    }
  });

  it('the credit note carries the remaining PAIR and no settlement status', () => {
    const fields = interfaceFields('CreditNoteDto');
    expect(fields).toContain('remainingAmountMinor');
    expect(fields).toContain('remainingCarryingBaseAmountMinor');
    // `status` is lifecycle only; there is no `settlementState`, no `isRefunded`
    // and no `consumed*` that could disagree with the pair.
    expect(fields).toContain('status');
    expect(fields.filter((f) => /settlementState|isRefunded|consumed/i.test(f))).toEqual([]);
  });

  it('the tax element exists only as a structural zero, and only where the invoice has one', () => {
    // OD-03 is OPEN. `od03Problems` reads every column matching
    // `(^|_)tax(_|$)` on every relation in `public` and there is no allowlist:
    // "nothing is permitted by being named, only by being structurally zero".
    // In the contract the mirror of that is the literal type `'0'`.
    expect(SOURCE).toMatch(/readonly taxMinor: '0';/);
    expect(SOURCE).not.toMatch(/taxRate|taxPercent|vat|jurisdiction/i);
  });
});
